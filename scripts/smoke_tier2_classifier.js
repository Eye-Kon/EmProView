/**
 * Smoke test for the Phase 4.2 Tier-2 targeted classifier. The vision API
 * is mocked with an injectable fetch that replays scripted verdicts, so the
 * deterministic plumbing (markdown parsing, cell targeting, inheritance,
 * provenance, hard gates) is exercised without a live model.
 * Run: node scripts/smoke_tier2_classifier.js
 */
const assert = require("assert");
const { buildProvenanceGrid, parseMarkdownTable } = require("../backend/extraction/tier2Classifier");
const { DataIntegrityError } = require("../backend/geo/DataIntegrityError");

const KSLC_MARKDOWN = `| ENGINE FAILURE PROCEDURES |
| --- |
| TAKEOFF |
| ALL AIRCRAFT |
| RWY | AT | TURN |
| 16L/R | D11.6 TCH | LEFT Hdg 320° |
| 17 | | |
| 34L/R | D4.7 TCH | LEFT Hdg 330° |
| 35 | D4.2 TCH | |`;

/** Fetch stub: pops scripted responses and records each classifier prompt. */
function makeFetchStub(scriptedResponses, capturedPrompts = []) {
    return async (_url, init) => {
        const body = JSON.parse(init.body);
        capturedPrompts.push(body.prompt);
        assert.ok(Array.isArray(body.images) && body.images.length === 1, "classifier call must attach the chart image");

        const next = scriptedResponses.shift();
        if (next === undefined) {
            throw new Error("fetch stub exhausted: more classifier calls than scripted responses");
        }

        return { ok: true, json: async () => ({ response: next }) };
    };
}

async function expectIntegrityError(name, promise, messageFragment) {
    try {
        await promise;
        console.error(`FAIL: ${name} did not throw`);
        process.exitCode = 1;
    } catch (error) {
        assert.ok(error instanceof DataIntegrityError, `${name}: expected DataIntegrityError, got ${error.name}: ${error.message}`);
        assert.ok(error.message.includes(messageFragment), `${name}: "${error.message}" missing "${messageFragment}"`);
        console.log(`${name} OK: ${error.message.slice(0, 90)}`);
    }
}

async function main() {
    // Markdown parsing sanity: banners kept, separator dropped, empties preserved.
    const rows = parseMarkdownTable(KSLC_MARKDOWN);
    assert.strictEqual(rows.length, 8);
    assert.deepStrictEqual(rows[5], ["17", "", ""]);

    // Happy path: 17 fully empty (MERGED x2, tolerating "MERGED." noise),
    // 35's TURN genuinely blank (BLANK).
    const prompts = [];
    const { grid, classifierResults } = await buildProvenanceGrid(KSLC_MARKDOWN, {
        imageBase64: "FAKE64",
        visionModelName: "qwen2.5vl:7b",
        fetchFn: makeFetchStub(["MERGED", " merged. ", "BLANK"], prompts)
    });

    assert.strictEqual(classifierResults.length, 3);
    assert.ok(prompts[0].includes("AT column for Runway 17"));
    assert.ok(prompts[1].includes("TURN column for Runway 17"));
    assert.ok(prompts[2].includes("TURN column for Runway 35"));

    // Runway 17 row: identifier charted, AT/TURN inherited from 16L/R.
    assert.deepStrictEqual(grid[5], [
        { text: "17", provenance: "CHARTED" },
        { text: "D11.6 TCH", provenance: "ROWSPAN_INHERITED" },
        { text: "LEFT Hdg 320°", provenance: "ROWSPAN_INHERITED" }
    ]);

    // Runway 35: own DME charted, TURN confirmed charted-blank.
    assert.deepStrictEqual(grid[7], [
        { text: "35", provenance: "CHARTED" },
        { text: "D4.2 TCH", provenance: "CHARTED" },
        { text: "", provenance: "CHARTED" }
    ]);

    // Banner rows survive untouched and never triggered classification.
    assert.strictEqual(grid[0][0].text, "ENGINE FAILURE PROCEDURES");
    console.log("happy path OK (3 targeted calls, inheritance + provenance correct)");

    // Fully populated table: zero classifier calls.
    const noCalls = await buildProvenanceGrid(
        `| RWY | AT | TURN |\n| 16L/R | D11.6 TCH | LEFT Hdg 320 |`,
        { imageBase64: "FAKE64", visionModelName: "m", fetchFn: makeFetchStub([]) }
    );
    assert.strictEqual(noCalls.classifierResults.length, 0);
    console.log("fully populated table OK (0 classifier calls)");

    // TEXT verdict: OCR dropped printed data -> hard failure.
    await expectIntegrityError(
        "TEXT verdict",
        buildProvenanceGrid(KSLC_MARKDOWN, {
            imageBase64: "FAKE64", visionModelName: "m", fetchFn: makeFetchStub(["TEXT"])
        }),
        "Refusing to proceed with dropped data"
    );

    // Junk verdict: classifier broke the one-token contract.
    await expectIntegrityError(
        "junk verdict",
        buildProvenanceGrid(KSLC_MARKDOWN, {
            imageBase64: "FAKE64", visionModelName: "m", fetchFn: makeFetchStub(["The cell appears to be merged"])
        }),
        "unusable verdict"
    );

    // MERGED with no runway row above it.
    await expectIntegrityError(
        "MERGED with nothing above",
        buildProvenanceGrid(
            `| RWY | AT | TURN |\n| 16L | | LEFT Hdg 320 |`,
            { imageBase64: "FAKE64", visionModelName: "m", fetchFn: makeFetchStub(["MERGED"]) }
        ),
        "no runway row above"
    );

    // Missing RWY header.
    await expectIntegrityError(
        "missing header",
        buildProvenanceGrid(`| 16L/R | D11.6 TCH | LEFT Hdg 320 |`, {
            imageBase64: "FAKE64", visionModelName: "m", fetchFn: makeFetchStub([])
        }),
        "no RWY header row"
    );

    // Runway row with empty identifier.
    await expectIntegrityError(
        "empty runway identifier",
        buildProvenanceGrid(`| RWY | AT | TURN |\n| | D4.2 TCH | |`, {
            imageBase64: "FAKE64", visionModelName: "m", fetchFn: makeFetchStub([])
        }),
        "no runway identifier"
    );

    console.log("all tier-2 classifier smoke tests passed");
}

main().catch((error) => {
    console.error("FAIL:", error);
    process.exitCode = 1;
});
