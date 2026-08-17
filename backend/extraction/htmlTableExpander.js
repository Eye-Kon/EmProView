/**
 * Phase 4.1 Tier-1 structural extraction: deterministic occupancy-grid
 * expansion of the vision model's HTML table transcription.
 *
 * WHY HTML: Markdown cannot express vertically merged cells, so a merged
 * "TURN" cell flattened to markdown becomes indistinguishable from a
 * genuinely blank one — the structural information is destroyed before any
 * downstream code can see it. HTML preserves the physical layout via
 * rowspan/colspan, and cheerio's default parse5 engine implements the
 * WHATWG HTML5 parsing algorithm, whose malformed-input recovery is
 * spec-defined and deterministic (the same tree a browser would build),
 * never a library author's heuristic.
 *
 * THE VISION MODEL IS UNTRUSTED. Parsing is forgiving (parse5 always
 * produces a tree), but acceptance is not: every structural anomaly a
 * hallucinated table could exhibit is a hard DataIntegrityError (-> 422),
 * never a guess:
 *   - zero or multiple <table> elements
 *   - a table with no rows or no cells
 *   - a non-integer / non-positive / absurdly large rowspan or colspan
 *   - a rowspan extending past the last physical <tr> (overflow)
 *   - overlapping spans fighting for the same grid coordinate (collision)
 *   - a span displacing charted cells sideways so data rows disagree on
 *     width (the signature of a hallucinated rowspan overwriting the
 *     legitimate procedure of the runway below)
 *
 * Every cell in the expanded grid carries provenance:
 *   CHARTED            text physically printed in this cell's own <td>/<th>
 *                      (a colspan cell is CHARTED across all its columns —
 *                      the printed cell physically covers them)
 *   ROWSPAN_INHERITED  the coordinate was empty in the DOM and was filled
 *                      by an active rowspan from a cell above
 */
const cheerio = require("cheerio");
const { DataIntegrityError } = require("../geo/DataIntegrityError");

const CELL_PROVENANCES = ["CHARTED", "ROWSPAN_INHERITED"];

// Memory-bomb guard: no real EFP table approaches this. A span attribute
// beyond it is a hallucination, rejected before any array is allocated.
const MAX_SPAN = 20;

/**
 * Parses a rowspan/colspan attribute. Absent -> 1. Anything that is not a
 * plain positive integer within MAX_SPAN is rejected — including the HTML
 * spec's rowspan="0" ("span to end of row group"): a transcription of a
 * printed table has no legitimate use for it, so it is treated as evidence
 * of hallucination rather than intent.
 */
function parseSpanAttribute(rawValue, attributeName, cellDescription) {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
        return 1;
    }

    const trimmed = String(rawValue).trim();

    if (!/^\d+$/.test(trimmed)) {
        throw new DataIntegrityError(
            `HTML table cell ${cellDescription} has a non-integer ${attributeName}="${trimmed}". ` +
                `Span attributes must be plain positive integers.`
        );
    }

    const span = Number.parseInt(trimmed, 10);

    if (span < 1 || span > MAX_SPAN) {
        throw new DataIntegrityError(
            `HTML table cell ${cellDescription} has ${attributeName}="${trimmed}", outside the accepted range 1-${MAX_SPAN}.`
        );
    }

    return span;
}

/** Collapses all whitespace runs so cell text compares and logs cleanly. */
function normalizeCellText(rawText) {
    return rawText.replace(/\s+/g, " ").trim();
}

/**
 * Expands the vision model's HTML transcription into a fully populated 2D
 * grid: grid[row][column] = { text, provenance }.
 *
 * Implements the HTML table processing model's grid algorithm: rows are
 * walked in document order; each cell claims the leftmost unoccupied slot in
 * its row, reserves (colspan) columns, and down-fills (rowspan - 1) rows
 * beneath itself with ROWSPAN_INHERITED copies.
 *
 * @param {string} rawHtml  Vision OCR output (ideally a bare <table>).
 * @returns {{ grid: Array<Array<{text: string, provenance: string}>>, rowCount: number, columnCount: number }}
 */
