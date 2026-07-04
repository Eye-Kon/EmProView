/**
 * EmProView Phase 2: AI Extraction Schema
 * This file defines the strict JSON Schema required by OpenAI's Structured Outputs.
 * It forces the LLM to return data exactly matching our Phase 1 frontend requirements.
 */

const procedureSchema = {
    name: "engine_out_procedure_extraction",
    description: "Extracts aircraft engine-out emergency procedures into a strict geometric array for radar visualization.",
    strict: true,
    schema: {
        type: "object",
        properties: {
            procedureType: {
                type: "string",
                enum: ["heading_turn", "conditional_route", "rnav_sequence"],
                description: "The primary mathematical classification of the procedure."
            },
            airportCode: {
                type: "string",
                description: "The 4-letter ICAO code of the departure airport (e.g., KLAS, KPHX, KSFO)."
            },
            procedureRows: {
                type: "array",
                description: "Independent routes for specific runways or departure paths.",
                items: {
                    type: "object",
                    properties: {
                        runways: {
                            type: "array",
                            items: { type: "string" },
                            description: "The runway(s) this row applies to (e.g., ['01R', '01L'])."
                        },
                        instructionText: {
                            type: "string",
                            description: "The verbatim text from the chart detailing the procedure."
                        },
                        assignedHeadingDegrees: {
                            type: ["number", "null"],
                            description: "The raw heading to fly. MUST be null for rnav_sequence."
                        },
                        geometry: {
                            type: "object",
                            properties: {
                                segments: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            segmentType: {
                                                type: "string",
                                                enum: ["track_to_fix", "direct_to_fix", "hold"]
                                            },
                                            label: {
                                                type: "string",
                                                description: "A short, UI-friendly label for this leg."
                                            },
                                            headingDegrees: {
                                                type: ["number", "null"],
                                                description: "The magnetic heading of this vector."
                                            },
                                            distanceNM: {
                                                type: ["number", "null"],
                                                description: "The physical length of this vector in Nautical Miles. MUST be null when the source text does not explicitly provide distance."
                                            }
                                        },
                                        required: ["segmentType", "label", "headingDegrees", "distanceNM"],
                                        additionalProperties: false
                                    }
                                }
                            },
                            required: ["segments"],
                            additionalProperties: false
                        }
                    },
                    required: ["runways", "instructionText", "assignedHeadingDegrees", "geometry"],
                    additionalProperties: false
                }
            }
        },
        required: ["procedureType", "airportCode", "procedureRows"],
        additionalProperties: false
    }
};

module.exports = { procedureSchema };