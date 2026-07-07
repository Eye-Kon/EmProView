/**
 * FAA NASR -> navDatabase.json ETL.
 *
 * Ingests the FAA's 28-day NASR CSV subscription (https://nfdc.faa.gov,
 * "28 Day NASR Subscription", CSV format) and produces the ground-truth
 * database object, stamped with the AIRAC cycle derived from the data's own
 * EFF_DATE. In production this feeds the MongoDB nav_data collection via
 * backend/jobs/nasrUpdater.js (utils/navDbQuery.js queries that collection);
 * the CLI below can still emit a JSON snapshot for offline inspection.
 *
 * Usage:
 *   node scripts/etl_nasr.js --dir <extracted-csv-folder> [--out data/navDatabase.json]
 *
 * Inputs read from the extracted folder:
 *   APT_BASE.csv     airport ICAO ids + magnetic variation
 *   APT_RWY_END.csv  runway end coordinates + TRUE_ALIGNMENT
 *   NAV_BASE.csv     navaid coordinates + magnetic variation
 *
 * Only complete records are emitted (coordinates + true alignment +
 * variation); incomplete rows are counted and skipped, never guessed.
 */
const fs = require("fs");
const path = require("path");
const { getCycleForDate } = require("../utils/airac");

function parseArgs(argv) {
    const args = { out: path.join(__dirname, "..", "data", "navDatabase.json") };

    for (let i = 2; i < argv.length; i += 1) {
        if (argv[i] === "--dir") {
            args.dir = argv[i + 1];
            i += 1;
        } else if (argv[i] === "--out") {
            args.out = argv[i + 1];
            i += 1;
        }
    }

    if (!args.dir) {
        console.error("Usage: node scripts/etl_nasr.js --dir <extracted-nasr-csv-folder> [--out <file>]");
        process.exit(1);
    }

    return args;
}

/** Minimal RFC-4180 CSV parser (quoted fields, embedded commas/quotes). */
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];

        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
        } else if (char === '"') {
            inQuotes = true;
        } else if (char === ",") {
            row.push(field);
            field = "";
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && text[i + 1] === "\n") {
                i += 1;
            }
            row.push(field);
            field = "";
            if (row.length > 1 || row[0] !== "") {
                rows.push(row);
            }
            row = [];
        } else {
            field += char;
        }
    }

    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return rows;
}

function loadCsvAsObjects(filePath) {
    const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
    const header = rows[0];

    return rows.slice(1).map((row) => {
        const record = {};
        header.forEach((column, index) => {
            record[column] = row[index] ?? "";
        });
        return record;
    });
}

function toFiniteNumber(value) {
    if (typeof value !== "string" || value.trim() === "") {
        return null;
    }

    const numberValue = Number(value);

    return Number.isFinite(numberValue) ? numberValue : null;
}

/** East-positive signed variation from NASR value + hemisphere columns. */
function signedVariation(magnitude, hemisphere) {
    const value = toFiniteNumber(magnitude);

    if (value === null) {
        return null;
    }

    const hemis = String(hemisphere || "").trim().toUpperCase();

    if (hemis === "W") {
        return -value;
    }

    if (hemis === "E" || hemis === "") {
        return value;
    }

    return null;
}

/**
 * Parses an extracted NASR CSV folder into the ground-truth database object.
 * Shared by the CLI below and backend/jobs/nasrUpdater.js. Throws on
 * unusable input (e.g. missing EFF_DATE) instead of exiting the process.
 */
