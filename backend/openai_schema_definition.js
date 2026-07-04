/**
 * EmProView Phase 2: AI Extraction Schema
 * This file defines the strict JSON Schema required by OpenAI's Structured Outputs.
 * It forces the LLM to return data exactly matching our Phase 1 frontend requirements.
 */

const procedureSchema = {
    name: "engine_out_procedure_extraction",
    description: "Extracts aircraft engine-out emergency procedures into strict ARINC-inspired navigation legs for radar visualization. Categorize each segment as HEADING_TO_ALTITUDE, DIRECT_TO_FIX, or TRACK_TO_FIX based only on chart text and visible map data.",
    strict: true,
    schema: {
        type: "object",
        description: "Segment categorization rules: Use HEADING_TO_ALTITUDE for runway heading or assigned heading legs that terminate at an altitude. Use DIRECT_TO_FIX when the text says direct/proceed direct to a named fix. Use TRACK_TO_FIX when the chart shows a published route, VIA coding, SID/FMS/EO SID, or waypoint-to-waypoint sequence such as AA01R leading through map fixes.",
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
                                    description: "Sequential navigation legs. If the VIA column contains a coded route such as AA01R, EO08, or similar, and the map depicts a chain of waypoints, encode the route as TRACK_TO_FIX segments in displayed order.",
                                    items: {
                                        type: "object",
                                        description: "A polymorphic navigation leg inspired by ARINC 424 path terminators. Segment type determines which optional fields must be populated.",
                                        properties: {
                                            segmentType: {
                                                type: "string",
                                                enum: ["HEADING_TO_ALTITUDE", "DIRECT_TO_FIX", "TRACK_TO_FIX"],
                                                description: "HEADING_TO_ALTITUDE (VA): fly a heading until an altitude boundary. DIRECT_TO_FIX (DF): proceed direct to a named fix. TRACK_TO_FIX (TF): follow a published track or waypoint sequence to a named fix; use for RNAV/FMS routes shown by a VIA code and map waypoint chain."
                                            },
                                            label: {
                                                type: "string",
                                                description: "A short, UI-friendly label for this leg."
                                            },
                                            headingDegrees: {
                                                type: ["number", "null"],
                                                description: "Required when segmentType is HEADING_TO_ALTITUDE. Optional for DIRECT_TO_FIX and TRACK_TO_FIX; use null if the chart does not explicitly provide a heading."
                                            },
                                            targetWaypoint: {
                                                type: ["string", "null"],
                                                description: "Required when segmentType is DIRECT_TO_FIX or TRACK_TO_FIX. The named fix or waypoint that terminates this leg. Use null for HEADING_TO_ALTITUDE if no waypoint terminates the leg."
                                            },
                                            terminationAltitude: {
                                                type: ["number", "null"],
                                                description: "Optional altitude boundary for the leg. Required by meaning for HEADING_TO_ALTITUDE when the chart states an altitude termination; otherwise use null."
                                            },
                                            distanceNM: {
                                                type: ["number", "null"],
                                                description: "The physical length of this vector in Nautical Miles. MUST be null when the source text does not explicitly provide distance."
                                            }
                                        },
                                        required: ["segmentType", "label", "distanceNM"],
                                        allOf: [
                                            {
                                                if: {
                                                    properties: {
                                                        segmentType: { const: "HEADING_TO_ALTITUDE" }
                                                    }
                                                },
                                                then: {
                                                    required: ["headingDegrees"]
                                                }
                                            },
                                            {
                                                if: {
                                                    properties: {
                                                        segmentType: { enum: ["DIRECT_TO_FIX", "TRACK_TO_FIX"] }
                                                    }
                                                },
                                                then: {
                                                    required: ["targetWaypoint"]
                                                }
                                            }
                                        ],
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