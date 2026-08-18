/**
 * Phase 6.0 batch extraction engine — rejection manifest and error isolation.
 *
 * Pure unit test of processChartBatch. Extractor is injected so this never
 * touches MongoDB, Ollama, nav_data, or OperatorProcedureRegistry.
 *
 * Run: node scripts/smoke_batch_extract.js
 */
const assert = require("assert");
const { processChartBatch } = require("../backend/services/batchExtractService");
const { extractPdfTextLayer, isSupportedChartFile } = require("../backend/extraction/ocrChart");

function chartFile(name) {
    return { originalname: name, mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.4") };
}

function parametricExtract(filename) {
    return {
        airline: "American Airlines",
        airportCode: filename.slice(0, 4),
        procedureType: "Engine Failure Takeoff",
        procedureRows: [{ runways: ["16L"], instructionText: "Maintain runway heading." }]
    };
}

async function main() {
    console.log("Phase 6.0 batch-extract smokes\n");

    const calls = [];
    const extractChart = async (file, operatorId) => {
        calls.push(file.originalname);
        assert.strictEqual(operatorId, "AAL");

        if (file.originalname === "KDEN_08.pdf") {
            throw new Error("Missing mandatory TCH navaid in matrix.");
        }

        return { ...parametricExtract(file.originalname), operator_id: operatorId };
    };

    const files = [
        chartFile("KSLC_16L.pdf"),
        chartFile("KDEN_08.pdf"),
        chartFile("KPHX_08.pdf"),
        chartFile("KCLT_36C.pdf"),
        chartFile("KDFW_17C.pdf")
    ];

    const manifest = await processChartBatch({ files, operatorId: "AAL", extractChart });

    assert.strictEqual(manifest.operator_id, "AAL");
    assert.deepStrictEqual(manifest.summary, {
        total: 5,
        success_count: 4,
        fail_count: 1
    });
    assert.strictEqual(manifest.successful.length, 4);
    assert.strictEqual(manifest.failed.length, 1);
    assert.strictEqual(manifest.successful[0].filename, "KSLC_16L.pdf");
    assert.strictEqual(manifest.successful[0].data.airportCode, "KSLC");
    assert.strictEqual(manifest.successful[0].data.operator_id, "AAL");
    assert.deepStrictEqual(manifest.failed[0], {
        filename: "KDEN_08.pdf",
        error: "Missing mandatory TCH navaid in matrix."
    });
    assert.deepStrictEqual(calls, files.map((file) => file.originalname));
    console.log("  ok — per-file isolation: Chart B still runs after Chart A throws");
    console.log("  ok — rejection manifest schema (summary / successful / failed)");

    const allFailed = await processChartBatch({
        files: [chartFile("bad.pdf")],
        operatorId: "DAL",
        extractChart: async () => {
            throw new Error("Vision OCR returned no procedure text.");
        }
    });
    assert.strictEqual(allFailed.summary.success_count, 0);
    assert.strictEqual(allFailed.summary.fail_count, 1);
    assert.strictEqual(allFailed.failed[0].error, "Vision OCR returned no procedure text.");
    console.log("  ok — OCR failure is recorded, not thrown out of the batch");

    assert.strictEqual(isSupportedChartFile({ originalname: "KSLC_16L.pdf", mimetype: "application/pdf" }), true);
    assert.strictEqual(isSupportedChartFile({ originalname: "chart.png", mimetype: "image/png" }), true);
    assert.strictEqual(isSupportedChartFile({ originalname: "notes.txt", mimetype: "text/plain" }), true);
    assert.strictEqual(isSupportedChartFile({ originalname: "malware.exe", mimetype: "application/octet-stream" }), false);
    console.log("  ok — chart file type gate");

    const pdfWithText = Buffer.from(
        "%PDF-1.4\nBT\n(AIRPORT: KSLC RWY 16L) Tj\nET\n",
        "latin1"
    );
    assert.match(extractPdfTextLayer(pdfWithText), /AIRPORT: KSLC RWY 16L/);
    assert.strictEqual(extractPdfTextLayer(Buffer.from("%PDF-1.4 image-only")), "");
    console.log("  ok — PDF text-layer extraction (empty layer is OCR failure)");

    console.log("\nAll Phase 6.0 batch-extract smokes passed.");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
