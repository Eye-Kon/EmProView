/**
 * ARINC 424-18 PD (Airport SID) primary-record field catalog.
 *
 * Columns are 1-based per the specification. The encoder walks this table
 * in order, applies pad/transform rules, and refuses any record that is
 * not exactly 132 characters. No procedure logic lives here — only the
 * packing law.
 */
const { DataIntegrityError } = require("../backend/geo/DataIntegrityError");

const SPEC_VERSION = "424-18";
const RECORD_LENGTH = 132;
const RECORD_KIND = "PD";

/**
 * @typedef {object} CatalogField
 * @property {string} name
 * @property {number} start      1-based inclusive column
 * @property {number} width
 * @property {"LEFT"|"RIGHT"} pad   LEFT = leading pad (numeric), RIGHT = trailing pad (ident)
 * @property {string} padChar
 * @property {string} [transform]
 */

/** @type {CatalogField[]} */
const PD_PRIMARY_FIELDS = [
    { name: "recordType", start: 1, width: 1, pad: "RIGHT", padChar: " " },
    { name: "customerAreaCode", start: 2, width: 3, pad: "RIGHT", padChar: " ", transform: "uppercase" },
    { name: "sectionCode", start: 5, width: 1, pad: "RIGHT", padChar: " " },
    { name: "blank6", start: 6, width: 1, pad: "RIGHT", padChar: " " },
    { name: "airportIdentifier", start: 7, width: 4, pad: "RIGHT", padChar: " ", transform: "uppercase" },
    { name: "icaoCode", start: 11, width: 2, pad: "RIGHT", padChar: " ", transform: "uppercase" },
    { name: "subsectionCode", start: 13, width: 1, pad: "RIGHT", padChar: " " },
    { name: "procedureIdentifier", start: 14, width: 6, pad: "RIGHT", padChar: " ", transform: "uppercase" },
    { name: "routeType", start: 20, width: 1, pad: "RIGHT", padChar: " " },
    { name: "transitionIdentifier", start: 21, width: 5, pad: "RIGHT", padChar: " ", transform: "uppercase" },
    { name: "sequenceNumber", start: 26, width: 3, pad: "LEFT", padChar: "0", transform: "sequence" },
    { name: "blank29", start: 29, width: 1, pad: "RIGHT", padChar: " " },
    { name: "fixIdentifier", start: 30, width: 5, pad: "RIGHT", padChar: " ", transform: "uppercase" },
    { name: "fixIcaoCode", start: 35, width: 2, pad: "RIGHT", padChar: " ", transform: "uppercase" },
    { name: "fixSectionCode", start: 37, width: 1, pad: "RIGHT", padChar: " " },
    { name: "fixSubsectionCode", start: 38, width: 1, pad: "RIGHT", padChar: " " },
    { name: "continuationNumber", start: 39, width: 1, pad: "LEFT", padChar: "0" },
    { name: "waypointDescription", start: 40, width: 4, pad: "RIGHT", padChar: " " },
    { name: "turnDirection", start: 44, width: 1, pad: "RIGHT", padChar: " ", transform: "uppercase" },
    { name: "rnp", start: 45, width: 3, pad: "RIGHT", padChar: " " },
    { name: "pathTerminator", start: 48, width: 2, pad: "RIGHT", padChar: " ", transform: "uppercase" },
    { name: "turnDirectionValid", start: 50, width: 1, pad: "RIGHT", padChar: " ", transform: "uppercase" },
    { name: "recommendedNavaid", start: 51, width: 4, pad: "RIGHT", padChar: " ", transform: "uppercase" },
    { name: "recommendedNavaidIcao", start: 55, width: 2, pad: "RIGHT", padChar: " ", transform: "uppercase" },
    { name: "arcRadius", start: 57, width: 6, pad: "RIGHT", padChar: " " },
    { name: "theta", start: 63, width: 4, pad: "RIGHT", padChar: " " },
    { name: "rho", start: 67, width: 4, pad: "LEFT", padChar: "0", transform: "distance10" },
    { name: "magneticCourse", start: 71, width: 4, pad: "LEFT", padChar: "0", transform: "course10" },
    { name: "routeDistance", start: 75, width: 4, pad: "LEFT", padChar: "0", transform: "distance10" },
    { name: "blank79", start: 79, width: 4, pad: "RIGHT", padChar: " " },
    { name: "altitudeDescription", start: 83, width: 1, pad: "RIGHT", padChar: " " },
    { name: "atcIndicator", start: 84, width: 1, pad: "RIGHT", padChar: " " },
    { name: "altitude", start: 85, width: 5, pad: "LEFT", padChar: "0", transform: "altitude" },
    { name: "altitude2", start: 90, width: 5, pad: "RIGHT", padChar: " " },
    { name: "transitionAltitude", start: 95, width: 5, pad: "RIGHT", padChar: " " },
    { name: "speedLimit", start: 100, width: 3, pad: "RIGHT", padChar: " " },
    { name: "verticalAngle", start: 103, width: 4, pad: "RIGHT", padChar: " " },
    { name: "centerFix", start: 107, width: 5, pad: "RIGHT", padChar: " " },
    { name: "multipleCode", start: 112, width: 1, pad: "RIGHT", padChar: " " },
    { name: "centerFixIcao", start: 113, width: 2, pad: "RIGHT", padChar: " " },
    { name: "centerFixSection", start: 115, width: 2, pad: "RIGHT", padChar: " " },
    { name: "gnssIndicator", start: 117, width: 1, pad: "RIGHT", padChar: " " },
    { name: "speedLimitDescription", start: 118, width: 1, pad: "RIGHT", padChar: " " },
    { name: "routeQualifier1", start: 119, width: 1, pad: "RIGHT", padChar: " " },
    { name: "routeQualifier2", start: 120, width: 1, pad: "RIGHT", padChar: " " },
    { name: "blank121", start: 121, width: 3, pad: "RIGHT", padChar: " " },
    { name: "fileRecordNumber", start: 124, width: 5, pad: "LEFT", padChar: "0", transform: "sequence" },
    { name: "cycleDate", start: 129, width: 4, pad: "LEFT", padChar: "0" }
];

