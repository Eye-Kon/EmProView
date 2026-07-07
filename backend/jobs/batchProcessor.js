/**
 * batchProcessor: persistent asynchronous batch queue for high-volume
 * chart-text extraction (5,000+ procedures per job).
 *
 * Storage model (two collections, both TTL-cleaned 7 days after a job
 * finishes):
 *
 *   batch_jobs     one small state document per job: status (pending |
 *                  processing | completed | failed), counters, the resolved
 *                  flightDate + airacCycle, and a heartbeat timestamp.
 *                  Deliberately carries NO chart texts or results, so it
 *                  can never approach MongoDB's 16 MB document cap.
 *
 *   batch_results  one document per item, keyed { jobId, index }. Created
 *                  at ingestion holding the input chartText with status
 *                  "pending"; updated in place with the enriched result (or
 *                  the failure report) as the worker progresses.
 *
 * Temporal atomicity: the AIRAC cycle is resolved ONCE at job creation via
 * determineActiveCycle(flightDate ?? now) and stamped on the job. Every
 * item is enriched against that locked flightDate, so a 40-hour batch that
 * runs across an AIRAC rollover cannot produce a library mixing cycles.
 *
 * Crash resumption: jobs are claimed atomically with findOneAndUpdate
 * (pending, or processing with a heartbeat older than 5 minutes = orphaned
 * by a dead worker). Because each item's result lives in its own document,
 * a resumed job simply processes the items still marked pending — finished
 * work is never redone and counters are recomputed from the collection at
 * completion, so they cannot drift.
 *
 * Concurrency: BATCH_CONCURRENCY (default 1) items are extracted in
 * parallel within a job — 1 protects a CPU-bound local LLM; raise it when
 * the endpoint is a cloud tenant.
 */
const crypto = require("crypto");
const { determineActiveCycle } = require("../../utils/navDbQuery");
const { extractProcedureFromText, enrichProcedureWithSpatialTriggers } = require("../extractionService");

const JOBS_COLLECTION = "batch_jobs";
const RESULTS_COLLECTION = "batch_results";
const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const STALE_HEARTBEAT_MS = 5 * 60 * 1000;
const FINISHED_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INSERT_BATCH_SIZE = 1000;
const MAX_ITEMS_PER_JOB = 50000;

function log(level, message) {
    const prefix = `[Batch Worker] ${new Date().toISOString()}`;

    if (level === "error") {
        console.error(`${prefix} ERROR: ${message}`);
    } else if (level === "warn") {
        console.warn(`${prefix} WARN: ${message}`);
    } else {
        console.log(`${prefix} ${message}`);
    }
}

async function ensureIndexes(db) {
    await db.collection(JOBS_COLLECTION).createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection(JOBS_COLLECTION).createIndex({ status: 1, heartbeatAt: 1, createdAt: 1 });
    await db.collection(RESULTS_COLLECTION).createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection(RESULTS_COLLECTION).createIndex({ jobId: 1, index: 1 }, { unique: true });
    await db.collection(RESULTS_COLLECTION).createIndex({ jobId: 1, status: 1 });
}

/**
 * Creates a batch job from an array of chart texts and returns the 202
 * receipt. Resolves and locks the AIRAC cycle for the whole job here —
 * an uncovered flight date rejects the batch up front (AiracExpiredError)
 * rather than failing 5,000 items one by one.
 */
async function createBatchJob(db, chartTexts, flightDate) {
    if (!Array.isArray(chartTexts) || chartTexts.length === 0) {
        throw Object.assign(new Error("Batch payload must be a non-empty array of chart texts."), { statusCode: 400 });
    }

    if (chartTexts.length > MAX_ITEMS_PER_JOB) {
        throw Object.assign(
            new Error(`Batch exceeds the ${MAX_ITEMS_PER_JOB}-item limit; split it into multiple jobs.`),
            { statusCode: 400 }
        );
    }

    const resolvedFlightDate = flightDate ?? new Date();
    const airacCycle = await determineActiveCycle(resolvedFlightDate);

    const jobId = crypto.randomUUID();
    const now = new Date();
    const itemDocs = chartTexts.map((chartText, index) => ({
        jobId,
        index,
        chartText,
        status: "pending",
        createdAt: now
    }));

    for (let i = 0; i < itemDocs.length; i += INSERT_BATCH_SIZE) {
        await db.collection(RESULTS_COLLECTION).insertMany(itemDocs.slice(i, i + INSERT_BATCH_SIZE), { ordered: false });
    }

    await db.collection(JOBS_COLLECTION).insertOne({
        _id: jobId,
        status: "pending",
        totalCount: chartTexts.length,
        completedCount: 0,
        failedCount: 0,
        flightDate: resolvedFlightDate,
        airacCycle,
        createdAt: now,
        heartbeatAt: null,
        startedAt: null,
        finishedAt: null
    });

    log("info", `Job ${jobId} accepted: ${chartTexts.length} items, locked to AIRAC ${airacCycle.ident} ` +
        `(flight date ${resolvedFlightDate.toISOString()}).`);

    return { jobId, totalCount: chartTexts.length, airacCycle, flightDate: resolvedFlightDate.toISOString() };
}

