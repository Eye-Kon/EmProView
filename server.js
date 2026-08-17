require("dotenv").config();

// Production hard gate: the API must never come up guarded by a missing or
// hardcoded credential. Checked before any module wiring so the failure is
// the first and only line an operator sees.
if (!process.env.ADMIN_API_KEY) {
    console.error("CRITICAL FATAL: ADMIN_API_KEY is not set. Refusing to start with unauthenticated admin routes.");
    process.exit(1);
}

const cors = require("cors");
const express = require("express");
const fs = require("fs");
const { MongoClient } = require("mongodb");
const multer = require("multer");
const path = require("path");

/** Sync trace for /api/analyze — survives container death via ./logs mount. */
function analyzeTrace(stage, details = {}) {
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        stage,
        ...details
    });
    console.log(`[analyze] ${line}`);
    const tracePath = process.env.ANALYZE_TRACE_PATH;
    if (!tracePath) {
        return;
    }
    try {
        fs.mkdirSync(path.dirname(tracePath), { recursive: true });
        fs.appendFileSync(tracePath, `${line}\n`, "utf8");
    } catch (error) {
        console.error(`[analyze] failed to write trace file: ${error.message}`);
    }
}
const { AiracExpiredError, DataIntegrityError } = require("./backend/geo_engine");
const { solveRunwayEscapePath } = require("./backend/geo/MultiLegSolver");
const { parseRunwayMatrix } = require("./backend/extraction/parseRunwayMatrix");
const { buildProvenanceGrid } = require("./backend/extraction/tier2Classifier");
const { resolvePhysicalGroundTruth } = require("./utils/groundTruthService");
const { initNasrUpdater } = require("./backend/jobs/nasrUpdater");
const { createBatchJob, initBatchWorker, JOBS_COLLECTION, RESULTS_COLLECTION } = require("./backend/jobs/batchProcessor");
const {
    openai,
    LLM_MODEL_NAME,
    extractProcedureFromText,
    parseFlightDate,
    getProcedureAirportCode,
    enrichProcedureWithSpatialTriggers
} = require("./backend/extractionService");
const { initNavDb, ensureNavDataIndexes, determineActiveCycle, PUBLIC_OPERATOR_ID } = require("./utils/navDbQuery");
const { generateAixmRoute, UnserializableRouteError } = require("./utils/aixmExporter");

const app = express();
const PORT = process.env.PORT || 3000;

// OCR requires a vision-capable model; air-gapped deployments with a
// text-only local LLM must disable it explicitly (default: disabled).
const OCR_ENABLED = process.env.ENABLE_OCR === "true";

// Deterministic extraction settings for the native Ollama caller: zero
// temperature removes sampling randomness, and the fixed 4096-token context
// window guarantees the full prompt + procedure text is never silently
// truncated. Bounded retries absorb the residual failure mode of a small
// local model emitting malformed or schema-violating JSON.
const LLM_EXTRACTION_OPTIONS = { num_ctx: 4096, temperature: 0.0 };
const LLM_EXTRACTION_MAX_ATTEMPTS = 3;

// Dual-pass vision settings (Stage 1 of /api/analyze): the uploaded chart
// image is transcribed by a local vision-capable Ollama model, and only the
// resulting raw text enters the deterministic JSON extraction loop above.
// qwen2.5vl, not llama3.2-vision: mllama cannot load on current Ollama.
// The prompt itself is built per-request (it names the target runway).
const VISION_MODEL_NAME = process.env.LLM_VISION_MODEL_NAME || "qwen2.5vl:7b";
const VISION_OCR_OPTIONS = { temperature: 0.0 };

// VULNERABILITY #3 PATCH: The Memory Bomb
// Enforce strict 5MB limit and reject non-image MIME types
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max file size
    fileFilter: (req, file, cb) => {
        if (resolveSupportedImageMimeType(file)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG, and WEBP are allowed.'));
        }
    }
});

// Batch ingestion accepts a JSON file upload: a 5,000-chart array is several
// MB, far past express.json()'s 100 KB default body limit.
const batchUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max batch file
    fileFilter: (req, file, cb) => {
        const isJson = (file.mimetype || "").includes("json") || path.extname(file.originalname || "").toLowerCase() === ".json";
        cb(isJson ? null : new Error("Invalid file type. Batch upload must be a .json file."), isJson);
    }
});

const client = new MongoClient(process.env.MONGODB_URI);
let db;

