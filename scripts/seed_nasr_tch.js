/**
 * Idempotent NASR ground-truth seed for local cycle-compiler tests.
 *
 * Live FAA ingest already carries WASATCH TCH (VORTAC, UT → ARINC region K2).
 * This script upserts that same station into the covering AIRAC cycle so a
 * host without a full NASR sideload can still resolve ICAO region.
 *
 * TCH is Utah (K2), not K4. K4 is AR/AZ/CA/LA/NM/NV/OK/TX.
 *
 *   docker compose exec app node scripts/seed_nasr_tch.js
 *   MONGODB_URI=mongodb://localhost:27017/emproview node scripts/seed_nasr_tch.js
 */
require("dotenv").config();

const { MongoClient } = require("mongodb");
const { PUBLIC_OPERATOR_ID } = require("../utils/navDbQuery");

const TCH = {
    identifier: "TCH",
    name: "WASATCH",
    type: "VORTAC",
    state: "UT",
    latitude: 40.85025913,
    longitude: -111.98190558,
    elevation: 4216.2,
    magneticVariation: 16
};

async function main() {
    const uri = process.env.MONGODB_URI;

    if (!uri) {
        throw new Error("MONGODB_URI is required. Run inside the app container or set it in .env.");
    }

    const client = new MongoClient(uri);
    await client.connect();
    const navData = client.db("emproview").collection("nav_data");

    try {
        const meta = await navData.findOne({ docType: "meta" }, { sort: { airacCycle: -1 } });

        if (!meta?.airacCycle) {
            throw new Error("nav_data has no AIRAC meta document. Ingest NASR before seeding TCH.");
        }

        const airacCycle = meta.airacCycle;
        const filter = {
            docType: "navaid",
            identifier: TCH.identifier,
            airacCycle,
            operator_id: PUBLIC_OPERATOR_ID
        };

        const result = await navData.updateOne(
            filter,
            {
                $setOnInsert: {
                    docType: "navaid",
                    identifier: TCH.identifier,
                    airacCycle,
                    operator_id: PUBLIC_OPERATOR_ID
                },
                $set: {
                    candidates: [
                        {
                            name: TCH.name,
                            type: TCH.type,
                            state: TCH.state,
                            latitude: TCH.latitude,
                            longitude: TCH.longitude,
                            elevation: TCH.elevation,
                            magneticVariation: TCH.magneticVariation
                        }
                    ]
                }
            },
            { upsert: true }
        );

        const action = result.upsertedCount ? "inserted" : "updated";
        console.log(
            `TCH ${action} in nav_data cycle ${airacCycle} ` +
                `(${TCH.name} ${TCH.type}, state ${TCH.state} → ICAO region K2).`
        );
    } finally {
        await client.close();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
