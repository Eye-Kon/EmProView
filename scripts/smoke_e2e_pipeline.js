/**
 * Phase 6.2 end-to-end HITL governance: prove /api/verify refuses an
 * unjustified 424-bound heading delta, accepts a justified lock, allows a
 * second fleet identity on the same runway, ignores non-424 coordinate
 * noise, and preserves CHARTED provenance with an ANALYST_01 ledger row.
 *
 * HTTP-only (fetch). Requires a running API and ADMIN_API_KEY.
 *
 *   node scripts/smoke_e2e_pipeline.js
 *   API_BASE_URL=http://localhost:3000 ADMIN_API_KEY=... node scripts/smoke_e2e_pipeline.js
 */
require("dotenv").config();

const API_BASE_URL = (process.env.API_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const API_KEY = process.env.ADMIN_API_KEY;

/** Narrow-body Engine-Out SID locked in Tests 1–2 / 4–5. */
const IDENTITY_A = {
    operator_id: "AAL",
    airport_icao: "KSLC",
    procedure_ident: "EF35A",
    route_type: "0",
    transition: "35"
};

/** Heavy fleet split: same airport + runway, distinct 5-part ARINC key. */
const IDENTITY_H = {
    operator_id: "AAL",
    airport_icao: "KSLC",
    procedure_ident: "EF35H",
    route_type: "1",
    transition: "35"
};

const BASELINE_START = { latitude: 40.7881, longitude: -111.9778 };
const SILENT_LATITUDE = 40.7889;

function buildVerifyPayload({
    identity = IDENTITY_A,
    heading,
    user_id,
    justification,
    startPoint = BASELINE_START
} = {}) {
    const payload = {
        ...identity,
        airportCode: identity.airport_icao,
        airline: "American Airlines",
        procedureType: "Engine Failure Takeoff",
        aircraft: identity.procedure_ident === IDENTITY_H.procedure_ident ? "HEAVY" : "A32F",
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
                        provenance: "CHARTED",
                        startPoint: { ...startPoint }
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

function identityQuery(identity) {
    const params = new URLSearchParams({
        airport_icao: identity.airport_icao,
        route_type: identity.route_type,
        transition: identity.transition
    });

    return `/api/procedures/${encodeURIComponent(identity.operator_id)}/${encodeURIComponent(identity.procedure_ident)}?${params}`;
}

function formatIdentity(identity) {
    return `${identity.operator_id}/${identity.airport_icao}/` +
        `${identity.procedure_ident}/${identity.route_type}/${identity.transition}`;
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

function assertAccepted(result, label) {
    if (result.status !== 200 && result.status !== 201) {
        fail(label, `expected 200/201, got ${result.status} ${JSON.stringify(result.body)}`);
    }
}

function cloneWithoutMongoId(document) {
    const clone = JSON.parse(JSON.stringify(document));
    delete clone._id;
    return clone;
}

async function main() {
    console.log("Phase 6.2 E2E HITL governance stress tests\n");
    console.log(`  API ${API_BASE_URL}`);
    console.log(`  A-fleet ${formatIdentity(IDENTITY_A)}`);
    console.log(`  H-fleet ${formatIdentity(IDENTITY_H)}\n`);

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

    console.log("\n  Fixture: lock KSLC RWY 35 / EF35A at charted heading 320");
    const fixture = await api("POST", "/api/verify", buildVerifyPayload({
        heading: 320,
        user_id: "SMOKE_E2E",
        justification: "E2E fixture: seed charted 320 before the 330 HITL delta."
    }));
    assertAccepted(fixture, "fixture /api/verify (heading 320)");
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
    assertAccepted(accepted, "justified 330 delta must lock");
    pass(`POST /api/verify accepted ${accepted.status}`);

    if (!accepted.body?.ok || !accepted.body?.identity) {
        fail("verify response missing ok/identity", JSON.stringify(accepted.body));
    }

    for (const [field, value] of Object.entries(IDENTITY_A)) {
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
                "Rebuild the API so POST /api/verify returns the OperatorProcedureRegistry receipt."
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

    console.log("\n  Test 3: Fleet split (identity collision)");
    const heavy = await api("POST", "/api/verify", buildVerifyPayload({
        identity: IDENTITY_H,
        heading: 330,
        user_id: "ANALYST_01",
        justification: "Heavy-fleet Engine-Out SID is a distinct ARINC 424 identity."
    }));

    if (heavy.status === 409) {
        fail(
            "fleet split collided — unique index is still locking on runway, not the 5-part ARINC key",
            JSON.stringify(heavy.body)
        );
    }
    assertAccepted(heavy, "EF35H / route_type 1 on the same KSLC 35 runway");
    pass(`POST /api/verify EF35H accepted ${heavy.status} (no runway 409)`);

    if (heavy.body?.identity?.procedure_ident !== IDENTITY_H.procedure_ident
        || heavy.body?.identity?.route_type !== IDENTITY_H.route_type) {
        fail("EF35H identity receipt", JSON.stringify(heavy.body?.identity));
    }
    if (heavy.body?.registry?.status !== "ACTIVE") {
        fail("EF35H registry lock", JSON.stringify(heavy.body?.registry));
    }
    pass(`H-fleet locked ACTIVE as ${formatIdentity(IDENTITY_H)}`);

    console.log("\n  Test 4: Alert fatigue trap (non-424 fields)");
    const lockedA = await api("GET", identityQuery(IDENTITY_A));
    if (lockedA.status !== 200 || !lockedA.body?.procedure) {
        fail(
            "GET /api/procedures/:operator/:ident (EF35A)",
            `got ${lockedA.status} ${JSON.stringify(lockedA.body)}`
        );
    }

    const silentPayload = cloneWithoutMongoId(lockedA.body.procedure);
    const silentLeg = silentPayload.procedureRows?.[0]?.legs?.[0];
    if (!silentLeg) {
        fail("EF35A payload missing TURN_TO_HEADING leg", JSON.stringify(silentPayload.procedureRows));
    }

    silentLeg.startPoint = {
        ...(silentLeg.startPoint || BASELINE_START),
        latitude: SILENT_LATITUDE
    };
    silentPayload.user_id = "ANALYST_01";
    delete silentPayload.justification;

    const silent = await api("POST", "/api/verify", silentPayload);

    if (silent.status === 400) {
        fail(
            "non-424 latitude change demanded HITL justification — diff engine is over-triggering",
            JSON.stringify(silent.body)
        );
    }
    if (silent.status !== 200) {
        fail(
            "silent non-424 update",
            `expected 200, got ${silent.status} ${JSON.stringify(silent.body)}`
        );
    }
    if (silent.body?.amendmentCount) {
        fail(
            "silent update wrote 424 amendments",
            `expected amendmentCount 0, got ${silent.body.amendmentCount}`
        );
    }
    pass("POST /api/verify startPoint.latitude without justification returned 200");

    console.log("\n  Test 5: DO-200B provenance audit");
    const audited = await api("GET", identityQuery(IDENTITY_A));
    if (audited.status !== 200 || !audited.body?.procedure) {
        fail(
            "GET locked EF35A for provenance audit",
            `got ${audited.status} ${JSON.stringify(audited.body)}`
        );
    }

    const procedure = audited.body.procedure;
    const turnLeg = procedure.procedureRows?.[0]?.legs?.[0];
    if (!turnLeg || turnLeg.type !== "TURN_TO_HEADING") {
        fail("EF35A TURN_TO_HEADING leg missing", JSON.stringify(procedure.procedureRows));
    }

    if (turnLeg.provenance !== "CHARTED") {
        fail(
            "OCR provenance overwritten",
            `expected CHARTED, got ${JSON.stringify(turnLeg.provenance)}`
        );
    }
    pass('TURN_TO_HEADING provenance remains "CHARTED"');

    if (turnLeg.targetMagneticHeading !== 330) {
        fail("audited heading", `expected targetMagneticHeading 330, got ${turnLeg.targetMagneticHeading}`);
    }

    const ledger = Array.isArray(procedure.amendments) ? procedure.amendments : [];
    const headingAmendment = ledger.find((row) =>
        typeof row.field_path === "string"
        && row.field_path.includes("targetMagneticHeading")
        && row.previous_value === 320
        && row.current_value === 330
        && row.user_id === "ANALYST_01"
    );

    if (!headingAmendment) {
        fail(
            "HITL ledger missing 320 → 330 tagged ANALYST_01",
            `amendments=${JSON.stringify(ledger.slice(-8))}`
        );
    }
    pass("amendments[] records 320 → 330 with ANALYST_01");

    if (turnLeg.startPoint?.latitude !== SILENT_LATITUDE) {
        fail(
            "non-424 latitude was not persisted",
            `expected ${SILENT_LATITUDE}, got ${turnLeg.startPoint?.latitude}`
        );
    }
    pass(`startPoint.latitude persisted at ${SILENT_LATITUDE} without a new amendment`);

    console.log("\n✅ All Phase 6.2 E2E HITL governance checks passed.");
}

main().catch((error) => {
    console.error(`\n❌ Phase 6.2 E2E failed: ${error.message}`);
    process.exit(1);
});
