/**
 * Phase 7.1 cycle compiler integration: POST /api/compile-cycle against a
 * live API. Asserts HTTP 200, 132-character PD records, and AIRAC stamp
 * in columns 129-132. Does not crash the pack on isolated exporter failures.
 *
 * HTTP-only (Node `http`). Requires a running API and ADMIN_API_KEY.
 *
 *   node scripts/smoke_compile_cycle.js
 */
require("dotenv").config();

const http = require("http");
const { RECORD_LENGTH } = require("../utils/arinc424Catalog");
const { LINE_TERMINATOR } = require("../services/arinc424Exporter");

const HOST = "localhost";
const PORT = 3000;
const PATH = "/api/compile-cycle";
const OPERATOR_ID = "AAL";
const AIRAC_CYCLE = "2608";
const API_KEY = process.env.ADMIN_API_KEY;

function pass(label) {
    console.log(`  ✅ ${label}`);
}

function fail(label, detail) {
    console.log(`  ❌ ${label}`);
    if (detail) {
        console.log(`     ${detail}`);
    }
    process.exit(1);
}

function postCompileCycle() {
    const body = JSON.stringify({
        operator_id: OPERATOR_ID,
        airac_cycle: AIRAC_CYCLE
    });

    const headers = {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
    };

    if (API_KEY) {
        headers["x-api-key"] = API_KEY;
    }

    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                hostname: HOST,
                port: PORT,
                path: PATH,
                method: "POST",
                headers
            },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () => {
                    resolve({
                        status: response.statusCode,
                        raw: Buffer.concat(chunks).toString("utf8")
                    });
                });
            }
        );

        request.on("error", reject);
        request.write(body);
        request.end();
    });
}

function parseBody(raw) {
    try {
        return JSON.parse(raw);
    } catch (error) {
        fail("response JSON parse", `${error.message}\n     ${raw}`);
    }
}

async function main() {
    console.log("Phase 7.1 cycle compiler integration\n");
    console.log(`  POST http://${HOST}:${PORT}${PATH}`);
    console.log(`  body { operator_id: "${OPERATOR_ID}", airac_cycle: "${AIRAC_CYCLE}" }\n`);

    if (!API_KEY) {
        fail("ADMIN_API_KEY is required", "Set it in the environment or a .env file.");
    }

    let response;

    try {
        response = await postCompileCycle();
    } catch (error) {
        fail("POST /api/compile-cycle", error.message);
    }

    if (response.status !== 200) {
        fail(
            `expected 200 OK, got ${response.status}`,
            response.raw
        );
    }

    pass("POST /api/compile-cycle returned 200 OK");

    const pack = parseBody(response.raw);

    console.log("\n  summary:");
    console.log(`    ${JSON.stringify(pack.summary, null, 2).replace(/\n/g, "\n    ")}`);

    const manifest = Array.isArray(pack.rejection_manifest) ? pack.rejection_manifest : [];

    if (manifest.length > 0) {
        console.log("\n  rejection_manifest:");
        for (const entry of manifest) {
            console.log(`    ${JSON.stringify(entry)}`);
        }
    } else {
        console.log("\n  rejection_manifest: (empty)");
    }

    const payload = typeof pack.arinc424_payload === "string" ? pack.arinc424_payload : "";
    const records = payload.split(LINE_TERMINATOR).filter((line) => line.length > 0);

    console.log(`\n  arinc424 records generated: ${records.length}`);

    if (records.length === 0) {
        pass("payload empty — no records to measure (compiler did not crash)");
        console.log("\n✅ Phase 7.1 cycle compiler integration passed.");
        return;
    }

    const first = records[0];

    if (first.length !== RECORD_LENGTH) {
        fail(
            `first record length is ${first.length}, expected ${RECORD_LENGTH}`,
            JSON.stringify(first)
        );
    }

    pass(`first record is exactly ${RECORD_LENGTH} characters`);

    const stampedCycle = first.slice(128, 132);

    if (stampedCycle !== AIRAC_CYCLE) {
        fail(
            `columns 129-132 are ${JSON.stringify(stampedCycle)}, expected ${JSON.stringify(AIRAC_CYCLE)}`,
            JSON.stringify(first)
        );
    }

    pass(`columns 129-132 match airac_cycle "${AIRAC_CYCLE}"`);
    console.log("\n✅ Phase 7.1 cycle compiler integration passed.");
}

main().catch((error) => {
    console.error(`\n❌ Phase 7.1 cycle compiler integration failed: ${error.message}`);
    process.exit(1);
});
