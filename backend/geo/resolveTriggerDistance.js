/**
 * Resolves a lateral trigger distance for WGS-84 intersection math.
 *
 * Lateral procedures supply triggerDistanceNM directly. Altitude-based
 * procedures (e.g. "Climb to 4500 MSL before turning") omit distance; the
 * along-track NM is derived from altitude, field elevation, and climb gradient.
 */
const { DataIntegrityError } = require("./DataIntegrityError");

/** KCLT field elevation (ft MSL). */
const FIELD_ELEVATION_FT = 748;

/** Standard climb gradient (ft / NM) when the chart does not state one. */
const DEFAULT_CLIMB_GRADIENT_FT_NM = 400;

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {object} params
 * @param {number|null|undefined} params.triggerDistanceNM
 * @param {number|null|undefined} params.triggerAltitudeMsl
 * @param {number|null|undefined} params.climbGradientFtNm
 * @param {string} [params.distanceFieldPath]
 * @param {string} [params.altitudeFieldPath]
 * @returns {number} Positive finite trigger distance in NM
 */
function resolveTriggerDistanceNM({
    triggerDistanceNM,
    triggerAltitudeMsl,
    climbGradientFtNm,
    distanceFieldPath = "trigger_distance_nm",
    altitudeFieldPath = "trigger_altitude_msl"
}) {
    if (isFiniteNumber(triggerDistanceNM)) {
        return triggerDistanceNM;
    }

    if (isFiniteNumber(triggerAltitudeMsl)) {
        const gradient =
            isFiniteNumber(climbGradientFtNm) && climbGradientFtNm > 0
                ? climbGradientFtNm
                : DEFAULT_CLIMB_GRADIENT_FT_NM;

        const distance = (triggerAltitudeMsl - FIELD_ELEVATION_FT) / gradient;

        if (!Number.isFinite(distance) || distance <= 0) {
            throw new DataIntegrityError(
                `Computed ${distanceFieldPath} from altitude is not a positive finite number ` +
                    `(altitude=${triggerAltitudeMsl}, fieldElevation=${FIELD_ELEVATION_FT}, gradient=${gradient}).`
            );
        }

        return distance;
    }

    throw new DataIntegrityError(
        `LLM extraction must include either ${distanceFieldPath} or ${altitudeFieldPath}.`
    );
}

module.exports = {
    FIELD_ELEVATION_FT,
    DEFAULT_CLIMB_GRADIENT_FT_NM,
    resolveTriggerDistanceNM
};
