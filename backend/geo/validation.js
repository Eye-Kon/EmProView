const { DataIntegrityError } = require("./DataIntegrityError");

function requireField(value, fieldPath) {
    if (value === undefined || value === null) {
        throw new DataIntegrityError(`Missing required field: ${fieldPath}`);
    }

    return value;
}

function requireFiniteNumber(value, fieldPath) {
    // Strict type check: Number(null) coerces to 0, which would silently turn
    // a missing field into a valid-looking value.
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new DataIntegrityError(`Field ${fieldPath} must be a finite number.`);
    }

    return value;
}

/**
 * Optional numeric field for LLM payloads. Accepts null/undefined/"" as
 * "not provided". Coerces numeric strings (LLMs often emit "4500"). Rejects
 * non-numeric junk so bad data still surfaces as a 422.
 *
 * @returns {number|null}
 */
function optionalFiniteNumber(value, fieldPath) {
    if (value === undefined || value === null) {
        return null;
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed === "" || trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "none") {
            return null;
        }

        const coerced = Number(trimmed);
        if (!Number.isFinite(coerced)) {
            throw new DataIntegrityError(`Field ${fieldPath} must be a finite number, null, or omitted.`);
        }

        return coerced;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    throw new DataIntegrityError(`Field ${fieldPath} must be a finite number, null, or omitted.`);
}

function requireNonEmptyString(value, fieldPath) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new DataIntegrityError(`Field ${fieldPath} must be a non-empty string.`);
    }

    return value.trim();
}

/**
 * Optional string field for LLM payloads. Treats null/undefined/""/"null"/"none"
 * as absent; otherwise returns a trimmed non-empty string.
 *
 * @returns {string|null}
 */
function optionalNonEmptyString(value, fieldPath) {
    if (value === undefined || value === null) {
        return null;
    }

    if (typeof value !== "string") {
        throw new DataIntegrityError(`Field ${fieldPath} must be a string, null, or omitted.`);
    }

    const trimmed = value.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "none") {
        return null;
    }

    return trimmed;
}

module.exports = {
    requireField,
    requireFiniteNumber,
    optionalFiniteNumber,
    requireNonEmptyString,
    optionalNonEmptyString
};