function assertCatalogCoverage() {
    let cursor = 1;

    for (const field of PD_PRIMARY_FIELDS) {
        if (field.start !== cursor) {
            throw new DataIntegrityError(
                `ARINC ${SPEC_VERSION} catalog gap: expected column ${cursor}, found ${field.name} at ${field.start}.`
            );
        }

        cursor += field.width;
    }

    if (cursor !== RECORD_LENGTH + 1) {
        throw new DataIntegrityError(
            `ARINC ${SPEC_VERSION} catalog does not span ${RECORD_LENGTH} columns (ended at ${cursor - 1}).`
        );
    }
}

assertCatalogCoverage();

function isBlank(value) {
    return value === undefined || value === null || value === "";
}

function applyTransform(field, value) {
    if (isBlank(value)) {
        return "";
    }

    switch (field.transform) {
        case "uppercase":
            return String(value).trim().toUpperCase();
        case "sequence": {
            const number = Number(value);
            if (!Number.isFinite(number) || number < 0) {
                throw new DataIntegrityError(
                    `ARINC 424 field ${field.name} must be a non-negative sequence number, received ${JSON.stringify(value)}.`
                );
            }
            return String(Math.round(number));
        }
        case "course10":
        case "distance10": {
            const number = Number(value);
            if (!Number.isFinite(number)) {
                throw new DataIntegrityError(
                    `ARINC 424 field ${field.name} must be a finite number, received ${JSON.stringify(value)}.`
                );
            }
            return String(Math.round(number * 10));
        }
        case "altitude": {
            const number = Number(value);
            if (!Number.isFinite(number)) {
                throw new DataIntegrityError(
                    `ARINC 424 field ${field.name} must be a finite altitude, received ${JSON.stringify(value)}.`
                );
            }
            return String(Math.round(number));
        }
        default:
            return String(value);
    }
}

function padField(field, raw) {
    const width = field.width;

    if (raw.length > width) {
        throw new DataIntegrityError(
            `ARINC 424 field ${field.name} value ${JSON.stringify(raw)} exceeds width ${width}.`
        );
    }

    if (raw === "") {
        return "".padEnd(width, " ");
    }

    if (field.pad === "LEFT") {
        return raw.padStart(width, field.padChar);
    }

    return raw.padEnd(width, field.padChar);
}

/**
 * Packs a field-name → value map into one 132-character PD record.
 * Omitted fields become blank (space or zero per the catalog). Required
 * presence is the exporter's job; this function only packs.
 */
function encodePdRecord(values = {}) {
    let record = "";

    for (const field of PD_PRIMARY_FIELDS) {
        const transformed = applyTransform(field, values[field.name]);
        record += padField(field, transformed);
    }

    if (record.length !== RECORD_LENGTH) {
        throw new DataIntegrityError(
            `ARINC 424 ${RECORD_KIND} encoder produced a ${record.length}-character record; ${RECORD_LENGTH} required.`
        );
    }

    return record;
}

function decodePdRecord(record) {
    if (typeof record !== "string" || record.length !== RECORD_LENGTH) {
        throw new DataIntegrityError(
            `ARINC 424 decode requires a ${RECORD_LENGTH}-character string, received length ${record?.length}.`
        );
    }

    const values = {};

    for (const field of PD_PRIMARY_FIELDS) {
        values[field.name] = record.slice(field.start - 1, field.start - 1 + field.width);
    }

    return values;
}

module.exports = {
    SPEC_VERSION,
    RECORD_LENGTH,
    RECORD_KIND,
    PD_PRIMARY_FIELDS,
    encodePdRecord,
    decodePdRecord
};
