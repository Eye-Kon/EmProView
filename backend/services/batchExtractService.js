/**
 * Phase 6 batch extraction engine.
 *
 * Walks an uploaded set of Engine-Out SID charts, transcribes each file,
 * and runs it through the existing LLM extraction core. Failures are
 * isolated per file: Chart A's OCR/parse error is logged and recorded in
 * the rejection manifest, then Chart B still runs.
 *
 * Extraction only. This service MUST NOT insert into nav_data, MUST NOT
 * lock OperatorProcedureRegistry, and MUST NOT compile ARINC 424-18.
 * Successful payloads stay unverified for HITL routing through /api/verify.
 */
const { transcribeChartFile } = require("../extraction/ocrChart");

function log(level, message) {
    const prefix = `[batch-extract] ${new Date().toISOString()}`;

    if (level === "error") {
        console.error(`${prefix} ERROR: ${message}`);
    } else if (level === "warn") {
        console.warn(`${prefix} WARN: ${message}`);
    } else {
        console.log(`${prefix} ${message}`);
    }
}

function filenameOf(file) {
    const name = file?.originalname;

    if (typeof name === "string" && name.trim() !== "") {
        return name;
    }

    return "unknown";
}

function errorMessageOf(error) {
    if (error && typeof error.message === "string" && error.message.trim() !== "") {
        return error.message;
    }

    return "Unknown extraction failure.";
}

/**
 * OCR (or text-layer read) + LLM extraction for a single chart file.
 * Does not enrich against NASR and does not persist.
 */
async function extractChartFile(file, operatorId) {
    const { extractProcedureFromText } = require("../extractionService");
    const rawText = await transcribeChartFile(file);
    const extracted = await extractProcedureFromText(rawText);

    return {
        ...extracted,
        operator_id: operatorId
    };
}

/**
 * @param {object} options
 * @param {Array<{originalname?: string, buffer?: Buffer, mimetype?: string}>} options.files
 * @param {string} options.operatorId  ICAO operator code, already normalized.
 * @param {Function} [options.extractChart]  Injectable extractor for tests.
 * @returns {Promise<{operator_id: string, summary: object, successful: object[], failed: object[]}>}
 */
async function processChartBatch({ files, operatorId, extractChart = extractChartFile }) {
    const chartFiles = Array.isArray(files) ? files : [];
    const successful = [];
    const failed = [];

    for (const file of chartFiles) {
        const filename = filenameOf(file);

        try {
            const data = await extractChart(file, operatorId);
            successful.push({ filename, data });
        } catch (error) {
            log("warn", `${filename} failed: ${error?.name || "Error"}: ${errorMessageOf(error)}`);
            failed.push({
                filename,
                error: errorMessageOf(error)
            });
        }
    }

    return {
        operator_id: operatorId,
        summary: {
            total: chartFiles.length,
            success_count: successful.length,
            fail_count: failed.length
        },
        successful,
        failed
    };
}

module.exports = {
    extractChartFile,
    processChartBatch
};
