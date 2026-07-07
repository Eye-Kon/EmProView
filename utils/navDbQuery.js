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
 * Resolves a runway end using the ground truth of the AIRAC cycle effective
 * on the flight date.
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
        magneticVariation: requireFiniteNumber(runway.magneticVariation, `${fieldPath}.magneticVariation`),
        airacCycle: activeCycle.ident
    };
}

module.exports = {
    initNavDb,
    getNavaid,
    getRunway,
    determineActiveCycle
};
