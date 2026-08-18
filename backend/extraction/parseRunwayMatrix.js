/**
 * Phase 4 Stage-2 validator: multi-runway, multi-leg extraction modeled on
 * ARINC 424 leg sequences. The LLM is an untrusted boundary: its output is
 * treated exactly like external input. Anything that is not strict, complete
 * JSON matching the nested schema below is a DataIntegrityError (-> 422),
 * never a silent default.
 *
 * Expected shape:
 *   {
 *     "runways": [
 *       {
 *         "identifier": "16L",
 *         "legs": [
 *           {
 *             "type": "TRACK_TO_DME" | "TURN_TO_HEADING" | "TRACK_TO_ALTITUDE",
 *             "value": <number>,           // DME NM, heading, or altitude MSL
 *             "navaid": <string|null>,     // optional station ident, e.g. "TCH"
 *             "direction": "LEFT" | "RIGHT" | null,
 *             "provenance": "CHARTED" | "ROWSPAN_INHERITED"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * The LLM is instructed to unroll grouped runways ("16L/R") upstream; this
 * validator only guarantees each emitted entry is individually well-formed.
 */
const { DataIntegrityError } = require("../geo/DataIntegrityError");
const {
    optionalFiniteNumber,
    optionalNonEmptyString,
    requireEnum,
    requireNonEmptyString
} = require("../geo/validation");

/** Leg discriminators the LLM must emit exactly (uppercase, ARINC-style). */
const LEG_TYPES = ["TRACK_TO_DME", "TURN_TO_HEADING", "TRACK_TO_ALTITUDE"];

/**
 * Audit-trail discriminator carried from the occupancy-grid cell that
 * produced each leg (see htmlTableExpander). REQUIRED and exact: provenance
 * is the boundary between "printed on the chart" and "structurally inferred
 * from a rowspan" — a leg without it has no audit trail, so it is rejected,
 * never defaulted.
 */
const LEG_PROVENANCES = ["CHARTED", "ROWSPAN_INHERITED"];

/**
 * Turn direction is nullable: absent / null / "none" all mean "no charted
 * direction". A present value must resolve to LEFT or RIGHT.
 */
function parseLegDirection(value, fieldPath) {
    const normalized = optionalNonEmptyString(value, fieldPath);

    if (normalized === null) {
        return null;
    }

    return requireEnum(normalized.toUpperCase(), ["LEFT", "RIGHT"], fieldPath);
}

function parseLeg(rawLeg, fieldPath) {
    if (rawLeg === null || typeof rawLeg !== "object" || Array.isArray(rawLeg)) {
        throw new DataIntegrityError(`Field ${fieldPath} must be a leg object.`);
    }

    const type = requireEnum(rawLeg.type, LEG_TYPES, `${fieldPath}.type`);

    // value is REQUIRED on every leg: a leg without its number (DME distance,
    // heading, or altitude) is uncomputable and must be rejected, not defaulted.
    const value = optionalFiniteNumber(rawLeg.value, `${fieldPath}.value`);

    if (value === null) {
        throw new DataIntegrityError(
            `Field ${fieldPath}.value must be a finite number (DME distance NM, magnetic heading, or altitude MSL).`
        );
    }

    return {
        type,
        value,
        navaid: optionalNonEmptyString(rawLeg.navaid, `${fieldPath}.navaid`),
        direction: parseLegDirection(rawLeg.direction, `${fieldPath}.direction`),
        provenance: requireEnum(rawLeg.provenance, LEG_PROVENANCES, `${fieldPath}.provenance`)
    };
}