async function connectDB() {
    // Failure domain 1: the database connection itself.
    try {
        await client.connect();
        db = client.db("emproview");
        console.log("Connected to MongoDB");
    } catch (error) {
        console.error("CRITICAL FATAL: Failed to connect to MongoDB", error);
        process.exit(1); // Force server to crash if DB isn't available, preventing ghost state
    }

    // Failure domain 2: downstream service initialization. Each step is
    // labeled so a startup crash names the component that actually threw,
    // instead of masquerading as a connection failure.
    const initSteps = [
        // Point the geodetic ground-truth layer at live nav_data
        ["initNavDb (geodetic ground-truth layer)", () => initNavDb(db)],
        // Multi-tenant compound index ({operator_id, identifier, airportId})
        // must exist before operator-scoped queries serve traffic.
        ["ensureNavDataIndexes (nav_data multi-tenant index)", () => ensureNavDataIndexes()],
        // Demo seeding is a development convenience only: production
        // containers must start with an empty procedures collection.
        ["seedDatabase (demo data seeder)", async () => {
            if (process.env.SEED_DEMO_DATA === "true") {
                await seedDatabase();
            }
        }],
        // Weekly NASR ingestion + startup AIRAC catch-up
        ["initNasrUpdater (NASR ingestion scheduler)", () => initNasrUpdater(db)],
        // Persistent async batch queue (resumes orphaned jobs)
        ["initBatchWorker (batch extraction queue)", () => initBatchWorker(db)]
    ];

    for (const [componentName, step] of initSteps) {
        try {
            await step();
        } catch (error) {
            console.error(`CRITICAL FATAL: Startup initialization failed in ${componentName}`, error);
            process.exit(1); // A partially initialized server must not serve traffic
        }
    }
}

connectDB();

app.use(cors({
    origin: "http://localhost:5173",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key", "Authorization"]
}));

// /api/analyze carries a base64 chart image inline (~6.7 MB for a 5 MB
// image); express's 100 KB default body cap would reject every scan.
app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

function requireAuth(req, res, next) {
    const apiKey = req.get("x-api-key");

    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
        return res.status(403).json({ error: "Forbidden" });
    }

    return next();
}

app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        service: "EmProView Phase 1 API",
        database: db ? "connected" : "disconnected"
    });
});

app.get("/api/procedures", async (req, res) => {
    try {
        const savedProcedures = await db.collection("procedures").find({}).toArray();
        return res.json({
            count: savedProcedures.length,
            procedures: savedProcedures
        });
    } catch (error) {
        console.error("Failed to load procedures:", error);
        return res.status(500).json({ error: "Failed to load procedure data." });
    }
});

app.post("/api/verify", requireAuth, async (req, res) => {
    const incomingProcedure = req.body;

    if (!incomingProcedure || !Array.isArray(incomingProcedure.procedureRows)) {
        return res.status(400).json({ error: "Invalid payload: procedureRows array is required." });
    }

    let verifyFlightDate;

    try {
        verifyFlightDate = parseFlightDate(incomingProcedure.flightDate);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }

    try {
        const incomingAirportCode = getProcedureAirportCode(incomingProcedure);

        if (incomingAirportCode === "UNKNOWN") {
            return res.status(400).json({ error: "Invalid payload: airportCode is required." });
        }

        for (const incomingRow of incomingProcedure.procedureRows) {
            const incomingRunways = Array.isArray(incomingRow.runways) ? incomingRow.runways : [];

            if (incomingRunways.length === 0) {
                return res.status(400).json({ error: "Invalid payload: each procedure row must include at least one runway." });
            }

            const collision = await db.collection("procedures").findOne({
                ...getAirportQuery(incomingAirportCode),
                "procedureRows.runways": { $in: incomingRunways }
            });

            if (collision) {
                return res.status(409).json({
                    error: "Conflict: Procedure for this Airport/Runway already exists. Manual archiving required."
                });
            }
        }

        const enrichedProcedure = await enrichProcedureWithSpatialTriggers(incomingProcedure, verifyFlightDate);

        // Publication gate: extraction previews may carry partial results, but a
        // published procedure must have every row's geometry fully resolved.
        const failedRows = enrichedProcedure.procedureRows.filter((row) => row.integrity?.status === "failed");

        if (failedRows.length > 0) {
            return res.status(422).json({
                error: "Cannot publish: one or more rows failed geometry enrichment.",
                failures: failedRows.map((row) => ({
                    rowId: row.rowId,
                    runways: row.runways,
                    errors: row.integrity.errors
                }))
            });
        }

        await db.collection("procedures").insertOne(enrichedProcedure);

        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error("Procedure verification failed:", error);
        return res.status(500).json({ error: "Failed to verify and save procedure." });
    }
});

app.delete("/api/procedures/:airportCode/:runway", requireAuth, async (req, res) => {
    const { airportCode, runway } = req.params;

    try {
        const procedure = await db.collection("procedures").findOne({
            ...getAirportQuery(airportCode),
            "procedureRows.runways": runway
        });

        if (!procedure) {
            return res.status(200).json({ ok: true });
        }

        const matchingRow = procedure.procedureRows.find((row) => Array.isArray(row.runways) && row.runways.includes(runway));
        
        // Defensive check in case matchingRow is undefined
        if (!matchingRow) {
            return res.status(404).json({ error: "Runway not found in procedure rows." });
        }

        if (matchingRow.runways.length > 1) {
            await db.collection("procedures").updateOne(
                { _id: procedure._id, "procedureRows.runways": runway },
                { $pull: { "procedureRows.$.runways": runway } }
            );
        } else {
            await db.collection("procedures").deleteOne({ _id: procedure._id });
        }

        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error("Failed to delete procedure runway:", error);
        return res.status(500).json({ error: "Failed to delete procedure runway." });
    }
});

