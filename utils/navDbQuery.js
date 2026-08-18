/**
 * navDbQuery: the physical ground-truth boundary for the geodetic engine.
 *
 * Ground truth lives in the multi-cycle MongoDB `nav_data` collection,
 * maintained by backend/jobs/nasrUpdater.js: the currently effective AIRAC
 * cycle and the upcoming preloaded cycle coexist, every document stamped
 * with an `airacCycle` field and each cycle carrying its own metadata doc
 * (_id: "airac_<cycle>").
 *
 * Queries are temporal: every accessor takes a flightDate (defaulting to
 * the current UTC time) and resolves against the cycle whose effective
 * window covers that date. No covering cycle throws AiracExpiredError —
 * the engine never computes geometry from stale or not-yet-effective
 * ground truth.
 *
 * The geo engine is injected with this service and never reads raw
 * database records itself. Every accessor validates the record before
 * returning it, so downstream solvers can trust that coordinates, True
 * Headings, and Magnetic Variations are present and finite. Magnetic
 * variation is expressed in degrees, East-positive (True = Magnetic +
 * variation).
 *
 * Initialization: server.js must call initNavDb(db) with the established
 * MongoDB Db instance before any query runs. All accessors are async.
 */
const { isCycleCurrent, getCycleForDate } = require("./airac");
const { DataIntegrityError } = require("../backend/geo/DataIntegrityError");
const { AiracExpiredError } = require("../backend/geo/AiracExpiredError");
const { requireFiniteNumber, requireNonEmptyString } = require("../backend/geo/validation");

const NAV_DATA_COLLECTION = "nav_data";

/**
 * Logical multi-tenancy: proprietary operator procedures (tailored waypoints,
 * e.g. American Airlines EFPs) coexist with the public FAA NASR baseline in
 * the single nav_data collection, discriminated by an `operator_id` field.
 * The public ARINC 424 baseline is operator "FAA". Documents ingested before
 * the multi-tenant schema carry no operator_id and are treated as FAA public
 * data (the field is stamped by the ETL going forward).
 */
const PUBLIC_OPERATOR_ID = "FAA";

// Compound index backing operator-scoped lookups across millions of colocated
// tailored + public records. `identifier` is this collection's ident field.
const OPERATOR_IDENT_AIRPORT_INDEX = { operator_id: 1, identifier: 1, airportId: 1 };

let navDataCollection = null;

/**
 * Injects the active MongoDB connection. Must be called once at startup,
 * after the client connects and before the geo engine serves any request.
 *
 * @param {import("mongodb").Db} db - connected Db instance
 */
function initNavDb(db) {
    if (!db || typeof db.collection !== "function") {
        throw new Error("initNavDb requires a connected MongoDB Db instance.");
    }

    navDataCollection = db.collection(NAV_DATA_COLLECTION);
}

function getCollection() {
    if (!navDataCollection) {
        throw new Error(
            "navDbQuery is not initialized. Call initNavDb(db) with the active MongoDB connection before querying."
        );
    }

    return navDataCollection;
}

/**
 * Ensures the multi-tenant compound index exists on nav_data. Idempotent
 * (createIndex is a no-op when the index already exists). server.js awaits
 * this during startup, right after initNavDb; the NASR ETL also builds it at
 * ingest commit time.
 */
async function ensureNavDataIndexes() {
    await getCollection().createIndex(OPERATOR_IDENT_AIRPORT_INDEX);
}

/**
 * Tenant filter for nav_data queries. Tailored operators match strictly;
 * the FAA public baseline also matches documents with no operator_id stamp
 * (legacy cycles ingested before the multi-tenant schema — in MongoDB,
 * `null` inside $in matches missing fields).
 */
function operatorFilter(operatorId) {
    return operatorId === PUBLIC_OPERATOR_ID
        ? { operator_id: { $in: [PUBLIC_OPERATOR_ID, null] } }
        : { operator_id: operatorId };
}

