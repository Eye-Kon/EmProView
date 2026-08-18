/**
 * POST /api/batch-extract — synchronous bulk chart ingestion.
 *
 * Accepts multipart/form-data with chart files (files[] or files) plus
 * operator_id. Returns a rejection manifest. Never auto-locks identity
 * or writes canonical nav data; successes are handed back for HITL
 * verification via /api/verify.
 */
const multer = require("multer");
const { isSupportedChartFile } = require("../extraction/ocrChart");
const { processChartBatch } = require("../services/batchExtractService");

const MAX_BATCH_FILES = 50;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const FILE_FIELDS = new Set(["files", "files[]"]);

const batchChartUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_BYTES,
        files: MAX_BATCH_FILES
    },
    fileFilter: (req, file, cb) => {
        if (!FILE_FIELDS.has(file.fieldname)) {
            cb(null, false);
            return;
        }

        if (isSupportedChartFile(file)) {
            cb(null, true);
            return;
        }

        cb(new Error("Invalid file type. Batch extract accepts JPEG, PNG, WEBP, PDF, and TXT chart files."));
    }
});

function collectChartFiles(req) {
    return (req.files || []).filter((file) => FILE_FIELDS.has(file.fieldname));
}

function normalizeOperatorId(rawOperatorId) {
    if (typeof rawOperatorId !== "string" || rawOperatorId.trim() === "") {
        return null;
    }

    return rawOperatorId.trim().toUpperCase();
}

function batchExtractUploadMiddleware(req, res, next) {
    batchChartUpload.any()(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ error: `Upload error: ${err.message}` });
        }

        if (err) {
            return res.status(400).json({ error: err.message });
        }

        return next();
    });
}

async function handleBatchExtract(req, res) {
    const operatorId = normalizeOperatorId(req.body?.operator_id ?? req.query?.operator_id);

    if (!operatorId) {
        return res.status(400).json({
            error: 'Missing required field: operator_id (e.g. "AAL").'
        });
    }

    const files = collectChartFiles(req);

    if (files.length === 0) {
        return res.status(400).json({
            error: "Missing required files: upload one or more chart files as files[] (or files)."
        });
    }

    try {
        const manifest = await processChartBatch({ files, operatorId });
        return res.status(200).json(manifest);
    } catch (error) {
        console.error("Batch extract failed:", error);
        return res.status(500).json({ error: "Failed to process batch extraction." });
    }
}

module.exports = {
    MAX_BATCH_FILES,
    batchExtractUploadMiddleware,
    handleBatchExtract
};
