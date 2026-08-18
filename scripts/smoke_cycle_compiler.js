/**
 * Phase 7.0 multi-tenant cycle compiler — isolation, cycle stamp, payload.
 *
 * Pure unit test of compileOperatorCycle. Registry, canonical store, and
 * exporter are injected so this never touches MongoDB or NASR.
 *
 * Run: node scripts/smoke_cycle_compiler.js
 */
const assert = require("assert");
const { DataIntegrityError } = require("../backend/geo/DataIntegrityError");
const { parseCompileCycleBody } = require("../backend/controllers/cycleCompilerController");
const {
    CYCLE_DATE_START,
    CYCLE_DATE_WIDTH,
    compileOperatorCycle,
    stampAiracCycle,
    concatenateRecords
} = require("../backend/services/cycleCompilerService");
const { RECORD_LENGTH } = require("../utils/arinc424Catalog");
const { LINE_TERMINATOR } = require("../services/arinc424Exporter");

const IDENTITY_A = {
    operator_id: "AAL",
    airport_icao: "KSLC",
    procedure_ident: "EF16LA",
    route_type: "0",
    transition: "16L"
};

const IDENTITY_B = {
    operator_id: "AAL",
    airport_icao: "KDEN",
    procedure_ident: "EF08A",
    route_type: "0",
    transition: "08"
};

const IDENTITY_C = {
    operator_id: "AAL",
    airport_icao: "KPHX",
    procedure_ident: "EF08A",
    route_type: "0",
    transition: "08"
};

function padRecord(tag, cycle = "0000") {
    const core = String(tag).padEnd(RECORD_LENGTH - CYCLE_DATE_WIDTH, " ");
    return core.slice(0, RECORD_LENGTH - CYCLE_DATE_WIDTH) + cycle;
}

async function main() {
    console.log("Phase 7.0 cycle-compiler smokes\n");

    const exact = parseCompileCycleBody({ operator_id: "aal", airac_cycle: "2608" });
    assert.deepStrictEqual(exact, { operatorId: "AAL", airacCycle: "2608" });
    assert.ok(parseCompileCycleBody({ operator_id: "AAL" }).error);
    assert.ok(parseCompileCycleBody({ operator_id: "AAL", airac_cycle: "2608", extra: true }).error);
    assert.ok(parseCompileCycleBody({ operator_id: "AAL", airac_cycle: "26" }).error);
    console.log("  ok — request body is exactly operator_id + airac_cycle (YYNN)");

    const stamped = stampAiracCycle(padRecord("PD"), "2608");
    assert.strictEqual(stamped.length, RECORD_LENGTH);
    assert.strictEqual(stamped.slice(CYCLE_DATE_START - 1, CYCLE_DATE_START - 1 + CYCLE_DATE_WIDTH), "2608");
    console.log("  ok — cycle stamp overwrites columns 129-132");

    const joined = concatenateRecords([padRecord("A", "2608"), padRecord("B", "2608")]);
    assert.ok(joined.endsWith(LINE_TERMINATOR));
    assert.strictEqual(joined.split(LINE_TERMINATOR).filter(Boolean).length, 2);
    console.log("  ok — payload concatenates 132-char records with CR/LF");

    const canon = new Map([
        [JSON.stringify(IDENTITY_A), { ...IDENTITY_A, procedureRows: [] }],
        [JSON.stringify(IDENTITY_C), { ...IDENTITY_C, procedureRows: [] }]
    ]);

    const pack = await compileOperatorCycle({
        operatorId: "AAL",
        airacCycle: "2608",
        listActive: async () => [IDENTITY_A, IDENTITY_B, IDENTITY_C],
        findCanonical: async (identity) => canon.get(JSON.stringify(identity)) || null,
        exportRecords: async (procedure, options) => {
            assert.strictEqual(options.airacCycle.ident, "2608");

            if (procedure.airport_icao === "KPHX") {
                throw new DataIntegrityError(
                    "ARINC 424 export refused: 1 unverified row(s). Only locked verified procedures are serialized."
                );
            }

            return [padRecord(`${procedure.airport_icao}${options.fileRecordStart}`, "9999")];
        }
    });

    assert.strictEqual(pack.operator_id, "AAL");
    assert.strictEqual(pack.airac_cycle, "2608");
    assert.deepStrictEqual(pack.summary, {
        total_attempted: 3,
        total_succeeded: 1,
        total_failed: 2
    });
    assert.strictEqual(pack.rejection_manifest.length, 2);
    assert.strictEqual(pack.rejection_manifest[0].airport_icao, "KDEN");
    assert.match(pack.rejection_manifest[0].reason, /not found/);
    assert.strictEqual(pack.rejection_manifest[1].airport_icao, "KPHX");
    assert.match(pack.rejection_manifest[1].reason, /unverified/);
    assert.ok(!pack.arinc424_payload.includes("KDEN"));
    assert.ok(!pack.arinc424_payload.includes("KPHX"));
    const lines = pack.arinc424_payload.split(LINE_TERMINATOR).filter(Boolean);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].length, RECORD_LENGTH);
    assert.strictEqual(lines[0].slice(128, 132), "2608");
    console.log("  ok — missing canonical and exporter 422 are isolated; cycle 2608 is stamped");

    const empty = await compileOperatorCycle({
        operatorId: "DAL",
        airacCycle: "2609",
        listActive: async () => [],
        findCanonical: async () => {
            throw new Error("findCanonical must not run for an empty registry");
        },
        exportRecords: async () => {
            throw new Error("exportRecords must not run for an empty registry");
        }
    });
    assert.deepStrictEqual(empty.summary, {
        total_attempted: 0,
        total_succeeded: 0,
        total_failed: 0
    });
    assert.strictEqual(empty.arinc424_payload, "");
    assert.deepStrictEqual(empty.rejection_manifest, []);
    console.log("  ok — empty ACTIVE set returns an empty pack, not an exception");

    console.log("\nAll Phase 7.0 cycle-compiler smokes passed.");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
