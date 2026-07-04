/**
 * EmProView Phase 2: AI Extraction Schema
 * This file defines the strict JSON Schema required by OpenAI's Structured Outputs.
 * It forces the LLM to return data exactly matching our Phase 1 frontend requirements.
 */

const procedureSchema = {
    name: "engine_out_procedure_extraction",
    description: "Extracts aircraft engine-out emergency procedures into strict ARINC-inspired navigation legs and parametric COGO constraints for radar visualization.",
    strict: true,
    schema: {
        type: "object",
        description: "Segment categorization rules: Use HEADING_TO_ALTITUDE for runway heading or assigned heading legs that terminate at an altitude or DME/radial boundary. Use DIRECT_TO_FIX when the text says direct/proceed direct to a named fix. Use TRACK_TO_FIX when the chart shows a published route, VIA coding, SID/FMS/EO SID, or waypoint-to-waypoint sequence such as AA01R leading through map fixes. If the text says maintain runway heading until a DME from a NAVAID, encode that as a spatialTrigger with triggerType RADIAL_DISTANCE_INTERSECTION.",
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
                                        description: "A polymorphic navigation leg inspired by ARINC 424 path terminators and COGO constraints. For text like 'Maintain runway heading until 11.6 DME from the TCH VOR, then turn left heading 320', use HEADING_TO_ALTITUDE or TRACK_TO_FIX as appropriate and include a spatialTrigger with triggerType RADIAL_DISTANCE_INTERSECTION.",
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
                                                description: "The named fix or waypoint that terminates this leg. Use for DIRECT_TO_FIX or TRACK_TO_FIX when a waypoint is present; use null for DME/radial-only terminations."
                                            },
                                            terminationAltitude: {
                                                type: ["number", "null"],
                                                description: "Optional altitude boundary for the leg. Required by meaning for HEADING_TO_ALTITUDE when the chart states an altitude termination; otherwise use null."
                                            },
                                            spatialTrigger: {
                                                type: ["object", "null"],
                                                description: "Parametric COGO trigger for non-waypoint constraints. Use when the route is defined by a DME/radial/distance boundary instead of a named fix.",
                                                properties: {
                                                    triggerType: {
                                                        type: "string",
                                                        enum: ["RADIAL_DISTANCE_INTERSECTION"],
                                                        description: "Use RADIAL_DISTANCE_INTERSECTION when an aircraft track intersects a DME radius from a reference NAVAID."
                                                    },
                                                    referenceNavaid: {
                                                        type: "string",
                                                        description: "Reference NAVAID identifier, such as TCH."
                                                    },
                                                    triggerDistanceNM: {
                                                        type: "number",
                                                        description: "DME distance in nautical miles from the reference NAVAID."
                                                    },
                                                    resultingAction: {
                                                        type: "object",
                                                        properties: {
                                                            actionType: {
                                                                type: "string",
                                                                enum: ["TURN_HEADING", "DIRECT_TO_FIX", "TRACK_TO_FIX"],
                                                                description: "The action that begins at the computed trigger point."
                                                            },
                                                            turnDirection: {
                                                                type: ["string", "null"],
                                                                enum: ["left", "right", "not_applicable", null],
                                                                description: "Turn direction if stated."
                                                            },
                                                            magneticHeading: {
                                                                type: ["number", "null"],
                                                                description: "Resulting magnetic heading, such as 320."
                                                            }
                                                        },
                                                        required: ["actionType", "turnDirection", "magneticHeading"],
                                                        additionalProperties: false
                                                    }
                                                },
                                                required: ["triggerType", "referenceNavaid", "triggerDistanceNM", "resultingAction"],
                                                additionalProperties: false
                                            },
                                            distanceNM: {
                                                type: ["number", "null"],
                                                description: "The physical length of this vector in Nautical Miles. MUST be null when the source text does not explicitly provide distance."
                                            }
                                        },
                                        required: ["segmentType", "label", "distanceNM"],
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