/**
 * Phase 5.1 governance smokes: 5-part ARINC 424 identity, 424-bound
 * parametric diff, HITL justification gate, OCR provenance preservation.
 *
 * Pure unit test — no MongoDB, no exporter.
 * Run: node scripts/smoke_procedure_identity.js
 */
const assert = require("assert");
const {
    ProcedureIdentityError,
    parseProcedureIdentity,
    collectBoundFields,
    diffBoundFields,
    requireHitlUserId,
    buildAmendments,
    preserveOcrProvenance,
    isLegacyRunwayLockIndex
} = require("../backend/models/canonicalProcedure");

function baseline(overrides = {}) {
    return {
        operator_id: "AAL",
        airport_icao: "KSLC",
        procedure_ident: "EF16LA",
        route_type: "0",
        transition: "16L",
        procedureRows: [
            {
                rowId: "row-16l",
                runways: ["16L"],
                assignedHeadingDegrees: 320,
                turnDirection: "left",
                geometry: {
                    segments: [
                        {
                            segmentType: "HEADING_TO_ALTITUDE",
                            headingDegrees: 164,
                            provenance: "CHARTED",
                            spatialTrigger: {
                                triggerType: "RADIAL_DISTANCE_INTERSECTION",
                                referenceNavaid: "TCH",
                                triggerDistanceNM: 11.6,
                                resultingAction: {
                                    actionType: "TURN_HEADING",
                                    turnDirection: "left",
                                    magneticHeading: 320
                                }
                            }
                        }
                    ]
                }
            }
        ],
        ...overrides
    };
}

function assertIdentityRejects(payload, messagePattern, label) {
    assert.throws(
        () => parseProcedureIdentity(payload),
        (error) => error instanceof ProcedureIdentityError && messagePattern.test(error.message),
        `${label}: expected ProcedureIdentityError matching ${messagePattern}`
    );
    console.log(`  ok (rejected 400) — ${label}`);
}