function normalizeFlightDate(flightDate) {
    const date = flightDate instanceof Date ? flightDate : new Date(flightDate);

    if (!Number.isFinite(date.getTime())) {
        throw new DataIntegrityError(`flightDate must be a valid date, got: ${flightDate}`);
    }

    return date;
}

/**
 * Resolves the AIRAC cycle whose effective window covers the flight date.
 * Throws AiracExpiredError when no loaded cycle covers it (stale database,
 * or a flight date outside the loaded current/upcoming windows).
 *
 * @param {Date|string|number} [flightDate] - defaults to current UTC time
 */
async function determineActiveCycle(flightDate = new Date()) {
    const date = normalizeFlightDate(flightDate);
    const metas = await getCollection().find({ docType: "meta" }).toArray();

    if (metas.length === 0) {
        throw new DataIntegrityError(
            "nav_data holds no AIRAC cycle metadata. Has the NASR ingestion job run yet?"
        );
    }

    const covering = metas.find((meta) => isCycleCurrent(meta, date));

    if (!covering) {
        let requiredIdent = "unknown";

        try {
            requiredIdent = getCycleForDate(date).ident;
        } catch {
            // Pre-epoch or otherwise unresolvable date; report it as unknown.
        }

        const loadedCycles = metas
            .map((meta) => `${meta.airacCycle} (${meta.effectiveFrom} to ${meta.effectiveTo})`)
            .sort()
            .join(", ");

        throw new AiracExpiredError(
            `No ground-truth AIRAC cycle covers flight date ${date.toISOString()} (required cycle ${requiredIdent}). ` +
            `Loaded cycles: ${loadedCycles}. Refresh the database via the NASR ETL before computing geometry.`
        );
    }

    return {
        ident: covering.airacCycle,
        effectiveFrom: covering.effectiveFrom,
        effectiveTo: covering.effectiveTo,
        source: covering.source
    };
}

const EARTH_RADIUS_NM = 3440.065;

function greatCircleDistanceNM(a, b) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b.latitude - a.latitude);
    const dLon = toRad(b.longitude - a.longitude);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;

    return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(h));
}

/**
 * Resolves a navaid identifier to a single validated station, using the
 * ground truth of the AIRAC cycle effective on the flight date.
 *
 * Navaid identifiers are NOT globally unique in the NAS (NDBs share idents
 * with VORs; terminal stations share idents with enroute stations across the
 * country). Mirroring FMS duplicate-ident behavior, when multiple stations
 * share the identifier this function requires a WGS-84 reference point (the
 * procedure's origin) and deterministically returns the spatially closest
 * candidate. A duplicate ident with no reference point is a fail-safe throw,
 * never a guess.
 *
 * @param {string} identifier - navaid ident, e.g. "TCH"
 * @param {{latitude:number,longitude:number}} [referencePoint] - procedure origin
 * @param {Date|string|number} [flightDate] - defaults to current UTC time
 */
