/**
 * POST /api/compile-cycle — fleet-wide ARINC 424-18 cycle pack.
 *
 * Body is exactly { operator_id, airac_cycle }. Compiles every ACTIVE
 * OperatorProcedureRegistry lock for that operator into one CR/LF text
 * block. Encoder failures are isolated into rejection_manifest.
 */
const { compileOperatorCycle } = require("../services/cycleCompilerService");

const AIRAC_CYCLE_PATTERN = /^\d{4}$/;

function parseCompileCycleBody(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return {
            error: "Request body must be a JSON object with exactly two keys: operator_id and airac_cycle."
        };
    }

    const keys = Object.keys(body);
    const hasOperator = Object.prototype.hasOwnProperty.call(body, "operator_id");
    const hasCycle = Object.prototype.hasOwnProperty.call(body, "airac_cycle");

    if (keys.length !== 2 || !hasOperator || !hasCycle) {
        return {
            error: "Request body must contain exactly two keys: operator_id and airac_cycle."
        };
    }

    if (typeof body.operator_id !== "string" || body.operator_id.trim() === "") {
        return {
            error: 'Invalid operator_id: a non-empty ICAO operator code is required (e.g. "AAL").'
        };
    }

    if (typeof body.airac_cycle !== "string" || !AIRAC_CYCLE_PATTERN.test(body.airac_cycle.trim())) {
        return {
            error: 'Invalid airac_cycle: must be a 4-digit AIRAC ident (YYNN), e.g. "2608".'
        };
    }

    return {
        operatorId: body.operator_id.trim().toUpperCase(),
        airacCycle: body.airac_cycle.trim()
    };
}

function createCompileCycleHandler(getDb) {
    return async function handleCompileCycle(req, res) {
        const parsed = parseCompileCycleBody(req.body);

        if (parsed.error) {
            return res.status(400).json({ error: parsed.error });
        }

        try {
            const pack = await compileOperatorCycle({
                db: getDb(),
                operatorId: parsed.operatorId,
                airacCycle: parsed.airacCycle
            });

            return res.status(200).json(pack);
        } catch (error) {
            console.error("Cycle compilation failed:", error);
            return res.status(500).json({ error: "Failed to compile operator cycle." });
        }
    };
}

module.exports = {
    AIRAC_CYCLE_PATTERN,
    createCompileCycleHandler,
    parseCompileCycleBody
};
