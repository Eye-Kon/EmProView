/**
 * NASR ETL ingestion: streams the FAA 28-day NASR CSV subscriber zip
 * (default: nasr_dropzone/nasr.zip) into the multi-cycle MongoDB
 * `nav_data` collection.
 *
 * Architecture — zero RAM bloat:
 *   - The zip is NEVER extracted to disk or inflated into memory.
 *     unzipper.Open.file() reads only the central directory; each needed
 *     entry is then decompressed as a stream.
 *   - Each CSV entry is piped through csv-parser and consumed row-by-row
 *     with `for await`, so backpressure pauses the decompressor while a
 *     Mongo batch is being flushed. No file is ever held in memory.
 *   - Documents accumulate in a batch array of BATCH_SIZE (1,000). Each
 *     flush executes one insertMany/bulkWrite, then the array is dropped
 *     so the old batch becomes garbage-collectable before the stream
 *     resumes.
 *
 * The only in-memory state is bounded join/bookkeeping data, never file
 * contents: the SITE_NO -> {icao, magneticVariation} lookup built from
 * APT_BASE.csv (~20k tiny objects, required to join runway ends to their
 * airport), and a Set of navaid identifiers used for post-insert count
 * verification.
 *
 * Inputs inside the zip (FAA CSV subscription naming, matched
 * case-insensitively anywhere in the archive):
 *   APT_BASE.csv     airport ICAO ids + airport magnetic variation
 *   APT_RWY_END.csv  runway-end coordinates + TRUE_ALIGNMENT
 *   NAV_BASE.csv     navaid coordinates + magnetic variation
 *
 * Data integrity: a record without a finite WGS-84 coordinate is dropped
 * and counted — never coerced to zeros. Runway ends additionally require
 * a finite True Heading and airport Magnetic Variation, and navaids a
 * finite Magnetic Variation, because utils/navDbQuery.js fail-safes on
 * those fields at query time.
 *
 * AIRAC tagging: the cycle is derived from the data's own EFF_DATE column
 * (falling back to the current UTC date), via utils/airac.js. Every
 * document is stamped with `airacCycle`; the cycle metadata doc
 * (_id: "airac_<cycle>") is inserted LAST as the commit point, so a crash
 * mid-stream leaves an invisible partial cycle, never a queryable
 * half-dataset (query resolution goes through metadata docs only).
 *
 * Note on "Mongoose insertMany": this codebase uses the native `mongodb`
 * driver (no Mongoose models exist), so the bulk operations are the
 * driver's own insertMany()/bulkWrite() — same server-side semantics.
 *
 * Usage:
 *   const { ingestNasrZip } = require("./utils/nasrUpdater");
 *   await ingestNasrZip(db);                       // nasr_dropzone/nasr.zip
 *   await ingestNasrZip(db, "/path/to/nasr.zip");  // explicit path
 *
 *   CLI: node utils/nasrUpdater.js [zipPath]       // uses MONGODB_URI
 */
const fs = require("fs");
const path = require("path");
const unzipper = require("unzipper");
const csv = require("csv-parser");
const { getCycleForDate } = require("./airac");

const NAV_DATA_COLLECTION = "nav_data";
const BATCH_SIZE = 1000;
const DEFAULT_ZIP_PATH = path.join(__dirname, "..", "nasr_dropzone", "nasr.zip");

// Entry name patterns, in priority order per dataset. Matched against the
// basename so nested folders inside the archive are transparent.
const ENTRY_PATTERNS = {
    airports: [/^APT_BASE\.csv$/i, /^APT\.csv$/i],
    runwayEnds: [/^APT_RWY_END\.csv$/i],
    navaids: [/^NAV_BASE\.csv$/i, /^NAV\.csv$/i]
};

function log(message) {
    console.log(`[NASR ETL] ${new Date().toISOString()} ${message}`);
}

/* ------------------------------------------------------------------ */
/* Deterministic field parsers                                         */
/* ------------------------------------------------------------------ */

/** Trimmed string field, or null when absent/blank. */
function text(value) {
    const trimmed = typeof value === "string" ? value.trim() : "";

    return trimmed === "" ? null : trimmed;
}

