/**
 * Parses the Ollama response into the relational-logic contract. The LLM is
 * an untrusted boundary: its output is treated exactly like external input.
 * Anything that is not strict, complete JSON with coherent turn semantics is
 * a DataIntegrityError (-> 422), never a silent default.
 *
 * The trigger schema is deliberately FLAT (no oneOf/anyOf, no nested trigger
 * object): the 4GiB local model (phi3) reliably fills flat nullable fields
 * but hallucinates structure on polymorphic/conditional schemas.
 *   trigger_type             "altitude" | "dme" | "unspecified"  (REQUIRED, exact)
 *   trigger_altitude_msl     number | null
 *   trigger_dme_distance_nm  number | null
 *   trigger_navaid_ident     string | null
 *
 * Strict-enforcement guarantees (deterministic aviation safety contract):
 *   - trigger_type is never inferred from other fields. Omitted, null, or
 *     any value other than the three exact lowercase strings -> 422.
 *   - The retired trigger_distance_nm key is rejected at the ingestion gate.
 *     It is reintroduced on the OUTPUT object only after validation succeeds,
 *     because the downstream WGS-84 stage and response contract read it.
 */
const { DataIntegrityError } = require("../geo/DataIntegrityError");
const {
    optionalFiniteNumber,
    optionalNonEmptyString,
    requireEnum
} = require("../geo/validation");
const { resolveTriggerDistanceNM } = require("../geo/resolveTriggerDistance");

/** Flat trigger discriminator values the LLM must emit exactly. */
const TRIGGER_TYPES = ["altitude", "dme", "unspecified"];

function parseRelationalLogic(rawResponse) {
    // Tolerate a fenced/prefixed reply by isolating the outermost JSON object,
    // but nothing beyond that: the content itself must parse strictly.
    const jsonMatch = typeof rawResponse === "string" ? rawResponse.match(/\{[\s\S]*\}/) : null;

    if (!jsonMatch) {
        throw new DataIntegrityError(
            `LLM extraction did not produce a JSON object of relational logic. Raw response: ${String(rawResponse).slice(0, 200)}`
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

    // Ingestion gate 1: the retired alias is a schema violation, not a synonym.
    if (Object.prototype.hasOwnProperty.call(extraction, "trigger_distance_nm")) {
        throw new DataIntegrityError(
            "LLM extraction contains the retired field trigger_distance_nm. " +
                "The schema requires trigger_dme_distance_nm; legacy aliases are rejected."
        );
    }

    // Ingestion gate 2: trigger_type is required and exact. No inference.
    const triggerType = requireEnum(extraction.trigger_type, TRIGGER_TYPES, "llmExtraction.trigger_type");

    // Field coercion: null/undefined/""/"null" are valid absences, and string
    // outputs ("3.5") are coerced into finite numbers. Non-numeric junk -> 422.
    const optionalDmeDistance = optionalFiniteNumber(
        extraction.trigger_dme_distance_nm,
        "llmExtraction.trigger_dme_distance_nm"
    );
    const optionalAltitude = optionalFiniteNumber(
        extraction.trigger_altitude_msl,
        "llmExtraction.trigger_altitude_msl"
    );
    const optionalGradient = optionalFiniteNumber(
        extraction.climb_gradient_ft_nm,
        "llmExtraction.climb_gradient_ft_nm"
    );
    const triggerNavaidIdent = optionalNonEmptyString(
        extraction.trigger_navaid_ident,
        "llmExtraction.trigger_navaid_ident"
    );

    // Per-type coherence. A 'dme' trigger is complete with a null altitude
    // (and vice versa) — the two fields are independent, never conditional.
    if (triggerType === "dme" && optionalDmeDistance === null) {
        throw new DataIntegrityError(
            "LLM extraction with trigger_type 'dme' must include trigger_dme_distance_nm as a finite number."
        );
    }

    if (triggerType === "altitude" && optionalAltitude === null) {
        throw new DataIntegrityError(
            "LLM extraction with trigger_type 'altitude' must include trigger_altitude_msl as a finite number."
        );
    }

    extraction.trigger_type = triggerType;
    extraction.trigger_dme_distance_nm = optionalDmeDistance;
    extraction.trigger_altitude_msl = optionalAltitude;
    extraction.climb_gradient_ft_nm = optionalGradient;
    extraction.trigger_navaid_ident = triggerNavaidIdent;

    const triggerDistanceNM = resolveTriggerDistanceNM({
        triggerDistanceNM: optionalDmeDistance,
        triggerAltitudeMsl: optionalAltitude,
        climbGradientFtNm: optionalGradient,
        distanceFieldPath: "llmExtraction.trigger_dme_distance_nm",
        altitudeFieldPath: "llmExtraction.trigger_altitude_msl"
    });

    // Post-validation internal mapping ONLY: downstream WGS-84 solving and the
    // response contract read trigger_distance_nm. Never accepted as input.
    extraction.trigger_distance_nm = triggerDistanceNM;

    // Coerce optional headings (LLMs often emit "360" as a string).
    const initialMagneticHeading = optionalFiniteNumber(
        extraction.initial_magnetic_heading,
        "llmExtraction.initial_magnetic_heading"
    );
    const targetMagneticHeading = optionalFiniteNumber(
        extraction.target_magnetic_heading,
        "llmExtraction.target_magnetic_heading"
    );
    const targetNavaid = optionalNonEmptyString(
        extraction.target_navaid ?? extraction.target_fix ?? extraction.target_waypoint,
        "llmExtraction.target_navaid"
    );

    extraction.initial_magnetic_heading = initialMagneticHeading;
    extraction.target_magnetic_heading = targetMagneticHeading;
    extraction.target_navaid = targetNavaid;

    const rawDirection = typeof extraction.turn_direction === "string"
        ? extraction.turn_direction.trim().toLowerCase()
        : null;

    let turn = null;

    if (rawDirection === "left" || rawDirection === "right") {
        // Turn is valid with a post-turn heading OR a direct-to navaid/fix.
        // "Climbing right turn direct CLT" has RIGHT + CLT but no numeric heading.
        if (targetMagneticHeading === null && targetNavaid === null) {
            throw new DataIntegrityError(
                "LLM extraction with turn_direction LEFT/RIGHT must include either " +
                    "target_magnetic_heading or target_navaid (fix identifier)."
            );
        }

        turn = {
            turnDirection: rawDirection,
            magneticHeading: targetMagneticHeading,
            targetNavaid
        };
    } else if (rawDirection !== null && rawDirection !== "none" && rawDirection !== "not_applicable") {
        throw new DataIntegrityError(
            `LLM extraction returned an incoherent turn_direction: ${extraction.turn_direction}. Expected LEFT, RIGHT, or NONE.`
        );
    }

    return { extraction, triggerDistanceNM, turn };
}

module.exports = {
    TRIGGER_TYPES,
    parseRelationalLogic
};
