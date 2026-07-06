/**
 * Smoke test for the refactored geodetic engine.
 * Run: node scripts/smoke_geo_engine.js
 */
const assert = require("assert");
const { segmentProcessor, DataIntegrityError, GeoMath } = require("../backend/geo_engine");
const navDbQuery = require("../utils/navDbQuery");

// 1. True North normalization is pure and correct.
assert.strictEqual(GeoMath.magneticToTrue(320, 11.6), 331.6);
assert.strictEqual(GeoMath.trueToMagnetic(331.6, 11.6), 320);
assert.strictEqual(GeoMath.magneticToTrue(355, 10), 5);

// Expected values are derived from the live ground-truth database so the
// test stays valid across AIRAC cycles and data sources.
const runway16L = navDbQuery.getRunway("KSLC", "16L");
const expectedTargetTrue = GeoMath.magneticToTrue(320, runway16L.magneticVariation);
const expectedTurn = GeoMath.getAngularDifference(runway16L.trueHeading, expectedTargetTrue, "left");

// 2. KSLC 16L: maintain runway heading until D11.6 TCH, then left heading 320 (magnetic).
const kslcSegment = {
    segmentType: "HEADING_TO_ALTITUDE",
    label: "D11.6 TCH",
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
};
const result = segmentProcessor.process(kslcSegment, { runways: ["16L"] }, { airportCode: "KSLC" });

assert.ok(result.computedTurnPoint, "expected computedTurnPoint for single-runway row");
assert.strictEqual(result.triggerType, "RADIAL_DISTANCE_INTERSECTION");
assert.strictEqual(result.computedTurnPoint.departureTrueHeading, runway16L.trueHeading);
assert.strictEqual(result.computedTurnPoint.targetMagneticHeading, 320);
assert.strictEqual(result.computedTurnPoint.targetHeading, expectedTargetTrue);
assert.strictEqual(result.computedTurnPoint.turnDirection, "left");
assert.ok(result.computedTurnPoint.dmeErrorNM <= 0.001, "turn point must sit on the DME arc");
assert.ok(
    Math.abs(result.computedTurnPoint.distanceAlongTrackNM - 11.6) < 5,
    "turn point should be roughly 11.6 NM down-track of the field"
);
console.log("KSLC 16L turn point:", result.computedTurnPoint);

// 3. Straight-through fix: turnDirection "not_applicable" and null heading
//    yields the intersection geometry with no turn telemetry and no error.
const straightThroughSegment = {
    segmentType: "TRACK_TO_FIX",
    label: "D11.6 TCH (no turn)",
    spatialTrigger: {
        triggerType: "RADIAL_DISTANCE_INTERSECTION",
        referenceNavaid: "TCH",
        triggerDistanceNM: 11.6,
        resultingAction: {
            actionType: null,
            turnDirection: "not_applicable",
            magneticHeading: null
        }
    }
};
const straightThrough = segmentProcessor.process(
    straightThroughSegment,
    { runways: ["16L"] },
    { airportCode: "KSLC" }
);

assert.ok(straightThrough.computedTurnPoint, "expected computedTurnPoint for straight-through fix");
assert.strictEqual(straightThrough.computedTurnPoint.latitude, result.computedTurnPoint.latitude);
assert.strictEqual(straightThrough.computedTurnPoint.longitude, result.computedTurnPoint.longitude);
assert.strictEqual(straightThrough.computedTurnPoint.turnDirection, "not_applicable");
assert.strictEqual(straightThrough.computedTurnPoint.targetHeading, undefined);
assert.strictEqual(straightThrough.computedTurnPoint.turnDegrees, undefined);
console.log("Straight-through fix:", straightThrough.computedTurnPoint);

// 3b. A null resultingAction is also a valid straight-through fix.
const nullActionResult = segmentProcessor.process(
    {
        spatialTrigger: {
            triggerType: "RADIAL_DISTANCE_INTERSECTION",
            referenceNavaid: "TCH",
            triggerDistanceNM: 11.6,
            resultingAction: null
        }
    },
    { runways: ["16L"] },
    { airportCode: "KSLC" }
);
assert.strictEqual(nullActionResult.computedTurnPoint.turnDirection, "not_applicable");

// 3c. A commanded heading with a missing/invalid direction is a clear turn
//     intent with corrupt data and must fail fast.
assert.throws(
    () =>
        segmentProcessor.process(
            {
                spatialTrigger: {
                    triggerType: "RADIAL_DISTANCE_INTERSECTION",
                    referenceNavaid: "TCH",
                    triggerDistanceNM: 11.6,
                    resultingAction: { actionType: "TURN_HEADING", turnDirection: null, magneticHeading: 320 }
                }
            },
            { runways: ["16L"] },
            { airportCode: "KSLC" }
        ),
    DataIntegrityError
);

// 3d. A turn direction without a commanded heading is also corrupt.
assert.throws(
    () =>
        segmentProcessor.process(
            {
                spatialTrigger: {
                    triggerType: "RADIAL_DISTANCE_INTERSECTION",
                    referenceNavaid: "TCH",
                    triggerDistanceNM: 11.6,
                    resultingAction: { actionType: "TURN_HEADING", turnDirection: "left", magneticHeading: null }
                }
            },
            { runways: ["16L"] },
            { airportCode: "KSLC" }
        ),
    DataIntegrityError
);

