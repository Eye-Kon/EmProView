/**
 * Phase 6.1 end-to-end HITL gate: prove /api/verify refuses an unjustified
 * 424-bound heading delta, then accepts the same payload with user_id +
 * justification, upserts the canonical procedure, and locks the 5-part
 * identity in OperatorProcedureRegistry.
 *
 * HTTP-only (fetch). Requires a running API and ADMIN_API_KEY.
 *
 *   node scripts/smoke_e2e_pipeline.js
 *   API_BASE_URL=http://localhost:3000 ADMIN_API_KEY=... node scripts/smoke_e2e_pipeline.js
 */
require("dotenv").config();

const API_BASE_URL = (process.env.API_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const API_KEY = process.env.ADMIN_API_KEY;

const IDENTITY = {
    operator_id: "AAL",
    airport_icao: "KSLC",
    procedure_ident: "EF35",
    route_type: "0",
    transition: "35"
};

function buildVerifyPayload({ heading, user_id, justification } = {}) {
    const payload = {
        ...IDENTITY,
        airportCode: IDENTITY.airport_icao,
        airline: "American Airlines",
        procedureType: "Engine Failure Takeoff",
        aircraft: "ALL AIRCRAFT",
        procedureRows: [
            {
                runways: ["35"],
                assignedHeadingDegrees: heading,
                turnDirection: "left",
                instructionText: `KSLC RWY 35 engine-out: turn left heading ${heading}.`,
                legs: [
                    {
                        type: "TURN_TO_HEADING",
                        value: heading,
                        targetMagneticHeading: heading,
                        direction: "LEFT",
                        navaid: null,
                        provenance: "CHARTED"
                    }
                ],
                geometry: {
                    segments: [
                        {
                            segmentType: "HEADING_TO_ALTITUDE",
                            headingDegrees: heading,
                            provenance: "CHARTED"
                        }
                    ]
                }
            }
        ]
    };

    if (user_id !== undefined) {
        payload.user_id = user_id;
    }

    if (justification !== undefined) {
        payload.justification = justification;
    }

    return payload;
}

function matchesIdentity(procedure) {
    return procedure
        && procedure.operator_id === IDENTITY.operator_id
        && procedure.airport_icao === IDENTITY.airport_icao
        && procedure.procedure_ident === IDENTITY.procedure_ident
        && procedure.route_type === IDENTITY.route_type
        && procedure.transition === IDENTITY.transition;
}

async function readJson(response) {
    const text = await response.text();

    if (!text) {
        return {};
    }

    try {
        return JSON.parse(text);
    } catch {
        return { raw: text };
    }
}

async function api(method, path, body) {
    const headers = { Accept: "application/json" };

    if (API_KEY) {
        headers["x-api-key"] = API_KEY;
    }

    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
    });

    return { status: response.status, body: await readJson(response) };
}

function pass(label) {
    console.log(`  ✅ ${label}`);
}

function fail(label, detail) {
    console.log(`  ❌ ${label}`);
    if (detail) {
        console.log(`     ${detail}`);
    }
    throw new Error(label);
}

