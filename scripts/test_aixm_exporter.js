/**
 * Temporary test: AIXM 5.1 exporter against real engine output.
 * Run: node scripts/test_aixm_exporter.js  (requires MONGODB_URI in .env)
 */
require("dotenv").config();

const assert = require("assert");
const { MongoClient } = require("mongodb");
const { segmentProcessor } = require("./../backend/geo_engine");
const navDbQuery = require("../utils/navDbQuery");
const { generateAixmRoute, UnserializableRouteError } = require("../utils/aixmExporter");

async function main() {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    navDbQuery.initNavDb(client.db("emproview"));

    try {
        const flightDate = new Date("2026-07-07T12:00:00Z");
        const segment = {
            segmentType: "HEADING_TO_ALTITUDE",
            label: "D11.6 TCH",
            spatialTrigger: {
                triggerType: "RADIAL_DISTANCE_INTERSECTION",
                referenceNavaid: "TCH",
                triggerDistanceNM: 11.6,
                resultingAction: { actionType: "TURN_HEADING", turnDirection: "left", magneticHeading: 320 }
            }
        };
        const row = { rowId: "row-1", runways: ["16L", "16R"] };
        const computed = await segmentProcessor.process(segment, row, { airportCode: "KSLC", flightDate });

        const enrichedProcedure = {
            airportCode: "KSLC",
            airline: "Delta",
            aircraft: "737-800",
            procedureRows: [
                {
                    ...row,
                    geometry: { segments: [{ ...segment, computedSpatialTrigger: computed }] },
                    integrity: { status: "enriched", errors: [] }
                }
            ]
        };

        const airacCycle = await navDbQuery.determineActiveCycle(flightDate);
        const xml = generateAixmRoute(enrichedProcedure, airacCycle, flightDate);

        // Structural assertions.
        assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
        assert.ok(xml.includes('xmlns:aixm="http://www.aixm.aero/schema/5.1"'), "AIXM 5.1 namespace");
        assert.ok(xml.includes('xmlns:gml="http://www.opengis.net/gml/3.2"'), "GML 3.2 namespace");
        assert.strictEqual((xml.match(/<aixm:routeSegment>/g) || []).length, 2, "one routeSegment per runway");
        assert.strictEqual((xml.match(/<gml:LineString /g) || []).length, 2);
        assert.ok(xml.includes(`AIRAC cycle ${airacCycle.ident}`), "AIRAC provenance note");
        assert.ok(xml.includes("flight date 2026-07-07T12:00:00.000Z"), "flightDate provenance note");
        assert.ok(xml.includes(`<gml:beginPosition>${airacCycle.effectiveFrom}</gml:beginPosition>`), "featureLifetime begin");
        assert.ok(xml.includes(`<gml:endPosition>${airacCycle.effectiveTo}</gml:endPosition>`), "featureLifetime end");

        // GML axis order: posList pairs must be "latitude longitude" (lat ~40, lon ~-111 for KSLC).
        const posList = xml.match(/<gml:posList>([^<]+)<\/gml:posList>/)[1].trim().split(/\s+/).map(Number);
        assert.ok(posList.length >= 4 && posList.length % 2 === 0, "posList holds coordinate pairs");
        for (let i = 0; i < posList.length; i += 2) {
            assert.ok(posList[i] > 39 && posList[i] < 42, `pair ${i / 2}: first value is latitude`);
            assert.ok(posList[i + 1] < -110 && posList[i + 1] > -113, `pair ${i / 2}: second value is longitude`);
        }

        // Balanced tags for every element we emit.
        for (const tag of ["aixm:Route", "aixm:routeSegment", "aixm:RouteSegment", "aixm:Curve", "gml:LineString",
            "gml:posList", "aixm:annotation", "aixm:Note", "aixm:featureLifetime", "gml:TimePeriod"]) {
            const opens = (xml.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
            const closes = (xml.match(new RegExp(`</${tag}>`, "g")) || []).length;
            assert.strictEqual(opens, closes, `balanced <${tag}> tags`);
        }

        console.log("--- AIXM sample (first 45 lines) ---");
        console.log(xml.split("\n").slice(0, 45).join("\n"));
        console.log(`--- (${xml.split("\n").length} lines total) ---\n`);

        // Failsafe 1: failed rows are rejected before serialization.
        const failedPayload = {
            ...enrichedProcedure,
            procedureRows: [
                enrichedProcedure.procedureRows[0],
                { rowId: "row-2", runways: ["35"], integrity: { status: "failed", errors: ["DataIntegrityError: Runway not found"] } }
            ]
        };
        assert.throws(() => generateAixmRoute(failedPayload, airacCycle, flightDate), UnserializableRouteError);

        // Failsafe 2: missing geometry is rejected.
        assert.throws(() => generateAixmRoute({ airportCode: "KSLC", procedureRows: [] }, airacCycle, flightDate), UnserializableRouteError);

        // Failsafe 3: no computed tracks (no spatial triggers) is rejected.
        const noTriggerPayload = {
            airportCode: "KSLC",
            procedureRows: [{ rowId: "row-1", runways: ["16L"], geometry: { segments: [{ segmentType: "TRACK_TO_FIX" }] }, integrity: { status: "enriched", errors: [] } }]
        };
        assert.throws(() => generateAixmRoute(noTriggerPayload, airacCycle, flightDate), UnserializableRouteError);

        // Failsafe 4: missing AIRAC context is rejected.
        assert.throws(() => generateAixmRoute(enrichedProcedure, null, flightDate), UnserializableRouteError);

        console.log("All AIXM exporter tests passed.");
    } finally {
        await client.close();
    }
}

main().catch((error) => {
    console.error("AIXM exporter test failed:", error);
    process.exit(1);
});
