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

function requireNonEmptyString(value, fieldPath) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new DataIntegrityError(`Field ${fieldPath} must be a non-empty string.`);
    }

    return value.trim();
}

module.exports = {
    requireField,
    requireFiniteNumber,
    requireNonEmptyString
};