async function getNavaid(identifier, referencePoint, flightDate = new Date()) {
    const activeCycle = await determineActiveCycle(flightDate);

    const navaidId = requireNonEmptyString(identifier, "navaid identifier");
    const document = await getCollection().findOne({
        docType: "navaid",
        identifier: navaidId,
        airacCycle: activeCycle.ident
    });
    const candidates = Array.isArray(document?.candidates) ? document.candidates : [];

    if (candidates.length === 0) {
        throw new DataIntegrityError(`Navaid not found in AIRAC cycle ${activeCycle.ident}: ${navaidId}`);
    }

    let selected = candidates[0];
    let disambiguation = null;

    if (candidates.length > 1) {
        const hasReference =
            Number.isFinite(referencePoint?.latitude) && Number.isFinite(referencePoint?.longitude);

        if (!hasReference) {
            throw new DataIntegrityError(
                `Navaid ident ${navaidId} is duplicated (${candidates.length} stations: ` +
                candidates.map((c) => `${c.type || "?"}/${c.state || "?"}`).join(", ") +
                ") and no reference point was provided for spatial disambiguation."
            );
        }

        const ranked = candidates
            .map((candidate) => ({
                candidate,
                distanceNM: greatCircleDistanceNM(referencePoint, candidate)
            }))
            .sort((a, b) => a.distanceNM - b.distanceNM);

        selected = ranked[0].candidate;
        disambiguation = {
            candidateCount: candidates.length,
            selectedDistanceNM: Number(ranked[0].distanceNM.toFixed(1)),
            nextNearestDistanceNM: Number(ranked[1].distanceNM.toFixed(1))
        };
    }

    const fieldPath = `nav_data[${activeCycle.ident}].navaids.${navaidId}`;

    return {
        identifier: navaidId,
        name: selected.name,
        type: selected.type,
        state: selected.state ?? null,
        latitude: requireFiniteNumber(selected.latitude, `${fieldPath}.latitude`),
        longitude: requireFiniteNumber(selected.longitude, `${fieldPath}.longitude`),
        magneticVariation: requireFiniteNumber(selected.magneticVariation, `${fieldPath}.magneticVariation`),
        airacCycle: activeCycle.ident,
        ...(disambiguation ? { disambiguation } : {})
    };
}

/**
 * Trigger-navaid resolution constants.
 *
 * NAV_BASE.csv carries no airport association, so "terminal facility
 * associated with the airport" is implemented as a deterministic spatial
 * proxy: a terminal-type station (DME/TACAN — the DME/ILS class of
 * facilities present in NAV_BASE) sited within TERMINAL_RADIUS_NM of the
 * airport's reference coordinates. Enroute stations (VOR/VOR-DME/VORTAC/
 * NDB/...) are only eligible via the fallback radius.
 */
const TERMINAL_NAVAID_TYPES = new Set(["DME", "TACAN"]);
const TERMINAL_RADIUS_NM = 5;
const ENROUTE_FALLBACK_RADIUS_NM = 40;

/**
 * Runs the bounded spatial search for one operator's dataset:
 *
 *   Tier 1 (terminal):  candidates of a terminal type (DME/TACAN) within
 *                       TERMINAL_RADIUS_NM of the airport reference point.
 *                       Nearest wins.
 *   Tier 2 (enroute):   only if tier 1 is empty — candidates of enroute
 *                       types within ENROUTE_FALLBACK_RADIUS_NM of the
 *                       airport reference point. Nearest wins.
 *
 * Returns null when the ident is absent from this operator's dataset or no
 * candidate satisfies the radius rules — null is the cascade signal for the
 * caller, never a silent guess. A same-ident station outside these bounds
 * is the wrong facility, not a fallback.
 */
async function searchOperatorDataset(navaidId, cycleIdent, operatorId, airportReference) {
    const document = await getCollection().findOne({
        docType: "navaid",
        identifier: navaidId,
        airacCycle: cycleIdent,
        ...operatorFilter(operatorId)
    });
    const candidates = Array.isArray(document?.candidates) ? document.candidates : [];

    if (candidates.length === 0) {
        return { candidateCount: 0, match: null };
    }

    const ranked = candidates
        .filter((candidate) => Number.isFinite(candidate.latitude) && Number.isFinite(candidate.longitude))
        .map((candidate) => ({
            candidate,
            distanceNM: greatCircleDistanceNM(airportReference, candidate)
        }))
        .sort((a, b) => a.distanceNM - b.distanceNM);

    const terminalMatch = ranked.find(
        (entry) => TERMINAL_NAVAID_TYPES.has(entry.candidate.type) && entry.distanceNM <= TERMINAL_RADIUS_NM
    );
    const enrouteMatch = terminalMatch
        ? null
        : ranked.find(
            (entry) => !TERMINAL_NAVAID_TYPES.has(entry.candidate.type) && entry.distanceNM <= ENROUTE_FALLBACK_RADIUS_NM
        );
    const selected = terminalMatch ?? enrouteMatch;

    if (!selected) {
        return { candidateCount: candidates.length, match: null };
    }

    return {
        candidateCount: candidates.length,
        match: {
            selected,
            tier: terminalMatch ? "terminal" : "enroute_40nm",
            candidateCount: candidates.length
        }
    };
}

