/**
 * navDbQuery: the physical ground-truth boundary for the geodetic engine.
 *
 * The geo engine is injected with this service and never reads raw database
 * records itself. Every accessor validates the record before returning it, so
 * downstream solvers can trust that coordinates, True Headings, and Magnetic
 * Variations are present and finite. Magnetic variation is expressed in
 * degrees, East-positive (True = Magnetic + variation).
 *
 * Temporal enforcement: every query first asserts that the database's AIRAC
 * cycle covers the current UTC time. Expired ground truth throws
 * AiracExpiredError and halts extraction — the engine never computes
 * geometry from stale data.
 */
const navDatabase = require("../data/navDatabase.json");
const { isCycleCurrent, getCycleForDate } = require("./airac");
const { DataIntegrityError } = require("../backend/geo/DataIntegrityError");
const { AiracExpiredError } = require("../backend/geo/AiracExpiredError");
const { requireFiniteNumber, requireNonEmptyString } = require("../backend/geo/validation");

function getActiveCycle() {
    const cycle = navDatabase.airac;

    if (!cycle || typeof cycle.ident !== "string") {
        throw new DataIntegrityError("navDatabase is missing its AIRAC cycle metadata.");
    }

    return {
        ident: cycle.ident,
        effectiveFrom: cycle.effectiveFrom,
        effectiveTo: cycle.effectiveTo,
        source: cycle.source
    };
}

function assertCycleCurrent(now = new Date()) {
    const cycle = getActiveCycle();

    if (!isCycleCurrent(cycle, now)) {
        const requiredCycle = getCycleForDate(now);

        throw new AiracExpiredError(
            `Ground-truth database AIRAC cycle ${cycle.ident} (effective ${cycle.effectiveFrom} to ${cycle.effectiveTo}) ` +
            `does not cover the current UTC time. Current cycle is ${requiredCycle.ident}. ` +
            "Refresh the database via the NASR ETL before computing geometry."
        );
    }

    return cycle;
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
 * Resolves a navaid identifier to a single validated station.
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
 */
function getNavaid(identifier, referencePoint) {
    assertCycleCurrent();

    const navaidId = requireNonEmptyString(identifier, "navaid identifier");
    const rawCandidates = navDatabase.navaids?.[navaidId];
    const candidates = Array.isArray(rawCandidates) ? rawCandidates : rawCandidates ? [rawCandidates] : [];

    if (candidates.length === 0) {
        throw new DataIntegrityError(`Navaid not found: ${navaidId}`);
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

    const fieldPath = `navDatabase.navaids.${navaidId}`;

    return {
        identifier: navaidId,
        name: selected.name,
        type: selected.type,
        state: selected.state ?? null,
        latitude: requireFiniteNumber(selected.latitude, `${fieldPath}.latitude`),
        longitude: requireFiniteNumber(selected.longitude, `${fieldPath}.longitude`),
        magneticVariation: requireFiniteNumber(selected.magneticVariation, `${fieldPath}.magneticVariation`),
        ...(disambiguation ? { disambiguation } : {})
    };
}

function getRunway(airportCode, runwayIdentifier) {
    assertCycleCurrent();

    const airport = requireNonEmptyString(airportCode, "airportCode");
    const runwayId = requireNonEmptyString(runwayIdentifier, "runway identifier");
    const databaseKey = `${airport}_${runwayId}`;
    const runway = navDatabase.runways?.[databaseKey];

    if (!runway) {
        throw new DataIntegrityError(`Runway not found: ${databaseKey}`);
    }

    const fieldPath = `navDatabase.runways.${databaseKey}`;

    return {
        airportCode: airport,
        runwayIdentifier: runwayId,
        latitude: requireFiniteNumber(runway.latitude, `${fieldPath}.latitude`),
        longitude: requireFiniteNumber(runway.longitude, `${fieldPath}.longitude`),
        trueHeading: requireFiniteNumber(runway.trueHeading, `${fieldPath}.trueHeading`),
        magneticVariation: requireFiniteNumber(runway.magneticVariation, `${fieldPath}.magneticVariation`)
    };
}

module.exports = {
    getNavaid,
    getRunway,
    getActiveCycle,
    assertCycleCurrent
};