app.post("/api/extract", requireAuth, async (req, res) => {
    const rawText = req.body.text ?? req.body.chartText;

    if (typeof rawText !== "string" || rawText.trim() === "") {
        return res.status(400).json({ error: "Missing required field: text" });
    }

    let flightDate;

    try {
        flightDate = parseFlightDate(req.body.flightDate);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }

    try {
        const extractedProcedure = await extractProcedureFromText(rawText);
        const enrichedProcedure = await enrichProcedureWithSpatialTriggers(extractedProcedure, flightDate);

        // SWIM presentation layer: ?format=aixm serializes the verified route
        // to AIXM 5.1 XML instead of the standard JSON preview.
        if (req.query.format === "aixm") {
            const resolvedFlightDate = flightDate ?? new Date();
            const airacCycle = await determineActiveCycle(resolvedFlightDate);
            const aixmXml = generateAixmRoute(enrichedProcedure, airacCycle, resolvedFlightDate);

            return res.type("application/xml").send(aixmXml);
        }

        return res.json(enrichedProcedure);
    } catch (error) {
        // AIXM failsafe: unverified routes and uncovered flight dates are
        // client errors (the route cannot be serialized), not server faults.
        if (error instanceof UnserializableRouteError || error instanceof AiracExpiredError) {
            return res.status(422).json({ error: error.message });
        }

        console.error("OpenAI extraction failed:", error);
        return res.status(500).json({ error: "Failed to extract procedure data" });
    }
});

/**
 * Batch ingestion: accepts a JSON file upload (field "file") containing
 * either an array of chart texts or { flightDate, items: [...] }, where each
 * item is a string or { text } / { chartText }. Small payloads may instead
 * be sent inline as the JSON body (subject to the 100 KB body limit).
 * Responds immediately with 202 + jobId; the background worker does the rest.
 */
app.post("/api/extract/batch", requireAuth, (req, res, next) => {
    batchUpload.single("file")(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ error: `Upload error: ${err.message}` });
        } else if (err) {
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        let payload;

        if (req.file) {
            try {
                payload = JSON.parse(req.file.buffer.toString("utf8"));
            } catch {
                return res.status(400).json({ error: "Uploaded batch file is not valid JSON." });
            }
        } else {
            payload = req.body;
        }

        const rawItems = Array.isArray(payload) ? payload : payload?.items;

        if (!Array.isArray(rawItems) || rawItems.length === 0) {
            return res.status(400).json({
                error: "Batch payload must be a JSON array of chart texts, or { items: [...] }."
            });
        }

        const chartTexts = rawItems.map((item) => (typeof item === "string" ? item : item?.text ?? item?.chartText));

        if (chartTexts.some((text) => typeof text !== "string" || text.trim() === "")) {
            return res.status(400).json({ error: "Every batch item must carry non-empty chart text." });
        }

        const flightDate = parseFlightDate(
            (Array.isArray(payload) ? undefined : payload?.flightDate) ?? req.body?.flightDate ?? req.query.flightDate
        );

        const receipt = await createBatchJob(db, chartTexts, flightDate);

        return res.status(202).json(receipt);
    } catch (error) {
        if (error instanceof AiracExpiredError) {
            return res.status(422).json({ error: error.message });
        }

        if (error.statusCode === 400 || error.message?.startsWith("Invalid flightDate")) {
            return res.status(400).json({ error: error.message });
        }

        console.error("Batch job creation failed:", error);
        return res.status(500).json({ error: "Failed to create batch job." });
    }
});

/**
 * Batch retrieval: job status + counters while running; paginated results
 * (?offset, ?limit <= 1000) once finished. ?format=aixm serializes each
 * verified result through the AIXM 5.1 exporter using the job's locked
 * AIRAC cycle; items with failed rows are reported as unserializable.
 */
