/**
 * Canonical procedure governance: 5-part ARINC 424 identity, 424-bound
 * parametric field extraction, HITL amendment ledger, and provenance
 * preservation (CHARTED / ROWSPAN_INHERITED are never overwritten by HITL).
 *
 * Phase 5.1 — database governance only. No ARINC 424 encoder lives here.
 */
const { DataIntegrityError } = require("../geo/DataIntegrityError");
const { requireNonEmptyString } = require("../geo/validation");

const PROCEDURES_COLLECTION = "procedures";
const PROCEDURE_IDENTITY_INDEX_NAME = "procedure_arinc424_identity_unique";
const LEGACY_RUNWAY_INDEX_HINTS = ["runway", "runways", "airportCode_1_procedureRows.runways_1"];

const MAX_PROCEDURE_IDENT = 6;
const MAX_TRANSITION = 5;

/**
 * Parametric leaves that land in an ARINC 424 PD/VM/VD column. Computed
 * GeoJSON, integrity reports, and coordinates are excluded.
 */
const BOUND_SEGMENT_KEYS = [
    "segmentType",
    "headingDegrees",
    "targetWaypoint",
    "terminationAltitude",
    "distanceNM"
];

const BOUND_TRIGGER_KEYS = [
    "triggerType",
    "referenceNavaid",
    "triggerDistanceNM",
    "triggerAltitudeMsl"
];

const BOUND_ACTION_KEYS = ["actionType", "turnDirection", "magneticHeading"];

const BOUND_LEG_KEYS = ["type", "value", "navaid", "direction"];

const BOUND_ROW_KEYS = [
    "assignedHeadingDegrees",
    "turnDirection",
    "triggerFix",
    "triggerDescription",
    "holdInstruction",
    "routeFixes"
];

class ProcedureIdentityError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProcedureIdentityError";
        this.statusCode = 400;
    }
}

function normalizeToken(value, fieldPath, { maxLength, uppercase = true } = {}) {
    const trimmed = requireNonEmptyString(value, fieldPath);
    const normalized = uppercase ? trimmed.toUpperCase() : trimmed;

    if (maxLength && normalized.length > maxLength) {
        throw new ProcedureIdentityError(
            `Invalid field: ${fieldPath} must be at most ${maxLength} characters (ARINC 424 column width). ` +
                `Received ${normalized.length}-character value ${JSON.stringify(normalized)}.`
        );
    }

    return normalized;
}

/**
 * Resolves the 5-part identity from a verify payload. airport_icao accepts
 * the legacy airportCode / airport.icao / source.airportCode fallbacks;
 * operator_id accepts airline.icao. All five parts are required for a save.
 */
function parseProcedureIdentity(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new ProcedureIdentityError("Invalid payload: a procedure object is required.");
    }

    const operatorRaw = payload.operator_id ?? payload.airline?.icao ?? payload.airline;
    const airportRaw =
        payload.airport_icao ??
        payload.airportCode ??
        payload.airport?.icao ??
        payload.source?.airportCode;

    let routeTypeRaw = payload.route_type;
    if (typeof routeTypeRaw === "number" && Number.isFinite(routeTypeRaw)) {
        routeTypeRaw = String(routeTypeRaw);
    }

    try {
        return {
            operator_id: normalizeToken(operatorRaw, "operator_id"),
            airport_icao: normalizeToken(airportRaw, "airport_icao"),
            procedure_ident: normalizeToken(payload.procedure_ident, "procedure_ident", {
                maxLength: MAX_PROCEDURE_IDENT
            }),
            route_type: normalizeToken(routeTypeRaw, "route_type", { maxLength: 1 }),
            transition: normalizeToken(payload.transition, "transition", {
                maxLength: MAX_TRANSITION
            })
        };
    } catch (error) {
        if (error instanceof DataIntegrityError) {
            throw new ProcedureIdentityError(
                `Invalid field: ${error.message.replace(/^Field /, "")} ` +
                    `The 5-part ARINC 424 identity (operator_id, airport_icao, procedure_ident, route_type, transition) ` +
                    `is required for every new save.`
            );
        }
        throw error;
    }
}