/**
 * Atomically claims the oldest runnable job: pending, or processing with a
 * stale heartbeat (orphaned by a crashed worker).
 */
async function claimJob(db) {
    const staleBefore = new Date(Date.now() - STALE_HEARTBEAT_MS);

    return db.collection(JOBS_COLLECTION).findOneAndUpdate(
        {
            $or: [
                { status: "pending" },
                { status: "processing", heartbeatAt: { $lt: staleBefore } }
            ]
        },
        { $set: { status: "processing", heartbeatAt: new Date() }, $max: { startedAt: new Date() } },
        { sort: { createdAt: 1 }, returnDocument: "after" }
    );
}

async function processItem(db, job, item) {
    const results = db.collection(RESULTS_COLLECTION);
    const jobs = db.collection(JOBS_COLLECTION);

    try {
        const procedure = await extractProcedureFromText(item.chartText);
        const enriched = await enrichProcedureWithSpatialTriggers(procedure, job.flightDate);
        const failedRowCount = (enriched.procedureRows || []).filter((row) => row.integrity?.status === "failed").length;

        await results.updateOne(
            { _id: item._id },
            { $set: { status: "completed", result: enriched, failedRowCount, processedAt: new Date() }, $unset: { chartText: "" } }
        );
        await jobs.updateOne({ _id: job._id }, { $inc: { completedCount: 1 }, $set: { heartbeatAt: new Date() } });
    } catch (error) {
        log("warn", `Job ${job._id} item ${item.index} failed: ${error.name}: ${error.message}`);
        await results.updateOne(
            { _id: item._id },
            { $set: { status: "failed", error: `${error.name}: ${error.message}`, processedAt: new Date() } }
        );
        await jobs.updateOne({ _id: job._id }, { $inc: { failedCount: 1 }, $set: { heartbeatAt: new Date() } });
    }
}

async function processJob(db, job, concurrency) {
    const jobs = db.collection(JOBS_COLLECTION);
    const results = db.collection(RESULTS_COLLECTION);

    // Crash resumption: only items never finished are (re)processed.
    const pendingItems = await results.find({ jobId: job._id, status: "pending" }).sort({ index: 1 }).toArray();

    log("info", `Job ${job._id}: processing ${pendingItems.length} pending of ${job.totalCount} items ` +
        `(concurrency ${concurrency}, AIRAC ${job.airacCycle?.ident}).`);

    // Keep the claim alive during long LLM calls so another poll cannot
    // steal an actively-running job.
    const heartbeatTimer = setInterval(() => {
        jobs.updateOne({ _id: job._id }, { $set: { heartbeatAt: new Date() } }).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);

    try {
        let nextIndex = 0;
        const workers = Array.from({ length: Math.max(1, Math.min(concurrency, pendingItems.length)) }, async () => {
            while (nextIndex < pendingItems.length) {
                const item = pendingItems[nextIndex];
                nextIndex += 1;
                await processItem(db, job, item);
            }
        });

        await Promise.all(workers);

        // Authoritative counts from the collection: progressive $inc counters
        // are advisory and could drift across a crash-resume.
        const completedCount = await results.countDocuments({ jobId: job._id, status: "completed" });
        const failedCount = await results.countDocuments({ jobId: job._id, status: "failed" });
        const finalStatus = completedCount === 0 && failedCount > 0 ? "failed" : "completed";
        const expireAt = new Date(Date.now() + FINISHED_JOB_TTL_MS);

        await jobs.updateOne(
            { _id: job._id },
            { $set: { status: finalStatus, completedCount, failedCount, finishedAt: new Date(), heartbeatAt: new Date(), expireAt } }
        );
        await results.updateMany({ jobId: job._id }, { $set: { expireAt } });

        log("info", `Job ${job._id} ${finalStatus}: ${completedCount} completed, ${failedCount} failed. ` +
            `Records expire ${expireAt.toISOString()}.`);
    } finally {
        clearInterval(heartbeatTimer);
    }
}

let isDraining = false;

async function drainQueue(db, concurrency) {
    if (isDraining) {
        return;
    }

    isDraining = true;

    try {
        for (;;) {
            const job = await claimJob(db);

            if (!job) {
                break;
            }

            await processJob(db, job, concurrency);
        }
    } finally {
        isDraining = false;
    }
}

/**
 * Starts the background worker loop. Call once at startup, after
 * initNavDb(db) — enrichment resolves ground truth through the query layer.
 */
function initBatchWorker(db) {
    const concurrency = Math.max(1, Number.parseInt(process.env.BATCH_CONCURRENCY, 10) || 1);

    ensureIndexes(db).catch((error) => log("error", `Index setup failed: ${error.message}`));

    setInterval(() => {
        drainQueue(db, concurrency).catch((error) => log("error", `Queue drain failed: ${error.message}`));
    }, POLL_INTERVAL_MS);

    log("info", `Batch worker started: polling every ${POLL_INTERVAL_MS / 1000}s, concurrency ${concurrency}, ` +
        `stale-claim takeover after ${STALE_HEARTBEAT_MS / 60000} minutes.`);
}

module.exports = {
    createBatchJob,
    initBatchWorker,
    JOBS_COLLECTION,
    RESULTS_COLLECTION
};
