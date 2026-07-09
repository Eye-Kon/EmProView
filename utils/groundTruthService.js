/**
 * groundTruthService: the Validated Ground-Truth Query Boundary.
 *
 * A single orchestrated entry point — resolvePhysicalGroundTruth — that turns
 * the symbolic anchors of an extracted procedure (airport, runway end, navaid
 * ident) into fully validated WGS-84 physical ground truth, in strict order:
 *
 *   1. Temporal enforcement (AIRAC): the effective-window check runs before
 *      any spatial query. If no loaded AIRAC cycle covers currentUtcTime, an
 *      AiracExpiredError is thrown and resolution terminates immediately —
 *      no geometry is ever computed from stale or not-yet-effective data.
 *   2. Runway threshold: exact WGS-84 threshold coordinates, True Heading,
 *      and Magnetic Variation for the requested runway end. Any missing or
 *      non-finite physical field throws DataIntegrityError naming the exact
 *      database field that failed. Nothing is ever coerced to zero.
 *   3. Navaid spatial disambiguation: navaid idents are not globally unique
 *      in the NAS. Duplicated idents are resolved deterministically to the
 *      candidate nearest (great-circle) to the runway threshold resolved in
 *      step 2, with human-visible disambiguation evidence attached. A
 *      duplicated ident with no reference point is a DataIntegrityError,
 *      never a guess.
 *
 * The underlying queries, validation, and haversine ranking live in
 * utils/navDbQuery.js (the raw accessor layer over the multi-cycle MongoDB
 * nav_data collection). This module composes them into the one-call contract
 * consumed by the extraction pipeline. Magnetic variation is expressed in
 * degrees, East-positive (True = Magnetic + variation).
 *
 * Initialization: server.js already wires the accessor layer via initNavDb(db);
 * initGroundTruthService(db) is provided for standalone use (scripts, tests)
 * and delegates to the same injection point.
 */
const navDb = require("./navDbQuery");
const { DataIntegrityError } = require("../backend/geo/DataIntegrityError");
const { AiracExpiredError } = require("../backend/geo/AiracExpiredError");

/**
 * Injects the active MongoDB connection into the ground-truth query layer.
 * Delegates to initNavDb: both this service and the geo engine share one
 * collection handle. Call once at startup, before any resolution runs.
 *
 * @param {import("mongodb").Db} db - connected Db instance
 */
function initGroundTruthService(db) {
    navDb.initNavDb(db);
}

/**
 * Resolves the physical ground truth for a procedure anchored on a runway
 * end and a navaid, enforcing AIRAC currency first and failing fast on any
 * structural violation in the database.
 *
 * @param {string} airportId - ICAO airport id, e.g. "KSLC"
 * @param {string} runwayId - runway end identifier, e.g. "16L"
 * @param {string} navaidId - navaid ident, e.g. "TCH"
 * @param {Date|string|number} [currentUtcTime] - defaults to current UTC time
 * @returns {Promise<object>} validated ground-truth contract (see below)
 * @throws {AiracExpiredError} when no loaded AIRAC cycle covers currentUtcTime
 * @throws {DataIntegrityError} when a record is missing or a physical field
 *   is absent / non-finite; the message names the exact database field
 */
async function resolvePhysicalGroundTruth(airportId, runwayId, navaidId, currentUtcTime = new Date()) {
    // 1. Temporal enforcement. determineActiveCycle throws AiracExpiredError
    //    before any spatial query is issued; the covering cycle it returns
    //    scopes both queries below to the same ground-truth snapshot.
    const airacCycle = await navDb.determineActiveCycle(currentUtcTime);

    // 2. Runway threshold. getRunway validates latitude, longitude,
    //    trueHeading, and magneticVariation as finite numbers, throwing
    //    DataIntegrityError with the offending field path otherwise.
    const runway = await navDb.getRunway(airportId, runwayId, currentUtcTime);

    // 3. Navaid, spatially disambiguated against the threshold from step 2.
    //    Duplicate idents resolve to the nearest station; a duplicate with no
    //    usable reference point fails inside getNavaid.
    const navaid = await navDb.getNavaid(
        navaidId,
        { latitude: runway.latitude, longitude: runway.longitude },
        currentUtcTime
    );

    const disambiguation = navaid.disambiguation
        ? {
            ...navaid.disambiguation,
            note:
                `Navaid ident ${navaid.identifier} matched ${navaid.disambiguation.candidateCount} stations; ` +
                `selected ${navaid.name} (${navaid.type}) at ${navaid.disambiguation.selectedDistanceNM} NM from the ` +
                `${runway.airportCode} ${runway.runwayIdentifier} threshold ` +
                `(next-nearest candidate at ${navaid.disambiguation.nextNearestDistanceNM} NM).`
        }
        : null;

    return {
        airacCycle: {
            ident: airacCycle.ident,
            effectiveFrom: airacCycle.effectiveFrom,
            effectiveTo: airacCycle.effectiveTo,
            source: airacCycle.source
        },
        originRunway: {
            airportId: runway.airportCode,
            runwayId: runway.runwayIdentifier,
            threshold: {
                latitude: runway.latitude,
                longitude: runway.longitude
            },
            trueHeading: runway.trueHeading,
            magneticVariation: runway.magneticVariation
        },
        navaid: {
            identifier: navaid.identifier,
            name: navaid.name,
            type: navaid.type,
            state: navaid.state,
            coordinates: {
                latitude: navaid.latitude,
                longitude: navaid.longitude
            },
            magneticVariation: navaid.magneticVariation
        },
        // The variation relevant to procedure geometry at the origin: courses
        // published magnetically at the airport convert to True with this value.
        magneticVariation: runway.magneticVariation,
        disambiguation
    };
}

module.exports = {
    initGroundTruthService,
    resolvePhysicalGroundTruth,
    // Re-exported so callers can catch typed failures without reaching into
    // backend/geo internals.
    DataIntegrityError,
    AiracExpiredError
};
