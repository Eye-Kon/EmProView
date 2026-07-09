/**
 * Smoke test for utils/groundTruthService.js.
 *
 * Runs against the live nav_data collection when it holds a currently
 * effective AIRAC cycle. When the collection is empty (e.g. a fresh
 * air-gapped deployment awaiting its first NASR sideload), it seeds a
 * clearly marked synthetic cycle ("9999"), runs the assertions, and removes
 * the fixture afterwards. It refuses to seed alongside real data.
 *
 * Run inside the app container (or anywhere MONGODB_URI reaches Mongo):
 *   node scripts/smoke_ground_truth.js
 */
const assert = require("assert");
const { MongoClient } = require("mongodb");
const {
    initGroundTruthService,
    resolvePhysicalGroundTruth,
    DataIntegrityError,
    AiracExpiredError
} = require("../utils/groundTruthService");

const SYNTHETIC_CYCLE = "9999";

function buildFixture(now) {
    const from = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const to = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();

    return [
        {
            _id: `airac_${SYNTHETIC_CYCLE}`,
            docType: "meta",
            airacCycle: SYNTHETIC_CYCLE,
            ident: SYNTHETIC_CYCLE,
            effectiveFrom: from,
            effectiveTo: to,
            source: "SMOKE TEST FIXTURE"
        },
        {
            docType: "runway",
            airacCycle: SYNTHETIC_CYCLE,
            key: "KSLC_16L",
            latitude: 40.804012,
            longitude: -111.981478,
            trueHeading: 176.65,
            magneticVariation: 11.0
        },
        {
            docType: "navaid",
            airacCycle: SYNTHETIC_CYCLE,
            identifier: "TCH",
            candidates: [
                // Near KSLC (should win disambiguation).
                { name: "SALT LAKE CITY", type: "VORTAC", state: "UT", latitude: 40.85, longitude: -111.98, magneticVariation: 11.0 },
                // Far duplicate ident.
                { name: "FARAWAY", type: "NDB", state: "FL", latitude: 28.0, longitude: -81.0, magneticVariation: -6.0 }
            ]
        }
    ];
}

async function main() {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const navData = client.db("emproview").collection("nav_data");

    let seeded = false;

    try {
        initGroundTruthService(client.db("emproview"));

        if ((await navData.countDocuments({ docType: "meta" })) === 0) {
            console.log("nav_data is empty; seeding synthetic AIRAC cycle 9999 for the test.");
            await navData.insertMany(buildFixture(new Date()));
            seeded = true;
        }

        // Happy path: full contract for KSLC 16L anchored on TCH.
        const truth = await resolvePhysicalGroundTruth("KSLC", "16L", "TCH");
        assert.ok(truth.airacCycle.ident, "airacCycle.ident missing");
        assert.ok(Number.isFinite(truth.originRunway.threshold.latitude));
        assert.ok(Number.isFinite(truth.originRunway.threshold.longitude));
        assert.ok(Number.isFinite(truth.originRunway.trueHeading));
        assert.ok(Number.isFinite(truth.originRunway.magneticVariation));
        assert.ok(Number.isFinite(truth.navaid.coordinates.latitude));
        assert.ok(Number.isFinite(truth.navaid.coordinates.longitude));
        assert.ok(Number.isFinite(truth.navaid.magneticVariation));
        assert.strictEqual(truth.magneticVariation, truth.originRunway.magneticVariation);
        console.log(JSON.stringify(truth, null, 2));

        if (seeded) {
            // Disambiguation must have picked the near station and attached evidence.
            assert.strictEqual(truth.navaid.name, "SALT LAKE CITY");
            assert.strictEqual(truth.disambiguation.candidateCount, 2);
            assert.ok(truth.disambiguation.selectedDistanceNM < truth.disambiguation.nextNearestDistanceNM);
            assert.ok(truth.disambiguation.note.includes("2 stations"));
            console.log("Duplicate-ident disambiguation selected the nearest station with evidence.");
        }

        // Temporal enforcement: a date beyond every loaded cycle throws
        // AiracExpiredError before any spatial query runs.
        const metas = await navData.find({ docType: "meta" }).toArray();
        const beyond = new Date(Math.max(...metas.map((m) => Date.parse(m.effectiveTo))) + 86400000);
        await assert.rejects(
            () => resolvePhysicalGroundTruth("KSLC", "16L", "TCH", beyond),
            AiracExpiredError
        );
        console.log("AiracExpiredError correctly thrown for a date outside every cycle window.");

        // Fail-fast: a nonexistent runway is a DataIntegrityError, never a guess.
        await assert.rejects(
            () => resolvePhysicalGroundTruth("KSLC", "99Z", "TCH"),
            DataIntegrityError
        );
        console.log("DataIntegrityError correctly thrown for a missing runway.");

        console.log("groundTruthService smoke test PASSED.");
    } finally {
        if (seeded) {
            const removed = await navData.deleteMany({ airacCycle: SYNTHETIC_CYCLE });
            console.log(`Cleaned up synthetic fixture (${removed.deletedCount} documents).`);
        }

        await client.close();
    }
}

main().catch((error) => {
    console.error("SMOKE TEST FAILED:", error);
    process.exit(1);
});
