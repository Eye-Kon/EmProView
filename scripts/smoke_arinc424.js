/**
 * Phase 5.2: ARINC 424-18 catalog packing, terminator registry, exporter.
 * Run: node scripts/smoke_arinc424.js
 */
const assert = require("assert");
const { DataIntegrityError } = require("../backend/geo/DataIntegrityError");
const {
    RECORD_LENGTH,
    encodePdRecord,
    decodePdRecord
} = require("../utils/arinc424Catalog");
const { mapCanonicalLeg, collectCanonicalLegs } = require("../utils/arinc424Mappers");
const { generateArinc424Records, LINE_TERMINATOR } = require("../services/arinc424Exporter");

function verifiedProcedure() {
    return {
        operator_id: "AAL",
        airport_icao: "KSLC",
        procedure_ident: "EF16LA",
        route_type: "0",
        transition: "16L",
        procedureRows: [
            {
                runways: ["16L"],
                assignedHeadingDegrees: 320,
                turnDirection: "left",
                integrity: { status: "enriched", errors: [] },
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
        ]
    };
}

async function main() {
    console.log("Phase 5.2 ARINC 424-18 smokes\n");

    const packed = encodePdRecord({
        recordType: "T",
        customerAreaCode: "AAL",
        sectionCode: "P",
        airportIdentifier: "KSLC",
        icaoCode: "K2",
        subsectionCode: "D",
        procedureIdentifier: "EF16LA",
        routeType: "0",
        transitionIdentifier: "16L",
        sequenceNumber: 10,
        fixIdentifier: "RW16L",
        fixIcaoCode: "K2",
        fixSectionCode: "P",
        fixSubsectionCode: "G",
        continuationNumber: 0,
        pathTerminator: "VD",
        recommendedNavaid: "TCH",
        recommendedNavaidIcao: "K2",
        rho: 11.6,
        routeDistance: 11.6,
        magneticCourse: 164,
        fileRecordNumber: 1,
        cycleDate: "2608"
    });

    assert.strictEqual(packed.length, RECORD_LENGTH);
    assert.ok(!packed.includes("\n") && !packed.includes("\r"));
    const decoded = decodePdRecord(packed);
    assert.strictEqual(decoded.pathTerminator, "VD");
    assert.strictEqual(decoded.rho, "0116");
    assert.strictEqual(decoded.magneticCourse, "1640");
    assert.strictEqual(decoded.procedureIdentifier, "EF16LA");
    assert.strictEqual(decoded.transitionIdentifier, "16L  ");
    console.log("  ok — PD record is 132 chars; course×10 and DME tenths pack correctly");

    const vd = mapCanonicalLeg(
        { type: "TRACK_TO_DME", value: 11.6, navaid: "TCH" },
        { runwayMagneticHeading: 164, path: "leg[0]" }
    );
    assert.strictEqual(vd.pathTerminator, "VD");
    assert.strictEqual(vd.rho, 11.6);
    const vm = mapCanonicalLeg(
        { type: "TURN_TO_HEADING", value: 320, direction: "LEFT" },
        { runwayMagneticHeading: 164, path: "leg[1]" }
    );
    assert.strictEqual(vm.pathTerminator, "VM");
    assert.strictEqual(vm.turnDirection, "L");
    const va = mapCanonicalLeg(
        { type: "TRACK_TO_ALTITUDE", value: 4500 },
        { runwayMagneticHeading: 164, path: "leg[2]" }
    );
    assert.strictEqual(va.pathTerminator, "VA");
    assert.strictEqual(va.altitude, 4500);
    console.log("  ok — TRACK_TO_DME/TURN_TO_HEADING/TRACK_TO_ALTITUDE → VD/VM/VA");

    assert.throws(
        () => mapCanonicalLeg({ type: "TRACK_TO_FIX", value: 1 }, { runwayMagneticHeading: 164 }),
        (error) => error instanceof DataIntegrityError && /unregistered leg type/.test(error.message)
    );
    console.log("  ok (rejected 422) — unregistered terminator is refused");

    assert.throws(
        () => mapCanonicalLeg(
            { type: "TRACK_TO_DME", value: 11.6, navaid: null },
            { runwayMagneticHeading: 164 }
        ),
        (error) => error instanceof DataIntegrityError && /navaid/.test(error.message)
    );
    console.log("  ok (rejected 422) — VD without a navaid is refused");

    const legs = collectCanonicalLegs(verifiedProcedure());
    assert.strictEqual(legs[0].type, "TRACK_TO_DME");
    assert.strictEqual(legs[0].navaid, "TCH");
    assert.strictEqual(legs[1].type, "TURN_TO_HEADING");
    assert.strictEqual(legs[1].value, 320);
    console.log("  ok — verified extract segments collapse to canonical DME + heading legs");

    const fakeNav = {
        async getRunway() {
            return {
                airportCode: "KSLC",
                runwayIdentifier: "16L",
                latitude: 40.788,
                longitude: -111.978,
                trueHeading: 175.5,
                magneticVariation: 11.5,
                elevation_ft: 4227
            };
        },
        async getNavaid() {
            return { identifier: "TCH", state: "UT", latitude: 40.85, longitude: -111.98 };
        }
    };

    const records = await generateArinc424Records(verifiedProcedure(), {
        airacCycle: { ident: "2608" },
        flightDate: new Date("2026-08-17T12:00:00Z"),
        navDb: fakeNav
    });

    assert.strictEqual(records.length, 2);
    assert.ok(records.every((line) => line.length === RECORD_LENGTH));
    assert.strictEqual(decodePdRecord(records[0]).pathTerminator, "VD");
    assert.strictEqual(decodePdRecord(records[1]).pathTerminator, "VM");
    assert.strictEqual(decodePdRecord(records[0]).recommendedNavaid.trim(), "TCH");
    assert.strictEqual(decodePdRecord(records[1]).turnDirection, "L");
    // True 175.5, East var 11.5 → magnetic 164.0
    assert.strictEqual(decodePdRecord(records[0]).magneticCourse, "1640");
    assert.strictEqual(decodePdRecord(records[1]).magneticCourse, "3200");
    console.log("  ok — exporter emits two 132-char PD lines; VD course from NASR trueToMagnetic");

    await assert.rejects(
        () => generateArinc424Records(
            { ...verifiedProcedure(), procedureRows: [{ ...verifiedProcedure().procedureRows[0], integrity: { status: "failed" } }] },
            { airacCycle: { ident: "2608" }, navDb: fakeNav }
        ),
        (error) => error instanceof DataIntegrityError && /unverified/.test(error.message)
    );
    console.log("  ok (rejected 422) — unverified rows are not serialized");

    assert.ok(LINE_TERMINATOR === "\r\n");
    console.log("  ok — records terminate with CR/LF");

    console.log("\nAll ARINC 424-18 smokes passed.");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
