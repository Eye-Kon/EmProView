/**
 * MultiLegSolver: Phase 4.3 WGS-84 geodesic solver for multi-runway,
 * multi-leg engine-failure procedures.
 *
 * Walks one runway's validated leg sequence (parseRunwayMatrix output)
 * as a stateful geodetic cursor — position, True heading, distance flown,
 * and altitude — and emits one GeoJSON LineString feature per leg plus a
 * Point feature at every DME trigger intersection. Leg semantics:
 *
 *   TRACK_TO_DME       straight geodesic from the cursor along the current
 *                      True track to the forward intersection with the DME
 *                      arc (leg.value NM) around the leg's station.
 *   TURN_TO_HEADING    standard-bank turn arc from the cursor's current
 *                      track onto the target magnetic heading (converted to
 *                      True via the origin runway's magnetic variation).
 *   TRACK_TO_ALTITUDE  straight climb vector along the current track until
 *                      the cumulative climb profile reaches leg.value ft MSL.
 *
 * Provenance neutrality (Phase 4.3 contract): CHARTED and ROWSPAN_INHERITED
 * legs run through EXACTLY the same math. Provenance is copied verbatim into
 * each feature's properties for UI styling and is never read by the solver.
 *
 * The climb profile is a nominal display model, not aircraft performance:
 * altitude accrues at DEFAULT_CLIMB_GRADIENT_FT_PER_NM over every NM flown
 * (straight legs and turn arc length alike). The turn radius derives from a
 * standard 25° bank at a nominal engine-out climb TAS — declared in the
 * parametric record as radiusSource "standard_bank_nominal_tas", never a
 * flyability guarantee.
 */
const turf = require("@turf/turf");
const { GeoMath } = require("./GeoMath");
const { DataIntegrityError } = require("./DataIntegrityError");

// Standard-rate turn geometry: R = V² / (g · tan(bank)), with a standard
// 25° bank angle at a nominal 200 kt engine-out climb TAS ≈ 1.25 NM.
const STANDARD_BANK_ANGLE_DEGREES = 25;
const NOMINAL_CLIMB_TAS_KT = 200;
const KT_TO_MPS = 0.514444;
const G_MPS2 = 9.80665;
const METERS_PER_NM = 1852;
const STANDARD_TURN_RADIUS_NM = Number(
    (
        Math.pow(NOMINAL_CLIMB_TAS_KT * KT_TO_MPS, 2) /
        (G_MPS2 * Math.tan((STANDARD_BANK_ANGLE_DEGREES * Math.PI) / 180)) /
        METERS_PER_NM
    ).toFixed(3)
);

// Nominal climb gradient (ft/NM) driving the display climb profile; matches
// the engine default used by the pre-Phase 4 flat pipeline.
const DEFAULT_CLIMB_GRADIENT_FT_PER_NM = 400;

const ARC_SAMPLE_STEP_DEGREES = 5;

// Display-only extension past the final rollout so the escape heading is
// visible on the map when the procedure ends in a turn.
const FINAL_ROLLOUT_DISPLAY_EXTENSION_NM = 12;

function toPoint(coords) {
    return turf.point([coords.longitude, coords.latitude]);
}

function toLatLng(turfPoint) {
    const [longitude, latitude] = turfPoint.geometry.coordinates;

    return {
        latitude: Number(latitude.toFixed(6)),
        longitude: Number(longitude.toFixed(6))
    };
}

function project(coords, trueHeading, distanceNM) {
    return toLatLng(
        turf.destination(toPoint(coords), distanceNM, GeoMath.normalizeBearingDelta(trueHeading), {
            units: "nauticalmiles"
        })
    );
}

function lineFeature(coordinates, properties) {
    return {
        type: "Feature",
        geometry: {
            type: "LineString",
            coordinates: coordinates.map((coords) => [coords.longitude, coords.latitude])
        },
        properties
    };
}

function pointFeature(coords, properties) {
    return {
        type: "Feature",
        geometry: {
            type: "Point",
            coordinates: [coords.longitude, coords.latitude]
        },
        properties
    };
}

/**
 * Advances the geodetic cursor by a flown distance: cumulative distance
 * always accrues; altitude accrues only when an elevation reference exists
 * (finite start altitude), at the nominal climb gradient.
 */
function advanceCursor(cursor, distanceNM) {
    cursor.distanceFlownNM += distanceNM;

    if (Number.isFinite(cursor.altitudeFtMsl)) {
        cursor.altitudeFtMsl += distanceNM * DEFAULT_CLIMB_GRADIENT_FT_PER_NM;
    }
}

