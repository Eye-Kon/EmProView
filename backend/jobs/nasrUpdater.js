/**
 * NASR Updater: automated 28-day FAA NASR ingestion with zero-downtime swaps.
 *
 * Every Tuesday at 08:00 UTC this job:
 *   1. Resolves the AIRAC cycle to ingest via utils/airac.js. When the next
 *      cycle becomes effective before the following weekly run, the upcoming
 *      cycle is preferred (falling back to the current one if the FAA has not
 *      published it yet) so the ground truth never expires between runs.
 *   2. Downloads the FAA 28-day NASR CSV subscription zip to the OS temp
 *      directory, retrying with exponential backoff (max 3 attempts).
 *   3. Extracts the CSVs and reuses scripts/etl_nasr.js to parse them.
 *   4. Writes the parsed records into the `nav_data_staging` collection.
 *   5. After verification, atomically renames `nav_data_staging` over the
 *      live `nav_data` collection (dropTarget: true) so active queries never
 *      observe a partial dataset.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const cron = require("node-cron");
const AdmZip = require("adm-zip");
const { getCycleForDate, isCycleCurrent, CYCLE_LENGTH_MS } = require("../../utils/airac");
const { buildNavDatabase } = require("../../scripts/etl_nasr");

const LIVE_COLLECTION = "nav_data";
const STAGING_COLLECTION = "nav_data_staging";
const CRON_SCHEDULE = "0 8 * * 2"; // Every Tuesday 08:00 UTC
const MAX_DOWNLOAD_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// The FAA CDN rejects requests without a browser-like User-Agent.
const HTTP_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; EmProView-NASR-Updater/1.0)" };

const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function log(level, message) {
    const prefix = `[NASR Updater] ${new Date().toISOString()}`;

    if (level === "error") {
        console.error(`${prefix} ERROR: ${message}`);
    } else if (level === "warn") {
        console.warn(`${prefix} WARN: ${message}`);
    } else {
        console.log(`${prefix} ${message}`);
    }
}

/**
 * FAA 28-day subscription CSV zip URL for a cycle, keyed by its UTC
 * effective date, e.g.
 * https://nfdc.faa.gov/webContent/28DaySub/extra/11_Jun_2026_CSV.zip
 */
function buildDownloadUrl(cycle) {
    const effective = new Date(cycle.effectiveFrom);
    const day = String(effective.getUTCDate()).padStart(2, "0");
    const month = MONTH_ABBREVIATIONS[effective.getUTCMonth()];
    const year = effective.getUTCFullYear();

    return `https://nfdc.faa.gov/webContent/28DaySub/extra/${day}_${month}_${year}_CSV.zip`;
}

/**
 * Cycles to attempt, in preference order.
 *
 * If the next cycle rolls over before the next weekly run, prefer it (the
 * FAA publishes preview data in advance) so the database does not expire
 * mid-week; otherwise ingest the currently effective cycle. The other cycle
 * is kept as a fallback in case the preferred download is not available.
 */
