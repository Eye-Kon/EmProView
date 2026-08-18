/**
 * Chart-file transcription for bulk ingestion.
 *
 * Images go through the same local vision OCR path as /api/analyze Stage 1
 * (Ollama native /api/generate + LLM_VISION_MODEL_NAME). Digitally generated
 * PDFs contribute extractable text; scanned PDFs with no text layer fail
 * with an OCR error so the batch engine can isolate them. Plain-text dumps
 * (.txt) skip vision and pass through to the LLM extractor.
 *
 * This module never writes to nav_data or OperatorProcedureRegistry.
 */
const path = require("path");

const VISION_MODEL_NAME = process.env.LLM_VISION_MODEL_NAME || "qwen2.5vl:7b";
const VISION_OCR_OPTIONS = { temperature: 0.0 };
const VISION_TIMEOUT_MS = 300_000;

const IMAGE_MIME_BY_EXTENSION = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
};

const CHART_OCR_PROMPT =
    "You are a precision aeronautical OCR system. " +
    "Locate the engine-out / ENGINE FAILURE PROCEDURES content on this chart. " +
    "Transcribe the ENTIRE procedure table and header metadata exactly as printed. " +
    "If the content is a table, emit a clean Markdown table. " +
    "If a cell is blank or visually merged with another, leave it completely empty (e.g., | |). " +
    "Do not add commentary.";

function resolveOllamaGenerateUrl() {
    if (process.env.OLLAMA_GENERATE_URL) {
        return process.env.OLLAMA_GENERATE_URL;
    }

    const base = process.env.LLM_BASE_URL;

    if (typeof base === "string" && base.trim() !== "") {
        return `${base.replace(/\/v1\/?$/, "")}/api/generate`;
    }

    return "http://llm:11434/api/generate";
}

function fileExtension(file) {
    return path.extname(file?.originalname || "").toLowerCase();
}

function reportedMime(file) {
    return (file?.mimetype || "").toLowerCase();
}

function resolveImageMimeType(file) {
    const extension = fileExtension(file);
    const mime = reportedMime(file);

    if (IMAGE_MIME_BY_EXTENSION[extension]) {
        return IMAGE_MIME_BY_EXTENSION[extension];
    }

    if (mime === "image/jpeg" || mime === "image/jpg") {
        return "image/jpeg";
    }

    if (mime === "image/png" || mime === "image/webp") {
        return mime;
    }

    return null;
}

function isPdfFile(file) {
    const extension = fileExtension(file);
    const mime = reportedMime(file);

    return extension === ".pdf" || mime === "application/pdf";
}

function isTextFile(file) {
    const extension = fileExtension(file);
    const mime = reportedMime(file);

    return extension === ".txt" || mime === "text/plain";
}

function isSupportedChartFile(file) {
    return Boolean(resolveImageMimeType(file) || isPdfFile(file) || isTextFile(file));
}

function unescapePdfLiteral(value) {
    return String(value)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\\(/g, "(")
        .replace(/\\\)/g, ")")
        .replace(/\\\\/g, "\\");
}

/**
 * Best-effort text-layer extraction from an uncompressed PDF. Scanned
 * image-only charts yield an empty string; the caller treats that as OCR
 * failure rather than inventing procedure text.
 */
function extractPdfTextLayer(buffer) {
    const raw = Buffer.isBuffer(buffer) ? buffer.toString("latin1") : String(buffer || "");
    const parts = [];

    const tjRegex = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
    let match;

    while ((match = tjRegex.exec(raw)) !== null) {
        parts.push(unescapePdfLiteral(match[1]));
    }

    const arrayRegex = /\[([\s\S]*?)\]\s*TJ/g;

    while ((match = arrayRegex.exec(raw)) !== null) {
        const inner = match[1];
        const strRegex = /\(((?:\\.|[^\\)])*)\)/g;
        let innerMatch;

        while ((innerMatch = strRegex.exec(inner)) !== null) {
            parts.push(unescapePdfLiteral(innerMatch[1]));
        }
    }

    return parts.join(" ").replace(/\s+/g, " ").trim();
}

function stripVisionFences(procedureText) {
    return procedureText
        .replace(/^```[\w-]*[ \t]*\r?\n?/, "")
        .replace(/\r?\n?```[ \t]*$/, "")
        .trim();
}

async function transcribeViaOllama(imageBase64) {
    const visionResponse = await fetch(resolveOllamaGenerateUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: VISION_MODEL_NAME,
            prompt: CHART_OCR_PROMPT,
            images: [imageBase64],
            stream: false,
            options: VISION_OCR_OPTIONS
        }),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS)
    });

    if (!visionResponse.ok) {
        throw new Error(`Vision OCR failed: Ollama returned HTTP ${visionResponse.status} ${visionResponse.statusText}`);
    }

    return stripVisionFences(((await visionResponse.json()).response || "").trim());
}

async function transcribeViaOpenAI(buffer, mimeType) {
    const { openai, LLM_MODEL_NAME } = require("../extractionService");
    const base64Image = buffer.toString("base64");
    const response = await openai.chat.completions.create({
        model: process.env.LLM_VISION_MODEL_NAME || LLM_MODEL_NAME,
        temperature: 0,
        top_p: 0.1,
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: CHART_OCR_PROMPT },
                    { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
                ]
            }
        ]
    });

    return stripVisionFences((response.choices[0]?.message?.content || "").trim());
}

async function transcribeChartImage(file) {
    const mimeType = resolveImageMimeType(file);

    if (!mimeType) {
        throw new Error("Unsupported image type. Only JPEG, PNG, and WEBP are allowed.");
    }

    if (!file.buffer || file.buffer.length === 0) {
        throw new Error("OCR failed: uploaded image is empty.");
    }

    const imageBase64 = file.buffer.toString("base64");

    if (process.env.LLM_BASE_URL) {
        return transcribeViaOllama(imageBase64);
    }

    if (process.env.ENABLE_OCR === "true") {
        return transcribeViaOpenAI(file.buffer, mimeType);
    }

    throw new Error(
        "OCR is not configured. Set LLM_BASE_URL for local vision OCR, or ENABLE_OCR=true with a vision-capable model."
    );
}

async function transcribeChartFile(file) {
    if (isTextFile(file)) {
        const text = (file.buffer || Buffer.alloc(0)).toString("utf8").trim();

        if (text === "") {
            throw new Error("OCR failed: text chart file is empty.");
        }

        return text;
    }

    if (isPdfFile(file)) {
        const pdfText = extractPdfTextLayer(file.buffer);

        if (pdfText === "") {
            throw new Error(
                "OCR failed: PDF contained no extractable procedure text. " +
                    "Rasterize the chart to JPEG, PNG, or WEBP and resubmit."
            );
        }

        return pdfText;
    }

    if (resolveImageMimeType(file)) {
        const procedureText = await transcribeChartImage(file);

        if (procedureText === "") {
            throw new Error(
                "Vision OCR returned no procedure text. The uploaded chart image does not contain a readable Engine Failure Procedure."
            );
        }

        return procedureText;
    }

    throw new Error("Invalid file type. Batch extract accepts JPEG, PNG, WEBP, PDF, and TXT chart files.");
}

module.exports = {
    isSupportedChartFile,
    isPdfFile,
    isTextFile,
    resolveImageMimeType,
    extractPdfTextLayer,
    transcribeChartFile,
    transcribeChartImage
};
