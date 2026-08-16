/**
 * Smoke test for the strict trigger-navaid resolution
 * (utils/navDbQuery.js resolveTriggerNavaid).
 *
 * Pure unit test against an in-memory fake nav_data collection — no MongoDB.
 * Every rejection asserted here surfaces as a 422 through /api/analyze.
 *
 * Run: node scripts/smoke_trigger_navaid.js
 * Or inside the container: docker compose exec app node scripts/smoke_trigger_navaid.js
 */
const assert = require("assert");
const navDb = require("../utils/navDbQuery");
const { DataIntegrityError } = require("../backend/geo/DataIntegrityError");

/* ---------------- fixture geometry ----------------
 * Airport reference (KCLT 36R threshold, roughly): 35.2144 N, 80.9431 W.
 * 1 degree of latitude ~ 60 NM, so:
 *   +0.05 deg lat  ~  3 NM  (inside the 5 NM terminal radius)
 *   +0.50 deg lat  ~ 30 NM  (inside the 40 NM enroute fallback)
 *   +1.00 deg lat  ~ 60 NM  (outside every radius)
 */
const AIRPORT_REF = { airportId: "KCLT", latitude: 35.2144, longitude: -80.9431 };
const CYCLE = "2608";

const now = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

const docs = {
    metas: [{
        docType: "meta",
        airacCycle: CYCLE,
        effectiveFrom: new Date(now - DAY_MS).toISOString(),
        effectiveTo: new Date(now + 27 * DAY_MS).toISOString()
    }],
    navaids: []
};

function candidate(type, latOffsetDeg, extra = {}) {
    return {
        name: extra.name ?? `${type} STATION`,
        type,
        state: "NC",
        latitude: AIRPORT_REF.latitude + latOffsetDeg,
        longitude: AIRPORT_REF.longitude,
        elevation: extra.elevation !== undefined ? extra.elevation : 748,
        magneticVariation: -8.1,
        ...extra
    };
}

/**
 * Seeds one navaid document. operatorId undefined emulates a legacy public
 * document ingested before the multi-tenant schema (no operator_id field);
 * a string stamps that tenant's tailored document.
 */
function seedNavaid(identifier, candidates, operatorId) {
    docs.navaids.push({
        docType: "navaid",
        airacCycle: CYCLE,
        identifier,
        candidates,
        ...(operatorId !== undefined ? { operator_id: operatorId } : {})
    });
}

// CLT: on-field terminal DME (3 NM) vs same-ident enroute VORTAC (30 NM).
seedNavaid("CLT", [
    candidate("VORTAC", 0.5, { name: "FAR VORTAC" }),
    candidate("DME", 0.05, { name: "FIELD DME" })
]);
// CLT (tailored AAL overlay): proprietary EFP waypoint sharing the public
// ident — must shadow the public station only for operator AAL requests.
seedNavaid("CLT", [candidate("DME", 0.03, { name: "AAL EFP DME" })], "AAL");
// GSO: no terminal station; enroute VOR/DME at 30 NM must be the fallback.
seedNavaid("GSO", [candidate("VOR/DME", 0.5, { name: "ENROUTE VORDME" })]);
// FAR: every candidate outside 40 NM — must reject.
seedNavaid("FAR", [candidate("VORTAC", 1.0), candidate("DME", 1.0)]);
// NEL: resolvable station but no ELEV in the source data — must reject loudly.
seedNavaid("NEL", [candidate("DME", 0.05, { elevation: null })]);
// XDM: terminal-type DME but at 30 NM (another airport's station) — must
// reject: too far for terminal tier, wrong type for the enroute fallback.
seedNavaid("XDM", [candidate("DME", 0.5)]);
// AA1: exists ONLY in the tailored AAL dataset — invisible to public queries.
seedNavaid("AA1", [candidate("DME", 0.05, { name: "AAL PROPRIETARY FIX" })], "AAL");

/** Mirrors MongoDB semantics for the operator_id filter (string or $in;
 *  null inside $in matches a missing field). */
function matchesOperatorFilter(docOperator, filter) {
    if (filter === undefined) {
        return true;
    }

    if (typeof filter === "string") {
        return docOperator === filter;
    }

    if (Array.isArray(filter?.$in)) {
        return filter.$in.includes(docOperator ?? null);
    }

    return false;
}

const fakeDb = {
    collection: () => ({
        find: (query) => ({
            toArray: async () => (query.docType === "meta" ? docs.metas : [])
        }),
        findOne: async (query) =>
            docs.navaids.find(
                (doc) => doc.identifier === query.identifier && matchesOperatorFilter(doc.operator_id, query.operator_id)
            ) ?? null
    })
};

async function assertRejects(promiseFactory, messagePattern, label) {
    await assert.rejects(
        promiseFactory,
        (error) => error instanceof DataIntegrityError && messagePattern.test(error.message),
        `${label}: expected DataIntegrityError matching ${messagePattern}`
    );
    console.log(`  ok (rejected 422) — ${label}`);
}

