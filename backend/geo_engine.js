const turf = require("@turf/turf");

function calculateDmeIntersection(aircraftTrackOrigin, aircraftBearing, navaidCoords, dmeDistance) {
    const origin = toLngLat(aircraftTrackOrigin);
    const navaid = toLngLat(navaidCoords);
    const bearing = Number(aircraftBearing);
    const dmeDistanceNm = Number(dmeDistance);

    if (!Number.isFinite(bearing) || !Number.isFinite(dmeDistanceNm)) {
        throw new Error("Invalid bearing or DME distance supplied to geometry engine.");
    }

    console.log("TURF AZIMUTH APPLIED:", bearing);

    const originPoint = turf.point(origin);
    const navaidPoint = turf.point(navaid);
    let bestCandidate = originPoint;
    let bestDelta = Math.abs(turf.distance(originPoint, navaidPoint, { units: "nauticalmiles" }) - dmeDistanceNm);
    let bestDistanceAlongTrackNM = 0;

    for (let distanceAlongTrackNm = 0.1; distanceAlongTrackNm <= 25; distanceAlongTrackNm += 0.1) {
        const candidate = turf.destination(originPoint, distanceAlongTrackNm, bearing, { units: "nauticalmiles" });
        const distanceToNavaidNM = turf.distance(candidate, navaidPoint, { units: "nauticalmiles" });
        const delta = Math.abs(distanceToNavaidNM - dmeDistanceNm);

        if (delta < bestDelta) {
            bestCandidate = candidate;
            bestDelta = delta;
            bestDistanceAlongTrackNM = distanceAlongTrackNm;
        }
    }

    if (bestDelta > 0.25) {
        throw new Error("No forward projected point closely matches the requested DME radius.");
    }

    const [longitude, latitude] = bestCandidate.geometry.coordinates;

    return {
        latitude,
        longitude,
        distanceAlongTrackNM: Number(bestDistanceAlongTrackNM.toFixed(1)),
        dmeErrorNM: Number(bestDelta.toFixed(3))
    };
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
    calculateDmeIntersection
};