function identityFilter(identity) {
    return {
        operator_id: identity.operator_id,
        airport_icao: identity.airport_icao,
        procedure_ident: identity.procedure_ident,
        route_type: identity.route_type,
        transition: identity.transition
    };
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valuesEqual(left, right) {
    if (Object.is(left, right)) {
        return true;
    }

    if (left === null || right === null || left === undefined || right === undefined) {
        return left == null && right == null;
    }

    if (typeof left === "number" && typeof right === "number") {
        return left === right;
    }

    return JSON.stringify(left) === JSON.stringify(right);
}

function recordBound(fields, path, value) {
    if (value === undefined) {
        return;
    }

    fields[path] = value;
}

function collectSegmentFields(fields, prefix, segment) {
    if (!isPlainObject(segment)) {
        return;
    }

    for (const key of BOUND_SEGMENT_KEYS) {
        recordBound(fields, `${prefix}.${key}`, segment[key]);
    }

    const trigger = segment.spatialTrigger;
    if (isPlainObject(trigger)) {
        for (const key of BOUND_TRIGGER_KEYS) {
            recordBound(fields, `${prefix}.spatialTrigger.${key}`, trigger[key]);
        }

        const action = trigger.resultingAction;
        if (isPlainObject(action)) {
            for (const key of BOUND_ACTION_KEYS) {
                recordBound(fields, `${prefix}.spatialTrigger.resultingAction.${key}`, action[key]);
            }
        }
    }
}

function collectRowFields(fields, rowIndex, row) {
    if (!isPlainObject(row)) {
        return;
    }

    const prefix = `procedureRows.${rowIndex}`;

    for (const key of BOUND_ROW_KEYS) {
        recordBound(fields, `${prefix}.${key}`, row[key]);
    }

    if (Array.isArray(row.legs)) {
        row.legs.forEach((leg, legIndex) => {
            if (!isPlainObject(leg)) {
                return;
            }

            for (const key of BOUND_LEG_KEYS) {
                recordBound(fields, `${prefix}.legs.${legIndex}.${key}`, leg[key]);
            }
        });
    }

    const segments = row.geometry?.segments;
    if (Array.isArray(segments)) {
        segments.forEach((segment, segmentIndex) => {
            collectSegmentFields(fields, `${prefix}.geometry.segments.${segmentIndex}`, segment);
        });
    }
}

/** Flat map of 424-bound parametric paths → values. */
function collectBoundFields(procedure) {
    const fields = {};

    if (!procedure || typeof procedure !== "object") {
        return fields;
    }

    recordBound(fields, "procedure_ident", procedure.procedure_ident);
    recordBound(fields, "route_type", procedure.route_type);
    recordBound(fields, "transition", procedure.transition);
    recordBound(fields, "assignedHeadingDegrees", procedure.assignedHeadingDegrees);

    const rows = Array.isArray(procedure.procedureRows) ? procedure.procedureRows : [];
    rows.forEach((row, index) => collectRowFields(fields, index, row));

    return fields;
}

/**
 * Deep-compare 424-bound parametric fields. Returns only paths whose
 * values changed. Encoder-irrelevant noise (GeoJSON, AIRAC, integrity)
 * is ignored.
 */
function diffBoundFields(existingProcedure, incomingProcedure) {
    const previous = collectBoundFields(existingProcedure);
    const current = collectBoundFields(incomingProcedure);
    const paths = new Set([...Object.keys(previous), ...Object.keys(current)]);
    const diffs = [];

    for (const field_path of [...paths].sort()) {
        const previous_value = previous[field_path];
        const current_value = current[field_path];

        if (valuesEqual(previous_value, current_value)) {
            continue;
        }

        diffs.push({ field_path, previous_value, current_value });
    }

    return diffs;
}

function normalizeJustification(value) {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function amendmentJustificationsByPath(payload) {
    const map = new Map();
    const incoming = Array.isArray(payload?.amendments) ? payload.amendments : [];

    for (const entry of incoming) {
        if (!isPlainObject(entry) || typeof entry.field_path !== "string") {
            continue;
        }

        const justification = normalizeJustification(entry.justification);
        if (justification) {
            map.set(entry.field_path, justification);
        }
    }

    return map;
}

/**
 * Hard gate: every 424-bound delta requires user_id + justification.
 * Justification may be top-level (covers all diffs) or per-field on
 * payload.amendments[]. Missing either is a 400 — the lock is refused.
 */
function buildAmendments(diffs, payload, { now = new Date() } = {}) {
    if (diffs.length === 0) {
        return [];
    }

    const userId = typeof payload?.user_id === "string" ? payload.user_id.trim() : "";
    if (!userId) {
        throw new ProcedureIdentityError(
            "HITL amendment rejected: user_id is required when a 424-bound parametric field changes."
        );
    }

    const globalJustification = normalizeJustification(payload?.justification);
    const perPath = amendmentJustificationsByPath(payload);
    const missing = [];
    const amendments = [];

    for (const diff of diffs) {
        const justification = perPath.get(diff.field_path) ?? globalJustification;

        if (!justification) {
            missing.push(diff.field_path);
            continue;
        }

        amendments.push({
            field_path: diff.field_path,
            previous_value: diff.previous_value ?? null,
            current_value: diff.current_value ?? null,
            user_id: userId,
            timestamp: now,
            justification
        });
    }

    if (missing.length > 0) {
        throw new ProcedureIdentityError(
            `HITL amendment rejected: justification is required for 424-bound field(s): ${missing.join(", ")}.`
        );
    }

    return amendments;
}

function preserveProvenanceNode(existingNode, incomingNode) {
    if (Array.isArray(existingNode) && Array.isArray(incomingNode)) {
        const length = Math.min(existingNode.length, incomingNode.length);
        for (let index = 0; index < length; index += 1) {
            preserveProvenanceNode(existingNode[index], incomingNode[index]);
        }
        return;
    }

    if (!isPlainObject(existingNode) || !isPlainObject(incomingNode)) {
        return;
    }

    const existingProvenance = existingNode.provenance;
    if (existingProvenance === "CHARTED" || existingProvenance === "ROWSPAN_INHERITED") {
        incomingNode.provenance = existingProvenance;
    }

    for (const key of Object.keys(existingNode)) {
        if (key === "provenance" || !(key in incomingNode)) {
            continue;
        }

        preserveProvenanceNode(existingNode[key], incomingNode[key]);
    }
}

/**
 * Copies CHARTED / ROWSPAN_INHERITED from the stored document onto the
 * incoming tree so a HITL value change cannot rewrite OCR provenance.
 */
function preserveOcrProvenance(existingProcedure, incomingProcedure) {
    if (!existingProcedure || !incomingProcedure) {
        return incomingProcedure;
    }

    preserveProvenanceNode(existingProcedure, incomingProcedure);
    return incomingProcedure;
}

function stampIdentity(procedure, identity) {
    const {
        user_id: _userId,
        justification: _justification,
        amendments: _payloadAmendments,
        ...rest
    } = procedure;

    return {
        ...rest,
        operator_id: identity.operator_id,
        airport_icao: identity.airport_icao,
        airportCode: procedure.airportCode || identity.airport_icao,
        procedure_ident: identity.procedure_ident,
        route_type: identity.route_type,
        transition: identity.transition
    };
}

function isLegacyRunwayLockIndex(index) {
    if (!index || index.unique !== true) {
        return false;
    }

    const keyNames = Object.keys(index.key || {});
    const joined = `${index.name || ""} ${keyNames.join(" ")}`.toLowerCase();

    if (LEGACY_RUNWAY_INDEX_HINTS.some((hint) => joined.includes(hint.toLowerCase()))) {
        return keyNames.some((name) => /runway/i.test(name) || /airport/i.test(name));
    }

    return keyNames.some((name) => /procedureRows\.runways/i.test(name));
}

/**
 * Drops the legacy airport+runway uniqueness lock (runways are transition
 * attributes) and installs a partial unique index on the 5-part identity
 * so pre-Phase-5 seed documents without the key still load.
 */
async function ensureCanonicalProcedureIndexes(db) {
    const collection = db.collection(PROCEDURES_COLLECTION);
    const existing = await collection.indexes();

    for (const index of existing) {
        if (index.name === "_id_" || index.name === PROCEDURE_IDENTITY_INDEX_NAME) {
            continue;
        }

        if (isLegacyRunwayLockIndex(index)) {
            await collection.dropIndex(index.name);
        }
    }

    await collection.createIndex(
        {
            operator_id: 1,
            airport_icao: 1,
            procedure_ident: 1,
            route_type: 1,
            transition: 1
        },
        {
            unique: true,
            name: PROCEDURE_IDENTITY_INDEX_NAME,
            partialFilterExpression: {
                operator_id: { $type: "string" },
                airport_icao: { $type: "string" },
                procedure_ident: { $type: "string" },
                route_type: { $type: "string" },
                transition: { $type: "string" }
            }
        }
    );
}

async function findCanonicalProcedure(db, identity) {
    return db.collection(PROCEDURES_COLLECTION).findOne(identityFilter(identity));
}

async function upsertCanonicalProcedure(db, identity, document) {
    await db.collection(PROCEDURES_COLLECTION).replaceOne(identityFilter(identity), document, {
        upsert: true
    });
}

module.exports = {
    PROCEDURES_COLLECTION,
    PROCEDURE_IDENTITY_INDEX_NAME,
    MAX_PROCEDURE_IDENT,
    MAX_TRANSITION,
    ProcedureIdentityError,
    parseProcedureIdentity,
    identityFilter,
    collectBoundFields,
    diffBoundFields,
    buildAmendments,
    preserveOcrProvenance,
    stampIdentity,
    ensureCanonicalProcedureIndexes,
    findCanonicalProcedure,
    upsertCanonicalProcedure,
    isLegacyRunwayLockIndex
};