function parseRunway(rawRunway, fieldPath) {
    if (rawRunway === null || typeof rawRunway !== "object" || Array.isArray(rawRunway)) {
        throw new DataIntegrityError(`Field ${fieldPath} must be a runway object.`);
    }

    const identifier = requireNonEmptyString(rawRunway.identifier, `${fieldPath}.identifier`).toUpperCase();

    // A grouped identifier surviving to this point means the LLM skipped the
    // mandated matrix unrolling — reject so the retry loop re-prompts.
    if (/[\/,\s]/.test(identifier)) {
        throw new DataIntegrityError(
            `Field ${fieldPath}.identifier must be a single unrolled runway (e.g. '16L'), ` +
                `not a grouped identifier. Received: '${identifier}'.`
        );
    }

    if (!Array.isArray(rawRunway.legs) || rawRunway.legs.length === 0) {
        throw new DataIntegrityError(`Field ${fieldPath}.legs must be a non-empty array of leg objects.`);
    }

    return {
        identifier,
        legs: rawRunway.legs.map((leg, index) => parseLeg(leg, `${fieldPath}.legs[${index}]`))
    };
}

function parseRunwayMatrix(rawResponse) {
    // Tolerate a fenced/prefixed reply by isolating the outermost JSON object,
    // but nothing beyond that: the content itself must parse strictly.
    const jsonMatch = typeof rawResponse === "string" ? rawResponse.match(/\{[\s\S]*\}/) : null;

    if (!jsonMatch) {
        throw new DataIntegrityError(
            `LLM extraction did not produce a JSON object. Raw response: ${String(rawResponse).slice(0, 200)}`
        );
    }

    let extraction;

    try {
        extraction = JSON.parse(jsonMatch[0]);
    } catch {
        throw new DataIntegrityError(
            `LLM extraction produced malformed JSON. Raw response: ${jsonMatch[0].slice(0, 200)}`
        );
    }

    if (!Array.isArray(extraction.runways) || extraction.runways.length === 0) {
        throw new DataIntegrityError(
            "LLM extraction must contain a non-empty 'runways' array of runway procedure objects."
        );
    }

    return {
        runways: extraction.runways.map((runway, index) => parseRunway(runway, `llmExtraction.runways[${index}]`))
    };
}

/**
 * Fills TRACK_TO_DME legs that the LLM left with navaid: null.
 *
 * Group-level / header navaids (e.g. TCH on a KSLC AT column) propagate
 * downward to later rows, and a single unique station in the matrix — or
 * the request's default navaid — fills remaining gaps. Charted DME legs
 * must never reach the solver without a station. Provenance on the leg
 * is unchanged: this is station inheritance, not a new OCR claim.
 *
 * @param {{runways: Array<{identifier: string, legs: object[]}>}} matrix
 * @param {{defaultNavaid?: string|null}} [options]
 */
function propagateMatrixNavaids(matrix, { defaultNavaid = null } = {}) {
    if (!matrix || !Array.isArray(matrix.runways)) {
        throw new DataIntegrityError("Navaid propagation requires a parsed runway matrix.");
    }

    const named = new Set();

    for (const runway of matrix.runways) {
        for (const leg of runway.legs) {
            if (leg.type === "TRACK_TO_DME" && typeof leg.navaid === "string" && leg.navaid.trim() !== "") {
                named.add(leg.navaid.trim().toUpperCase());
            }
        }
    }

    const fallback = typeof defaultNavaid === "string" && defaultNavaid.trim() !== ""
        ? defaultNavaid.trim().toUpperCase()
        : null;
    const groupNavaid = named.size === 1 ? [...named][0] : fallback;

    let lastSeen = null;

    for (const runway of matrix.runways) {
        for (const leg of runway.legs) {
            if (leg.type !== "TRACK_TO_DME") {
                continue;
            }

            if (typeof leg.navaid === "string" && leg.navaid.trim() !== "") {
                lastSeen = leg.navaid.trim().toUpperCase();
                leg.navaid = lastSeen;
                continue;
            }

            const inherited = lastSeen || groupNavaid;

            if (!inherited) {
                throw new DataIntegrityError(
                    `Runway ${runway.identifier}: TRACK_TO_DME is missing a navaid and no group-level ` +
                        `or header navaid (e.g. TCH) could be inherited.`
                );
            }

            leg.navaid = inherited;
        }
    }

    return matrix;
}

module.exports = {
    LEG_TYPES,
    LEG_PROVENANCES,
    parseRunwayMatrix,
    propagateMatrixNavaids
};
