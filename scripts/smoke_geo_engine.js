/**
 * Smoke test for the geodetic engine against the live multi-cycle MongoDB
 * nav_data collection (maintained by backend/jobs/nasrUpdater.js).
 * Run: node scripts/smoke_geo_engine.js  (requires MONGODB_URI in .env)
 */
require("dotenv").config();

const assert = require("assert");
const { MongoClient } = require("mongodb");
const { segmentProcessor, DataIntegrityError, AiracExpiredError, GeoMath } = require("../backend/geo_engine");
const navDbQuery = require("../utils/navDbQuery");

async function main() {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db("emproview");

    try {
        // 0. The query layer fails loudly before injection.
        await assert.rejects(() => navDbQuery.getRunway("KSLC", "16L"), /not initialized/);
        navDbQuery.initNavDb(db);

        // 1. True North normalization is pure and correct.
        assert.strictEqual(GeoMath.magneticToTrue(320, 11.6), 331.6);
        assert.strictEqual(GeoMath.trueToMagnetic(331.6, 11.6), 320);
        assert.strictEqual(GeoMath.magneticToTrue(355, 10), 5);

        // Expected values are derived from the live ground-truth database so the
        // test stays valid across AIRAC cycles and data sources.
        const runway16L = await navDbQuery.getRunway("KSLC", "16L");
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
        const result = await segmentProcessor.process(kslcSegment, { runways: ["16L"] }, { airportCode: "KSLC" });

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
        const straightThrough = await segmentProcessor.process(
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
        const nullActionResult = await segmentProcessor.process(
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
        await assert.rejects(
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
        await assert.rejects(
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

        // 5. Unknown trigger types fail fast (synchronously, in the router).
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
        await assert.rejects(
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
        await assert.rejects(
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
        assert.strictEqual(result.groundTruth.airacCycle.ident, (await navDbQuery.determineActiveCycle()).ident);

        // Straight-through paths also carry an artifact, with no turn record.
        const straightArtifact = straightThrough.computedTurnPoint.path;
        assert.strictEqual(straightArtifact.parametric.legType, "TRACK_THROUGH_TRIGGER");
        assert.strictEqual(straightArtifact.parametric.turn, null);
        assert.strictEqual(
            straightArtifact.parametric.outbound.trueHeading,
            straightArtifact.parametric.inbound.trueHeading
        );

        // 9. Multi-runway rows emit one path per runway (the chart's parallel fan).
        const fan = await segmentProcessor.process(kslcSegment, { runways: ["16L", "16R", "17"] }, { airportCode: "KSLC" });
        assert.strictEqual(fan.computedTurnPoints.length, 3);
        assert.ok(fan.computedTurnPoints.every((point) => point.path?.geojson));

        // 10. Duplicate navaid idents: spatial disambiguation, never a blind guess.
        const activeCycle = await navDbQuery.determineActiveCycle();
        const duplicatedDoc = await db.collection("nav_data").findOne({
            docType: "navaid",
            airacCycle: activeCycle.ident,
            "candidates.1": { $exists: true }
        });
        assert.ok(duplicatedDoc, "expected at least one duplicated navaid ident in NASR data");

        const duplicatedIdent = duplicatedDoc.identifier;
        const [stationA, stationB] = duplicatedDoc.candidates;

        // Without a reference point, a duplicated ident must fail-safe.
        await assert.rejects(() => navDbQuery.getNavaid(duplicatedIdent), DataIntegrityError);

        // With a reference point, the spatially closest station wins deterministically.
        const nearA = await navDbQuery.getNavaid(duplicatedIdent, { latitude: stationA.latitude, longitude: stationA.longitude });
        assert.strictEqual(nearA.latitude, stationA.latitude);
        assert.ok(nearA.disambiguation.candidateCount >= 2);
        assert.ok(nearA.disambiguation.selectedDistanceNM < nearA.disambiguation.nextNearestDistanceNM);

        const nearB = await navDbQuery.getNavaid(duplicatedIdent, { latitude: stationB.latitude, longitude: stationB.longitude });
        assert.strictEqual(nearB.latitude, stationB.latitude);
        console.log(
            `Duplicate ident ${duplicatedIdent}: ${nearA.disambiguation.candidateCount} stations, ` +
            `resolved ${nearA.type}/${nearA.state} vs ${nearB.type}/${nearB.state} by proximity.`
        );

        // The solver records which physical station resolved the ident.
        assert.strictEqual(result.resolvedNavaid.name, "WASATCH");
        assert.ok(Number.isFinite(result.resolvedNavaid.latitude));

        // 11. Multi-cycle temporal targeting: every loaded cycle resolves by a
        //     date inside its own window, and a date beyond all loaded cycles
        //     throws AiracExpiredError.
        const metas = await db.collection("nav_data").find({ docType: "meta" }).toArray();
        assert.ok(metas.length >= 1, "expected at least one AIRAC cycle in nav_data");

        for (const meta of metas) {
            const midWindow = new Date((Date.parse(meta.effectiveFrom) + Date.parse(meta.effectiveTo)) / 2);
            const resolved = await navDbQuery.determineActiveCycle(midWindow);
            assert.strictEqual(resolved.ident, meta.airacCycle);

            // Ground truth is queryable per cycle with an explicit flightDate.
            const cycleRunway = await navDbQuery.getRunway("KSLC", "16L", midWindow);
            assert.strictEqual(cycleRunway.airacCycle, meta.airacCycle);
            assert.ok(Number.isFinite(cycleRunway.trueHeading));
        }
        console.log(`Loaded cycles resolve correctly: ${metas.map((m) => m.airacCycle).sort().join(", ")}.`);

        const beyondAllCycles = new Date(
            Math.max(...metas.map((m) => Date.parse(m.effectiveTo))) + 86400000
        );
        await assert.rejects(() => navDbQuery.determineActiveCycle(beyondAllCycles), AiracExpiredError);
        await assert.rejects(() => navDbQuery.getRunway("KSLC", "16L", beyondAllCycles), AiracExpiredError);
        await assert.rejects(() => navDbQuery.getNavaid("TCH", null, beyondAllCycles), AiracExpiredError);
        assert.ok(await navDbQuery.determineActiveCycle(new Date()));

        // 12. flightDate threads through the solver context to cycle provenance.
        if (metas.length > 1) {
            const upcoming = metas.reduce((a, b) => (Date.parse(a.effectiveFrom) > Date.parse(b.effectiveFrom) ? a : b));
            const upcomingMid = new Date((Date.parse(upcoming.effectiveFrom) + Date.parse(upcoming.effectiveTo)) / 2);
            const futureResult = await segmentProcessor.process(
                kslcSegment,
                { runways: ["16L"] },
                { airportCode: "KSLC", flightDate: upcomingMid }
            );
            assert.strictEqual(futureResult.groundTruth.airacCycle.ident, upcoming.airacCycle);
            console.log(`Solver resolved upcoming cycle ${upcoming.airacCycle} for flight date ${upcomingMid.toISOString()}.`);
        }

        console.log("All geo engine smoke tests passed.");
    } finally {
        await client.close();
    }
}

main().catch((error) => {
    console.error("Smoke test failed:", error);
    process.exit(1);
});
