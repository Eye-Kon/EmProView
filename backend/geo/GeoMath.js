const turf = require("@turf/turf");
const { DataIntegrityError } = require("./DataIntegrityError");

const EARTH_RADIUS_METERS = 6371008.8;
const NM_TO_METERS = 1852;
const BEARING_ALIGNMENT_TOLERANCE_DEGREES = 1;
const DME_TOLERANCE_NM = 0.001;

const GeoMath = {
    /**
     * Converts a magnetic heading to a WGS-84 True heading using the
     * station/runway magnetic variation (degrees, East-positive).
     * All spatial math in this engine operates in True degrees only.
     */
    magneticToTrue(magneticHeading, magneticVariation) {
        const magnetic = Number(magneticHeading);
        const variation = Number(magneticVariation);

        if (!Number.isFinite(magnetic) || !Number.isFinite(variation)) {
            throw new DataIntegrityError(
                "magneticToTrue requires finite magneticHeading and magneticVariation values."
            );
        }

        return GeoMath.normalizeBearing(magnetic + variation);
    },

    trueToMagnetic(trueHeading, magneticVariation) {
        const trueValue = Number(trueHeading);
        const variation = Number(magneticVariation);

        if (!Number.isFinite(trueValue) || !Number.isFinite(variation)) {
            throw new DataIntegrityError(
                "trueToMagnetic requires finite trueHeading and magneticVariation values."
            );
        }

        return GeoMath.normalizeBearing(trueValue - variation);
    },

    normalizeBearing(bearing) {
        let normalized = Number(bearing) % 360;

        if (normalized < 0) {
            normalized += 360;
        }

        return normalized;
    },

    normalizeBearingDelta(deltaDegrees) {
        let normalized = deltaDegrees % 360;

        if (normalized > 180) {
            normalized -= 360;
        } else if (normalized < -180) {
            normalized += 360;
        }

        return normalized;
    },

    getAngularDifference(fromHeading, toHeading, direction) {
        const departureHeading = GeoMath.normalizeBearing(fromHeading);
        const targetHeading = GeoMath.normalizeBearing(toHeading);
        const turnDirection = String(direction).trim().toLowerCase();

        if (!Number.isFinite(departureHeading) || !Number.isFinite(targetHeading)) {
            throw new DataIntegrityError("Heading values must be finite numbers for angular difference calculation.");
        }

        if (turnDirection !== "left" && turnDirection !== "right") {
            throw new DataIntegrityError(`Unsupported turn direction: ${direction}`);
        }

        const leftTurnMagnitude = GeoMath.normalizeBearing(departureHeading - targetHeading);
        const rightTurnMagnitude = GeoMath.normalizeBearing(targetHeading - departureHeading);
        const turnMagnitude = turnDirection === "left" ? leftTurnMagnitude : rightTurnMagnitude;
        const turnDegrees = turnDirection === "left" ? -turnMagnitude : turnMagnitude;

        return {
            departureHeading,
            targetHeading,
            turnDirection,
            turnMagnitude: Number(turnMagnitude.toFixed(1)),
            turnDegrees: Number(turnDegrees.toFixed(1))
        };
    },

    toLngLat(coords) {
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

        throw new DataIntegrityError("Coordinates must be provided as { latitude, longitude } or [lat, lon].");
    },

    calculateTrackCircleIntersection(originCoords, trueHeading, navaidCoords, triggerDistanceNM) {
        const origin = GeoMath.toLngLat(originCoords);
        const navaid = GeoMath.toLngLat(navaidCoords);
        const departureBearing = GeoMath.normalizeBearing(trueHeading);
        const radiusNm = Number(triggerDistanceNM);

        if (!Number.isFinite(departureBearing) || !Number.isFinite(radiusNm)) {
            throw new DataIntegrityError("Departure bearing and trigger distance must be finite numbers.");
        }

        const originPoint = turf.point(origin);
        const navaidPoint = turf.point(navaid);
        const trackDistancesNm = GeoMath.solveTrackDistancesToCircle(
            originPoint,
            navaidPoint,
            departureBearing,
            radiusNm
        );

        let bestForwardIntersection = null;

        for (const trackDistanceNm of trackDistancesNm) {
            const candidatePoint = GeoMath.projectAlongTrueHeading(originPoint, trackDistanceNm, departureBearing);

            if (!GeoMath.isForwardAlongDepartureBearing(originPoint, candidatePoint, departureBearing)) {
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
            throw new DataIntegrityError("No forward track intersection found on the DME arc.");
        }

        const [longitude, latitude] = bestForwardIntersection.point.geometry.coordinates;

        return {
            latitude,
            longitude,
            distanceAlongTrackNM: Number(bestForwardIntersection.distanceAlongTrackNM.toFixed(1)),
            dmeErrorNM: Number(bestForwardIntersection.dmeErrorNM.toFixed(3))
        };
    },

    projectAlongTrueHeading(originPoint, distanceNm, trueHeading) {
        return turf.destination(originPoint, distanceNm, trueHeading, { units: "nauticalmiles" });
    },

    isForwardAlongDepartureBearing(originPoint, candidatePoint, departureBearing) {
        const distanceFromOriginNm = turf.distance(originPoint, candidatePoint, { units: "nauticalmiles" });

        if (distanceFromOriginNm <= DME_TOLERANCE_NM) {
            return false;
        }

        const bearingToCandidate = GeoMath.normalizeBearing(turf.bearing(originPoint, candidatePoint));
        const bearingDelta = Math.abs(GeoMath.normalizeBearingDelta(bearingToCandidate - departureBearing));

        return bearingDelta <= BEARING_ALIGNMENT_TOLERANCE_DEGREES;
    },

    solveTrackDistancesToCircle(originPoint, navaidPoint, departureBearing, radiusNm) {
        const bearingToNavaid = turf.bearing(originPoint, navaidPoint);
        const trackAngleRad = GeoMath.degreesToRadians(
            GeoMath.normalizeBearingDelta(bearingToNavaid - departureBearing)
        );
        const distanceToNavaidNm = turf.distance(originPoint, navaidPoint, { units: "nauticalmiles" });
        const onRad = GeoMath.nmToRadians(distanceToNavaidNm);
        const rhoRad = GeoMath.nmToRadians(radiusNm);
        const cosRho = Math.cos(rhoRad);
        const cosOn = Math.cos(onRad);
        const sinOn = Math.sin(onRad);
        const cosTheta = Math.cos(trackAngleRad);
        const amplitude = Math.hypot(cosOn, sinOn * cosTheta);
        const ratio = cosRho / amplitude;

        if (Math.abs(ratio) > 1) {
            throw new DataIntegrityError("Track does not intersect the DME arc at the requested radius.");
        }

        const phase = Math.atan2(sinOn * cosTheta, cosOn);
        const angularOffset = Math.acos(ratio);

        return [phase + angularOffset, phase - angularOffset]
            .map((sigmaRad) => GeoMath.radiansToNm(sigmaRad))
            .filter((sigmaNm) => sigmaNm > DME_TOLERANCE_NM);
    },

    nmToRadians(distanceNm) {
        return (distanceNm * NM_TO_METERS) / EARTH_RADIUS_METERS;
    },

    radiansToNm(angleRadians) {
        return (angleRadians * EARTH_RADIUS_METERS) / NM_TO_METERS;
    },

    degreesToRadians(degrees) {
        return (degrees * Math.PI) / 180;
    }
};

module.exports = {
    GeoMath
};
