/**
 * Phase 7.0 multi-tenant cycle compiler.
 *
 * Walks OperatorProcedureRegistry ACTIVE locks for one operator, loads each
 * verified canonical procedure by its 5-part ARINC 424 identity, and runs
 * the Phase 5 encoder. Failures are isolated: a 422 on procedure A is
 * recorded in the rejection manifest and procedure B still compiles.
 *
 * The requested AIRAC cycle is stamped into columns 129-132 of every
 * emitted 132-character record, independent of the NASR active cycle.
 */
const { findCanonicalProcedure } = require("../models/canonicalProcedure");
const { listActiveRegistryEntries, registryFilter } = require("../models/operatorProcedureRegistry");
const { generateArinc424Records, LINE_TERMINATOR } = require("../../services/arinc424Exporter");
const { RECORD_LENGTH } = require("../../utils/arinc424Catalog");

const CYCLE_DATE_START = 129;
const CYCLE_DATE_WIDTH = 4;
const CYCLE_DATE_SLICE = CYCLE_DATE_START - 1;

function log(level, message) {
    const prefix = `[cycle-compiler] ${new Date().toISOString()}`;

    if (level === "error") {
        console.error(`${prefix} ERROR: ${message}`);
    } else if (level === "warn") {
        console.warn(`${prefix} WARN: ${message}`);
    } else {
        console.log(`${prefix} ${message}`);
    }
}

function formatIdentity(identity) {
    return `${identity.operator_id}/${identity.airport_icao}/` +
        `${identity.procedure_ident}/${identity.route_type}/${identity.transition}`;
}

function errorMessageOf(error) {
    if (error && typeof error.message === "string" && error.message.trim() !== "") {
        return error.message;
    }

    return "Unknown compilation failure.";
}

function identityFromRegistry(entry) {
    return registryFilter(entry);
}

/**
 * Overwrite columns 129-132 (1-based) with the requested AIRAC ident.
 * The encoder already packs cycleDate; the compiler owns the fleet stamp.
 */
function stampAiracCycle(record, airacCycle) {
    if (typeof airacCycle !== "string" || !/^\d{4}$/.test(airacCycle)) {
        throw new Error(
            `Cycle compiler refused AIRAC cycle ${JSON.stringify(airacCycle)}; a 4-digit YYNN ident is required.`
        );
    }

    if (typeof record !== "string" || record.length !== RECORD_LENGTH) {
        throw new Error(
            `Cycle compiler refused a record of length ${record?.length}; ${RECORD_LENGTH} required.`
        );
    }

    return record.slice(0, CYCLE_DATE_SLICE) + airacCycle + record.slice(CYCLE_DATE_SLICE + CYCLE_DATE_WIDTH);
}

function concatenateRecords(records) {
    if (!Array.isArray(records) || records.length === 0) {
        return "";
    }

    return records.join(LINE_TERMINATOR) + LINE_TERMINATOR;
}

/**
 * @param {object} options
 * @param {object} [options.db]  MongoDB Db; required unless findCanonical is injected.
 * @param {string} options.operatorId
 * @param {string} options.airacCycle  YYNN, already validated.
 * @param {Function} [options.listActive]
 * @param {Function} [options.findCanonical]
 * @param {Function} [options.exportRecords]
 */
async function compileOperatorCycle({
    db,
    operatorId,
    airacCycle,
    listActive = listActiveRegistryEntries,
    findCanonical = (identity) => findCanonicalProcedure(db, identity),
    exportRecords = generateArinc424Records
} = {}) {
    const activeEntries = await listActive(operatorId);
    const records = [];
    const rejection_manifest = [];
    let fileRecordStart = 1;

    for (const entry of activeEntries) {
        const identity = identityFromRegistry(entry);

        try {
            const procedure = await findCanonical(identity);

            if (!procedure) {
                throw new Error("Canonical procedure not found for 5-part identity.");
            }

            const batch = await exportRecords(procedure, {
                airacCycle: { ident: airacCycle },
                fileRecordStart
            });

            if (!Array.isArray(batch) || batch.length === 0) {
                throw new Error("ARINC 424 export produced no records.");
            }

            const stamped = batch.map((line) => stampAiracCycle(line, airacCycle));
            records.push(...stamped);
            fileRecordStart += stamped.length;
        } catch (error) {
            const reason = errorMessageOf(error);
            log("warn", `${formatIdentity(identity)} dropped: ${reason}`);
            rejection_manifest.push({
                ...identity,
                reason
            });
        }
    }

    return {
        operator_id: operatorId,
        airac_cycle: airacCycle,
        summary: {
            total_attempted: activeEntries.length,
            total_succeeded: activeEntries.length - rejection_manifest.length,
            total_failed: rejection_manifest.length
        },
        rejection_manifest,
        arinc424_payload: concatenateRecords(records)
    };
}

module.exports = {
    CYCLE_DATE_START,
    CYCLE_DATE_WIDTH,
    compileOperatorCycle,
    stampAiracCycle,
    concatenateRecords
};