/**
 * Resolves an LLM-extracted trigger navaid ident (the station a charted DME
 * distance is measured from) to exactly one validated station, scoped to
 * the airport of the procedure, via a hierarchical multi-tenant cascade:
 *
 *   Step A (tailored):  the requested operator's dataset (operator_id ===
 *                       requestedOperator) is searched first with the
 *                       terminal/enroute radius rules above. When the
 *                       request is not operator-tailored (operator "FAA"),
 *                       this IS the public baseline query and Step B is
 *                       skipped.
 *   Step B (public):    only if Step A resolves nothing — the exact same
 *                       spatial query hardcoded to the public FAA dataset
 *                       (operator_id === "FAA").
 *   Otherwise:          DataIntegrityError (-> 422). Null coordinates are
 *                       never returned.
 *
 * The returned station carries exact WGS-84 latitude/longitude and MSL
 * elevation; a missing/non-finite physical field on the selected station
 * throws with the exact database field path. Selection metadata records
 * which dataset (tailored vs public) resolved the station.
 *
 * @param {string} identifier - trigger navaid ident from the LLM, e.g. "CLT"
 * @param {{airportId:string,latitude:number,longitude:number}} airportReference
 *   airport identity + reference coordinates (the procedure's validated
 *   runway threshold serves as the airport reference point)
 * @param {Date|string|number} [flightDate] - defaults to current UTC time
 * @param {string} [operatorId] - tenant discriminator, e.g. "AAL"; defaults
 *   to the public FAA baseline
 */
async function resolveTriggerNavaid(identifier, airportReference, flightDate = new Date(), operatorId = PUBLIC_OPERATOR_ID) {
    const activeCycle = await determineActiveCycle(flightDate);

    const navaidId = requireNonEmptyString(identifier, "trigger navaid identifier").toUpperCase();
    const requestedOperator = requireNonEmptyString(operatorId, "operator_id").toUpperCase();
    const airportId = requireNonEmptyString(airportReference?.airportId, "airportReference.airportId");

    if (!Number.isFinite(airportReference?.latitude) || !Number.isFinite(airportReference?.longitude)) {
        throw new DataIntegrityError(
            `Trigger navaid ${navaidId} could not be resolved: airport reference coordinates for ${airportId} are not finite.`
        );
    }

    // Step A (tailored): the requested operator's dataset.
    let resolvedOperator = requestedOperator;
    let { candidateCount, match } = await searchOperatorDataset(
        navaidId, activeCycle.ident, requestedOperator, airportReference
    );

    // Step B (public fallback): same spatial query, hardcoded to the FAA
    // public baseline. Skipped when Step A already searched it.
    if (!match && requestedOperator !== PUBLIC_OPERATOR_ID) {
        resolvedOperator = PUBLIC_OPERATOR_ID;
        const publicResult = await searchOperatorDataset(
            navaidId, activeCycle.ident, PUBLIC_OPERATOR_ID, airportReference
        );
        candidateCount += publicResult.candidateCount;
        match = publicResult.match;
    }

    // Strict rejection: both the tailored and public datasets failed.
    if (!match) {
        const searchedDatasets = requestedOperator === PUBLIC_OPERATOR_ID
            ? `the public ${PUBLIC_OPERATOR_ID} dataset`
            : `the tailored ${requestedOperator} dataset and the public ${PUBLIC_OPERATOR_ID} fallback`;

        if (candidateCount === 0) {
            throw new DataIntegrityError(
                `Trigger navaid could not be resolved: ident ${navaidId} not found in AIRAC cycle ${activeCycle.ident} ` +
                    `(searched ${searchedDatasets}).`
            );
        }

        throw new DataIntegrityError(
            `Trigger navaid ${navaidId} could not be resolved for ${airportId}: ` +
                `${candidateCount} candidate station(s) exist in AIRAC cycle ${activeCycle.ident} across ${searchedDatasets}, ` +
                `but none is a terminal facility (DME/TACAN) within ${TERMINAL_RADIUS_NM} NM of the airport or an ` +
                `enroute facility within ${ENROUTE_FALLBACK_RADIUS_NM} NM.`
        );
    }

    const { selected, tier } = match;
    const fieldPath = `nav_data[${activeCycle.ident}].navaids.${navaidId}`;

    return {
        identifier: navaidId,
        name: selected.candidate.name,
        type: selected.candidate.type,
        state: selected.candidate.state ?? null,
        operator_id: resolvedOperator,
        latitude: requireFiniteNumber(selected.candidate.latitude, `${fieldPath}.latitude`),
        longitude: requireFiniteNumber(selected.candidate.longitude, `${fieldPath}.longitude`),
        elevationFtMsl: requireFiniteNumber(selected.candidate.elevation, `${fieldPath}.elevation`),
        magneticVariation: requireFiniteNumber(selected.candidate.magneticVariation, `${fieldPath}.magneticVariation`),
        airacCycle: activeCycle.ident,
        selection: {
            tier,
            distanceNM: Number(selected.distanceNM.toFixed(2)),
            candidateCount: match.candidateCount,
            operator: resolvedOperator,
            dataset: resolvedOperator === PUBLIC_OPERATOR_ID ? "public" : "tailored"
        }
    };
}

