/**
 * Phase 5.2: group-level navaid inheritance on the runway matrix.
 * Run: node scripts/smoke_navaid_propagation.js
 */
const assert = require("assert");
const { parseRunwayMatrix, propagateMatrixNavaids } = require("../backend/extraction/parseRunwayMatrix");
const { DataIntegrityError } = require("../backend/geo/DataIntegrityError");

function dmeLeg(value, navaid, provenance = "CHARTED") {
    return {
        type: "TRACK_TO_DME",
        value,
        navaid,
        direction: null,
        provenance
    };
}

function turnLeg(value, provenance = "CHARTED") {
    return {
        type: "TURN_TO_HEADING",
        value,
        navaid: null,
        direction: "LEFT",
        provenance
    };
}

function matrixJson(runways) {
    return JSON.stringify({ runways });
}

function main() {
    console.log("Phase 5.2 navaid propagation smokes\n");

    const dropped35 = parseRunwayMatrix(matrixJson([
        {
            identifier: "16L",
            legs: [dmeLeg(11.6, "TCH"), turnLeg(320)]
        },
        {
            identifier: "35",
            legs: [dmeLeg(4.2, null), turnLeg(330)]
        }
    ]));

    assert.strictEqual(dropped35.runways[1].legs[0].navaid, null);
    propagateMatrixNavaids(dropped35);
    assert.strictEqual(dropped35.runways[1].legs[0].navaid, "TCH");
    assert.strictEqual(dropped35.runways[1].legs[0].provenance, "CHARTED");
    console.log("  ok — RWY 35 inherits group navaid TCH; provenance stays CHARTED");

    const allNull = parseRunwayMatrix(matrixJson([
        { identifier: "35", legs: [dmeLeg(4.2, null), turnLeg(330)] }
    ]));
    propagateMatrixNavaids(allNull, { defaultNavaid: "tch" });
    assert.strictEqual(allNull.runways[0].legs[0].navaid, "TCH");
    console.log("  ok — header/default navaidId fills a charted DME with navaid: null");

    const isolated = parseRunwayMatrix(matrixJson([
        { identifier: "35", legs: [dmeLeg(4.2, null), turnLeg(330)] }
    ]));
    assert.throws(
        () => propagateMatrixNavaids(isolated),
        (error) => error instanceof DataIntegrityError && /missing a navaid/.test(error.message)
    );
    console.log("  ok (rejected 422) — DME with no inheritable navaid is refused");

    console.log("\nAll navaid propagation smokes passed.");
}

main();