/** Finite number, or null. Never coerces blank/garbage to 0. */
function finiteNumber(value) {
    const raw = text(value);

    if (raw === null) {
        return null;
    }

    const parsed = Number(raw);

    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * FAA sexagesimal coordinate string -> signed decimal degrees.
 * Accepts the two NASR encodings:
 *   formatted  "38-51-07.5000N" / "104-42-29.1000W"
 *   seconds    "139867.5000N"   (total seconds + hemisphere)
 * Returns null on anything else — no guessing.
 */
function sexagesimalToDecimal(value) {
    const raw = text(value);

    if (raw === null) {
        return null;
    }

    const hemisphere = raw.slice(-1).toUpperCase();
    const sign = hemisphere === "S" || hemisphere === "W" ? -1 : 1;

    if (!"NSEW".includes(hemisphere)) {
        return null;
    }

    const body = raw.slice(0, -1);
    const formatted = body.match(/^(\d{1,3})-([0-5]?\d)-([0-5]?\d(?:\.\d+)?)$/);

    if (formatted) {
        const degrees = Number(formatted[1]) + Number(formatted[2]) / 60 + Number(formatted[3]) / 3600;

        return Number.isFinite(degrees) ? sign * degrees : null;
    }

    const seconds = body.match(/^\d+(?:\.\d+)?$/);

    if (seconds) {
        const degrees = Number(body) / 3600;

        return Number.isFinite(degrees) ? sign * degrees : null;
    }

    return null;
}

/**
 * WGS-84 coordinate from a NASR CSV row: the pre-computed decimal column
 * when present, otherwise the DEG/MIN/SEC/HEMIS column group, otherwise
 * the formatted sexagesimal string. Null when none yields a finite value.
 */
function coordinate(row, axis /* "LAT" | "LONG" */) {
    const decimal = finiteNumber(row[`${axis}_DECIMAL`]);

    if (decimal !== null) {
        return decimal;
    }

    const deg = finiteNumber(row[`${axis}_DEG`]);
    const min = finiteNumber(row[`${axis}_MIN`]);
    const sec = finiteNumber(row[`${axis}_SEC`]);
    const hemis = text(row[`${axis}_HEMIS`]);

    if (deg !== null && min !== null && sec !== null && hemis !== null) {
        const sign = hemis.toUpperCase() === "S" || hemis.toUpperCase() === "W" ? -1 : 1;

        return sign * (deg + min / 60 + sec / 3600);
    }

    return sexagesimalToDecimal(row[axis] ?? row[`${axis}_FORMATTED`]);
}

/** East-positive signed magnetic variation from value + hemisphere columns. */
function signedVariation(magnitudeValue, hemisphereValue) {
    const magnitude = finiteNumber(magnitudeValue);

    if (magnitude === null) {
        return null;
    }

    const hemisphere = (text(hemisphereValue) || "E").toUpperCase();

    if (hemisphere === "W") {
        return -magnitude;
    }

    return hemisphere === "E" ? magnitude : null;
}

/* ------------------------------------------------------------------ */
/* Streaming plumbing                                                  */
/* ------------------------------------------------------------------ */

function findEntry(directory, patterns) {
    for (const pattern of patterns) {
        const entry = directory.files.find(
            (file) => file.type !== "Directory" && pattern.test(path.posix.basename(file.path))
        );

        if (entry) {
            return entry;
        }
    }

    return null;
}

/**
 * Async row iterator over one zip entry: raw deflate stream -> csv-parser.
 * `for await` consumption gives full backpressure — while the caller is
 * awaiting a Mongo flush, decompression is paused, so peak memory stays at
 * one batch + stream buffers regardless of file size.
 */
function csvRows(entry) {
    return entry.stream().pipe(csv({
        mapHeaders: ({ header }) => header.replace(/^\uFEFF/, "").trim()
    }));
}

/** Flushes a full batch with one bulk call and returns a fresh array. */
async function flushBatch(collection, batch, useBulkWrite) {
    if (batch.length === 0) {
        return batch;
    }

    if (useBulkWrite) {
        await collection.bulkWrite(batch, { ordered: true });
    } else {
        await collection.insertMany(batch, { ordered: false });
    }

    return []; // old array is dereferenced -> eligible for GC
}

/* ------------------------------------------------------------------ */
/* Ingestion passes (one streamed CSV each)                            */
/* ------------------------------------------------------------------ */

/**
 * Pass 1 — APT_BASE.csv: builds the SITE_NO|ARPT_ID -> airport join table
 * (ICAO id + magnetic variation) and captures the data's EFF_DATE. Small,
 * bounded, and required to join runway ends to their airport; no inserts.
 */
async function streamAirports(entry, state) {
    for await (const row of csvRows(entry)) {
        state.effectiveDateRaw = state.effectiveDateRaw || text(row.EFF_DATE);

        const icao = text(row.ICAO_ID);

        if (!icao) {
            continue; // non-ICAO landing facility: unreachable via getRunway()
        }

        state.airportsBySite.set(`${text(row.SITE_NO)}|${text(row.ARPT_ID)}`, {
            icao,
            magneticVariation: signedVariation(row.MAG_VARN, row.MAG_HEMIS)
        });
        state.stats.airports += 1;
    }
}

/**
 * Pass 2 — APT_RWY_END.csv: streams runway-end records into `nav_data` as
 * insertMany batches of BATCH_SIZE.
 */
async function streamRunwayEnds(entry, state, collection) {
    let batch = [];

    for await (const row of csvRows(entry)) {
        state.effectiveDateRaw = state.effectiveDateRaw || text(row.EFF_DATE);

        const airport = state.airportsBySite.get(`${text(row.SITE_NO)}|${text(row.ARPT_ID)}`);
        const runwayId = text(row.RWY_END_ID);
        const latitude = coordinate(row, "LAT");
        const longitude = coordinate(row, "LONG");
        const trueHeading = finiteNumber(row.TRUE_ALIGNMENT);

        if (!airport || !runwayId || latitude === null || longitude === null ||
            trueHeading === null || airport.magneticVariation === null) {
            state.stats.runwaysDropped += 1;
            continue;
        }

        batch.push({
            docType: "runway",
            airacCycle: state.cycle.ident,
            key: `${airport.icao}_${runwayId}`,
            airportId: airport.icao,
            runwayId,
            latitude,
            longitude,
            trueHeading,
            magneticVariation: airport.magneticVariation
        });
        state.stats.runways += 1;

        if (batch.length >= BATCH_SIZE) {
            batch = await flushBatch(collection, batch, false);
        }
    }

    await flushBatch(collection, batch, false);
}

/**
 * Pass 3 — NAV_BASE.csv: streams navaid records into `nav_data` as
 * bulkWrite batches of BATCH_SIZE.
 *
 * Navaid idents are NOT unique in the NAS (NDBs share idents with VORs,
 * terminal with enroute stations), and utils/navDbQuery.js disambiguates
 * duplicates spatially against a per-identifier `candidates` array. Each
 * row therefore becomes an upsert that $pushes its candidate onto the
 * identifier's document — grouping happens server-side, so this pass
 * stays streaming with no ident->records accumulation in process memory.
 */
async function streamNavaids(entry, state, collection) {
    let batch = [];

    for await (const row of csvRows(entry)) {
        state.effectiveDateRaw = state.effectiveDateRaw || text(row.EFF_DATE);

        const identifier = text(row.NAV_ID);
        const latitude = coordinate(row, "LAT");
        const longitude = coordinate(row, "LONG");
        const magneticVariation = signedVariation(row.MAG_VARN, row.MAG_VARN_HEMIS);

        if (!identifier || latitude === null || longitude === null || magneticVariation === null) {
            state.stats.navaidsDropped += 1;
            continue;
        }

        batch.push({
            updateOne: {
                filter: { docType: "navaid", airacCycle: state.cycle.ident, identifier },
                update: {
                    $setOnInsert: { docType: "navaid", airacCycle: state.cycle.ident, identifier },
                    $push: {
                        candidates: {
                            name: text(row.NAME),
                            type: text(row.NAV_TYPE)?.toUpperCase() ?? null,
                            state: text(row.STATE_CODE),
                            latitude,
                            longitude,
                            magneticVariation
                        }
                    }
                },
                upsert: true
            }
        });
        state.navaidIdents.add(identifier);
        state.stats.navaids += 1;

        if (batch.length >= BATCH_SIZE) {
            batch = await flushBatch(collection, batch, true);
        }
    }

    await flushBatch(collection, batch, true);
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Streams one NASR CSV subscriber zip into `nav_data`.
 *
 * @param {import("mongodb").Db} db - connected Db instance
 * @param {string} [zipPath] - defaults to nasr_dropzone/nasr.zip
 * @returns {Promise<{airacCycle: string, stats: object}>}
 */
async function ingestNasrZip(db, zipPath = DEFAULT_ZIP_PATH) {
    if (!db || typeof db.collection !== "function") {
        throw new Error("ingestNasrZip requires a connected MongoDB Db instance.");
    }

    if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
        throw new Error(`NASR zip not found: ${zipPath}`);
    }

    log(`Opening ${zipPath} (central directory only — entries stay compressed until streamed).`);
    const directory = await unzipper.Open.file(zipPath);

    const airportsEntry = findEntry(directory, ENTRY_PATTERNS.airports);
    const runwayEndsEntry = findEntry(directory, ENTRY_PATTERNS.runwayEnds);
    const navaidsEntry = findEntry(directory, ENTRY_PATTERNS.navaids);

    if (!airportsEntry || !runwayEndsEntry || !navaidsEntry) {
        const found = directory.files.map((file) => file.path).join(", ");
        throw new Error(
            "Zip is missing required NASR CSVs (need APT_BASE.csv, APT_RWY_END.csv, NAV_BASE.csv). " +
            `Archive contains: ${found}`
        );
    }

    const state = {
        cycle: null,
        effectiveDateRaw: null,
        airportsBySite: new Map(),
        navaidIdents: new Set(),
        stats: { airports: 0, runways: 0, runwaysDropped: 0, navaids: 0, navaidsDropped: 0 }
    };

    // Pass 1 streams before any insert so the AIRAC cycle is known (and
    // stamped on every document) before the first batch is flushed.
    log(`Pass 1/3: streaming ${airportsEntry.path} (airport join table) ...`);
    await streamAirports(airportsEntry, state);

    // AIRAC cycle: the data's own EFF_DATE (YYYY/MM/DD, UTC cycle start) is
    // authoritative; without it, tag with the currently effective cycle.
    state.cycle = state.effectiveDateRaw
        ? getCycleForDate(new Date(`${state.effectiveDateRaw.replaceAll("/", "-")}T00:00:00Z`))
        : getCycleForDate(new Date());
    log(`AIRAC cycle ${state.cycle.ident} (effective ${state.cycle.effectiveFrom} -> ${state.cycle.effectiveTo}).`);

    const collection = db.collection(NAV_DATA_COLLECTION);
    const metaId = `airac_${state.cycle.ident}`;

    if (await collection.findOne({ _id: metaId })) {
        log(`Cycle ${state.cycle.ident} is already committed in nav_data; skipping re-ingest.`);
        return { airacCycle: state.cycle.ident, stats: state.stats };
    }

    // Clear residue from a previously interrupted ingestion of this cycle,
    // then stream data docs. The metadata doc is inserted last: queries
    // resolve cycles only through metadata, so until it lands this cycle
    // is invisible and live reads keep zero-downtime semantics.
    await collection.deleteMany({ airacCycle: state.cycle.ident });

    log(`Pass 2/3: streaming ${runwayEndsEntry.path} -> runway docs (insertMany x${BATCH_SIZE}) ...`);
    await streamRunwayEnds(runwayEndsEntry, state, collection);

    log(`Pass 3/3: streaming ${navaidsEntry.path} -> navaid docs (bulkWrite x${BATCH_SIZE}) ...`);
    await streamNavaids(navaidsEntry, state, collection);

    // Verify the streamed inserts landed completely before committing.
    const runwayCount = await collection.countDocuments({ docType: "runway", airacCycle: state.cycle.ident });
    const navaidCount = await collection.countDocuments({ docType: "navaid", airacCycle: state.cycle.ident });

    if (runwayCount !== state.stats.runways || navaidCount !== state.navaidIdents.size ||
        runwayCount === 0 || navaidCount === 0) {
        await collection.deleteMany({ airacCycle: state.cycle.ident });
        throw new Error(
            `Cycle ${state.cycle.ident} verification failed: runways ${runwayCount}/${state.stats.runways}, ` +
            `navaid idents ${navaidCount}/${state.navaidIdents.size}. Partial insert rolled back.`
        );
    }

    await collection.insertOne({
        _id: metaId,
        docType: "meta",
        airacCycle: state.cycle.ident,
        ...state.cycle,
        source: "FAA NASR",
        sourceNote: `Streamed by utils/nasrUpdater.js from ${path.basename(zipPath)}` +
            (state.effectiveDateRaw ? ` (data effective ${state.effectiveDateRaw})` : "") + ".",
        generatedAt: new Date().toISOString()
    });

    await collection.createIndex({ docType: 1, airacCycle: 1, identifier: 1 });
    await collection.createIndex({ docType: 1, airacCycle: 1, key: 1 });

    log(`SUCCESS: cycle ${state.cycle.ident} committed — ${state.stats.runways} runway ends ` +
        `(${state.stats.runwaysDropped} dropped incomplete), ${state.stats.navaids} navaid records across ` +
        `${state.navaidIdents.size} idents (${state.stats.navaidsDropped} dropped incomplete).`);

    return { airacCycle: state.cycle.ident, stats: state.stats };
}

async function main() {
    require("dotenv").config();
    const { MongoClient } = require("mongodb");

    const zipPath = process.argv[2] || DEFAULT_ZIP_PATH;
    const uri = process.env.MONGODB_URI;

    if (!uri) {
        console.error("MONGODB_URI is not set. Usage: MONGODB_URI=... node utils/nasrUpdater.js [zipPath]");
        process.exit(1);
    }

    const client = new MongoClient(uri);

    try {
        await client.connect();
        await ingestNasrZip(client.db("emproview"), zipPath);
    } catch (error) {
        console.error(`[NASR ETL] FATAL: ${error.message}`);
        process.exitCode = 1;
    } finally {
        await client.close();
    }
}

if (require.main === module) {
    main();
}

module.exports = { ingestNasrZip, sexagesimalToDecimal, BATCH_SIZE };