app.get("/api/extract/batch/:jobId", requireAuth, async (req, res) => {
    try {
        const job = await db.collection(JOBS_COLLECTION).findOne({ _id: req.params.jobId });

        if (!job) {
            return res.status(404).json({ error: "Batch job not found (unknown jobId, or expired after 7 days)." });
        }

        const body = {
            jobId: job._id,
            status: job.status,
            totalCount: job.totalCount,
            completedCount: job.completedCount,
            failedCount: job.failedCount,
            progress: `${job.completedCount + job.failedCount} / ${job.totalCount}`,
            airacCycle: job.airacCycle,
            flightDate: job.flightDate,
            createdAt: job.createdAt,
            finishedAt: job.finishedAt
        };

        if (job.status !== "completed" && job.status !== "failed") {
            return res.json(body);
        }

        const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
        const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
        const items = await db.collection(RESULTS_COLLECTION)
            .find({ jobId: job._id })
            .sort({ index: 1 })
            .skip(offset)
            .limit(limit)
            .toArray();

        body.resultsOffset = offset;
        body.resultsReturned = items.length;

        if (req.query.format === "aixm") {
            body.results = items.map((item) => {
                if (item.status !== "completed") {
                    return { index: item.index, status: "failed", error: item.error };
                }

                try {
                    return {
                        index: item.index,
                        status: "completed",
                        aixm: generateAixmRoute(item.result, job.airacCycle, job.flightDate)
                    };
                } catch (error) {
                    if (!(error instanceof UnserializableRouteError)) {
                        throw error;
                    }

                    return { index: item.index, status: "unserializable", error: error.message };
                }
            });
        } else {
            body.results = items.map((item) => ({
                index: item.index,
                status: item.status,
                ...(item.failedRowCount !== undefined ? { failedRowCount: item.failedRowCount } : {}),
                ...(item.result !== undefined ? { result: item.result } : {}),
                ...(item.error !== undefined ? { error: item.error } : {})
            }));
        }

        return res.json(body);
    } catch (error) {
        console.error("Batch job retrieval failed:", error);
        return res.status(500).json({ error: "Failed to retrieve batch job." });
    }
});

// Auth guard for /api/analyze. Unlike requireAuth (403), this route's
// contract specifies 401 Unauthorized for a missing or invalid key.
function requireAnalyzeAuth(req, res, next) {
    const apiKey = req.get("x-api-key");

    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    return next();
}

