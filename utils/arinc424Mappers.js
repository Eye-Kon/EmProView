/**
 * Canonical-leg → ARINC 424-18 path-terminator registry.
 *
 * TRACK_TO_DME      → VD (heading to a DME distance)
 * TURN_TO_HEADING   → VM (heading to a manual termination)
 * TRACK_TO_ALTITUDE → VA (heading to an altitude)
 *
 * Unregistered types are a DataIntegrityError (422). No coordinates are
 * accepted or emitted. Magnetic course for VD/VA is supplied by the
 * exporter from NASR ground truth, never from the LLM.
 */
const { DataIntegrityError } = require("../backend/geo/DataIntegrityError");

const TERMINATOR_BY_LEG_TYPE = {
    TRACK_TO_DME: "VD",
    TURN_TO_HEADING: "VM",
    TRACK_TO_ALTITUDE: "VA"
};

function requireFinite(value, fieldPath) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new DataIntegrityError(
            `ARINC 424 mapping failed: ${fieldPath} must be a finite number, received ${JSON.stringify(value)}.`
        );
    }

    return value;
}

function requireIdent(value, fieldPath) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new DataIntegrityError(
            `ARINC 424 mapping failed: ${fieldPath} is missing or unverified.`
        );
    }

    return value.trim().toUpperCase();
}

function normalizeTurnDirection(value, fieldPath) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new DataIntegrityError(
            `ARINC 424 mapping failed: ${fieldPath} (turn direction) is required for VM.`
        );
    }

    const normalized = value.trim().toUpperCase();

    if (normalized === "LEFT" || normalized === "L") {
        return "L";
    }

    if (normalized === "RIGHT" || normalized === "R") {
        return "R";
    }

    throw new DataIntegrityError(
        `ARINC 424 mapping failed: ${fieldPath} must be LEFT or RIGHT, received ${JSON.stringify(value)}.`
    );
}

function mapTrackToDme(leg, context) {
    return {
        pathTerminator: "VD",
        recommendedNavaid: requireIdent(leg.navaid, `${context.path}.navaid`),
        rho: requireFinite(leg.value, `${context.path}.value`),
        routeDistance: requireFinite(leg.value, `${context.path}.value`),
        magneticCourse: requireFinite(context.runwayMagneticHeading, "runwayMagneticHeading"),
        turnDirection: "",
        turnDirectionValid: "",
        altitude: null
    };
}

function mapTurnToHeading(leg, context) {
    return {
        pathTerminator: "VM",
        recommendedNavaid: "",
        rho: null,
        routeDistance: null,
        magneticCourse: requireFinite(leg.value, `${context.path}.value`),
        turnDirection: normalizeTurnDirection(leg.direction, `${context.path}.direction`),
        turnDirectionValid: "Y",
        altitude: null
    };
}

function mapTrackToAltitude(leg, context) {
    return {
        pathTerminator: "VA",
        recommendedNavaid: "",
        rho: null,
        routeDistance: null,
        magneticCourse: requireFinite(context.runwayMagneticHeading, "runwayMagneticHeading"),
        turnDirection: "",
        turnDirectionValid: "",
        altitude: requireFinite(leg.value, `${context.path}.value`)
    };
}

const MAPPERS = {
    TRACK_TO_DME: mapTrackToDme,
    TURN_TO_HEADING: mapTurnToHeading,
    TRACK_TO_ALTITUDE: mapTrackToAltitude
};

/**
 * Maps one canonical leg to terminator fields. `context.runwayMagneticHeading`
 * is required for VD and VA and must already be derived via trueToMagnetic.
 */
function mapCanonicalLeg(leg, context = {}) {
    if (!leg || typeof leg.type !== "string") {
        throw new DataIntegrityError("ARINC 424 mapping failed: leg type is missing.");
    }

    const mapper = MAPPERS[leg.type];

    if (!mapper) {
        throw new DataIntegrityError(
            `ARINC 424 mapping failed: unregistered leg type '${leg.type}'. ` +
                `Registered types: ${Object.keys(TERMINATOR_BY_LEG_TYPE).join(", ")}.`
        );
    }

    return mapper(leg, { path: context.path || "leg", ...context });
}

function pushDmeThenTurn(legs, row, segment, provenance) {
    const trigger = segment.spatialTrigger;

    legs.push({
        type: "TRACK_TO_DME",
        value: trigger.triggerDistanceNM,
        navaid: trigger.referenceNavaid,
        direction: null,
        provenance
    });

    const action = trigger.resultingAction;
    const heading = action?.magneticHeading ?? row.assignedHeadingDegrees;
    const direction = action?.turnDirection ?? row.turnDirection;

    if (heading !== undefined && heading !== null) {
        legs.push({
            type: "TURN_TO_HEADING",
            value: heading,
            navaid: null,
            direction: direction ?? null,
            provenance
        });
    }
}

function legsFromLegacyRow(row) {
    const legs = [];
    const segments = Array.isArray(row?.geometry?.segments) ? row.geometry.segments : [];

    for (const segment of segments) {
        const provenance = segment.provenance === "ROWSPAN_INHERITED" ? "ROWSPAN_INHERITED" : "CHARTED";
        const trigger = segment.spatialTrigger;

        if (
            trigger &&
            (trigger.triggerType === "RADIAL_DISTANCE_INTERSECTION" || trigger.triggerDistanceNM != null) &&
            typeof trigger.triggerDistanceNM === "number"
        ) {
            pushDmeThenTurn(legs, row, segment, provenance);
            continue;
        }

        if (
            (segment.segmentType === "HEADING_TO_ALTITUDE" || segment.segmentType === "TRACK_TO_ALTITUDE") &&
            typeof segment.terminationAltitude === "number"
        ) {
            legs.push({
                type: "TRACK_TO_ALTITUDE",
                value: segment.terminationAltitude,
                navaid: null,
                direction: null,
                provenance
            });
        }
    }

    if (
        legs.length === 1 &&
        legs[0].type === "TRACK_TO_DME" &&
        typeof row?.assignedHeadingDegrees === "number"
    ) {
        legs.push({
            type: "TURN_TO_HEADING",
            value: row.assignedHeadingDegrees,
            navaid: null,
            direction: row.turnDirection ?? null,
            provenance: "CHARTED"
        });
    }

    return legs;
}

/**
 * Resolves canonical TRACK_TO_* / TURN_TO_HEADING legs from a verified
 * procedure: Phase 4 `runways[].legs` / `procedureRows[].legs` first,
 * then legacy extract segments.
 */
function collectCanonicalLegs(procedure) {
    const transition = typeof procedure?.transition === "string"
        ? procedure.transition.trim().toUpperCase()
        : "";

    if (Array.isArray(procedure?.runways)) {
        const match = procedure.runways.find((runway) => runway.identifier === transition)
            ?? procedure.runways[0];

        if (Array.isArray(match?.legs) && match.legs.length > 0) {
            return match.legs;
        }
    }

    const rows = Array.isArray(procedure?.procedureRows) ? procedure.procedureRows : [];
    const row = rows.find((entry) => Array.isArray(entry.runways) && entry.runways.includes(transition))
        ?? rows[0];

    if (Array.isArray(row?.legs) && row.legs.length > 0) {
        return row.legs;
    }

    const derived = legsFromLegacyRow(row);

    if (derived.length === 0) {
        throw new DataIntegrityError(
            "ARINC 424 mapping failed: the verified procedure has no canonical legs or DME/heading segments."
        );
    }

    return derived;
}

module.exports = {
    TERMINATOR_BY_LEG_TYPE,
    mapCanonicalLeg,
    collectCanonicalLegs
};