function main() {
    console.log("Phase 5.1 identity + HITL ledger smokes\n");

    const identity = parseProcedureIdentity(baseline());
    assert.deepStrictEqual(identity, {
        operator_id: "AAL",
        airport_icao: "KSLC",
        procedure_ident: "EF16LA",
        route_type: "0",
        transition: "16L"
    });
    console.log("  ok — 5-part identity parsed and normalized");

    const fromLegacy = parseProcedureIdentity({
        airline: { icao: "aal" },
        airportCode: "kslc",
        procedure_ident: "ef16lh",
        route_type: 0,
        transition: "16l",
        procedureRows: []
    });
    assert.strictEqual(fromLegacy.operator_id, "AAL");
    assert.strictEqual(fromLegacy.airport_icao, "KSLC");
    assert.strictEqual(fromLegacy.procedure_ident, "EF16LH");
    assert.strictEqual(fromLegacy.route_type, "0");
    assert.strictEqual(fromLegacy.transition, "16L");
    console.log("  ok — legacy airportCode / airline.icao / numeric route_type fallbacks");

    assertIdentityRejects(
        { airport_icao: "KSLC", procedure_ident: "EFP", route_type: "0", transition: "16L" },
        /operator_id/,
        "missing operator_id"
    );
    assertIdentityRejects(
        { ...baseline(), procedure_ident: "TOOLONG" },
        /at most 6 characters/,
        "procedure_ident longer than 6"
    );
    assertIdentityRejects(
        { ...baseline(), transition: "RW16LA" },
        /at most 5 characters/,
        "transition longer than 5"
    );

    const twoFleet = [
        parseProcedureIdentity(baseline({ procedure_ident: "EF16LA" })),
        parseProcedureIdentity(baseline({ procedure_ident: "EF16LH" }))
    ];
    assert.notStrictEqual(twoFleet[0].procedure_ident, twoFleet[1].procedure_ident);
    assert.strictEqual(twoFleet[0].transition, twoFleet[1].transition);
    assert.strictEqual(twoFleet[0].route_type, twoFleet[1].route_type);
    console.log("  ok — A32F vs heavy Engine-Out SIDs stay distinct on procedure_ident");

    const fields = collectBoundFields(baseline());
    assert.strictEqual(fields["procedureRows.0.assignedHeadingDegrees"], 320);
    assert.strictEqual(fields["procedureRows.0.geometry.segments.0.spatialTrigger.triggerDistanceNM"], 11.6);
    assert.strictEqual(
        fields["procedureRows.0.geometry.segments.0.spatialTrigger.resultingAction.magneticHeading"],
        320
    );
    assert.ok(!Object.keys(fields).some((path) => /computedSpatialTrigger|latitude|longitude/.test(path)));
    console.log("  ok — 424-bound collector captures headings/DME and ignores coordinates");

    const withTurnLeg = baseline();
    withTurnLeg.procedureRows[0].legs = [{
        type: "TURN_TO_HEADING",
        value: 330,
        targetMagneticHeading: 330,
        direction: "LEFT",
        navaid: null
    }];
    assert.strictEqual(
        collectBoundFields(withTurnLeg)["procedureRows.0.legs.0.targetMagneticHeading"],
        330
    );
    console.log("  ok — TURN_TO_HEADING targetMagneticHeading is a 424-bound field");

    const firstLockDiffs = diffBoundFields({}, baseline());
    assert.ok(firstLockDiffs.length > 0);
    assert.throws(
        () => requireHitlUserId(baseline()),
        (error) => error instanceof ProcedureIdentityError && /user_id/.test(error.message),
        "first lock without user_id must 400"
    );
    assert.throws(
        () => buildAmendments(firstLockDiffs, { ...baseline(), user_id: "analyst.1" }),
        (error) => error instanceof ProcedureIdentityError && /justification/.test(error.message),
        "first lock without justification must 400"
    );
    console.log("  ok (rejected 400) — first publication is a HITL delta from empty");

    const incoming = baseline();
    incoming.procedureRows[0].assignedHeadingDegrees = 330;
    incoming.procedureRows[0].geometry.segments[0].spatialTrigger.resultingAction.magneticHeading = 330;
    incoming.procedureRows[0].geometry.segments[0].computedSpatialTrigger = {
        computedTurnPoints: [{ runway: "16L", path: { geojson: { features: [] } } }]
    };

    const diffs = diffBoundFields(baseline(), incoming);
    assert.strictEqual(diffs.length, 2);
    assert.ok(diffs.some((diff) => diff.field_path.endsWith("assignedHeadingDegrees") && diff.previous_value === 320 && diff.current_value === 330));
    assert.ok(diffs.some((diff) => diff.field_path.endsWith("magneticHeading") && diff.previous_value === 320 && diff.current_value === 330));
    console.log("  ok — canonical diff flags 320 → 330 and ignores GeoJSON noise");

    assert.throws(
        () => buildAmendments(diffs, incoming),
        (error) => error instanceof ProcedureIdentityError && /user_id/.test(error.message),
        "delta without user_id must 400"
    );
    console.log("  ok (rejected 400) — HITL delta missing user_id");

    assert.throws(
        () => buildAmendments(diffs, { ...incoming, user_id: "analyst.1" }),
        (error) => error instanceof ProcedureIdentityError && /justification/.test(error.message),
        "delta without justification must 400"
    );
    console.log("  ok (rejected 400) — HITL delta missing justification");

    const ledger = buildAmendments(diffs, {
        ...incoming,
        user_id: "analyst.1",
        justification: "Chart 10-7E-1 RWY 35 / 16L turn is LEFT 330, not 320."
    }, { now: new Date("2026-08-17T12:00:00Z") });
    assert.strictEqual(ledger.length, 2);
    assert.ok(ledger.every((row) => row.user_id === "analyst.1" && row.justification.includes("330")));
    assert.ok(ledger.every((row) => row.timestamp.toISOString() === "2026-08-17T12:00:00.000Z"));
    console.log("  ok — HITL ledger rows carry user_id, timestamp, justification, previous/current");

    const existing = baseline();
    const edited = baseline();
    edited.procedureRows[0].assignedHeadingDegrees = 330;
    edited.procedureRows[0].geometry.segments[0].provenance = "MODIFIED_BY_HITL";
    preserveOcrProvenance(existing, edited);
    assert.strictEqual(edited.procedureRows[0].assignedHeadingDegrees, 330);
    assert.strictEqual(edited.procedureRows[0].geometry.segments[0].provenance, "CHARTED");
    console.log("  ok — value updates, OCR provenance stays CHARTED");

    assert.strictEqual(
        isLegacyRunwayLockIndex({
            unique: true,
            name: "airportCode_1_procedureRows.runways_1",
            key: { airportCode: 1, "procedureRows.runways": 1 }
        }),
        true
    );
    assert.strictEqual(
        isLegacyRunwayLockIndex({
            unique: true,
            name: "procedure_arinc424_identity_unique",
            key: { operator_id: 1, airport_icao: 1, procedure_ident: 1, route_type: 1, transition: 1 }
        }),
        false
    );
    console.log("  ok — legacy airport+runway unique index is detected; identity index is kept");

    assert.deepStrictEqual(diffBoundFields(baseline(), baseline()), []);
    assert.deepStrictEqual(buildAmendments([], baseline()), []);
    console.log("  ok — identical republish produces no amendments");

    console.log("\nAll Phase 5.1 identity / HITL ledger smokes passed.");
}

main();