async function main() {
    console.log("Phase 6.1 E2E HITL gate validation\n");
    console.log(`  API ${API_BASE_URL}`);
    console.log(`  identity ${IDENTITY.operator_id}/${IDENTITY.airport_icao}/` +
        `${IDENTITY.procedure_ident}/${IDENTITY.route_type}/${IDENTITY.transition}\n`);

    if (!API_KEY) {
        fail("ADMIN_API_KEY is required", "Set it in the environment or a .env file.");
    }

    let health;
    try {
        health = await api("GET", "/api/health");
    } catch (error) {
        fail("API is unreachable", `${error.message}. Start the server, then re-run.`);
    }

    if (health.status !== 200 || health.body?.status !== "ok") {
        fail("GET /api/health", `expected 200 ok, got ${health.status} ${JSON.stringify(health.body)}`);
    }
    pass("GET /api/health");

    console.log("\n  Fixture: lock KSLC RWY 35 at charted heading 320");
    const fixture = await api("POST", "/api/verify", buildVerifyPayload({
        heading: 320,
        user_id: "SMOKE_E2E",
        justification: "E2E fixture: seed charted 320 before the 330 HITL delta."
    }));

    if (fixture.status !== 200 && fixture.status !== 201) {
        fail(
            "fixture /api/verify (heading 320)",
            `expected 200/201, got ${fixture.status} ${JSON.stringify(fixture.body)}`
        );
    }
    pass(`baseline published (${fixture.status}) heading 320`);

    console.log("\n  Test 1: Rejection gate (no user_id / justification)");
    const rejected = await api("POST", "/api/verify", buildVerifyPayload({ heading: 330 }));

    if (rejected.status === 200 || rejected.status === 201) {
        fail(
            "unjustified 330 delta was accepted — HITL governance is broken",
            `got ${rejected.status} ${JSON.stringify(rejected.body)}`
        );
    }

    if (rejected.status < 400 || rejected.status >= 500) {
        fail(
            "unjustified 330 delta must be a 400-level reject",
            `got ${rejected.status} ${JSON.stringify(rejected.body)}`
        );
    }
    pass(`POST /api/verify without HITL rejected ${rejected.status}`);

    const unjustified = await api("POST", "/api/verify", buildVerifyPayload({
        heading: 330,
        user_id: "ANALYST_01"
    }));

    if (unjustified.status < 400 || unjustified.status >= 500) {
        fail(
            "330 delta with user_id but no justification must be a 400-level reject",
            `got ${unjustified.status} ${JSON.stringify(unjustified.body)}`
        );
    }
    pass(`POST /api/verify without justification rejected ${unjustified.status}`);

    console.log("\n  Test 2: Identity lock (HITL attestation)");
    const accepted = await api("POST", "/api/verify", buildVerifyPayload({
        heading: 330,
        user_id: "ANALYST_01",
        justification: "Correcting LLM hallucination to charted 330"
    }));

    if (accepted.status !== 200 && accepted.status !== 201) {
        fail(
            "justified 330 delta must lock",
            `expected 200/201, got ${accepted.status} ${JSON.stringify(accepted.body)}`
        );
    }
    pass(`POST /api/verify accepted ${accepted.status}`);

    if (!accepted.body?.ok || !accepted.body?.identity) {
        fail("verify response missing ok/identity", JSON.stringify(accepted.body));
    }

    for (const [field, value] of Object.entries(IDENTITY)) {
        if (accepted.body.identity[field] !== value) {
            fail(
                `verify identity.${field}`,
                `expected ${value}, got ${accepted.body.identity[field]}`
            );
        }
    }
    pass("5-part identity echoed on the lock receipt");

    if (accepted.body.registry?.status !== "ACTIVE") {
        fail(
            "registry lock",
            `expected registry.status ACTIVE, got ${JSON.stringify(accepted.body.registry)}. ` +
                "Restart the API so POST /api/verify returns the OperatorProcedureRegistry receipt."
        );
    }
    pass("OperatorProcedureRegistry status ACTIVE");

    if (!(accepted.body.amendmentCount >= 1)) {
        fail(
            "amendment ledger",
            `expected amendmentCount >= 1 for 320 → 330, got ${accepted.body.amendmentCount}`
        );
    }
    pass(`canonical amendment ledger wrote ${accepted.body.amendmentCount} bound-field change(s)`);

    const listed = await api("GET", "/api/procedures");
    if (listed.status !== 200 || !Array.isArray(listed.body?.procedures)) {
        fail("GET /api/procedures", `got ${listed.status} ${JSON.stringify(listed.body)}`);
    }

    const canonical = listed.body.procedures.find(matchesIdentity);
    if (!canonical) {
        fail(
            "canonical upsert",
            `no procedures document for ${IDENTITY.operator_id}/${IDENTITY.airport_icao}/` +
                `${IDENTITY.procedure_ident}/${IDENTITY.route_type}/${IDENTITY.transition}`
        );
    }

    const storedHeading = canonical.procedureRows?.[0]?.legs?.[0]?.targetMagneticHeading;
    if (storedHeading !== 330) {
        fail("canonical heading", `expected legs[0].targetMagneticHeading 330, got ${storedHeading}`);
    }
    pass("canonical procedures document upserted with targetMagneticHeading 330");

    const ledger = Array.isArray(canonical.amendments) ? canonical.amendments : [];
    const headingAmendment = ledger.find((row) =>
        typeof row.field_path === "string"
        && row.field_path.includes("targetMagneticHeading")
        && row.current_value === 330
        && row.user_id === "ANALYST_01"
    );

    if (!headingAmendment) {
        fail(
            "HITL ledger row for targetMagneticHeading",
            `amendments=${JSON.stringify(ledger.slice(-6))}`
        );
    }
    pass("HITL ledger records ANALYST_01 / charted 330");

    console.log("\n✅ All Phase 6.1 E2E HITL gate checks passed.");
}

main().catch((error) => {
    console.error(`\n❌ Phase 6.1 E2E failed: ${error.message}`);
    process.exit(1);
});
