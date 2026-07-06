/**
 * PathGeometry: builds the distributable path artifact for a solved leg.
 *
 * The parametric record is the source of truth — ARINC-style leg semantics
 * (origin, trigger point, turn center/radius/sweep, entry/exit True headings)
 * that enterprise consumers (EFB, ATC automation) can ingest as procedural
 * data. The GeoJSON FeatureCollection is a derived rendering product for map
 * and canvas display; it discretizes the turn arc and must never be treated
 * as the authoritative geometry.
 *
 * Turn radius and leg lengths are declared nominal display values
 * (radiusSource/lengthSource: "nominal_display"), NOT aircraft-performance
 * derived. Consumers must not treat them as flyability guarantees until a
 * performance-based radius solver replaces them.
 */
const turf = require("@turf/turf");
const { GeoMath } = require("./GeoMath");

const NOMINAL_DISPLAY_TURN_RADIUS_NM = 1.5;
const NOMINAL_DISPLAY_OUTBOUND_LEG_NM = 12;
const ARC_SAMPLE_STEP_DEGREES = 5;

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

/**
 * Builds the path for a leg that tracks from origin to a computed trigger
 * point, then either turns (turn provided) or continues straight through.
 *
 * @param {object} params
 * @param {{latitude:number,longitude:number}} params.origin - leg start (runway threshold)
 * @param {{latitude:number,longitude:number}} params.triggerPoint - computed WGS-84 trigger
 * @param {number} params.departureTrueHeading - inbound track, True degrees
 * @param {object|null} params.turn - { targetTrueHeading, turnDegrees, turnDirection } or null
 * @param {string} params.runway - runway identifier for labeling
 */
function buildTriggeredTurnPath({ origin, triggerPoint, departureTrueHeading, turn, runway }) {
    const inboundLengthNM = Number(
        turf.distance(toPoint(origin), toPoint(triggerPoint), { units: "nauticalmiles" }).toFixed(2)
    );
    const trackCoordinates = [origin, triggerPoint];

    let turnRecord = null;
    let outbound;

    if (turn) {
        const sweepDegrees = turn.turnDegrees;
        const turnSign = sweepDegrees >= 0 ? 1 : -1;
        const radiusNM = NOMINAL_DISPLAY_TURN_RADIUS_NM;

        // Turn circle center sits 90 deg abeam the inbound track, on the turn side.
        const center = project(triggerPoint, departureTrueHeading + turnSign * 90, radiusNM);
        const entryRadial = departureTrueHeading - turnSign * 90;
        const exitRadial = entryRadial + sweepDegrees;
        const rollout = project(center, exitRadial, radiusNM);

        for (let sweep = ARC_SAMPLE_STEP_DEGREES; sweep < Math.abs(sweepDegrees); sweep += ARC_SAMPLE_STEP_DEGREES) {
            trackCoordinates.push(project(center, entryRadial + turnSign * sweep, radiusNM));
        }
        trackCoordinates.push(rollout);

        turnRecord = {
            direction: turn.turnDirection,
            sweepDegrees,
            radiusNM,
            radiusSource: "nominal_display",
            center,
            entryTrueHeading: GeoMath.normalizeBearing(departureTrueHeading),
            exitTrueHeading: GeoMath.normalizeBearing(turn.targetTrueHeading),
            rolloutPoint: rollout
        };
        outbound = {
            trueHeading: GeoMath.normalizeBearing(turn.targetTrueHeading),
            lengthNM: NOMINAL_DISPLAY_OUTBOUND_LEG_NM,
            lengthSource: "nominal_display",
            endPoint: project(rollout, turn.targetTrueHeading, NOMINAL_DISPLAY_OUTBOUND_LEG_NM)
        };
    } else {
        // Straight-through: track is unchanged across the trigger boundary.
        outbound = {
            trueHeading: GeoMath.normalizeBearing(departureTrueHeading),
            lengthNM: NOMINAL_DISPLAY_OUTBOUND_LEG_NM,
            lengthSource: "nominal_display",
            endPoint: project(triggerPoint, departureTrueHeading, NOMINAL_DISPLAY_OUTBOUND_LEG_NM)
        };
    }

    trackCoordinates.push(outbound.endPoint);

    const parametric = {
        legType: turn ? "TRACK_TO_TRIGGER_TURN" : "TRACK_THROUGH_TRIGGER",
        runway,
        origin,
        triggerPoint,
        inbound: {
            trueHeading: GeoMath.normalizeBearing(departureTrueHeading),
            lengthNM: inboundLengthNM
        },
        turn: turnRecord,
        outbound
    };

    const geojson = {
        type: "FeatureCollection",
        features: [
            {
                type: "Feature",
                geometry: {
                    type: "LineString",
                    coordinates: trackCoordinates.map((coords) => [coords.longitude, coords.latitude])
                },
                properties: {
                    runway,
                    legType: parametric.legType,
                    role: "track"
                }
            },
            {
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [triggerPoint.longitude, triggerPoint.latitude]
                },
                properties: {
                    runway,
                    role: "trigger_point"
                }
            }
        ]
    };

    return { parametric, geojson };
}

module.exports = {
    buildTriggeredTurnPath,
    NOMINAL_DISPLAY_TURN_RADIUS_NM,
    NOMINAL_DISPLAY_OUTBOUND_LEG_NM
};