async function main() {
    navDb.initNavDb(fakeDb);

    console.log("TIERED RESOLUTION");

    // Tier 1: terminal DME at 3 NM beats same-ident enroute VORTAC at 30 NM.
    const clt = await navDb.resolveTriggerNavaid("CLT", AIRPORT_REF);
    assert.strictEqual(clt.name, "FIELD DME");
    assert.strictEqual(clt.selection.tier, "terminal");
    assert.strictEqual(clt.selection.candidateCount, 2);
    assert.strictEqual(clt.elevationFtMsl, 748);
    assert.ok(Number.isFinite(clt.latitude) && Number.isFinite(clt.longitude));
    console.log(`  ok — CLT: terminal DME preferred (${clt.selection.distanceNM} NM)`);

    // Tier 2: no terminal candidate -> enroute within 40 NM.
    const gso = await navDb.resolveTriggerNavaid("GSO", AIRPORT_REF);
    assert.strictEqual(gso.selection.tier, "enroute_40nm");
    assert.ok(gso.selection.distanceNM > 5 && gso.selection.distanceNM <= 40);
    console.log(`  ok — GSO: enroute fallback used (${gso.selection.distanceNM} NM)`);

    // Lowercase ident from the LLM normalizes to the stored uppercase ident.
    const lower = await navDb.resolveTriggerNavaid("clt", AIRPORT_REF);
    assert.strictEqual(lower.identifier, "CLT");
    console.log("  ok — lowercase ident normalized");

    console.log("MULTI-TENANT CASCADE");

    // Default (no operator): public FAA dataset; legacy docs without an
    // operator_id stamp still resolve as the public baseline.
    assert.strictEqual(clt.operator_id, "FAA");
    assert.strictEqual(clt.selection.dataset, "public");
    console.log("  ok — default request resolved against the public FAA dataset");

    // Step A: tailored AAL overlay shadows the same-ident public station.
    const tailored = await navDb.resolveTriggerNavaid("CLT", AIRPORT_REF, undefined, "AAL");
    assert.strictEqual(tailored.name, "AAL EFP DME");
    assert.strictEqual(tailored.operator_id, "AAL");
    assert.strictEqual(tailored.selection.dataset, "tailored");
    assert.strictEqual(tailored.selection.candidateCount, 1);
    console.log(`  ok — AAL request resolved the tailored EFP overlay (${tailored.selection.distanceNM} NM)`);

    // Tailored-only ident resolves for its operator (lowercase operator normalizes too).
    const proprietary = await navDb.resolveTriggerNavaid("AA1", AIRPORT_REF, undefined, "aal");
    assert.strictEqual(proprietary.name, "AAL PROPRIETARY FIX");
    assert.strictEqual(proprietary.selection.dataset, "tailored");
    console.log("  ok — AAL-only proprietary fix resolved (operator normalized from lowercase)");

    // Step B: operator with no tailored doc for the ident falls back to the
    // exact same spatial query against the public FAA dataset.
    const fallback = await navDb.resolveTriggerNavaid("GSO", AIRPORT_REF, undefined, "AAL");
    assert.strictEqual(fallback.name, "ENROUTE VORDME");
    assert.strictEqual(fallback.operator_id, "FAA");
    assert.strictEqual(fallback.selection.dataset, "public");
    assert.strictEqual(fallback.selection.tier, "enroute_40nm");
    console.log("  ok — AAL request for a public-only ident used the FAA fallback");

    // Tailored data is invisible to public (non-tailored) requests.
    await assertRejects(
        () => navDb.resolveTriggerNavaid("AA1", AIRPORT_REF),
        /ident AA1 not found .*public FAA dataset/,
        "tailored-only ident invisible without operator_id"
    );

    console.log("STRICT REJECTIONS");

    // Strict rejection: ident absent from BOTH the tailored and public datasets.
    await assertRejects(
        () => navDb.resolveTriggerNavaid("ZZZ", AIRPORT_REF, undefined, "AAL"),
        /ident ZZZ not found .*tailored AAL dataset and the public FAA fallback/,
        "unknown ident under operator cascade (both datasets searched)"
    );
    // Strict rejection: public fallback found candidates, but none in bounds.
    await assertRejects(
        () => navDb.resolveTriggerNavaid("FAR", AIRPORT_REF, undefined, "AAL"),
        /could not be resolved for KCLT.*tailored AAL dataset and the public FAA fallback/,
        "cascade exhausted with all candidates outside 40 NM"
    );

    await assertRejects(
        () => navDb.resolveTriggerNavaid("ZZZ", AIRPORT_REF),
        /Trigger navaid could not be resolved: ident ZZZ not found/,
        "unknown ident"
    );
    await assertRejects(
        () => navDb.resolveTriggerNavaid("FAR", AIRPORT_REF),
        /could not be resolved for KCLT/,
        "all candidates outside 40 NM"
    );
    await assertRejects(
        () => navDb.resolveTriggerNavaid("XDM", AIRPORT_REF),
        /could not be resolved for KCLT/,
        "terminal-type station beyond terminal radius (wrong airport's DME)"
    );
    await assertRejects(
        () => navDb.resolveTriggerNavaid("NEL", AIRPORT_REF),
        /navaids\.NEL\.elevation must be a finite number/,
        "selected station missing MSL elevation"
    );
    await assertRejects(
        () => navDb.resolveTriggerNavaid("CLT", { airportId: "KCLT", latitude: NaN, longitude: NaN }),
        /airport reference coordinates for KCLT are not finite/,
        "non-finite airport reference"
    );

    console.log("\nALL TRIGGER-NAVAID SMOKE TESTS PASSED");
}

main().catch((error) => {
    console.error("\nSMOKE TEST FAILED:", error.message);
    process.exit(1);
});
