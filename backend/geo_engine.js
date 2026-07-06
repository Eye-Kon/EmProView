const turf = require("@turf/turf");
const { getNavaid, getRunway } = require("../utils/navDbQuery");

const EARTH_RADIUS_METERS = 6371008.8;
const NM_TO_METERS = 1852;
const BEARING_ALIGNMENT_TOLERANCE_DEGREES = 1;
const DME_TOLERANCE_NM = 0.001;

function calculateTrackCircleIntersection(aircraftTrackOrigin, trueHeading, navaidCoords, triggerDistanceNM) {
    const origin = toLngLat(aircraftTrackOrigin);
    const navaid = toLngLat(navaidCoords);
    const departureBearing = normalizeBearing(Number(trueHeading));
    const radiusNm = Number(triggerDistanceNM);

    if (!Number.isFinite(departureBearing) || !Number.isFinite(radiusNm)) {
        throw new Error("Invalid bearing or trigger distance supplied to geometry engine.");
    }

    const originPoint = turf.point(origin);
    const navaidPoint = turf.point(navaid);
    const trackDistancesNm = solveTrackDistancesToCircle(
        originPoint,
        navaidPoint,
        departureBearing,
        radiusNm
    );

    let bestForwardIntersection = null;

    for (const trackDistanceNm of trackDistancesNm) {
        const candidatePoint = projectAlongTrueHeading(originPoint, trackDistanceNm, departureBearing);

        if (!isForwardAlongDepartureBearing(originPoint, candidatePoint, departureBearing)) {
            continue;
        }

        const dmeErrorNm = Math.abs(
            turf.distance(candidatePoint, navaidPoint, { units: "nauticalmiles" }) - radiusNm
        );

        if (dmeErrorNm > DME_TOLERANCE_NM) {
            continue;
        }

        if (
            bestForwardIntersection === null ||
            trackDistanceNm < bestForwardIntersection.distanceAlongTrackNM
        ) {
            bestForwardIntersection = {
                point: candidatePoint,
                distanceAlongTrackNM: trackDistanceNm,
                dmeErrorNM: dmeErrorNm
            };
        }
    }

    if (bestForwardIntersection === null) {
        throw new Error("No forward track intersection found on the DME arc.");
    }

    const [longitude, latitude] = bestForwardIntersection.point.geometry.coordinates;

    return {
        latitude,
        longitude,
        distanceAlongTrackNM: Number(bestForwardIntersection.distanceAlongTrackNM.toFixed(1)),
        dmeErrorNM: Number(bestForwardIntersection.dmeErrorNM.toFixed(3))
    };
}

function computeRadialDistanceTurnPoint(runwayIdentifier, navaidIdentifier, triggerDistanceNM) {
    const runway = getRunway(runwayIdentifier);
    const navaid = getNavaid(navaidIdentifier);

    return calculateTrackCircleIntersection(
        { latitude: runway.latitude, longitude: runway.longitude },
        runway.trueHeading,
        { latitude: navaid.latitude, longitude: navaid.longitude },
        triggerDistanceNM
    );
}

function projectAlongTrueHeading(originPoint, distanceNm, trueHeading) {
    return turf.destination(originPoint, distanceNm, trueHeading, { units: "nauticalmiles" });
}

function isForwardAlongDepartureBearing(originPoint, candidatePoint, departureBearing) {
    const distanceFromOriginNm = turf.distance(originPoint, candidatePoint, { units: "nauticalmiles" });

    if (distanceFromOriginNm <= DME_TOLERANCE_NM) {
        return false;
    }

    const bearingToCandidate = normalizeBearing(turf.bearing(originPoint, candidatePoint));
    const bearingDelta = Math.abs(normalizeBearingDelta(bearingToCandidate - departureBearing));

    return bearingDelta <= BEARING_ALIGNMENT_TOLERANCE_DEGREES;
}

function solveTrackDistancesToCircle(originPoint, navaidPoint, departureBearing, radiusNm) {
    const bearingToNavaid = turf.bearing(originPoint, navaidPoint);
    const trackAngleRad = degreesToRadians(normalizeBearingDelta(bearingToNavaid - departureBearing));
    const distanceToNavaidNm = turf.distance(originPoint, navaidPoint, { units: "nauticalmiles" });
    const onRad = nmToRadians(distanceToNavaidNm);
    const rhoRad = nmToRadians(radiusNm);
    const cosRho = Math.cos(rhoRad);
    const cosOn = Math.cos(onRad);
    const sinOn = Math.sin(onRad);
    const cosTheta = Math.cos(trackAngleRad);
    const amplitude = Math.hypot(cosOn, sinOn * cosTheta);
    const ratio = cosRho / amplitude;

    if (Math.abs(ratio) > 1) {
        throw new Error("Track does not intersect the DME arc at the requested radius.");
    }

    const phase = Math.atan2(sinOn * cosTheta, cosOn);
    const angularOffset = Math.acos(ratio);

    return [phase + angularOffset, phase - angularOffset]
        .map((sigmaRad) => radiansToNm(sigmaRad))
        .filter((sigmaNm) => sigmaNm > DME_TOLERANCE_NM);
}

function nmToRadians(distanceNm) {
    return (distanceNm * NM_TO_METERS) / EARTH_RADIUS_METERS;
}

function radiansToNm(angleRadians) {
    return (angleRadians * EARTH_RADIUS_METERS) / NM_TO_METERS;
}

function degreesToRadians(degrees) {
    return (degrees * Math.PI) / 180;
}

function normalizeBearing(bearing) {
    let normalized = bearing % 360;

    if (normalized < 0) {
        normalized += 360;
    }

    return normalized;
}

function normalizeBearingDelta(deltaDegrees) {
    let normalized = deltaDegrees % 360;

    if (normalized > 180) {
        normalized -= 360;
    } else if (normalized < -180) {
        normalized += 360;
    }

    return normalized;
}

function toLngLat(coords) {
    if (Array.isArray(coords) && coords.length >= 2) {
        return [Number(coords[1]), Number(coords[0])];
    }

    if (coords && typeof coords === "object") {
        const latitude = Number(coords.lat ?? coords.latitude);
        const longitude = Number(coords.lon ?? coords.lng ?? coords.longitude);

        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            return [longitude, latitude];
        }
    }

    throw new Error("Coordinates must be provided as { lat, lon } or [lat, lon].");
}

module.exports = {
    calculateTrackCircleIntersection,
    computeRadialDistanceTurnPoint
};
