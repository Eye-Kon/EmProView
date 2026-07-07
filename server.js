require("dotenv").config();

const express = require("express");
const { MongoClient } = require("mongodb");
const multer = require("multer");
const path = require("path");
const { AiracExpiredError } = require("./backend/geo_engine");
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
    try {
        await client.connect();
        db = client.db("emproview");
        console.log("Connected to MongoDB");
        initNavDb(db); // Point the geodetic ground-truth layer at live nav_data
        await seedDatabase();
        initNasrUpdater(db); // Weekly NASR ingestion + startup AIRAC catch-up
        initBatchWorker(db); // Persistent async batch queue (resumes orphaned jobs)
    } catch (error) {
        console.error("CRITICAL FATAL: Failed to connect to MongoDB", error);
        process.exit(1); // Force server to crash if DB isn't available, preventing ghost state
    }
}

connectDB();

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

// Multer error handling middleware wrapper for the OCR route
app.post("/api/ocr", requireAuth, (req, res, next) => {
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