function buildNavDatabase(dir) {
    const stats = { airports: 0, runways: 0, runwaysSkipped: 0, navaids: 0, navaidsSkipped: 0, navaidCollisions: 0 };

    console.log("Loading APT_BASE.csv ...");
    const airportRows = loadCsvAsObjects(path.join(dir, "APT_BASE.csv"));
    const airportsByKey = new Map();

    for (const row of airportRows) {
        const icao = row.ICAO_ID?.trim();

        if (!icao) {
            continue;
        }

        const magneticVariation = signedVariation(row.MAG_VARN, row.MAG_HEMIS);

        airportsByKey.set(`${row.SITE_NO}|${row.ARPT_ID}`, { icao, magneticVariation });
        stats.airports += 1;
    }

    console.log("Loading APT_RWY_END.csv ...");
    const runwayEndRows = loadCsvAsObjects(path.join(dir, "APT_RWY_END.csv"));
    const runways = {};
    let effectiveDateRaw = null;

    for (const row of runwayEndRows) {
        effectiveDateRaw = effectiveDateRaw || row.EFF_DATE;

        const airport = airportsByKey.get(`${row.SITE_NO}|${row.ARPT_ID}`);

        if (!airport) {
            continue;
        }

        const latitude = toFiniteNumber(row.LAT_DECIMAL);
        const longitude = toFiniteNumber(row.LONG_DECIMAL);
        const trueHeading = toFiniteNumber(row.TRUE_ALIGNMENT);
        const runwayEndId = row.RWY_END_ID?.trim();

        if (!runwayEndId || latitude === null || longitude === null || trueHeading === null || airport.magneticVariation === null) {
            stats.runwaysSkipped += 1;
            continue;
        }

        runways[`${airport.icao}_${runwayEndId}`] = {
            latitude,
            longitude,
            trueHeading,
            magneticVariation: airport.magneticVariation,
            ...(toFiniteNumber(row.RWY_END_ELEV) !== null ? { elevation: toFiniteNumber(row.RWY_END_ELEV) } : {})
        };
        stats.runways += 1;
    }

    console.log("Loading NAV_BASE.csv ...");
    const navaidRows = loadCsvAsObjects(path.join(dir, "NAV_BASE.csv"));

    // NAV_IDs are not globally unique: NDBs share idents with VORs, and
    // terminal stations share idents with enroute stations across the
    // country. Every candidate is preserved; the query layer disambiguates
    // spatially against the procedure's origin (FMS duplicate-ident behavior).
    const navaids = {};

    for (const row of navaidRows) {
        const identifier = row.NAV_ID?.trim();
        const navType = row.NAV_TYPE?.trim().toUpperCase();
        const latitude = toFiniteNumber(row.LAT_DECIMAL);
        const longitude = toFiniteNumber(row.LONG_DECIMAL);
        const magneticVariation = signedVariation(row.MAG_VARN, row.MAG_VARN_HEMIS);

        if (!identifier || latitude === null || longitude === null || magneticVariation === null) {
            stats.navaidsSkipped += 1;
            continue;
        }

        const candidate = {
            name: row.NAME?.trim(),
            type: navType,
            state: row.STATE_CODE?.trim() || null,
            latitude,
            longitude,
            magneticVariation,
            ...(toFiniteNumber(row.ELEV) !== null ? { elevation: toFiniteNumber(row.ELEV) } : {})
        };

        if (navaids[identifier]) {
            navaids[identifier].push(candidate);
            stats.navaidCollisions += 1;
        } else {
            navaids[identifier] = [candidate];
        }
        stats.navaids += 1;
    }

    if (!effectiveDateRaw) {
        throw new Error("Could not determine EFF_DATE from NASR data; aborting.");
    }

    // NASR EFF_DATE format: YYYY/MM/DD (UTC cycle start).
    const effectiveDate = new Date(`${effectiveDateRaw.replaceAll("/", "-")}T00:00:00Z`);
    const cycle = getCycleForDate(effectiveDate);

    const database = {
        airac: {
            ...cycle,
            source: "FAA NASR",
            sourceNote: `Generated by scripts/etl_nasr.js from NASR CSV subscription effective ${effectiveDateRaw}.`,
            generatedAt: new Date().toISOString()
        },
        navaids,
        runways
    };

    return { database, stats };
}

/**
 * Converts a parsed database object into the MongoDB document set for the
 * multi-cycle `nav_data` collection. Every document carries an `airacCycle`
 * stamp so spatial queries can resolve against the ground truth effective
 * for a specific flight date, and the metadata doc is keyed per cycle
 * (_id: "airac_<cycle>") so multiple cycles coexist.
 */
function buildNavDataDocuments(database) {
    const airacCycle = database.airac.ident;

    const metaDoc = {
        _id: `airac_${airacCycle}`,
        docType: "meta",
        airacCycle,
        ...database.airac
    };
    const navaidDocs = Object.entries(database.navaids).map(([identifier, candidates]) => ({
        docType: "navaid",
        airacCycle,
        identifier,
        candidates
    }));
    const runwayDocs = Object.entries(database.runways).map(([key, record]) => ({
        docType: "runway",
        airacCycle,
        key,
        ...record
    }));

    return { airacCycle, metaDoc, navaidDocs, runwayDocs };
}

function main() {
    const args = parseArgs(process.argv);
    const { database, stats } = buildNavDatabase(args.dir);
    const cycle = database.airac;

    fs.writeFileSync(args.out, JSON.stringify(database, null, 2));
    console.log(`AIRAC cycle ${cycle.ident} (${cycle.effectiveFrom} -> ${cycle.effectiveTo})`);
    console.log(
        `Wrote ${args.out}: ${stats.runways} runway ends across ${stats.airports} ICAO airports ` +
        `(${stats.runwaysSkipped} skipped incomplete), ${stats.navaids} navaid records ` +
        `(${stats.navaidsSkipped} skipped incomplete, ${stats.navaidCollisions} duplicate idents preserved as candidates).`
    );
}

if (require.main === module) {
    main();
}

module.exports = { buildNavDatabase, buildNavDataDocuments };
