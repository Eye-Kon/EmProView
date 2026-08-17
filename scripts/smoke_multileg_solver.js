/**
 * Smoke test for the Phase 4.3 multi-leg WGS-84 geodesic solver
 * (backend/geo/MultiLegSolver.js).
 *
 * Pure unit test — no MongoDB, no Ollama. Ground truth is synthetic
 * (KCLT-like geometry). Asserts:
 *   1. A full DME -> TURN -> ALTITUDE chain solves sequentially: each leg
 *      starts exactly where the previous one ended.
 *   2. Feature properties carry { runway, legType, provenance, role }.
 *   3. Provenance neutrality: an all-CHARTED and an all-ROWSPAN_INHERITED
 *      copy of the same legs produce IDENTICAL coordinates.
 *   4. Unresolvable stations and unanchored altitude legs reject with
 *      DataIntegrityError (-> 422), never a silent default.
 *
 * Run: node scripts/smoke_multileg_solver.js
 * Or inside the container: docker compose exec app node scripts/smoke_multileg_solver.js
 */
const assert = require("assert");
const {
    solveRunwayEscapePath,
    STANDARD_TURN_RADIUS_NM,
    DEFAULT_CLIMB_GRADIENT_FT_PER_NM
} = require("../backend/geo/MultiLegSolver");
const { DataIntegrityError } = require("../backend/geo/DataIntegrityError");

// Synthetic KCLT-like ground truth: threshold, a runway-aligned True
// heading, and a terminal DME sited ahead of the departure end.
const ORIGIN = { latitude: 35.2271, longitude: -80.9431 };
const DEPARTURE_TRUE_HEADING = 10;
const MAGNETIC_VARIATION = -7; // 7W: True = Magnetic - 7
const FIELD_ELEVATION_FT = 748;
const STATIONS = {
    TCH: {
        identifier: "TCH",
        coordinates: { latitude: 35.19, longitude: -80.95 }
    }
};
const DEFAULT_STATION = STATIONS.TCH;

function legChain(provenance) {
    return [
        { type: "TRACK_TO_DME", value: 11.6, navaid: "TCH", direction: null, provenance },
        { type: "TURN_TO_HEADING", value: 90, navaid: null, direction: "RIGHT", provenance },
        { type: "TRACK_TO_ALTITUDE", value: 10000, navaid: null, direction: null, provenance }
    ];
}

function solve(legs, overrides = {}) {
    return solveRunwayEscapePath({
        runwayId: "36R",
        origin: ORIGIN,
        departureTrueHeading: DEPARTURE_TRUE_HEADING,
        magneticVariation: MAGNETIC_VARIATION,
        startElevationFtMsl: FIELD_ELEVATION_FT,
        legs,
        stationsByIdent: STATIONS,
        defaultStation: DEFAULT_STATION,
        ...overrides
    });
}

