/**
 * Phase 4.2 Tier-2 targeted classification: Markdown transcription for
 * CONTENT, single-token vision classification for STRUCTURE.
 *
 * Lesson from Tier 1: the 7B q4 vision model reads cell text faithfully but
 * confabulates layout when asked to author HTML structure (it put rowspans
 * on headers and none on the actual merged cells). So the model is never
 * asked to describe structure in free form again. Instead:
 *   - Stage 1 transcribes the table to Markdown (proven reliable for text).
 *   - This module deterministically parses the Markdown into a grid.
 *   - For each runway row with an empty AT or TURN cell, ONE targeted
 *     vision question is asked about that specific physical cell, with a
 *     constrained single-token answer: MERGED / BLANK / TEXT. Perception,
 *     not authoring — the task class the model is actually good at.
 *
 * Deterministic resolution of each verdict:
 *   MERGED  copy the resolved cell text from the runway row immediately
 *           above, tagged { provenance: "ROWSPAN_INHERITED" }.
 *   BLANK   the cell is genuinely empty on the chart; stays empty, CHARTED.
 *   TEXT    the transcription dropped printed data -> DataIntegrityError.
 *           A re-scan is required; inventing the missed text is forbidden.
 *
 * Anything else — unparseable verdict, missing RWY/AT/TURN header, a runway
 * row with no identifier, a MERGED verdict with no runway row above, or a
 * degenerate transcription demanding more classifier calls than any real
 * chart could need — is a DataIntegrityError (-> 422), never a guess.
 * Classifier infrastructure failures (HTTP / timeout) throw plain Errors so
 * the caller surfaces them as 500s, consistent with the other LLM calls.
 */
const { DataIntegrityError } = require("../geo/DataIntegrityError");

const CLASSIFIER_VERDICTS = ["MERGED", "BLANK", "TEXT"];

// A real EFP table has a handful of runways; needing more targeted checks
// than this means the transcription is degenerate, not the chart.
const MAX_CLASSIFIER_CALLS = 16;

/** Matches markdown separator cells like ---, :---, ---:, :---: */
const SEPARATOR_CELL = /^:?-+:?$/;

/**
 * Splits a Markdown table into a 2D array of trimmed cell strings.
 * Boundary pipes produce empty leading/trailing artifacts which are
 * stripped; interior empty cells (the whole point) are preserved.
 * Separator rows (| --- | --- |) are dropped.
 */
function parseMarkdownTable(markdownText) {
    const rows = [];

    for (const rawLine of String(markdownText).split(/\r?\n/)) {
        const line = rawLine.trim();

        if (line === "" || !line.includes("|")) {
            continue;
        }

        let cells = line.split("|").map((cell) => cell.trim());

        if (cells.length > 0 && cells[0] === "" && line.startsWith("|")) {
            cells = cells.slice(1);
        }

        if (cells.length > 0 && cells[cells.length - 1] === "" && line.endsWith("|")) {
            cells = cells.slice(0, -1);
        }

        if (cells.length === 0 || cells.every((cell) => cell === "" || SEPARATOR_CELL.test(cell))) {
            continue;
        }

        rows.push(cells);
    }

    return rows;
}

/**
 * A data row is interrogated only if its RWY cell looks like a runway
 * identifier (leading digit: "16L/R", "17", "35"). Rows like "ALL AIRCRAFT"
 * or "CAT A/B" are section banners, not runways — classifying them would
 * ask the vision model about cells that do not exist.
 */
function isRunwayIdentifier(cellText) {
    return /^\d/.test(cellText);
}

function buildClassifierPrompt(columnName, runwayIdentifier) {
    return `You are a precision aeronautical inspector. ` +
        `Look at the 'ENGINE FAILURE PROCEDURES' table in this image. ` +
        `Focus specifically on the ${columnName} column for Runway ${runwayIdentifier}. ` +
        `Answer this single question: Is this cell physically merged with the row above it, ` +
        `or does it have a hard printed line separating it? ` +
        `Output exactly ONE token: MERGED if it shares the space with the row above, ` +
        `BLANK if it has its own empty boxed cell, ` +
        `or TEXT if there is text we missed.`;
}

/**
 * Normalizes the classifier reply to one of the three verdicts. Tolerates
 * only surrounding whitespace/punctuation around a single token ("MERGED.",
 * " blank "). A sentence, an explanation, or any other content is rejected:
 * a classifier that cannot follow a one-token contract cannot be trusted to
 * have inspected the right cell.
 */
function parseVerdict(rawResponse, columnName, runwayIdentifier) {
    const cleaned = String(rawResponse).trim().toUpperCase().replace(/^[^A-Z]+|[^A-Z]+$/g, "");

    if (!CLASSIFIER_VERDICTS.includes(cleaned)) {
        throw new DataIntegrityError(
            `Tier-2 classifier returned an unusable verdict for the ${columnName} cell of runway ` +
                `${runwayIdentifier}: "${String(rawResponse).slice(0, 120)}". ` +
                `Expected exactly one token of: ${CLASSIFIER_VERDICTS.join(", ")}.`
        );
    }

    return cleaned;
}

