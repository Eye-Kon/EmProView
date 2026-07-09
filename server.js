require("dotenv").config();

// Production hard gate: the API must never come up guarded by a missing or
// hardcoded credential. Checked before any module wiring so the failure is
// the first and only line an operator sees.
if (!process.env.ADMIN_API_KEY) {
    console.error("CRITICAL FATAL: ADMIN_API_KEY is not set. Refusing to start with unauthenticated admin routes.");
    process.exit(1);
}

const express = require("express");
const { MongoClient } = require("mongodb");
const multer = require("multer");
const path = require("path");
const { AiracExpiredError, DataIntegrityError, GeoMath } = require("./backend/geo_engine");
const { buildTriggeredTurnPath } = require("./backend/geo/PathGeometry");
const { requireFiniteNumber, requireNonEmptyString } = require("./backend/geo/validation");
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
const { initNavDb, determineActiveCycle } = require("./utils/navDbQuery");
const { generateAixmRoute, UnserializableRouteError } = require("./utils/aixmExporter");

const app = express();
const PORT = process.env.PORT || 3000;

// OCR requires a vision-capable model; air-gapped deployments with a
// text-only local LLM must disable it explicitly (default: disabled).
const OCR_ENABLED = process.env.ENABLE_OCR === "true";

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

// Allow the Vite mapping UI (separate origin in dev) to call /api routes.
app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) {
        return next();
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    return next();
});

app.use(express.json());
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

/**
 * Parses the Ollama response into the relational-logic contract. The LLM is
 * an untrusted boundary: its output is treated exactly like external input.
 * Anything that is not strict, complete JSON with coherent turn semantics is
 * a DataIntegrityError (-> 422), never a silent default.
 */
function parseRelationalLogic(rawResponse) {
    // Tolerate a fenced/prefixed reply by isolating the outermost JSON object,
    // but nothing beyond that: the content itself must parse strictly.
    const jsonMatch = typeof rawResponse === "string" ? rawResponse.match(/\{[\s\S]*\}/) : null;

    if (!jsonMatch) {
        throw new DataIntegrityError(
            `LLM extraction did not produce a JSON object of relational logic. Raw response: ${String(rawResponse).slice(0, 200)}`
        );
    }

    let extraction;

    try {
        extraction = JSON.parse(jsonMatch[0]);
    } catch {
        throw new DataIntegrityError(
            `LLM extraction produced malformed JSON. Raw response: ${jsonMatch[0].slice(0, 200)}`
        );
    }

    const triggerDistanceNM = requireFiniteNumber(extraction.trigger_distance_nm, "llmExtraction.trigger_distance_nm");
    const rawDirection = typeof extraction.turn_direction === "string"
        ? extraction.turn_direction.trim().toLowerCase()
        : null;

    let turn = null;

    if (rawDirection === "left" || rawDirection === "right") {
        turn = {
            turnDirection: rawDirection,
            magneticHeading: requireFiniteNumber(
                extraction.target_magnetic_heading,
                "llmExtraction.target_magnetic_heading"
            )
        };
    } else if (rawDirection !== null && rawDirection !== "none" && rawDirection !== "not_applicable") {
        throw new DataIntegrityError(
            `LLM extraction returned an incoherent turn_direction: ${extraction.turn_direction}. Expected LEFT, RIGHT, or NONE.`
        );
    }

    return { extraction, triggerDistanceNM, turn };
}