function selectCandidateCycles(now = new Date()) {
    const currentCycle = getCycleForDate(now);
    const nextCycle = getCycleForDate(new Date(Date.parse(currentCycle.effectiveFrom) + CYCLE_LENGTH_MS));
    const rollsOverBeforeNextRun = Date.parse(currentCycle.effectiveTo) - now.getTime() < WEEK_MS;

    return rollsOverBeforeNextRun ? [nextCycle, currentCycle] : [currentCycle, nextCycle];
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Streams the zip to disk, retrying with exponential backoff on transient
 * failures (timeouts, 5xx). A 404 aborts immediately: the cycle simply is
 * not published yet, and retrying will not change that.
 */
async function downloadWithRetry(url, destinationPath) {
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
        try {
            log("info", `Downloading ${url} (attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}) ...`);

            const response = await axios.get(url, {
                responseType: "stream",
                timeout: DOWNLOAD_TIMEOUT_MS,
                headers: HTTP_HEADERS
            });

            await new Promise((resolve, reject) => {
                const fileStream = fs.createWriteStream(destinationPath);
                response.data.pipe(fileStream);
                response.data.on("error", reject);
                fileStream.on("error", reject);
                fileStream.on("finish", resolve);
            });

            const { size } = fs.statSync(destinationPath);

            if (size === 0) {
                throw new Error("Downloaded file is empty.");
            }

            log("info", `Download complete: ${(size / 1024 / 1024).toFixed(1)} MB.`);
            return;
        } catch (error) {
            if (error.response?.status === 404) {
                throw Object.assign(new Error(`NASR file not published yet (404): ${url}`), { notPublished: true });
            }

            if (attempt === MAX_DOWNLOAD_ATTEMPTS) {
                throw new Error(`Download failed after ${MAX_DOWNLOAD_ATTEMPTS} attempts: ${error.message}`);
            }

            const backoffMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
            log("warn", `Attempt ${attempt} failed (${error.message}). Retrying in ${backoffMs / 1000}s ...`);
            await delay(backoffMs);
        }
    }
}

function extractZip(zipPath, extractDir) {
    log("info", `Extracting ${path.basename(zipPath)} ...`);
    new AdmZip(zipPath).extractAllTo(extractDir, true);
}

/**
 * Populates nav_data_staging from the parsed database. Documents:
 *   { _id: "airac", docType: "meta", ... }              cycle metadata
 *   { docType: "navaid", identifier, candidates: [] }   one per ident
 *   { docType: "runway", key, ...record }               one per runway end
 */
async function populateStaging(db, database) {
    const staging = db.collection(STAGING_COLLECTION);

    // Clear any residue from a previously failed run.
    await staging.drop().catch(() => {});

    await staging.insertOne({ _id: "airac", docType: "meta", ...database.airac });

    const navaidDocs = Object.entries(database.navaids).map(([identifier, candidates]) => ({
        docType: "navaid",
        identifier,
        candidates
    }));
    const runwayDocs = Object.entries(database.runways).map(([key, record]) => ({
        docType: "runway",
        key,
        ...record
    }));

    for (const docs of [navaidDocs, runwayDocs]) {
        for (let i = 0; i < docs.length; i += 5000) {
            await staging.insertMany(docs.slice(i, i + 5000), { ordered: false });
        }
    }

    await staging.createIndex({ docType: 1, identifier: 1 });
    await staging.createIndex({ docType: 1, key: 1 });

    return { navaidDocs: navaidDocs.length, runwayDocs: runwayDocs.length };
}

/** Fail-safe gate: the staging collection must be complete before the swap. */
async function verifyStaging(db, database, inserted) {
    const staging = db.collection(STAGING_COLLECTION);
    const meta = await staging.findOne({ _id: "airac" });
    const navaidCount = await staging.countDocuments({ docType: "navaid" });
    const runwayCount = await staging.countDocuments({ docType: "runway" });

    if (!meta?.ident) {
        throw new Error("Staging verification failed: AIRAC metadata document is missing.");
    }

    if (navaidCount === 0 || runwayCount === 0) {
        throw new Error(`Staging verification failed: empty dataset (navaids=${navaidCount}, runways=${runwayCount}).`);
    }

    if (navaidCount !== inserted.navaidDocs || runwayCount !== inserted.runwayDocs) {
        throw new Error(
            `Staging verification failed: count mismatch (navaids ${navaidCount}/${inserted.navaidDocs}, ` +
            `runways ${runwayCount}/${inserted.runwayDocs}).`
        );
    }

    const cycleStartsWithinAWeek = Date.parse(meta.effectiveFrom) - Date.now() < WEEK_MS;

    if (!isCycleCurrent(meta) && !cycleStartsWithinAWeek) {
        throw new Error(`Staging verification failed: AIRAC cycle ${meta.ident} is neither current nor imminent.`);
    }

    log("info", `Staging verified: AIRAC ${meta.ident}, ${navaidCount} navaid idents, ${runwayCount} runway ends.`);
}