// Bridges the vision, extraction, ground-truth, and spatial calculation layers:
//   Stage 1  Vision OCR of the uploaded chart image (local Ollama container,
//            native /api/generate via the Docker service name http://llm:11434,
//            vision-capable model) — emits the raw procedure text.
//   Stage 2  LLM extraction of relational logic from that text (same Ollama
//            container, text model, bounded 3-attempt retry loop).
//   Stage 3  Validated physical ground truth (groundTruthService) — AIRAC
//            currency is enforced before any spatial query runs.
//   Stage 4  Deterministic WGS-84 solving (GeoMath + PathGeometry).
// No stage degrades gracefully: expired, missing, or non-finite physical
// data rejects the computation with a 422 and the exact failure message.
app.post("/api/analyze", requireAnalyzeAuth, async (req, res) => {
    // Phase 4: runwayId is no longer part of the request contract — the
    // pipeline extracts the ENTIRE engine-failure-procedure matrix (every
    // runway, every leg) from the chart in one pass.
    const {
        image_base64: rawImageBase64,
        extraction_target: extractionTarget,
        airportId,
        navaidId,
        operator_id: rawOperatorId
    } = req.body || {};

    const missing = [
        ["image_base64", rawImageBase64],
        ["extraction_target", extractionTarget],
        ["airportId", airportId],
        ["navaidId", navaidId]
    ].filter(([, value]) => typeof value !== "string" || value.trim() === "").map(([name]) => name);

    if (missing.length > 0) {
        return res.status(400).json({
            error: `Missing required fields: ${missing.join(", ")}. ` +
                `image_base64, extraction_target, airportId, and navaidId must all be provided.`
        });
    }

    // Logical multi-tenancy: an optional operator_id (e.g. "AAL") scopes
    // trigger-navaid resolution to that operator's tailored dataset, with a
    // public-FAA fallback. Omitted/null defaults to the public ARINC 424
    // baseline ("FAA"); a present-but-invalid value is a 400, never a guess.
    if (rawOperatorId !== undefined && rawOperatorId !== null &&
        (typeof rawOperatorId !== "string" || rawOperatorId.trim() === "")) {
        return res.status(400).json({
            error: `Invalid field: operator_id must be a non-empty string (e.g. "AAL") when provided. ` +
                `Omit it to query the public ${PUBLIC_OPERATOR_ID} dataset.`
        });
    }

    const operatorId = (rawOperatorId ?? PUBLIC_OPERATOR_ID).trim().toUpperCase();

    // Browsers hand FileReader results back as data URLs; Ollama's native
    // /api/generate expects the bare base64 payload.
    const imageBase64 = rawImageBase64.replace(/^data:image\/[\w.+-]+;base64,/i, "").trim();

    analyzeTrace("request_received", {
        airportId,
        navaidId,
        operatorId,
        extractionTarget,
        imageBase64Chars: imageBase64.length
    });

    // Stage 1: vision OCR. One shot, no retry — a transcription failure is
    // either an infrastructure fault (500) or an unreadable chart (422
    // below); re-running the same image through the same weights at
    // temperature 0 cannot produce a different outcome.
    //
    // Full-table transcription (Phase 4.2): back to Markdown. The Tier-1
    // HTML experiment proved the 7B q4 vision model transcribes cell TEXT
    // faithfully but hallucinates STRUCTURE when asked to author rowspans
    // (it merged headers and flattened the real data merges). Markdown is
    // the reliable content channel; empty cells are resolved afterward by
    // the Tier-2 targeted classifier (one constrained visual question per
    // ambiguous cell), never inferred from the text.
    const visionPrompt = `You are a precision aeronautical OCR system. ` +
        `Locate the 'ENGINE FAILURE PROCEDURES' table. ` +
        `Transcribe the ENTIRE table exactly as printed into a clean Markdown table. ` +
        `If a cell is blank or visually merged with another, leave it completely empty (e.g., | |). ` +
        `Do not use HTML.`;

    let procedureText;

    try {
        analyzeTrace("vision_request_start", { model: VISION_MODEL_NAME });
        const visionResponse = await fetch("http://llm:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: VISION_MODEL_NAME,
                prompt: visionPrompt,
                images: [imageBase64],
                stream: false,
                options: VISION_OCR_OPTIONS
            }),
            // Vision inference is markedly slower than text-only extraction;
            // allow more headroom before declaring the container dead.
            signal: AbortSignal.timeout(300_000)
        });

        if (!visionResponse.ok) {
            throw new Error(`Ollama returned HTTP ${visionResponse.status} ${visionResponse.statusText}`);
        }

        procedureText = ((await visionResponse.json()).response || "").trim();

        // Fence stripping: the vision model wraps transcriptions in code
        // fences (```html ... ```) despite the prompt. Deterministic removal
        // of one leading and one trailing fence line only — table content is
        // never touched, and an unfenced transcription passes through
        // unchanged. parse5 also tolerates stray prose around the <table>.
        const defenced = procedureText
            .replace(/^```[\w-]*[ \t]*\r?\n?/, "")
            .replace(/\r?\n?```[ \t]*$/, "")
            .trim();

        if (defenced !== procedureText) {
            analyzeTrace("vision_fences_stripped", { rawChars: procedureText.length, strippedChars: defenced.length });
            procedureText = defenced;
        }

        // Full transcription goes into the trace: extraction failures are
        // undiagnosable without seeing exactly what the vision pass produced.
        analyzeTrace("vision_response_ok", { chars: procedureText.length, transcription: procedureText });
    } catch (error) {
        analyzeTrace("vision_failed", { name: error.name, message: error.message });
        console.error(`Vision OCR request failed (${error.name}): ${error.message}`);
        return res.status(500).json({ error: "Vision OCR failed. The inference container did not return a transcription." });
    }

    if (procedureText === "") {
        analyzeTrace("vision_empty_transcription", {});
        return res.status(422).json({
            error: "Vision OCR returned no procedure text. The uploaded chart image does not contain a readable Engine Failure Procedure.",
            transcription: ""
        });
    }

    try {
        // Tier 2 structural resolution: the Markdown transcription is parsed
        // deterministically into a grid, and every empty AT/TURN cell on a
        // runway row triggers ONE targeted vision classification of that
        // physical cell (MERGED / BLANK / TEXT). MERGED inherits the
        // resolved cell above with ROWSPAN_INHERITED provenance; BLANK stays
        // charted-empty; TEXT means the transcription dropped printed data
        // and the run fails. Structure comes from the image, never from
        // text-domain inference; every anomaly is a DataIntegrityError ->
        // 422 handled by the catch below.
        const { grid, classifierResults } = await buildProvenanceGrid(procedureText, {
            imageBase64,
            visionModelName: VISION_MODEL_NAME,
            trace: analyzeTrace
        });
        analyzeTrace("grid_built", {
            rows: grid.length,
            columns: grid[0]?.length ?? 0,
            classifierCalls: classifierResults.length,
            classifierResults,
            inheritedCells: grid.flat().filter((cell) => cell.provenance === "ROWSPAN_INHERITED").length
        });

        // Chart-shorthand normalization: Jeppesen EFP tables write DME
        // triggers as "D<distance>" next to the station ident (e.g. "AT
        // D11.6 TCH"). The extraction model only reliably recognizes the
        // long form ("11.6 DME TCH") — prompt-rule variants proved brittle
        // at q4, so the shorthand is rewritten mechanically on every cell of
        // the expanded grid before any text reaches the LLM. Deterministic,
        // logged, and the numeric value is never altered. Trailing \b leaves
        // radial-distance fix names (e.g. "D251K") untouched.
        let shorthandRewritten = false;
        const normalizedGrid = grid.map((row) => row.map((cell) => {
            const normalizedText = cell.text.replace(/\bD(\d+(?:\.\d+)?)\b/g, "$1 DME");

            if (normalizedText !== cell.text) {
                shorthandRewritten = true;
            }

            return { text: normalizedText, provenance: cell.provenance };
        }));

        if (shorthandRewritten) {
            analyzeTrace("shorthand_normalized", { grid: normalizedGrid });
        }

        const gridJson = JSON.stringify(normalizedGrid);

        // Phase 4.2 semantic parser: merged cells are already resolved by
        // the Tier-2 classifier, so the LLM never deduces table structure.
        // Its only jobs are unrolling grouped identifiers (16L/R -> 16L,
        // 16R) and mapping cell text onto the leg schema — carrying each
        // source cell's provenance tag through to the leg it produced.
        const prompt =
            `You are a precision aviation data extraction tool.\n` +
            `The input below is a JSON grid of an ENGINE FAILURE PROCEDURES table: an array of rows, ` +
            `each row an array of cells, each cell {"text": "...", "provenance": "CHARTED" | "ROWSPAN_INHERITED"}. ` +
            `Vertically merged cells have ALREADY been expanded — every runway row is fully populated. ` +
            `Parse it into structured leg sequences, with particular focus on: ${extractionTarget}.\n\n` +
            `PROCEDURE GRID:\n${gridJson}\n\n` +
            `Respond with ONLY a single JSON object in exactly this shape:\n` +
            `{"runways": [{"identifier": "<individual runway, e.g. '16L', '16R', '35'>", ` +
            `"legs": [{"type": "<exactly one of TRACK_TO_DME, TURN_TO_HEADING, TRACK_TO_ALTITUDE>", ` +
            `"value": <number>, ` +
            `"navaid": <DME station/navaid identifier as a string (e.g. "TCH"), or null if none>, ` +
            `"direction": <"LEFT", "RIGHT", or null>, ` +
            `"provenance": "<exactly the provenance of the grid cell this leg's data came from>"}]}]}\n` +
            `LEG RULES:\n` +
            `- Skip title/header rows (e.g. "ENGINE FAILURE PROCEDURES", "TAKEOFF", "RWY / AT / TURN"); ` +
            `extract only runway data rows.\n` +
            `- Emit one leg object per instruction, in the order the cells state them. ` +
            `Cells with empty text contain no instruction — emit no leg for them.\n` +
            `- TRACK_TO_DME: the procedure tracks until a DME distance (e.g. "11.6 DME TCH"). ` +
            `Set value to the DME distance in nautical miles and navaid to the station identifier if named (otherwise null).\n` +
            `- TURN_TO_HEADING: the procedure commands a turn to a magnetic heading. Set value to the heading as a number ` +
            `and direction to "LEFT" or "RIGHT" if the turn direction is stated (otherwise null).\n` +
            `- TRACK_TO_ALTITUDE: the procedure climbs until an altitude restriction. Set value to the altitude in feet MSL.\n` +
            `- direction is only "LEFT" or "RIGHT" on turn legs with a stated direction; otherwise it must be null.\n` +
            `PROVENANCE RULES:\n` +
            `- provenance is REQUIRED on every leg. Copy the "provenance" value of the exact grid cell the leg's data ` +
            `came from: "CHARTED" or "ROWSPAN_INHERITED". Never omit it, never invent it, never change it.\n` +
            `MATRIX UNROLLING:\n` +
            `- If a runway cell groups multiple runways (e.g. '16L/R' or '16L, 17'), you must unroll them and create a ` +
            `separate, identical JSON object for each individual runway ('16L', '16R', '17') in the output array.\n` +
            `- Every "identifier" in the output must be a single runway (e.g. "16L"), never a grouped identifier.\n` +
            `Emit numeric fields as JSON numbers (not quoted strings).\n` +
            `Do not include any conversational filler, markdown, code fences, labels, or explanation. ` +
            `Output the raw JSON object and nothing else.`;

        // Stage 2: LLM extraction with a bounded CORRECTIVE retry loop. Each
        // attempt is a full round trip: Ollama call (format: "json",
        // deterministic options), then strict schema validation via
        // parseRunwayMatrix. At temperature 0 an identical prompt reproduces
        // an identical (rejected) response, so attempts 2..N append the exact
        // validation failure to the prompt — the retry becomes a repair
        // instruction instead of a replay. Infrastructure failure (the
        // inference container unreachable / HTTP error / timeout) is still
        // an immediate 500 — retrying cannot fix a downed dependency.
        let parsedMatrix = null;
        let lastExtractionError = null;

        for (let attempt = 1; attempt <= LLM_EXTRACTION_MAX_ATTEMPTS; attempt += 1) {
            const attemptPrompt = lastExtractionError === null
                ? prompt
                : `${prompt}\n\n` +
                    `CORRECTION REQUIRED:\n` +
                    `Your previous response was rejected by strict schema validation for this reason:\n` +
                    `${lastExtractionError.message}\n` +
                    `Fix exactly that problem and re-emit the COMPLETE corrected JSON object for the entire table. ` +
                    `Output the raw JSON object and nothing else.`;

            let rawLlmResponse;

            try {
                analyzeTrace("llm_request_start", { attempt, corrective: lastExtractionError !== null });
                const llmResponse = await fetch("http://llm:11434/api/generate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: process.env.LLM_MODEL_NAME || "llama3:8b-instruct-q4_K_M",
                        prompt: attemptPrompt,
                        stream: false,
                        format: "json",
                        options: LLM_EXTRACTION_OPTIONS
                    }),
                    // Local inference can be slow; abort rather than hang forever.
                    signal: AbortSignal.timeout(120_000)
                });

                if (!llmResponse.ok) {
                    throw new Error(`Ollama returned HTTP ${llmResponse.status} ${llmResponse.statusText}`);
                }

                rawLlmResponse = ((await llmResponse.json()).response || "").trim();
                analyzeTrace("llm_response_ok", { attempt, chars: rawLlmResponse.length });
            } catch (error) {
                analyzeTrace("llm_failed", { attempt, name: error.name, message: error.message });
                console.error(`LLM analyze request failed (${error.name}): ${error.message}`);
                return res.status(500).json({ error: "LLM analysis failed. The inference container did not return a result." });
            }

            try {
                parsedMatrix = parseRunwayMatrix(rawLlmResponse);
                break;
            } catch (error) {
                if (!(error instanceof DataIntegrityError)) {
                    throw error;
                }

                lastExtractionError = error;
                analyzeTrace("llm_extraction_invalid", { attempt, message: error.message });
                console.warn(
                    `LLM extraction attempt ${attempt}/${LLM_EXTRACTION_MAX_ATTEMPTS} rejected: ${error.message}`
                );
            }
        }

        if (!parsedMatrix) {
            throw new DataIntegrityError(
                `LLM extraction failed strict schema validation on all ${LLM_EXTRACTION_MAX_ATTEMPTS} attempts. ` +
                    `Last failure: ${lastExtractionError.message}`
            );
        }

        analyzeTrace("matrix_extracted", {
            runwayCount: parsedMatrix.runways.length,
            runways: parsedMatrix.runways.map((runway) => ({
                identifier: runway.identifier,
                legCount: runway.legs.length
            }))
        });

        // ============================================================
        // Phase 4.3: Stages 3 (physical ground truth) and 4 (WGS-84
        // geodesic solving) run PER RUNWAY over the validated matrix.
        // Every runway's leg sequence becomes an ordered chain of solved
        // segments; all segments aggregate into ONE unified GeoJSON
        // FeatureCollection (the "spiderweb"). No runway degrades
        // gracefully: a single unresolvable runway, station, or climb
        // anchor rejects the whole computation with a 422.
        // ============================================================
        const resolutionTime = new Date().toISOString();
        const solvedRunways = [];
        const allFeatures = [];
        let airacCycle = null;

        for (const runway of parsedMatrix.runways) {
            // Stage 3: validated physical ground truth for THIS runway end.
            // AIRAC temporal enforcement runs first inside the service; the
            // threshold, the payload navaid, and every station any leg
            // references are resolved through the strict multi-tenant
            // cascade (tailored dataset first, public FAA fallback second;
            // terminal facilities at the airport first, enroute within
            // 40 NM as fallback) — unresolvable is a 422.
            const legNavaidIdents = [...new Set(
                runway.legs
                    .filter((leg) => typeof leg.navaid === "string" && leg.navaid.trim() !== "")
                    .map((leg) => leg.navaid.trim().toUpperCase())
            )];

            analyzeTrace("ground_truth_start", { runway: runway.identifier, legNavaidIdents });
            const groundTruth = await resolvePhysicalGroundTruth(
                airportId.trim(),
                runway.identifier,
                navaidId.trim(),
                resolutionTime,
                { legNavaidIdents, operatorId }
            );
            airacCycle = groundTruth.airacCycle;
            analyzeTrace("ground_truth_ok", {
                runway: runway.identifier,
                airac: groundTruth.airacCycle?.ident,
                threshold: groundTruth.originRunway.threshold,
                trueHeading: groundTruth.originRunway.trueHeading,
                magneticVariation: groundTruth.magneticVariation,
                legNavaids: Object.fromEntries(
                    Object.entries(groundTruth.legNavaids).map(([ident, station]) => [ident, {
                        type: station.type,
                        tier: station.selection.tier,
                        distanceNM: station.selection.distanceNM,
                        dataset: station.selection.dataset
                    }])
                )
            });

            // Climb-profile anchor for TRACK_TO_ALTITUDE legs: the validated
            // MSL elevation of a resolved terminal station at the airport
            // (a terminal DME sits on the field), else any resolved leg
            // station. Runways whose legs never trigger on altitude do not
            // need one; the solver enforces this per leg.
            const resolvedStations = Object.values(groundTruth.legNavaids);
            const terminalStation = resolvedStations.find((station) => station.selection.tier === "terminal");
            const elevationSource = terminalStation ?? resolvedStations[0] ?? null;
            const startElevationFtMsl = Number.isFinite(elevationSource?.elevationFtMsl)
                ? elevationSource.elevationFtMsl
                : null;

            // Stage 4: deterministic WGS-84 multi-leg solving. The solver
            // walks the leg chain sequentially — each leg starts where the
            // previous one ended, on the heading the previous one rolled
            // out on. Provenance (CHARTED vs ROWSPAN_INHERITED) rides along
            // as UI metadata only; the vector math is identical.
            analyzeTrace("path_solve_start", { runway: runway.identifier, legCount: runway.legs.length });
            const solved = solveRunwayEscapePath({
                runwayId: groundTruth.originRunway.runwayId,
                origin: groundTruth.originRunway.threshold,
                departureTrueHeading: groundTruth.originRunway.trueHeading,
                magneticVariation: groundTruth.magneticVariation,
                startElevationFtMsl,
                legs: runway.legs,
                stationsByIdent: groundTruth.legNavaids,
                defaultStation: {
                    identifier: groundTruth.navaid.identifier,
                    coordinates: groundTruth.navaid.coordinates
                }
            });
            analyzeTrace("path_solve_ok", {
                runway: runway.identifier,
                featureCount: solved.features.length,
                totalDistanceNM: solved.parametric.totalDistanceNM,
                finalTrueHeading: solved.parametric.finalTrueHeading
            });

            allFeatures.push(...solved.features);
            solvedRunways.push({
                identifier: runway.identifier,
                legs: runway.legs,
                parametric: solved.parametric,
                disambiguation: groundTruth.disambiguation
            });
        }

        // Unified FeatureCollection: every leg segment and trigger point of
        // every runway, each feature tagged with { runway, legType,
        // provenance } so the frontend can style the spiderweb distinctly.
        const geojson = {
            type: "FeatureCollection",
            features: allFeatures
        };

        analyzeTrace("request_complete", {
            runwayCount: solvedRunways.length,
            featureCount: allFeatures.length
        });

        return res.json({
            runways: solvedRunways,
            airacCycle,
            geojson,
            transcription: procedureText
        });
    } catch (error) {
        analyzeTrace("pipeline_failed", { name: error.name, message: error.message });
        // Every 422 carries the Stage-1 transcription: when downstream stages
        // reject, the operator must see what the vision pass actually read.
        // AiracExpiredError subclasses DataIntegrityError: both are structural
        // rejections of the computation, never generic server faults.
        if (error instanceof DataIntegrityError) {
            return res.status(422).json({ error: error.message, transcription: procedureText });
        }

        // Circuit-breaker Errors ("Invalid distance calculated", "Infinite loop averted")
        // are data/geometry faults — surface as 422 with the exact message.
        if (
            error instanceof Error &&
            (error.message === "Invalid distance calculated" || error.message === "Infinite loop averted")
        ) {
            return res.status(422).json({ error: error.message, transcription: procedureText });
        }

        console.error(`Analyze pipeline failed (${error.name}): ${error.message}`);
        return res.status(500).json({ error: "Analysis pipeline failed unexpectedly." });
    }
});

