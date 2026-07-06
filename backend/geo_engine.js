const turf = require("@turf/turf");
const { getNavaid, getRunway } = require("../utils/navDbQuery");

const EARTH_RADIUS_METERS = 6371008.8;
const NM_TO_METERS = 1852;

function calculateTrackCircleIntersection(aircraftTrackOrigin, aircraftBearing, navaidCoords, triggerDistanceNM) {
    const origin = toLngLat(aircraftTrackOrigin);
    const navaid = toLngLat(navaidCoords);
    const bearing = Number(aircraftBearing);
    const radiusNm = Number(triggerDistanceNM);

    if (!Number.isFinite(bearing) || !Number.isFinite(radiusNm)) {
        throw new Error("Invalid bearing or trigger distance supplied to geometry engine.");
    }

    const originPoint = turf.point(origin);
    const navaidPoint = turf.point(navaid);
    const bearingToNavaid = turf.bearing(originPoint, navaidPoint);
    const trackAngleRad = degreesToRadians(normalizeBearingDelta(bearingToNavaid - bearing));
    const distanceToNavaidNm = turf.distance(originPoint, navaidPoint, { units: "nauticalmiles" });
    const onRad = nmToRadians(distanceToNavaidNm);
    const rhoRad = nmToRadians(radiusNm);
    const cosRho = Math.cos(rhoRad);
    const cosOn = Math.cos(onRad);
    const sinOn = Math.sin(onRad);
    const cosTheta = Math.cos(trackAngleRad);
    const B = cosOn;
    const C = sinOn * cosTheta;
    const divisor = Math.hypot(B, C);
    const ratio = cosRho / divisor;

    if (Math.abs(ratio) > 1) {
        throw new Error("Track does not intersect the DME arc at the requested radius.");
    }

    const phi = Math.atan2(C, B);
    const angularOffset = Math.acos(ratio);
    const candidateSigmasRad = [phi + angularOffset, phi - angularOffset];
    let bestSigmaRad = null;

    for (const sigmaRad of candidateSigmasRad) {
        if (sigmaRad <= 0) {
            continue;
        }

        const sigmaNm = radiansToNm(sigmaRad);
        const candidatePoint = turf.destination(originPoint, sigmaNm, bearing, { units: "nauticalmiles" });
        const distanceToNavaidError = Math.abs(
            turf.distance(candidatePoint, navaidPoint, { units: "nauticalmiles" }) - radiusNm
        );

        if (distanceToNavaidError > 0.001) {
            continue;
        }

        if (bestSigmaRad === null || sigmaRad < bestSigmaRad) {
            bestSigmaRad = sigmaRad;
        }
    }

    if (bestSigmaRad === null) {
        throw new Error("No forward track intersection found on the DME arc.");
    }

    const distanceAlongTrackNM = radiansToNm(bestSigmaRad);
    const intersectionPoint = turf.destination(originPoint, distanceAlongTrackNM, bearing, { units: "nauticalmiles" });
    const [longitude, latitude] = intersectionPoint.geometry.coordinates;

    return {
        latitude,
        longitude,
        distanceAlongTrackNM: Number(distanceAlongTrackNM.toFixed(1)),
        dmeErrorNM: 0
    };
}

function computeRadialDistanceTurnPoint(runwayIdentifier, navaidIdentifier, triggerDistanceNM, aircraftBearing) {
    const runway = getRunway(runwayIdentifier);
    const navaid = getNavaid(navaidIdentifier);
    const bearing = Number.isFinite(Number(aircraftBearing)) ? Number(aircraftBearing) : runway.trueHeading;

    return calculateTrackCircleIntersection(
        { latitude: runway.latitude, longitude: runway.longitude },
        bearing,
        { latitude: navaid.latitude, longitude: navaid.longitude },
        triggerDistanceNM
    );
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
