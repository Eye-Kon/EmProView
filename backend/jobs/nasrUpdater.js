/**
 * NASR Updater: automated 28-day FAA NASR ingestion for the multi-cycle
 * `nav_data` collection.
 *
 * The collection holds every AIRAC cycle's documents side by side, each
 * stamped with an `airacCycle` field (metadata docs are keyed
 * "airac_<cycle>"). Spatial queries resolve against the cycle covering a
 * specific flight date, so ingestion never touches documents of other
 * cycles — new cycles are appended, expired ones are garbage-collected.
 *
 * Every Tuesday at 08:00 UTC (and once at startup) this job:
 *   1. Targets the currently effective AIRAC cycle and the upcoming one
 *      (via utils/airac.js), skipping any cycle already ingested.
 *   2. Downloads each missing cycle's FAA 28-day NASR CSV subscription zip
 *      to the OS temp directory, retrying with exponential backoff (max 3
 *      attempts). An unpublished upcoming cycle (404) is not a failure —
 *      it is retried on the next run.
 *   3. Streams the zip straight into `nav_data` via utils/nasrUpdater.js
 *      (ingestNasrZip): no disk extraction, no full-file buffering —
 *      entries are decompressed and parsed row-by-row, inserted in bulk
 *      batches. The cycle's metadata doc is inserted LAST, only after the
 *      data documents are verified — queries resolve cycles through their
 *      metadata, so a half-inserted cycle is invisible and live queries
 *      keep zero-downtime semantics.
 *   4. Garbage-collects: any cycle whose effectiveTo is more than 48 hours
 *      in the past is wiped with deleteMany, along with legacy documents
 *      from the old single-cycle schema (no airacCycle stamp).
 *
 * Air-gapped sideload mode: when NASR_LOCAL_ZIP_PATH is set, the network is
 * never touched. Each run instead looks for a NASR CSV zip at that path
 * (dropped into a mounted volume by the operator), ingests it — the data's
 * own EFF_DATE determines the cycle — and renames it with a .processed
 * suffix so it is not re-ingested on subsequent runs.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const cron = require("node-cron");
const { getCycleForDate, CYCLE_LENGTH_MS } = require("../../utils/airac");
const { ingestNasrZip } = require("../../utils/nasrUpdater");

const LIVE_COLLECTION = "nav_data";
const CRON_SCHEDULE = "0 8 * * 2"; // Every Tuesday 08:00 UTC
const MAX_DOWNLOAD_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 120000;
// Grace period after effectiveTo before a cycle is purged: keeps just-expired
// ground truth available for in-flight work and clock-skew safety.
const GC_GRACE_MS = 48 * 60 * 60 * 1000;

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

/** The two cycles the database must hold: currently effective + upcoming. */
function targetCycles(now = new Date()) {
    const current = getCycleForDate(now);
    const upcoming = getCycleForDate(new Date(Date.parse(current.effectiveFrom) + CYCLE_LENGTH_MS));

    return { current, upcoming };
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

async function isCycleIngested(db, cycle) {
    const meta = await db.collection(LIVE_COLLECTION).findOne({ _id: `airac_${cycle.ident}` });

    return Boolean(meta);
}

/**
 * Commits one NASR zip into nav_data by streaming it through
 * utils/nasrUpdater.js (ingestNasrZip). Shared by the network and sideload
 * ingestion paths. Nothing is extracted to disk and no file is buffered in
 * memory; documents flow to MongoDB in bulk batches.
 *
 * All commit-safety semantics live inside ingestNasrZip: skip when the
 * cycle's metadata doc already exists, wipe residue from an interrupted
 * attempt, verify counts, and insert the metadata doc LAST as the commit
 * point. determineActiveCycle only resolves cycles through metadata docs,
 * so a crash mid-stream leaves an invisible partial cycle, never a
 * queryable half-dataset.
 *
 * @returns {string} the committed cycle ident (from the data's own EFF_DATE)
 */
async function commitZip(db, zipPath) {
    log("info", `Streaming ${path.basename(zipPath)} into ${LIVE_COLLECTION} ...`);

    const { airacCycle } = await ingestNasrZip(db, zipPath);

    return airacCycle;
}

/** Downloads and commits one AIRAC cycle from the FAA (online mode). */
async function ingestCycle(db, cycle, workDir) {
    const url = buildDownloadUrl(cycle);
    const zipPath = path.join(workDir, `nasr_${cycle.ident}.zip`);

    log("info", `Ingesting AIRAC cycle ${cycle.ident} (effective ${cycle.effectiveFrom}).`);
    await downloadWithRetry(url, zipPath);

    const committedCycle = await commitZip(db, zipPath);

    if (committedCycle !== cycle.ident) {
        // The data's own EFF_DATE is authoritative over the URL we targeted.
        log("warn", `Requested cycle ${cycle.ident} but NASR data declared ${committedCycle}.`);
    }
}

/**
 * Air-gapped sideload mode: ingests a NASR zip dropped into a mounted
 * volume by the operator (NASR_LOCAL_ZIP_PATH). Never touches the network.
 * The zip's own EFF_DATE determines the cycle. After processing, the file
 * is renamed with a .processed suffix so the next cron pass does not
 * re-ingest it — the drop path stays free for the next cycle's zip.
 */
async function ingestFromLocalZip(db, zipPath) {
    const committedCycle = await commitZip(db, zipPath);

    markZipProcessed(zipPath);

    return committedCycle;
}

function markZipProcessed(zipPath) {
    let processedPath = `${zipPath}.processed`;

    if (fs.existsSync(processedPath)) {
        processedPath = `${zipPath}.processed-${Date.now()}`;
    }

    fs.renameSync(zipPath, processedPath);
    log("info", `Sideload file marked as processed: ${path.basename(processedPath)}.`);
}

/**
 * Purges cycles whose effectiveTo is more than GC_GRACE_MS in the past,
 * plus any legacy documents from the pre-multi-cycle schema.
 */
async function garbageCollectExpiredCycles(db, now = Date.now()) {
    const live = db.collection(LIVE_COLLECTION);

    const legacy = await live.deleteMany({ airacCycle: { $exists: false } });

    if (legacy.deletedCount > 0) {
        log("info", `GC: removed ${legacy.deletedCount} legacy single-cycle document(s).`);
    }

    const metas = await live.find({ docType: "meta" }).toArray();

    for (const meta of metas) {
        const expiredForMs = now - Date.parse(meta.effectiveTo);

        if (Number.isFinite(expiredForMs) && expiredForMs > GC_GRACE_MS) {
            const removed = await live.deleteMany({ airacCycle: meta.airacCycle });
            log("info", `GC: purged expired AIRAC cycle ${meta.airacCycle} ` +
                `(ended ${meta.effectiveTo}, ${removed.deletedCount} documents).`);
        }
    }
}

let isRunning = false;

/**
 * Idempotent update pass: ingests whichever target cycles are missing, then
 * garbage-collects expired ones. Safe to run at any time.
 */
async function runNasrUpdate(db) {
    if (isRunning) {
        log("warn", "Update already in progress; skipping this trigger.");
        return;
    }

    isRunning = true;

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nasr-"));
    let hardFailure = false;

    try {
        const localZipPath = process.env.NASR_LOCAL_ZIP_PATH;

        if (localZipPath) {
            // Air-gapped deployment: the network is never touched, even when
            // no drop file is present — freshness is the operator's duty.
            if (fs.existsSync(localZipPath) && fs.statSync(localZipPath).isFile() && localZipPath.toLowerCase().endsWith(".zip")) {
                try {
                    const committedCycle = await ingestFromLocalZip(db, localZipPath);
                    log("info", `Sideload ingestion complete: AIRAC cycle ${committedCycle} from ${path.basename(localZipPath)}.`);
                } catch (error) {
                    hardFailure = true;
                    log("error", `HARD FAILURE: sideload ingestion of ${localZipPath} aborted. ` +
                        `Existing cycles in nav_data are untouched. Cause: ${error.message}`);
                }
            } else {
                log("info", `Sideload mode (NASR_LOCAL_ZIP_PATH set): no .zip file at ${localZipPath}; nothing to ingest this run.`);
            }
        } else {
            const { current, upcoming } = targetCycles();

            for (const [label, cycle] of [["current", current], ["upcoming", upcoming]]) {
                if (await isCycleIngested(db, cycle)) {
                    log("info", `AIRAC cycle ${cycle.ident} (${label}) already ingested; skipping.`);
                    continue;
                }

                try {
                    await ingestCycle(db, cycle, workDir);
                } catch (error) {
                    if (error.notPublished && label === "upcoming") {
                        log("info", `Upcoming cycle ${cycle.ident} not published by the FAA yet; will retry on the next run.`);
                    } else {
                        hardFailure = true;
                        log("error", `HARD FAILURE: ingestion of ${label} cycle ${cycle.ident} aborted. ` +
                            `Existing cycles in nav_data are untouched. Cause: ${error.message}`);
                    }
                }
            }
        }

        await garbageCollectExpiredCycles(db);

        const metas = await db.collection(LIVE_COLLECTION).find({ docType: "meta" }).toArray();
        const loaded = metas.map((meta) => meta.airacCycle).sort().join(", ") || "none";

        if (!hardFailure) {
            log("info", `SUCCESS: update pass complete. Cycles in nav_data: ${loaded}.`);
        } else {
            log("warn", `Update pass finished with failures. Cycles in nav_data: ${loaded}.`);
        }
    } catch (error) {
        log("error", `HARD FAILURE: NASR update pass aborted. Cause: ${error.message}`);
    } finally {
        isRunning = false;
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

/**
 * Schedules the weekly job and runs one catch-up pass immediately: the pass
 * is idempotent (missing cycles are ingested, present ones skipped), so a
 * freshly deployed or long-stopped server heals itself without waiting for
 * Tuesday.
 */
function initNasrUpdater(db) {
    cron.schedule(CRON_SCHEDULE, () => {
        log("info", "Scheduled weekly run starting.");
        runNasrUpdate(db);
    }, { timezone: "Etc/UTC" });

    log("info", `Scheduled NASR ingestion for every Tuesday 08:00 UTC (cron "${CRON_SCHEDULE}").`);
    log("info", "Running startup catch-up pass.");
    runNasrUpdate(db);
}

module.exports = { initNasrUpdater, runNasrUpdate, buildDownloadUrl, targetCycles, garbageCollectExpiredCycles };