/**
 * Solves the complete escape path for one runway.
 *
 * @param {object} params
 * @param {string} params.runwayId - resolved runway identifier, e.g. "16L"
 * @param {{latitude:number,longitude:number}} params.origin - runway threshold (WGS-84)
 * @param {number} params.departureTrueHeading - runway True heading, degrees
 * @param {number} params.magneticVariation - degrees East-positive, from the runway record
 * @param {number|null} params.startElevationFtMsl - climb-profile anchor (ft MSL);
 *   null is allowed unless the sequence contains a TRACK_TO_ALTITUDE leg
 * @param {Array} params.legs - validated legs from parseRunwayMatrix
 * @param {object} params.stationsByIdent - { IDENT: { identifier, coordinates:{latitude,longitude} } }
 *   for every navaid ident referenced by a leg
 * @param {object} params.defaultStation - fallback DME station (the request
 *   payload's navaidId) used when a TRACK_TO_DME leg names no station
 * @returns {{ features: object[], parametric: object }}
 * @throws {DataIntegrityError} on unresolvable stations or an unanchorable climb
 */
function solveRunwayEscapePath({
    runwayId,
    origin,
    departureTrueHeading,
    magneticVariation,
    startElevationFtMsl,
    legs,
    stationsByIdent,
    defaultStation
}) {
    const cursor = {
        position: { latitude: origin.latitude, longitude: origin.longitude },
        trueHeading: GeoMath.normalizeBearing(departureTrueHeading),
        distanceFlownNM: 0,
        altitudeFtMsl: Number.isFinite(startElevationFtMsl) ? startElevationFtMsl : null
    };

    const features = [];
    const parametricLegs = [];

    legs.forEach((leg, index) => {
        // Provenance is UI metadata only — carried through untouched, never
        // consulted by any branch below.
        const baseProperties = {
            runway: runwayId,
            legIndex: index,
            legType: leg.type,
            provenance: leg.provenance,
            role: "leg"
        };

        if (leg.type === "TRACK_TO_DME") {
            const stationIdent = leg.navaid ? leg.navaid.toUpperCase() : null;
            const station = stationIdent ? stationsByIdent[stationIdent] : defaultStation;

            if (!station) {
                throw new DataIntegrityError(
                    `Runway ${runwayId} leg ${index} (TRACK_TO_DME): station ${stationIdent} was not resolved ` +
                        `against the navigation database.`
                );
            }

            const intersection = GeoMath.calculateTrackCircleIntersection(
                cursor.position,
                cursor.trueHeading,
                station.coordinates,
                leg.value
            );
            const triggerPoint = { latitude: intersection.latitude, longitude: intersection.longitude };

            features.push(lineFeature([cursor.position, triggerPoint], baseProperties));
            features.push(pointFeature(triggerPoint, {
                runway: runwayId,
                legIndex: index,
                legType: leg.type,
                provenance: leg.provenance,
                role: "trigger_point",
                dmeDistanceNM: leg.value,
                navaid: station.identifier
            }));

            parametricLegs.push({
                legType: leg.type,
                provenance: leg.provenance,
                startPoint: cursor.position,
                endPoint: triggerPoint,
                trueHeading: cursor.trueHeading,
                dme: {
                    navaid: station.identifier,
                    distanceNM: leg.value,
                    distanceAlongTrackNM: intersection.distanceAlongTrackNM,
                    dmeErrorNM: intersection.dmeErrorNM
                }
            });

            advanceCursor(cursor, intersection.distanceAlongTrackNM);
            cursor.position = triggerPoint;
            return;
        }

        if (leg.type === "TURN_TO_HEADING") {
            const targetTrueHeading = GeoMath.magneticToTrue(leg.value, magneticVariation);

            let turnDegrees;
            let turnDirection;

            if (leg.direction) {
                const evaluation = GeoMath.getAngularDifference(
                    cursor.trueHeading,
                    targetTrueHeading,
                    leg.direction
                );
                turnDegrees = evaluation.turnDegrees;
                turnDirection = evaluation.turnDirection;
            } else {
                // No charted direction: shortest-turn convention.
                turnDegrees = Number(
                    GeoMath.normalizeBearingDelta(targetTrueHeading - cursor.trueHeading).toFixed(1)
                );
                turnDirection = turnDegrees >= 0 ? "right" : "left";
            }

            if (!Number.isFinite(turnDegrees)) {
                throw new Error("Invalid distance calculated");
            }

            const turnSign = turnDegrees >= 0 ? 1 : -1;
            const radiusNM = STANDARD_TURN_RADIUS_NM;
            // Turn circle center sits 90° abeam the inbound track, on the turn side.
            const center = project(cursor.position, cursor.trueHeading + turnSign * 90, radiusNM);
            const entryRadial = cursor.trueHeading - turnSign * 90;
            const absSweep = Math.min(Math.abs(turnDegrees), 360);
            const arcCoordinates = [cursor.position];

            let iterations = 0;
            for (let sweep = ARC_SAMPLE_STEP_DEGREES; sweep < absSweep; sweep += ARC_SAMPLE_STEP_DEGREES) {
                iterations += 1;
                if (iterations > 10000) {
                    throw new Error("Infinite loop averted");
                }
                arcCoordinates.push(project(center, entryRadial + turnSign * sweep, radiusNM));
            }

            const rollout = project(center, entryRadial + turnSign * absSweep, radiusNM);
            arcCoordinates.push(rollout);

            // Final-leg turns get a display-only rollout extension so the
            // escape heading is visible; the parametric endpoint stays at
            // the rollout point.
            const isFinalLeg = index === legs.length - 1;
            if (isFinalLeg) {
                arcCoordinates.push(project(rollout, targetTrueHeading, FINAL_ROLLOUT_DISPLAY_EXTENSION_NM));
            }

            features.push(lineFeature(arcCoordinates, {
                ...baseProperties,
                ...(isFinalLeg ? { rolloutExtensionNM: FINAL_ROLLOUT_DISPLAY_EXTENSION_NM } : {})
            }));

            const arcLengthNM = radiusNM * ((absSweep * Math.PI) / 180);

            parametricLegs.push({
                legType: leg.type,
                provenance: leg.provenance,
                startPoint: cursor.position,
                endPoint: rollout,
                turn: {
                    direction: turnDirection,
                    directionSource: leg.direction ? "charted" : "shortest_turn",
                    sweepDegrees: turnDegrees,
                    radiusNM,
                    radiusSource: "standard_bank_nominal_tas",
                    bankAngleDegrees: STANDARD_BANK_ANGLE_DEGREES,
                    center,
                    entryTrueHeading: cursor.trueHeading,
                    exitTrueHeading: targetTrueHeading,
                    targetMagneticHeading: leg.value
                }
            });

            advanceCursor(cursor, arcLengthNM);
            cursor.position = rollout;
            cursor.trueHeading = targetTrueHeading;
            return;
        }

        if (leg.type === "TRACK_TO_ALTITUDE") {
            if (!Number.isFinite(cursor.altitudeFtMsl)) {
                throw new DataIntegrityError(
                    `Runway ${runwayId} leg ${index} (TRACK_TO_ALTITUDE): no field elevation reference is ` +
                        `available to anchor the climb profile. A terminal station with a validated MSL ` +
                        `elevation must resolve at this airport before altitude triggers can be solved.`
                );
            }

            // Altitude already satisfied earlier in the profile collapses to a
            // zero-length leg at the cursor ("at or above" semantics).
            const remainingFt = Math.max(leg.value - cursor.altitudeFtMsl, 0);
            const climbDistanceNM = Number((remainingFt / DEFAULT_CLIMB_GRADIENT_FT_PER_NM).toFixed(3));
            const capturePoint = climbDistanceNM > 0
                ? project(cursor.position, cursor.trueHeading, climbDistanceNM)
                : cursor.position;

            features.push(lineFeature([cursor.position, capturePoint], baseProperties));

            parametricLegs.push({
                legType: leg.type,
                provenance: leg.provenance,
                startPoint: cursor.position,
                endPoint: capturePoint,
                trueHeading: cursor.trueHeading,
                climb: {
                    targetAltitudeFtMsl: leg.value,
                    startAltitudeFtMsl: Number(cursor.altitudeFtMsl.toFixed(0)),
                    distanceNM: climbDistanceNM,
                    gradientFtPerNM: DEFAULT_CLIMB_GRADIENT_FT_PER_NM,
                    gradientSource: "nominal_display"
                }
            });

            advanceCursor(cursor, climbDistanceNM);
            cursor.position = capturePoint;
            cursor.altitudeFtMsl = Math.max(cursor.altitudeFtMsl, leg.value);
            return;
        }

        // parseRunwayMatrix guarantees the enum; reaching here means the
        // validator and the solver disagree on the schema.
        throw new DataIntegrityError(
            `Runway ${runwayId} leg ${index}: unsupported leg type '${leg.type}'.`
        );
    });

    return {
        features,
        parametric: {
            runway: runwayId,
            origin,
            departureTrueHeading: GeoMath.normalizeBearing(departureTrueHeading),
            finalTrueHeading: cursor.trueHeading,
            totalDistanceNM: Number(cursor.distanceFlownNM.toFixed(2)),
            finalAltitudeFtMsl: Number.isFinite(cursor.altitudeFtMsl)
                ? Number(cursor.altitudeFtMsl.toFixed(0))
                : null,
            legs: parametricLegs
        }
    };
}

module.exports = {
    solveRunwayEscapePath,
    STANDARD_BANK_ANGLE_DEGREES,
    STANDARD_TURN_RADIUS_NM,
    DEFAULT_CLIMB_GRADIENT_FT_PER_NM,
    FINAL_ROLLOUT_DISPLAY_EXTENSION_NM
};