function expandHtmlTable(rawHtml) {
    if (typeof rawHtml !== "string" || rawHtml.trim() === "") {
        throw new DataIntegrityError("Vision OCR output is empty; no HTML table to expand.");
    }

    // xml: false is the default, pinned explicitly: it selects the parse5
    // HTML parser (WHATWG spec recovery), never the looser htmlparser2 mode.
    const $ = cheerio.load(rawHtml, { xml: false });
    const tables = $("table");

    if (tables.length === 0) {
        throw new DataIntegrityError(
            "Vision OCR output contains no <table> element. The transcription must be a single HTML table."
        );
    }

    if (tables.length > 1) {
        throw new DataIntegrityError(
            `Vision OCR output contains ${tables.length} <table> elements; exactly one is required.`
        );
    }

    const rowElements = tables.first().find("tr").toArray();
    const rowCount = rowElements.length;

    if (rowCount === 0) {
        throw new DataIntegrityError("Vision OCR table contains no <tr> rows.");
    }

    /** @type {Array<Array<{text: string, provenance: string}|undefined>>} */
    const grid = Array.from({ length: rowCount }, () => []);
    /** Physical (CHARTED-origin) cell count per row, for the width gate. */
    const physicalCellCounts = new Array(rowCount).fill(0);

    rowElements.forEach((rowElement, rowIndex) => {
        const cellElements = $(rowElement).children("td, th").toArray();
        physicalCellCounts[rowIndex] = cellElements.length;

        let columnIndex = 0;

        for (const cellElement of cellElements) {
            // Standard reservation walk: skip slots already claimed by spans
            // from earlier rows (or earlier cells in this row).
            while (grid[rowIndex][columnIndex] !== undefined) {
                columnIndex += 1;
            }

            const text = normalizeCellText($(cellElement).text());
            const cellDescription = `at row ${rowIndex + 1}, column ${columnIndex + 1}` +
                (text !== "" ? ` ("${text}")` : " (empty)");
            const rowspan = parseSpanAttribute($(cellElement).attr("rowspan"), "rowspan", cellDescription);
            const colspan = parseSpanAttribute($(cellElement).attr("colspan"), "colspan", cellDescription);

            // OVERFLOW GATE: a span past the last physical row is a
            // hallucinated merge. Truncating it would silently assign this
            // procedure to runways that do not exist on the chart.
            if (rowIndex + rowspan > rowCount) {
                throw new DataIntegrityError(
                    `HTML table cell ${cellDescription} declares rowspan="${rowspan}" but only ` +
                        `${rowCount - rowIndex} row(s) remain in the table. ` +
                        `Refusing to truncate a span that exceeds the physical table.`
                );
            }

            for (let rowOffset = 0; rowOffset < rowspan; rowOffset += 1) {
                for (let colOffset = 0; colOffset < colspan; colOffset += 1) {
                    const targetRow = rowIndex + rowOffset;
                    const targetColumn = columnIndex + colOffset;

                    // COLLISION GATE: a span landing on an already-claimed
                    // coordinate means two cells are fighting for the same
                    // physical space — structurally impossible on a printed
                    // chart, so the transcription is untrustworthy.
                    if (grid[targetRow][targetColumn] !== undefined) {
                        const occupant = grid[targetRow][targetColumn];
                        throw new DataIntegrityError(
                            `HTML table cell ${cellDescription} spans into row ${targetRow + 1}, ` +
                                `column ${targetColumn + 1}, which is already occupied by ` +
                                `"${occupant.text}" (${occupant.provenance}). ` +
                                `Overlapping spans indicate a corrupted transcription.`
                        );
                    }

                    grid[targetRow][targetColumn] = {
                        text,
                        // A colspan cell physically covers its columns in the
                        // printed row -> CHARTED. Only vertical propagation
                        // into later rows is an inheritance.
                        provenance: rowOffset === 0 ? "CHARTED" : "ROWSPAN_INHERITED"
                    };
                }
            }

            columnIndex += colspan;
        }
    });

    // WIDTH GATE: after expansion, every multi-cell row must resolve to the
    // same width. A hallucinated rowspan that lands on a populated row does
    // not overwrite it under the reservation walk — it displaces the charted
    // cells sideways, and the row comes out wider than its siblings. Only
    // single-cell rows (full-width banners like "TAKEOFF" / "ALL AIRCRAFT",
    // or rows whose remaining cells are all span-inherited) are exempt.
    const rowWidths = grid.map((row) => row.length);
    const multiCellRowWidths = new Set(
        rowWidths.filter((_, rowIndex) => physicalCellCounts[rowIndex] > 1)
    );

    if (multiCellRowWidths.size > 1) {
        throw new DataIntegrityError(
            `HTML table rows disagree on column count after span expansion ` +
                `(widths seen: ${[...multiCellRowWidths].join(", ")}). ` +
                `A span has displaced physically charted cells — the transcription structure is untrustworthy.`
        );
    }

    const columnCount = Math.max(...rowWidths);

    // Coordinates never claimed by any cell (short rows) are filled as
    // explicitly empty CHARTED cells: the chart genuinely shows nothing
    // there, and downstream consumers must never meet `undefined`.
    const filledGrid = grid.map((row) => {
        const filledRow = [];
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
            filledRow.push(row[columnIndex] ?? { text: "", provenance: "CHARTED" });
        }
        return filledRow;
    });

    const hasAnyText = filledGrid.some((row) => row.some((cell) => cell.text !== ""));

    if (!hasAnyText) {
        throw new DataIntegrityError("Vision OCR table contains no cell text; the transcription is empty.");
    }

    return { grid: filledGrid, rowCount, columnCount };
}

module.exports = {
    CELL_PROVENANCES,
    MAX_SPAN,
    expandHtmlTable
};
