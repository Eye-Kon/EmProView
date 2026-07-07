/**
 * RADIAL_DISTANCE_INTERSECTION solver strategy.
 *
 * Computes the WGS-84 point where the departure track (runway True Heading)
 * intersects a DME radius around a reference navaid, then evaluates the
 * commanded turn at that point. All headings are normalized to True North
 * before any spatial math: the AI payload carries magnetic headings, and the
 * ground-truth magnetic variation comes exclusively from the navDb layer.
 */
const { GeoMath } = require("../GeoMath");
const { buildTriggeredTurnPath } = require("../PathGeometry");
const { requireField, requireFiniteNumber, requireNonEmptyString } = require("../validation");
const { DataIntegrityError } = require("../DataIntegrityError");

const TRIGGER_TYPE = "RADIAL_DISTANCE_INTERSECTION";

async function solve(segment, row, context) {
    const navDb = requireField(context?.navDb, "context.navDb");
    const airportCode = requireNonEmptyString(context?.airportCode, "context.airportCode");
    // Temporal targeting: ground truth resolves against the AIRAC cycle
    // effective on the flight date (undefined = current UTC time).
    const flightDate = context?.flightDate;

    const spatialTrigger = requireField(segment.spatialTrigger, "segment.spatialTrigger");
    const referenceNavaid = requireNonEmptyString(
        spatialTrigger.referenceNavaid,
        "segment.spatialTrigger.referenceNavaid"
    );
    const triggerDistanceNM = requireFiniteNumber(
        spatialTrigger.triggerDistanceNM,
        "segment.spatialTrigger.triggerDistanceNM"
    );
    const commandedTurn = resolveCommandedTurn(spatialTrigger.resultingAction);

    const runwayIdentifiers = requireField(row?.runways, "row.runways");

    if (!Array.isArray(runwayIdentifiers) || runwayIdentifiers.length === 0) {
        throw new DataIntegrityError("row.runways must be a non-empty array of runway identifiers.");
    }

    // Resolve runway ground truth first: the runway threshold anchors the
    // spatial disambiguation of duplicate navaid idents (FMS behavior — the
    // station nearest the procedure's origin wins, never a blind ident match).
    // An undefined flightDate falls through to the query layer's default
    // (current UTC time).
    const runways = await Promise.all(
        runwayIdentifiers.map((runwayIdentifier) => navDb.getRunway(airportCode, runwayIdentifier, flightDate))
    );
    const navaid = await navDb.getNavaid(
        referenceNavaid,
        { latitude: runways[0].latitude, longitude: runways[0].longitude },
        flightDate
    );
    const computedTurnPoints = runways.map((runway) =>
        solveForRunway({
            runway,
            navaid,
            triggerDistanceNM,
            commandedTurn
        })
    );

    return {
        triggerType: TRIGGER_TYPE,
        referenceNavaid: navaid.identifier,
        // Traceability: exactly which physical station resolved the ident,
        // including spatial disambiguation evidence when the ident was duplicated.
        resolvedNavaid: {
            identifier: navaid.identifier,
            name: navaid.name,
            type: navaid.type,
            state: navaid.state,
            latitude: navaid.latitude,
            longitude: navaid.longitude,
            ...(navaid.disambiguation ? { disambiguation: navaid.disambiguation } : {})
        },
        triggerDistanceNM,
        // Provenance: the AIRAC cycle whose ground truth produced this geometry.
        groundTruth: typeof navDb.determineActiveCycle === "function"
            ? { airacCycle: await navDb.determineActiveCycle(flightDate ?? new Date()) }
            : undefined,
        computedTurnPoints,
        // Preserved single-runway contract for existing renderers.
        ...(computedTurnPoints.length === 1 ? { computedTurnPoint: computedTurnPoints[0] } : {})
    };
}

