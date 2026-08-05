/**
 * Resolves a lateral trigger distance for WGS-84 intersection math.
 *
 * Lateral procedures supply triggerDistanceNM directly. Altitude-based
 * procedures (e.g. "Climb to 4500 MSL before turning") omit distance; the
 * along-track NM is derived from altitude, field elevation, and climb gradient.
 *
 * Callers must pass already-optional-normalized values (null when absent).
 * This helper never requires triggerDistanceNM — altitude alone is enough.
 */
const { DataIntegrityError } = require("./DataIntegrityError");
const { optionalFiniteNumber } = require("./validation");

/** KCLT field elevation (ft MSL). */
const FIELD_ELEVATION_FT = 748;

/** Standard climb gradient (ft / NM) when the chart does not state one. */
const DEFAULT_CLIMB_GRADIENT_FT_NM = 400;

/**
 * @param {object} params
 * @param {unknown} params.triggerDistanceNM  optional; null/undefined allowed
 * @param {unknown} params.triggerAltitudeMsl optional; null/undefined allowed
 * @param {unknown} params.climbGradientFtNm  optional; null/undefined allowed
 * @param {string} [params.distanceFieldPath]
 * @param {string} [params.altitudeFieldPath]
 * @returns {number} Positive finite trigger distance in NM
 */
function resolveTriggerDistanceNM({
    triggerDistanceNM,
    triggerAltitudeMsl,
    climbGradientFtNm,
    distanceFieldPath = "trigger_distance_nm",
    altitudeFieldPath = "trigger_altitude_msl",
    climbGradientFieldPath = "climb_gradient_ft_nm"
}) {
    // Normalize first — never call requireFiniteNumber on these optional fields.
    const distance = optionalFiniteNumber(triggerDistanceNM, distanceFieldPath);
    const altitude = optionalFiniteNumber(triggerAltitudeMsl, altitudeFieldPath);
    const gradientRaw = optionalFiniteNumber(climbGradientFtNm, climbGradientFieldPath);

    let resolved;

    if (distance !== null) {
        resolved = distance;
    } else if (altitude !== null) {
        const gradient =
            gradientRaw !== null && gradientRaw > 0
                ? gradientRaw
                : DEFAULT_CLIMB_GRADIENT_FT_NM;

        resolved = (altitude - FIELD_ELEVATION_FT) / gradient;
    } else {
        throw new DataIntegrityError(
            `LLM extraction must include either ${distanceFieldPath} or ${altitudeFieldPath}.`
        );
    }

    // Hard circuit breaker: never hand NaN / <=0 / Infinity to the spatial solver.
    if (Number.isNaN(resolved) || !Number.isFinite(resolved) || resolved <= 0) {
        throw new Error("Invalid distance calculated");
    }

    return resolved;
}

module.exports = {
    FIELD_ELEVATION_FT,
    DEFAULT_CLIMB_GRADIENT_FT_NM,
    resolveTriggerDistanceNM
};
