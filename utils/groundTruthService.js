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
 *      Magnetic Variation, and threshold elevation (elevation_ft, feet MSL)
 *      for the requested runway end. Any missing or non-finite physical
 *      field throws DataIntegrityError naming the exact database field that
 *      failed. Nothing is ever coerced to zero — including elevation.
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
 * @param {object} [options]
 * @param {string|null} [options.triggerNavaidIdent] - LLM-extracted ident of
 *   the station a charted DME distance is measured from. When present it is
 *   resolved via the strict tiered lookup (terminal facilities at the
 *   airport first, then enroute within 40 NM) and attached as
 *   `triggerNavaid`; an unresolvable ident throws DataIntegrityError.
 * @param {string} [options.operatorId] - tenant discriminator for tailored
 *   procedures (e.g. "AAL"). The trigger navaid is resolved against that
 *   operator's dataset first, falling back to the public FAA baseline;
 *   omitted means public-only.
 * @param {string[]} [options.legNavaidIdents] - Phase 4.3: every distinct
 *   station ident referenced by a runway's leg sequence. Each is resolved
 *   through the same strict tiered/multi-tenant cascade as the trigger
 *   navaid and returned in the `legNavaids` map (keyed by uppercased
 *   ident). Any unresolvable ident throws DataIntegrityError.
 * @returns {Promise<object>} validated ground-truth contract (see below)
 * @throws {AiracExpiredError} when no loaded AIRAC cycle covers currentUtcTime
 * @throws {DataIntegrityError} when a record is missing or a physical field
 *   is absent / non-finite; the message names the exact database field
 */
async function resolvePhysicalGroundTruth(airportId, runwayId, navaidId, currentUtcTime = new Date(), options = {}) {
    // 1. Temporal enforcement. determineActiveCycle throws AiracExpiredError
    //    before any spatial query is issued; the covering cycle it returns
    //    scopes both queries below to the same ground-truth snapshot.
    const airacCycle = await navDb.determineActiveCycle(currentUtcTime);

    // 2. Runway threshold. getRunway validates latitude, longitude,
    //    trueHeading, elevation_ft, and magneticVariation as finite numbers,
    //    throwing DataIntegrityError with the offending field path otherwise.
    const runway = await navDb.getRunway(airportId, runwayId, currentUtcTime);

    // 3. Navaid, spatially disambiguated against the threshold from step 2.
    //    Duplicate idents resolve to the nearest station; a duplicate with no
    //    usable reference point fails inside getNavaid.
    const navaid = await navDb.getNavaid(
        navaidId,
        { latitude: runway.latitude, longitude: runway.longitude },
        currentUtcTime
    );

    // 4. Optional trigger navaid (the station the charted DME distance is
    //    measured from), resolved via the strict tiered lookup with the
    //    runway threshold serving as the airport reference point. Failure
    //    here is a hard 422 — never null coordinates into the math engine.
    let triggerNavaid = null;

    if (options.triggerNavaidIdent) {
        const resolved = await navDb.resolveTriggerNavaid(
            options.triggerNavaidIdent,
            {
                airportId: runway.airportCode,
                latitude: runway.latitude,
                longitude: runway.longitude
            },
            currentUtcTime,
            options.operatorId
        );

        triggerNavaid = {
            identifier: resolved.identifier,
            name: resolved.name,
            type: resolved.type,
            state: resolved.state,
            operator_id: resolved.operator_id,
            coordinates: {
                latitude: resolved.latitude,
                longitude: resolved.longitude
            },
            elevationFtMsl: resolved.elevationFtMsl,
            magneticVariation: resolved.magneticVariation,
            selection: {
                ...resolved.selection,
                note:
                    `Trigger navaid ${resolved.identifier} resolved via ` +
                    `${resolved.selection.tier === "terminal" ? "terminal facility filter" : "40 NM enroute fallback"} ` +
                    `from the ${resolved.selection.dataset === "tailored"
                        ? `tailored ${resolved.selection.operator} dataset`
                        : "public FAA dataset"} ` +
                    `as ${resolved.name} (${resolved.type}) at ${resolved.selection.distanceNM} NM from the ` +
                    `${runway.airportCode} ${runway.runwayIdentifier} reference point ` +
                    `(${resolved.selection.candidateCount} candidate station(s) shared this ident).`
            }
        };
    }

    // 5. Phase 4.3 leg navaids: every distinct station referenced by the
    //    runway's leg sequence, resolved through the identical tiered
    //    multi-tenant cascade. The runway threshold anchors the spatial
    //    search; any miss is a hard DataIntegrityError from the accessor.
    const legNavaids = {};

    if (Array.isArray(options.legNavaidIdents)) {
        const uniqueIdents = [...new Set(
            options.legNavaidIdents
                .filter((ident) => typeof ident === "string" && ident.trim() !== "")
                .map((ident) => ident.trim().toUpperCase())
        )];

        for (const ident of uniqueIdents) {
            const resolved = await navDb.resolveTriggerNavaid(
                ident,
                {
                    airportId: runway.airportCode,
                    latitude: runway.latitude,
                    longitude: runway.longitude
                },
                currentUtcTime,
                options.operatorId
            );

            legNavaids[ident] = {
                identifier: resolved.identifier,
                name: resolved.name,
                type: resolved.type,
                state: resolved.state,
                operator_id: resolved.operator_id,
                coordinates: {
                    latitude: resolved.latitude,
                    longitude: resolved.longitude
                },
                elevationFtMsl: resolved.elevationFtMsl,
                magneticVariation: resolved.magneticVariation,
                selection: resolved.selection
            };
        }
    }

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
            magneticVariation: runway.magneticVariation,
            elevation_ft: runway.elevation_ft
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
        triggerNavaid,
        legNavaids,
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