// Bridges the extraction, ground-truth, and spatial calculation layers:
//   Stage 1  LLM extraction of relational logic (local Ollama container,
//            native /api/generate via the Docker service name http://llm:11434).
//   Stage 3  Validated physical ground truth (groundTruthService) — AIRAC
//            currency is enforced before any spatial query runs.
//   Stage 4  Deterministic WGS-84 solving (GeoMath + PathGeometry).
// No stage degrades gracefully: expired, missing, or non-finite physical
// data rejects the computation with a 422 and the exact failure message.
app.post("/api/analyze", requireAnalyzeAuth, async (req, res) => {
    const {
        procedure_text: procedureText,
        extraction_target: extractionTarget,
        airportId,
        runwayId,
        navaidId
    } = req.body || {};

    const missing = [
        ["procedure_text", procedureText],
        ["extraction_target", extractionTarget],
        ["airportId", airportId],
        ["runwayId", runwayId],
        ["navaidId", navaidId]
    ].filter(([, value]) => typeof value !== "string" || value.trim() === "").map(([name]) => name);

    if (missing.length > 0) {
        return res.status(400).json({
            error: `Missing required fields: ${missing.join(", ")}. ` +
                `procedure_text, extraction_target, airportId, runwayId, and navaidId must all be provided.`
        });
    }

    const prompt =
        `You are a precision aviation data extraction tool.\n` +
        `From the procedure text below, extract the relational logic of the procedure, ` +
        `with particular focus on: ${extractionTarget}.\n\n` +
        `PROCEDURE TEXT:\n${procedureText}\n\n` +
        `Respond with ONLY a single JSON object in exactly this shape:\n` +
        `{"extracted_value": "<the value of ${extractionTarget}>", ` +
        `"turn_direction": "<LEFT, RIGHT, or NONE>", ` +
        `"trigger_distance_nm": <the DME distance in nautical miles at which the action occurs, as a number>, ` +
        `"target_magnetic_heading": <the commanded magnetic heading or course after the action as a number, or null if none>}\n` +
        `Do not include any conversational filler, markdown, code fences, labels, or explanation. ` +
        `Output the raw JSON object and nothing else.`;

    // Stage 1: LLM extraction. Infrastructure failure here is a 500 — the
    // inference container is a server-side dependency, not a data problem.
    let rawLlmResponse;

    try {
        const llmResponse = await fetch("http://llm:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: process.env.LLM_MODEL_NAME || "llama3",
                prompt,
                stream: false,
                format: "json"
            }),
            // Local CPU inference can be slow; abort rather than hang forever.
            signal: AbortSignal.timeout(120_000)
        });

        if (!llmResponse.ok) {
            throw new Error(`Ollama returned HTTP ${llmResponse.status} ${llmResponse.statusText}`);
        }

        rawLlmResponse = ((await llmResponse.json()).response || "").trim();
    } catch (error) {
        console.error(`LLM analyze request failed (${error.name}): ${error.message}`);
        return res.status(500).json({ error: "LLM analysis failed. The inference container did not return a result." });
    }

    try {
        const { extraction, triggerDistanceNM, turn } = parseRelationalLogic(rawLlmResponse);

        // Stage 3: validated physical ground truth. AIRAC temporal enforcement
        // runs first inside the service; an expired cycle or any missing /
        // non-finite physical field throws before spatial math is reached.
        const groundTruth = await resolvePhysicalGroundTruth(
            airportId.trim(),
            runwayId.trim(),
            navaidId.trim(),
            new Date().toISOString()
        );

        const origin = {
            latitude: groundTruth.originRunway.threshold.latitude,
            longitude: groundTruth.originRunway.threshold.longitude
        };
        const departureTrueHeading = groundTruth.originRunway.trueHeading;

        // Stage 4: deterministic WGS-84 solving. The trigger point is the
        // forward intersection of the departure track with the DME arc around
        // the validated navaid station.
        const intersection = GeoMath.calculateTrackCircleIntersection(
            origin,
            departureTrueHeading,
            groundTruth.navaid.coordinates,
            triggerDistanceNM
        );
        const triggerPoint = { latitude: intersection.latitude, longitude: intersection.longitude };

        let resolvedTurn = null;

        if (turn) {
            // True North normalization: the LLM's magnetic heading is converted
            // to True using database ground truth before it touches spatial math.
            const targetTrueHeading = GeoMath.magneticToTrue(turn.magneticHeading, groundTruth.magneticVariation);
            const turnEvaluation = GeoMath.getAngularDifference(
                departureTrueHeading,
                targetTrueHeading,
                turn.turnDirection
            );

            resolvedTurn = {
                targetTrueHeading: turnEvaluation.targetHeading,
                turnDegrees: turnEvaluation.turnDegrees,
                turnDirection: turnEvaluation.turnDirection
            };
        }

        const path = buildTriggeredTurnPath({
            origin,
            triggerPoint,
            departureTrueHeading,
            turn: resolvedTurn,
            runway: groundTruth.originRunway.runwayId
        });

        return res.json({
            extraction,
            airacCycle: groundTruth.airacCycle,
            triggerPoint: {
                ...triggerPoint,
                distanceAlongTrackNM: intersection.distanceAlongTrackNM,
                dmeErrorNM: intersection.dmeErrorNM
            },
            parametric: path.parametric,
            geojson: path.geojson,
            disambiguation: groundTruth.disambiguation
        });
    } catch (error) {
        // AiracExpiredError subclasses DataIntegrityError: both are structural
        // rejections of the computation, never generic server faults.
        if (error instanceof DataIntegrityError) {
            return res.status(422).json({ error: error.message });
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