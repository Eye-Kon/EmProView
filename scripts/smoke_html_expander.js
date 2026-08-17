/**
 * Smoke test for the Phase 4.1 occupancy-grid expander: one happy path
 * (KSLC-style merged rows) and every hard gate. Run: node scripts/smoke_html_expander.js
 */
const assert = require("assert");
const { expandHtmlTable } = require("../backend/extraction/htmlTableExpander");
const { DataIntegrityError } = require("../backend/geo/DataIntegrityError");

// Happy path: 16L/R's AT + TURN cells rowspan down into runway 17's row;
// runway 35 has its own AT but inherits nothing (blank TURN is charted-blank).
const kslcTable = `
<table>
  <tr><th colspan="3">ENGINE FAILURE PROCEDURES</th></tr>
  <tr><th>RWY</th><th>AT</th><th>TURN</th></tr>
  <tr><td>16L/R</td><td rowspan="2">D11.6 TCH</td><td rowspan="2">LEFT Hdg 320</td></tr>
  <tr><td>17</td></tr>
  <tr><td>34L/R</td><td>D4.7 TCH</td><td>LEFT Hdg 330</td></tr>
  <tr><td>35</td><td>D4.2 TCH</td><td></td></tr>
</table>`;

const { grid, rowCount, columnCount } = expandHtmlTable(kslcTable);
assert.strictEqual(rowCount, 6);
assert.strictEqual(columnCount, 3);

// Banner row: colspan spread is CHARTED across all columns.
assert.deepStrictEqual(grid[0].map((c) => c.provenance), ["CHARTED", "CHARTED", "CHARTED"]);

// Runway 17's row: identifier charted, AT/TURN inherited from 16L/R.
assert.deepStrictEqual(grid[3], [
    { text: "17", provenance: "CHARTED" },
    { text: "D11.6 TCH", provenance: "ROWSPAN_INHERITED" },
    { text: "LEFT Hdg 320", provenance: "ROWSPAN_INHERITED" }
]);

// Runway 35: own DME charted, TURN charted-empty (never inherited).
assert.deepStrictEqual(grid[5], [
    { text: "35", provenance: "CHARTED" },
    { text: "D4.2 TCH", provenance: "CHARTED" },
    { text: "", provenance: "CHARTED" }
]);

console.log("happy path OK");

function expectGate(name, html, messageFragment) {
    try {
        expandHtmlTable(html);
        console.error(`FAIL: ${name} did not throw`);
        process.exitCode = 1;
    } catch (error) {
        assert.ok(error instanceof DataIntegrityError, `${name}: expected DataIntegrityError, got ${error.name}`);
        assert.ok(
            error.message.includes(messageFragment),
            `${name}: message "${error.message}" missing "${messageFragment}"`
        );
        console.log(`${name} OK: ${error.message.slice(0, 90)}`);
    }
}

expectGate("missing table", "<p>no table here</p>", "no <table>");

expectGate(
    "multiple tables",
    "<table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table>",
    "exactly one is required"
);

expectGate(
    "overflow",
    `<table>
      <tr><td>16L/R</td><td rowspan="3">D11.6</td></tr>
      <tr><td>17</td></tr>
    </table>`,
    "Refusing to truncate"
);

// A colspan expands sideways into a coordinate reserved by a rowspan from
// the row above: two cells claim the same physical space.
expectGate(
    "collision (overlapping spans)",
    `<table>
      <tr><td>X</td><td rowspan="2">A</td><td>Y</td></tr>
      <tr><td colspan="2">C</td><td>Z</td></tr>
    </table>`,
    "already occupied"
);

expectGate(
    "width displacement (hallucinated rowspan over populated row)",
    `<table>
      <tr><td>RWY</td><td>AT</td><td>TURN</td></tr>
      <tr><td rowspan="3">16L/R</td><td>D11.6</td><td>LEFT 320</td></tr>
      <tr><td>17</td><td>x</td><td>y</td></tr>
      <tr><td>34L/R</td><td>D4.7</td><td>LEFT 330</td></tr>
    </table>`,
    "disagree on column count"
);

expectGate(
    "invalid span attribute",
    `<table><tr><td rowspan="banana">A</td></tr><tr><td>B</td></tr></table>`,
    "non-integer rowspan"
);

expectGate(
    "span out of range",
    `<table><tr><td colspan="0">A</td></tr></table>`,
    "outside the accepted range"
);

expectGate("empty table", "<table><tr><td></td></tr></table>", "no cell text");

console.log("all expander smoke tests passed");