/**
 * Resolves a runway end using the ground truth of the AIRAC cycle effective
 * on the flight date. Validates latitude, longitude, trueHeading,
 * elevation_ft (threshold, feet MSL), and magneticVariation as finite
 * numbers. A found runway with a missing elevation_ft is a
 * DataIntegrityError — never guessed, never defaulted to 0.
 *
 * @param {string} airportCode - ICAO id, e.g. "KSLC"
 * @param {string} runwayIdentifier - runway end, e.g. "16L"
 * @param {Date|string|number} [flightDate] - defaults to current UTC time
 */
async function getRunway(airportCode, runwayIdentifier, flightDate = new Date()) {
    const activeCycle = await determineActiveCycle(flightDate);

    const airport = requireNonEmptyString(airportCode, "airportCode");
    const runwayId = requireNonEmptyString(runwayIdentifier, "runway identifier");
    const databaseKey = `${airport}_${runwayId}`;
    const runway = await getCollection().findOne({
        docType: "runway",
        key: databaseKey,
        airacCycle: activeCycle.ident
    });

    if (!runway) {
        throw new DataIntegrityError(`Runway not found in AIRAC cycle ${activeCycle.ident}: ${databaseKey}`);
    }

    const fieldPath = `nav_data[${activeCycle.ident}].runways.${databaseKey}`;

    return {
        airportCode: airport,
        runwayIdentifier: runwayId,
        latitude: requireFiniteNumber(runway.latitude, `${fieldPath}.latitude`),
        longitude: requireFiniteNumber(runway.longitude, `${fieldPath}.longitude`),
        trueHeading: requireFiniteNumber(runway.trueHeading, `${fieldPath}.trueHeading`),
        // Threshold elevation (ft MSL). Hard gate: missing / null / non-finite
        // is a DataIntegrityError — never guessed, never defaulted to 0.
        elevation_ft: requireFiniteNumber(runway.elevation_ft, `${fieldPath}.elevation_ft`),
        magneticVariation: requireFiniteNumber(runway.magneticVariation, `${fieldPath}.magneticVariation`),
        airacCycle: activeCycle.ident
    };
}

module.exports = {
    initNavDb,
    ensureNavDataIndexes,
    getNavaid,
    getRunway,
    resolveTriggerNavaid,
    determineActiveCycle,
    TERMINAL_RADIUS_NM,
    ENROUTE_FALLBACK_RADIUS_NM,
    PUBLIC_OPERATOR_ID
};