// Multer error handling middleware wrapper for the OCR route
app.post("/api/ocr", requireAuth, (req, res, next) => {
    if (!OCR_ENABLED) {
        return res.status(501).json({
            error: "OCR disabled in this deployment environment. A vision-capable model is not configured."
        });
    }

    upload.single("image")(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ error: `Upload error: ${err.message}` });
        } else if (err) {
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "Missing required file: image" });
    }

    try {
        const mimeType = resolveSupportedImageMimeType(req.file);

        if (!mimeType) {
            return res.status(400).json({ error: "Unsupported image type. Only JPEG, PNG, and WEBP are allowed." });
        }

        const base64Image = req.file.buffer.toString("base64");
        const response = await openai.chat.completions.create({
            // OCR needs a vision-capable model; the configured model must
            // support image inputs when this route is used.
            model: LLM_MODEL_NAME,
            temperature: 0,
            top_p: 0.1,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Transcribe the text in this image exactly as written. Do not add markdown, formatting, or commentary. Just output the raw text." },
                        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
                    ]
                }
            ]
        });

        return res.json({ text: response.choices[0].message.content });
    } catch (error) {
        console.error("OpenAI OCR failed:", error);
        return res.status(500).json({ error: "Failed to extract text from image" });
    }
});

async function seedDatabase() {
    const count = await db.collection("procedures").countDocuments();
    if (count === 0) {
        const seedData = require("./sample-data.json");
        await db.collection("procedures").insertMany(seedData);
        console.log("Database seeded from local JSON.");
    }
}

function getAirportQuery(airportCode) {
    return {
        $or: [
            { airportCode },
            { "source.airportCode": airportCode },
            { "airport.icao": airportCode }
        ]
    };
}

function resolveSupportedImageMimeType(file) {
    const extension = path.extname(file.originalname || "").toLowerCase();
    const reportedMime = (file.mimetype || "").toLowerCase();

    if (extension === ".jpg" || extension === ".jpeg" || reportedMime === "image/jpeg" || reportedMime === "image/jpg") {
        return "image/jpeg";
    }

    if (extension === ".png" || reportedMime === "image/png") {
        return "image/png";
    }

    if (extension === ".webp" || reportedMime === "image/webp") {
        return "image/webp";
    }

    return null;
}

app.listen(PORT, () => {
    console.log(`EmProView server running at http://localhost:${PORT}`);
});