function main() {
    console.log("SEQUENTIAL LEG CHAIN");

    const solved = solve(legChain("CHARTED"));

    // One LineString per leg + one trigger point for the DME leg.
    const lines = solved.features.filter((f) => f.geometry.type === "LineString");
    const points = solved.features.filter((f) => f.geometry.type === "Point");
    assert.strictEqual(lines.length, 3, "expected one LineString per leg");
    assert.strictEqual(points.length, 1, "expected one DME trigger point");
    console.log("  ok — 3 leg LineStrings + 1 trigger Point");

    // Continuity: each leg's first coordinate is the previous leg's last
    // parametric endpoint (the final turn leg carries a display-only rollout
    // extension, so continuity is asserted on the parametric record).
    const [dmeLeg, turnLeg, climbLeg] = solved.parametric.legs;
    assert.deepStrictEqual(turnLeg.startPoint, dmeLeg.endPoint, "turn must start at the DME trigger point");
    assert.deepStrictEqual(climbLeg.startPoint, turnLeg.endPoint, "climb must start at the turn rollout");
    console.log("  ok — legs chain sequentially (DME end -> turn start, rollout -> climb start)");

    // The DME trigger point feature sits at the DME leg's endpoint.
    assert.deepStrictEqual(
        points[0].geometry.coordinates,
        [dmeLeg.endPoint.longitude, dmeLeg.endPoint.latitude],
        "trigger point feature must sit at the DME intersection"
    );
    assert.strictEqual(points[0].properties.role, "trigger_point");
    assert.strictEqual(points[0].properties.navaid, "TCH");
    console.log("  ok — trigger point feature at the DME arc intersection");

    // Turn math: RIGHT from True 010 to Magnetic 090 (True 083 at 7W) = +73°,
    // standard-bank radius.
    assert.strictEqual(turnLeg.turn.direction, "right");
    assert.strictEqual(turnLeg.turn.sweepDegrees, 73);
    assert.strictEqual(turnLeg.turn.radiusNM, STANDARD_TURN_RADIUS_NM);
    assert.strictEqual(turnLeg.turn.exitTrueHeading, 83);
    console.log(`  ok — right turn 73° at standard-bank radius ${STANDARD_TURN_RADIUS_NM} NM onto True 083`);

    // Climb profile: altitude accrued over the DME leg + turn arc at the
    // nominal gradient, then the altitude leg covers exactly the remainder.
    // startAltitudeFtMsl is rounded to whole feet in the parametric record,
    // so allow the recomputed distance a rounding tolerance.
    const expectedDistance = (10000 - climbLeg.climb.startAltitudeFtMsl) / DEFAULT_CLIMB_GRADIENT_FT_PER_NM;
    assert.ok(
        Math.abs(climbLeg.climb.distanceNM - expectedDistance) < 0.005,
        "climb distance must close the altitude gap at the gradient"
    );
    assert.strictEqual(solved.parametric.finalAltitudeFtMsl, 10000);
    console.log(`  ok — climb profile closes to 10000 ft MSL over ${climbLeg.climb.distanceNM} NM`);

    // Feature property contract for frontend styling.
    for (const feature of solved.features) {
        assert.strictEqual(feature.properties.runway, "36R");
        assert.ok(["TRACK_TO_DME", "TURN_TO_HEADING", "TRACK_TO_ALTITUDE"].includes(feature.properties.legType));
        assert.strictEqual(feature.properties.provenance, "CHARTED");
        assert.ok(["leg", "trigger_point"].includes(feature.properties.role));
    }
    console.log("  ok — every feature tagged with { runway, legType, provenance, role }");

    console.log("PROVENANCE NEUTRALITY");

    // Same legs, inherited provenance: geometry must be bit-identical.
    const inherited = solve(legChain("ROWSPAN_INHERITED"));
    assert.deepStrictEqual(
        inherited.features.map((f) => f.geometry),
        solved.features.map((f) => f.geometry),
        "ROWSPAN_INHERITED legs must produce identical geometry to CHARTED legs"
    );
    assert.ok(inherited.features.every((f) => f.properties.provenance === "ROWSPAN_INHERITED"));
    console.log("  ok — inherited legs: identical vectors, provenance only in properties");

    console.log("SHORTEST-TURN CONVENTION");

    // No charted direction: Magnetic 300 (True 293) from True 010 is a
    // -77° (left) shortest turn, not +283 right.
    const shortest = solve([
        { type: "TRACK_TO_DME", value: 11.6, navaid: "TCH", direction: null, provenance: "CHARTED" },
        { type: "TURN_TO_HEADING", value: 300, navaid: null, direction: null, provenance: "CHARTED" }
    ]);
    const shortestTurn = shortest.parametric.legs[1].turn;
    assert.strictEqual(shortestTurn.direction, "left");
    assert.strictEqual(shortestTurn.sweepDegrees, -77);
    assert.strictEqual(shortestTurn.directionSource, "shortest_turn");
    console.log("  ok — undirected turn resolves via shortest-turn (-77° left)");

    console.log("FALLBACK DME STATION");

    // A DME leg with no charted station uses the payload navaid.
    const fallback = solve([
        { type: "TRACK_TO_DME", value: 5, navaid: null, direction: null, provenance: "CHARTED" }
    ]);
    assert.strictEqual(fallback.parametric.legs[0].dme.navaid, "TCH");
    console.log("  ok — station-less DME leg falls back to the payload navaid");

    console.log("STRICT REJECTIONS");

    assert.throws(
        () => solve([{ type: "TRACK_TO_DME", value: 5, navaid: "XYZ", direction: null, provenance: "CHARTED" }]),
        (error) => error instanceof DataIntegrityError && /station XYZ was not resolved/.test(error.message)
    );
    console.log("  ok (rejected 422) — DME leg naming an unresolved station");

    assert.throws(
        () => solve(
            [{ type: "TRACK_TO_ALTITUDE", value: 10000, navaid: null, direction: null, provenance: "CHARTED" }],
            { startElevationFtMsl: null }
        ),
        (error) => error instanceof DataIntegrityError && /no field elevation reference/.test(error.message)
    );
    console.log("  ok (rejected 422) — altitude leg with no climb-profile anchor");

    console.log("\nAll multi-leg solver smoke checks passed.");
}

main();