/**
 * Classifies the resulting action at the trigger point.
 *
 * Returns { turnDirection, magneticHeading } when a turn is commanded, or
 * null for a valid straight-through fix (the aircraft maintains its current
 * track across the boundary). Throws DataIntegrityError only when a turn is
 * clearly intended but the payload is incoherent.
 */
function resolveCommandedTurn(resultingAction) {
    const turnDirection =
        typeof resultingAction?.turnDirection === "string"
            ? resultingAction.turnDirection.trim().toLowerCase()
            : null;
    const magneticHeadingRaw = resultingAction?.magneticHeading;
    const hasCommandedHeading = magneticHeadingRaw !== null && magneticHeadingRaw !== undefined;
    const isTurnDirection = turnDirection === "left" || turnDirection === "right";

    // Straight-through waypoint: the schema explicitly declares no turn, or
    // the action carries neither a direction nor a commanded heading.
    if (turnDirection === "not_applicable" || (!hasCommandedHeading && !isTurnDirection)) {
        return null;
    }

    if (!isTurnDirection) {
        throw new DataIntegrityError(
            `A turn is commanded at the trigger point but turnDirection is missing or invalid: ${
                resultingAction?.turnDirection ?? "null"
            }. Expected 'left' or 'right'.`
        );
    }

    return {
        turnDirection,
        magneticHeading: requireFiniteNumber(
            magneticHeadingRaw,
            "segment.spatialTrigger.resultingAction.magneticHeading"
        )
    };
}

function solveForRunway({
    runway,
    navaid,
    triggerDistanceNM,
    commandedTurn
}) {
    const intersection = GeoMath.calculateTrackCircleIntersection(
        { latitude: runway.latitude, longitude: runway.longitude },
        runway.trueHeading,
        { latitude: navaid.latitude, longitude: navaid.longitude },
        triggerDistanceNM
    );
    const basePoint = {
        runway: runway.runwayIdentifier,
        latitude: intersection.latitude,
        longitude: intersection.longitude,
        distanceAlongTrackNM: intersection.distanceAlongTrackNM,
        dmeErrorNM: intersection.dmeErrorNM,
        departureTrueHeading: runway.trueHeading,
        magneticVariation: runway.magneticVariation
    };

    const origin = { latitude: runway.latitude, longitude: runway.longitude };
    const triggerPoint = { latitude: intersection.latitude, longitude: intersection.longitude };

    // Straight-through fix: the track is unchanged across the boundary, so no
    // magnetic-to-True normalization or turn evaluation applies.
    if (commandedTurn === null) {
        return {
            ...basePoint,
            turnDirection: "not_applicable",
            path: buildTriggeredTurnPath({
                origin,
                triggerPoint,
                departureTrueHeading: runway.trueHeading,
                turn: null,
                runway: runway.runwayIdentifier
            })
        };
    }

    // True North Normalization: the AI-provided magnetic heading is converted
    // to True using database ground truth before it touches spatial math.
    const targetTrueHeading = GeoMath.magneticToTrue(
        commandedTurn.magneticHeading,
        runway.magneticVariation
    );
    const turnEvaluation = GeoMath.getAngularDifference(
        runway.trueHeading,
        targetTrueHeading,
        commandedTurn.turnDirection
    );

    return {
        ...basePoint,
        targetMagneticHeading: GeoMath.normalizeBearing(commandedTurn.magneticHeading),
        targetHeading: turnEvaluation.targetHeading,
        turnDirection: turnEvaluation.turnDirection,
        turnMagnitude: turnEvaluation.turnMagnitude,
        turnDegrees: turnEvaluation.turnDegrees,
        path: buildTriggeredTurnPath({
            origin,
            triggerPoint,
            departureTrueHeading: runway.trueHeading,
            turn: {
                targetTrueHeading: turnEvaluation.targetHeading,
                turnDegrees: turnEvaluation.turnDegrees,
                turnDirection: turnEvaluation.turnDirection
            },
            runway: runway.runwayIdentifier
        })
    };
}

module.exports = {
    triggerType: TRIGGER_TYPE,
    solve
};