async function classifyCell({ columnName, runwayIdentifier, imageBase64, visionModelName, ollamaUrl, fetchFn, timeoutMs }) {
    const response = await fetchFn(ollamaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: visionModelName,
            prompt: buildClassifierPrompt(columnName, runwayIdentifier),
            images: [imageBase64],
            stream: false,
            options: { temperature: 0.0 }
        }),
        signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status} ${response.statusText} during Tier-2 cell classification`);
    }

    const rawVerdict = ((await response.json()).response || "").trim();

    return parseVerdict(rawVerdict, columnName, runwayIdentifier);
}

/**
 * Builds the fully populated provenance grid from a Markdown transcription,
 * resolving every empty AT/TURN cell of every runway row via targeted
 * vision classification.
 *
 * @param {string} markdownText   Stage-1 Markdown transcription (defenced).
 * @param {object} options
 * @param {string} options.imageBase64      The original chart image (bare base64).
 * @param {string} options.visionModelName  Vision model for classification calls.
 * @param {string} [options.ollamaUrl]      Ollama generate endpoint.
 * @param {Function} [options.fetchFn]      Injectable fetch for testing.
 * @param {number} [options.timeoutMs]      Per-classification timeout.
 * @param {Function} [options.trace]        analyzeTrace-style hook.
 * @returns {Promise<{ grid: Array<Array<{text: string, provenance: string}>>, classifierResults: Array<object> }>}
 */
async function buildProvenanceGrid(markdownText, {
    imageBase64,
    visionModelName,
    ollamaUrl = "http://llm:11434/api/generate",
    fetchFn = fetch,
    timeoutMs = 120_000,
    trace = () => {}
} = {}) {
    const rows = parseMarkdownTable(markdownText);

    if (rows.length === 0) {
        throw new DataIntegrityError("Vision OCR output contains no Markdown table rows.");
    }

    const headerRowIndex = rows.findIndex((cells) => cells.some((cell) => /^RWY$/i.test(cell)));

    if (headerRowIndex === -1) {
        throw new DataIntegrityError(
            "Vision OCR table has no RWY header row; the AT/TURN columns cannot be located."
        );
    }

    const headerCells = rows[headerRowIndex];
    const dataColumns = [];

    for (const columnLabel of ["AT", "TURN"]) {
        const columnIndex = headerCells.findIndex((cell) => new RegExp(`^${columnLabel}$`, "i").test(cell));

        if (columnIndex === -1) {
            throw new DataIntegrityError(
                `Vision OCR table header (${headerCells.join(" | ")}) is missing the ${columnLabel} column.`
            );
        }

        dataColumns.push({ label: columnLabel, index: columnIndex });
    }

    const rwyColumnIndex = headerCells.findIndex((cell) => /^RWY$/i.test(cell));
    const columnCount = Math.max(...rows.map((cells) => cells.length));

    // Uniform grid, everything CHARTED until a classification says otherwise.
    const grid = rows.map((cells) => {
        const row = [];
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
            row.push({ text: cells[columnIndex] ?? "", provenance: "CHARTED" });
        }
        return row;
    });

    const classifierResults = [];
    let previousRunwayRowIndex = null;

    for (let rowIndex = headerRowIndex + 1; rowIndex < grid.length; rowIndex += 1) {
        const identifier = grid[rowIndex][rwyColumnIndex].text;

        if (identifier === "") {
            throw new DataIntegrityError(
                `Vision OCR table row ${rowIndex + 1} has no runway identifier in the RWY column; ` +
                    `the row cannot be attributed to a runway.`
            );
        }

        if (!isRunwayIdentifier(identifier)) {
            // Section banner (e.g. "ALL AIRCRAFT"): carried in the grid for
            // context, never interrogated.
            continue;
        }

        for (const { label, index } of dataColumns) {
            const cell = grid[rowIndex][index];

            if (cell.text !== "") {
                continue;
            }

            if (classifierResults.length >= MAX_CLASSIFIER_CALLS) {
                throw new DataIntegrityError(
                    `Tier-2 classification aborted: more than ${MAX_CLASSIFIER_CALLS} empty cells require ` +
                        `visual inspection. The transcription is degenerate; re-scan the chart.`
                );
            }

            trace("tier2_classifier_call", { runway: identifier, column: label });

            const verdict = await classifyCell({
                columnName: label,
                runwayIdentifier: identifier,
                imageBase64,
                visionModelName,
                ollamaUrl,
                fetchFn,
                timeoutMs
            });

            classifierResults.push({ runway: identifier, column: label, verdict });
            trace("tier2_classifier_result", { runway: identifier, column: label, verdict });

            if (verdict === "TEXT") {
                throw new DataIntegrityError(
                    `Tier-2 classifier reports printed text in the ${label} cell for runway ${identifier} ` +
                        `that the transcription missed. Refusing to proceed with dropped data; re-scan the chart.`
                );
            }

            if (verdict === "MERGED") {
                if (previousRunwayRowIndex === null) {
                    throw new DataIntegrityError(
                        `Tier-2 classifier reports the ${label} cell for runway ${identifier} is merged with ` +
                            `the row above, but there is no runway row above it to inherit from.`
                    );
                }

                // Inherit the RESOLVED cell above, so multi-row merges
                // cascade (17 inherits what 16L/R resolved to).
                const source = grid[previousRunwayRowIndex][index];
                grid[rowIndex][index] = { text: source.text, provenance: "ROWSPAN_INHERITED" };
            }
            // BLANK: genuinely empty boxed cell — stays "", CHARTED.
        }

        previousRunwayRowIndex = rowIndex;
    }

    return { grid, classifierResults };
}

module.exports = {
    CLASSIFIER_VERDICTS,
    MAX_CLASSIFIER_CALLS,
    parseMarkdownTable,
    buildProvenanceGrid
};
