/**
 * extractionService: the shared LLM extraction + geodetic enrichment core.
 *
 * Used by both the synchronous HTTP routes (server.js) and the asynchronous
 * batch worker (backend/jobs/batchProcessor.js), so both paths run byte-
 * identical prompt logic, JSON-schema enforcement, and enrichment.
 *
 * LLM agnosticism: any OpenAI-compatible endpoint works (api.openai.com,
 * a local Ollama/llama.cpp container, or a private Azure tenant). Routing is
 * configured via env; prompt logic and JSON-schema enforcement never change.
 *   LLM_BASE_URL    e.g. http://ollama:11434/v1 (empty = api.openai.com)
 *   LLM_MODEL_NAME  e.g. llama3:8b (empty = gpt-4o)
 *   OPENAI_API_KEY  provider key; local endpoints usually ignore it
 */
const OpenAI = require("openai");
const { procedureSchema } = require("./openai_schema_definition");
const { systemInstructions, fewShotExamples } = require("./prompt");
const { segmentProcessor, DataIntegrityError } = require("./geo_engine");

const LLM_BASE_URL = process.env.LLM_BASE_URL || undefined;
const LLM_MODEL_NAME = process.env.LLM_MODEL_NAME || "gpt-4o";
const openai = new OpenAI({
    ...(LLM_BASE_URL ? { baseURL: LLM_BASE_URL } : {}),
    // The SDK requires a key even for local endpoints that ignore it.
    apiKey: process.env.OPENAI_API_KEY || (LLM_BASE_URL ? "local-endpoint-no-key" : undefined)
});

/** Runs the deterministic chart-text extraction and returns the parsed procedure. */
async function extractProcedureFromText(rawText) {
    const response = await openai.chat.completions.create({
        model: LLM_MODEL_NAME,
        temperature: 0,
        top_p: 0.1,
        messages: [
            { role: "system", content: systemInstructions },
            ...fewShotExamples,
            { role: "user", content: rawText }
        ],
        response_format: {
            type: "json_schema",
            json_schema: procedureSchema
        }
    });

    return JSON.parse(response.choices[0].message.content);
}

/** Optional flightDate from an API payload: undefined passes through (query layer defaults to now). */
function parseFlightDate(rawFlightDate) {
    if (rawFlightDate === undefined || rawFlightDate === null) {
        return undefined;
    }

    const date = new Date(rawFlightDate);

    if (!Number.isFinite(date.getTime())) {
        throw new Error(`Invalid flightDate: ${rawFlightDate}. Expected an ISO-8601 date string.`);
    }

    return date;
}

function getProcedureAirportCode(procedure) {
    const airportCode = procedure.airportCode || procedure.source?.airportCode || procedure.airport?.icao;

    if (typeof airportCode !== "string" || airportCode.trim() === "") {
        throw new DataIntegrityError("Procedure airportCode is required for spatial trigger resolution.");
    }

    return airportCode.trim();
}

async function enrichProcedureWithSpatialTriggers(procedure, flightDate) {
    if (!procedure?.procedureRows) {
        return procedure;
    }

    const airportCode = getProcedureAirportCode(procedure);

    // Per-row enrichment: a ground-truth gap in one row (e.g. a runway missing
    // from the nav database) must not abort the entire procedure. Each row
    // carries its own integrity report; failed rows keep their raw segments.
    return {
        ...procedure,
        procedureRows: await Promise.all(procedure.procedureRows.map(async (row) => {
            try {
                return {
                    ...row,
                    geometry: {
                        ...row.geometry,
                        segments: await Promise.all((row.geometry?.segments || []).map((segment) =>
                            enrichSegmentWithSpatialTrigger(segment, row, { airportCode, flightDate })
                        ))
                    },
                    integrity: { status: "enriched", errors: [] }
                };
            } catch (error) {
                if (!(error instanceof DataIntegrityError)) {
                    throw error;
                }

                console.warn(`Row ${row.rowId || "(unidentified)"} enrichment failed: ${error.message}`);

                return {
                    ...row,
                    integrity: {
                        status: "failed",
                        errors: [`${error.name}: ${error.message}`]
                    }
                };
            }
        }))
    };
}

async function enrichSegmentWithSpatialTrigger(segment, row, context) {
    if (!segment?.spatialTrigger) {
        return segment;
    }

    const computedSpatialTrigger = await segmentProcessor.process(segment, row, context);

    if (!computedSpatialTrigger) {
        return segment;
    }

    return {
        ...segment,
        computedSpatialTrigger
    };
}

module.exports = {
    openai,
    LLM_MODEL_NAME,
    extractProcedureFromText,
    parseFlightDate,
    getProcedureAirportCode,
    enrichProcedureWithSpatialTriggers
};