// 4. Segments without a spatial trigger are passed through untouched.
assert.strictEqual(segmentProcessor.process({ spatialTrigger: null }, {}, {}), null);

// 5. Unknown trigger types fail fast.
assert.throws(
    () =>
        segmentProcessor.process(
            { spatialTrigger: { triggerType: "HEADING_TO_ALTITUDE" } },
            { runways: ["16L"] },
            { airportCode: "KSLC" }
        ),
    DataIntegrityError
);

// 6. Missing schema fields fail fast.
assert.throws(
    () =>
        segmentProcessor.process(
            {
                spatialTrigger: {
                    triggerType: "RADIAL_DISTANCE_INTERSECTION",
                    referenceNavaid: "TCH",
                    triggerDistanceNM: null,
                    resultingAction: { turnDirection: "left", magneticHeading: 320 }
                }
            },
            { runways: ["16L"] },
            { airportCode: "KSLC" }
        ),
    DataIntegrityError
);

// 7. Unknown ground truth (runway not in navDb) fails fast.
assert.throws(
    () => segmentProcessor.process(kslcSegment, { runways: ["09C"] }, { airportCode: "KSLC" }),
    DataIntegrityError
);

// 8. Path artifact: hybrid parametric + GeoJSON payload with provenance.
const artifact = result.computedTurnPoint.path;
assert.ok(artifact, "expected path artifact on computed turn point");
assert.strictEqual(artifact.parametric.legType, "TRACK_TO_TRIGGER_TURN");
assert.strictEqual(artifact.parametric.turn.radiusSource, "nominal_display");
assert.strictEqual(artifact.parametric.turn.sweepDegrees, expectedTurn.turnDegrees);
assert.strictEqual(artifact.parametric.turn.exitTrueHeading, expectedTargetTrue);
assert.ok(Number.isFinite(artifact.parametric.turn.center.latitude), "turn center must be a WGS-84 coordinate");
const track = artifact.geojson.features.find((f) => f.geometry.type === "LineString");
assert.ok(track.geometry.coordinates.length > 20, "arc should be discretized into the LineString");
assert.strictEqual(result.groundTruth.airacCycle.ident, navDbQuery.getActiveCycle().ident);

// Straight-through paths also carry an artifact, with no turn record.
const straightArtifact = straightThrough.computedTurnPoint.path;
assert.strictEqual(straightArtifact.parametric.legType, "TRACK_THROUGH_TRIGGER");
assert.strictEqual(straightArtifact.parametric.turn, null);
assert.strictEqual(
    straightArtifact.parametric.outbound.trueHeading,
    straightArtifact.parametric.inbound.trueHeading
);

// 9. Multi-runway rows emit one path per runway (the chart's parallel fan).
const fan = segmentProcessor.process(kslcSegment, { runways: ["16L", "16R", "17"] }, { airportCode: "KSLC" });
assert.strictEqual(fan.computedTurnPoints.length, 3);
assert.ok(fan.computedTurnPoints.every((point) => point.path?.geojson));

// 10. Duplicate navaid idents: spatial disambiguation, never a blind guess.
const navDatabase = require("../data/navDatabase.json");
const duplicatedIdent = Object.keys(navDatabase.navaids).find(
    (ident) => Array.isArray(navDatabase.navaids[ident]) && navDatabase.navaids[ident].length > 1
);
assert.ok(duplicatedIdent, "expected at least one duplicated navaid ident in NASR data");

const [stationA, stationB] = navDatabase.navaids[duplicatedIdent];

// Without a reference point, a duplicated ident must fail-safe.
assert.throws(() => navDbQuery.getNavaid(duplicatedIdent), DataIntegrityError);

// With a reference point, the spatially closest station wins deterministically.
const nearA = navDbQuery.getNavaid(duplicatedIdent, { latitude: stationA.latitude, longitude: stationA.longitude });
assert.strictEqual(nearA.latitude, stationA.latitude);
assert.ok(nearA.disambiguation.candidateCount >= 2);
assert.ok(nearA.disambiguation.selectedDistanceNM < nearA.disambiguation.nextNearestDistanceNM);

const nearB = navDbQuery.getNavaid(duplicatedIdent, { latitude: stationB.latitude, longitude: stationB.longitude });
assert.strictEqual(nearB.latitude, stationB.latitude);
console.log(
    `Duplicate ident ${duplicatedIdent}: ${nearA.disambiguation.candidateCount} stations, ` +
    `resolved ${nearA.type}/${nearA.state} vs ${nearB.type}/${nearB.state} by proximity.`
);

// The solver records which physical station resolved the ident.
assert.strictEqual(result.resolvedNavaid.name, "WASATCH");
assert.ok(Number.isFinite(result.resolvedNavaid.latitude));

// 11. AIRAC temporal enforcement: stale ground truth throws AiracExpiredError.
const { AiracExpiredError } = require("../backend/geo_engine");
const activeCycle = navDbQuery.getActiveCycle();
assert.throws(
    () => navDbQuery.assertCycleCurrent(new Date(Date.parse(activeCycle.effectiveTo) + 86400000)),
    AiracExpiredError
);
assert.ok(navDbQuery.assertCycleCurrent(new Date(Date.parse(activeCycle.effectiveFrom) + 1000)));

console.log("All geo engine smoke tests passed.");
