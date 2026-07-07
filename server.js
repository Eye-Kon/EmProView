require("dotenv").config();

const express = require("express");
const { MongoClient } = require("mongodb");
const multer = require("multer");
const OpenAI = require("openai");
const path = require("path");
const { procedureSchema } = require("./backend/openai_schema_definition");
const { segmentProcessor, DataIntegrityError } = require("./backend/geo_engine");
const { systemInstructions, fewShotExamples } = require("./backend/prompt");
const { initNasrUpdater } = require("./backend/jobs/nasrUpdater");
const { initNavDb } = require("./utils/navDbQuery");

const app = express();
const PORT = process.env.PORT || 3000;
const openai = new OpenAI();

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
        const response = await openai.chat.completions.create({
            model: "gpt-4o", // Upgraded from specific 08-06 tag for broader vision/text consistency
            temperature: 0,
            top_p: 0.1,
            messages: [
                { role: "system", content: systemInstructions },
                ...fewShotExamples,
                { role: "user", content: rawText }
            ],
            response_format: {
                type: "json_schema",
                json_schema: procedureSchema
            }
        });

        const extractedProcedure = JSON.parse(response.choices[0].message.content);
        return res.json(await enrichProcedureWithSpatialTriggers(extractedProcedure, flightDate));
    } catch (error) {
        console.error("OpenAI extraction failed:", error);
        return res.status(500).json({ error: "Failed to extract procedure data" });
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
            model: "gpt-4o",
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

function getProcedureAirportCode(procedure) {
    const airportCode = procedure.airportCode || procedure.source?.airportCode || procedure.airport?.icao;

    if (typeof airportCode !== "string" || airportCode.trim() === "") {
        throw new DataIntegrityError("Procedure airportCode is required for spatial trigger resolution.");
    }

    return airportCode.trim();
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

/** Optional flightDate from an API payload: undefined passes through (query layer defaults to now). */
function parseFlightDate(rawFlightDate) {
    if (rawFlightDate === undefined || rawFlightDate === null) {
        return undefined;
    }

    const date = new Date(rawFlightDate);

    if (!Number.isFinite(date.getTime())) {
        throw new Error(`Invalid flightDate: ${rawFlightDate}. Expected an ISO-8601 date string.`);
    }

    return date;
}

async function enrichProcedureWithSpatialTriggers(procedure, flightDate) {
    if (!procedure?.procedureRows) {
        return procedure;
    }

    const airportCode = getProcedureAirportCode(procedure);

    // Per-row enrichment: a ground-truth gap in one row (e.g. a runway missing
    // from the nav database) must not abort the entire procedure. Each row
    // carries its own integrity report; failed rows keep their raw segments.
    return {
        ...procedure,
        procedureRows: await Promise.all(procedure.procedureRows.map(async (row) => {
            try {
                return {
                    ...row,
                    geometry: {
                        ...row.geometry,
                        segments: await Promise.all((row.geometry?.segments || []).map((segment) =>
                            enrichSegmentWithSpatialTrigger(segment, row, { airportCode, flightDate })
                        ))
                    },
                    integrity: { status: "enriched", errors: [] }
                };
            } catch (error) {
                if (!(error instanceof DataIntegrityError)) {
                    throw error;
                }

                console.warn(`Row ${row.rowId || "(unidentified)"} enrichment failed: ${error.message}`);

                return {
                    ...row,
                    integrity: {
                        status: "failed",
                        errors: [`${error.name}: ${error.message}`]
                    }
                };
            }
        }))
    };
}

async function enrichSegmentWithSpatialTrigger(segment, row, context) {
    if (!segment?.spatialTrigger) {
        return segment;
    }

    const computedSpatialTrigger = await segmentProcessor.process(segment, row, context);

    if (!computedSpatialTrigger) {
        return segment;
    }

    return {
        ...segment,
        computedSpatialTrigger
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