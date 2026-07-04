const turf = require("@turf/turf");

function calculateDmeIntersection(aircraftTrackOrigin, aircraftBearing, navaidCoords, dmeDistance) {
    const origin = toLngLat(aircraftTrackOrigin);
    const navaid = toLngLat(navaidCoords);
    const bearing = Number(aircraftBearing);
    const dmeDistanceNm = Number(dmeDistance);

    if (!Number.isFinite(bearing) || !Number.isFinite(dmeDistanceNm)) {
        throw new Error("Invalid bearing or DME distance supplied to geometry engine.");
    }

    const originPoint = turf.point(origin);
    const navaidPoint = turf.point(navaid);
    let lowNm = 0;
    let highNm = null;
    let previousDelta = turf.distance(originPoint, navaidPoint, { units: "nauticalmiles" }) - dmeDistanceNm;

    for (let distanceAlongTrackNm = 0.25; distanceAlongTrackNm <= 250; distanceAlongTrackNm += 0.25) {
        const candidate = turf.destination(originPoint, distanceAlongTrackNm, bearing, { units: "nauticalmiles" });
        const delta = turf.distance(candidate, navaidPoint, { units: "nauticalmiles" }) - dmeDistanceNm;

        if (delta === 0 || Math.sign(delta) !== Math.sign(previousDelta)) {
            highNm = distanceAlongTrackNm;
            lowNm = distanceAlongTrackNm - 0.25;
            break;
        }

        previousDelta = delta;
    }

    if (highNm === null) {
        throw new Error("No forward intersection found for the requested DME radius.");
    }

    for (let step = 0; step < 60; step += 1) {
        const midNm = (lowNm + highNm) / 2;
        const candidate = turf.destination(originPoint, midNm, bearing, { units: "nauticalmiles" });
        const midDelta = turf.distance(candidate, navaidPoint, { units: "nauticalmiles" }) - dmeDistanceNm;
        const lowPoint = turf.destination(originPoint, lowNm, bearing, { units: "nauticalmiles" });
        const lowDelta = turf.distance(lowPoint, navaidPoint, { units: "nauticalmiles" }) - dmeDistanceNm;

        if (midDelta === 0) {
            lowNm = midNm;
            highNm = midNm;
            break;
        }

        if (Math.sign(midDelta) === Math.sign(lowDelta)) {
            lowNm = midNm;
        } else {
            highNm = midNm;
        }
    }

    const intersection = turf.destination(originPoint, highNm, bearing, { units: "nauticalmiles" });
    const [longitude, latitude] = intersection.geometry.coordinates;

    return {
        latitude,
        longitude
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