/** Atomically promotes staging to live; active queries never see partial data. */
async function atomicSwap(db) {
    await db.renameCollection(STAGING_COLLECTION, LIVE_COLLECTION, { dropTarget: true });
    log("info", `Atomic swap complete: ${STAGING_COLLECTION} -> ${LIVE_COLLECTION}.`);
}

async function getLiveCycle(db) {
    try {
        return await db.collection(LIVE_COLLECTION).findOne({ _id: "airac" });
    } catch {
        return null;
    }
}

let isRunning = false;

async function runNasrUpdate(db, { force = false } = {}) {
    if (isRunning) {
        log("warn", "Update already in progress; skipping this trigger.");
        return;
    }

    isRunning = true;

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nasr-"));

    try {
        const candidates = selectCandidateCycles();
        const liveCycle = await getLiveCycle(db);

        if (!force && liveCycle?.ident === candidates[0].ident) {
            log("info", `Live nav_data already carries target AIRAC cycle ${liveCycle.ident}; nothing to do.`);
            return;
        }

        let database = null;

        for (const cycle of candidates) {
            const url = buildDownloadUrl(cycle);
            const zipPath = path.join(workDir, `nasr_${cycle.ident}.zip`);

            try {
                log("info", `Targeting AIRAC cycle ${cycle.ident} (effective ${cycle.effectiveFrom}).`);
                await downloadWithRetry(url, zipPath);
            } catch (error) {
                if (error.notPublished && cycle !== candidates[candidates.length - 1]) {
                    log("warn", `${error.message} Falling back to alternate cycle.`);
                    continue;
                }
                throw error;
            }

            const extractDir = path.join(workDir, `csv_${cycle.ident}`);
            extractZip(zipPath, extractDir);

            log("info", "Running NASR ETL against extracted CSVs ...");
            database = buildNavDatabase(extractDir).database;
            break;
        }

        if (!database) {
            throw new Error("No NASR dataset could be downloaded for any candidate cycle.");
        }

        const inserted = await populateStaging(db, database);
        await verifyStaging(db, database, inserted);
        await atomicSwap(db);

        log("info", `SUCCESS: nav_data now serves AIRAC cycle ${database.airac.ident} ` +
            `(effective ${database.airac.effectiveFrom} -> ${database.airac.effectiveTo}).`);
    } catch (error) {
        log("error", `HARD FAILURE: NASR update aborted. Live nav_data was NOT modified. Cause: ${error.message}`);
    } finally {
        isRunning = false;
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

/**
 * Schedules the weekly job and, if the live collection is missing or its
 * AIRAC cycle has already expired, kicks off an immediate catch-up run so a
 * freshly deployed or long-stopped server heals itself without waiting for
 * Tuesday.
 */
function initNasrUpdater(db) {
    cron.schedule(CRON_SCHEDULE, () => {
        log("info", "Scheduled weekly run starting.");
        runNasrUpdate(db);
    }, { timezone: "Etc/UTC" });

    log("info", `Scheduled NASR ingestion for every Tuesday 08:00 UTC (cron "${CRON_SCHEDULE}").`);

    getLiveCycle(db).then((liveCycle) => {
        if (!liveCycle || !isCycleCurrent(liveCycle)) {
            log("warn", liveCycle
                ? `Live AIRAC cycle ${liveCycle.ident} is expired; starting catch-up ingestion now.`
                : "Live nav_data collection is empty; starting initial ingestion now.");
            runNasrUpdate(db);
        } else {
            log("info", `Live nav_data is current (AIRAC ${liveCycle.ident}); next refresh on schedule.`);
        }
    }).catch((error) => {
        log("error", `Startup cycle check failed: ${error.message}`);
    });
}

module.exports = { initNasrUpdater, runNasrUpdate, buildDownloadUrl, selectCandidateCycles };
