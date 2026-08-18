/**
 * OperatorProcedureRegistry: durable, stateful lock for ARINC 424
 * procedure identifiers across AIRAC cycles.
 *
 * Native MongoDB collection (this repo does not use Mongoose). One row
 * per 5-part identity key. Idents are never reused: RETIRED rows stay
 * so a later mint cannot collide with a box still flying an old cycle.
 *
 * Unique compound index:
 *   (operator_id, airport_icao, procedure_ident, route_type, transition)
 */
const { DataIntegrityError } = require("../geo/DataIntegrityError");

const COLLECTION = "operator_procedure_registry";
const IDENTITY_INDEX_NAME = "operator_procedure_identity_unique";
const IDENTITY_INDEX = {
    operator_id: 1,
    airport_icao: 1,
    procedure_ident: 1,
    route_type: 1,
    transition: 1
};

const REGISTRY_STATUSES = ["ACTIVE", "RETIRED"];

let registryCollection = null;

function initOperatorProcedureRegistry(db) {
    if (!db || typeof db.collection !== "function") {
        throw new Error("initOperatorProcedureRegistry requires a connected MongoDB Db instance.");
    }

    registryCollection = db.collection(COLLECTION);
}

function getRegistryCollection() {
    if (!registryCollection) {
        throw new Error(
            "OperatorProcedureRegistry is not initialized. Call initOperatorProcedureRegistry(db) at startup."
        );
    }

    return registryCollection;
}

async function ensureOperatorProcedureRegistryIndexes() {
    await getRegistryCollection().createIndex(IDENTITY_INDEX, {
        unique: true,
        name: IDENTITY_INDEX_NAME
    });
}

function registryFilter(identity) {
    return {
        operator_id: identity.operator_id,
        airport_icao: identity.airport_icao,
        procedure_ident: identity.procedure_ident,
        route_type: identity.route_type,
        transition: identity.transition
    };
}

async function findRegistryEntry(identity) {
    return getRegistryCollection().findOne(registryFilter(identity));
}

/**
 * Fleet-wide ACTIVE lock set for one operator. Sort is stable so a cycle
 * pack is byte-identical across recompiles of the same registry.
 */
async function listActiveRegistryEntries(operatorId) {
    return getRegistryCollection()
        .find({ operator_id: operatorId, status: "ACTIVE" })
        .sort({
            airport_icao: 1,
            procedure_ident: 1,
            route_type: 1,
            transition: 1
        })
        .toArray();
}

/**
 * Locks the 5-part ident as ACTIVE. A RETIRED row is a hard reject —
 * the ident is reserved forever. Re-locking an already-ACTIVE key is
 * idempotent (same procedure republished / amended).
 */
async function lockRegistryIdent(identity, { now = new Date() } = {}) {
    const existing = await findRegistryEntry(identity);

    if (existing?.status === "RETIRED") {
        throw new DataIntegrityError(
            `ARINC 424 ident is RETIRED and cannot be reused: ` +
                `${identity.operator_id}/${identity.airport_icao}/` +
                `${identity.procedure_ident}/${identity.route_type}/${identity.transition}.`
        );
    }

    if (existing?.status === "ACTIVE") {
        return existing;
    }

    const document = {
        ...registryFilter(identity),
        status: "ACTIVE",
        lockedAt: now,
        updatedAt: now
    };

    try {
        await getRegistryCollection().insertOne(document);
    } catch (error) {
        if (error?.code === 11000) {
            const raced = await findRegistryEntry(identity);
            if (raced?.status === "RETIRED") {
                throw new DataIntegrityError(
                    `ARINC 424 ident is RETIRED and cannot be reused: ` +
                        `${identity.operator_id}/${identity.airport_icao}/` +
                        `${identity.procedure_ident}/${identity.route_type}/${identity.transition}.`
                );
            }
            return raced;
        }
        throw error;
    }

    return document;
}

module.exports = {
    COLLECTION,
    IDENTITY_INDEX_NAME,
    IDENTITY_INDEX,
    REGISTRY_STATUSES,
    initOperatorProcedureRegistry,
    ensureOperatorProcedureRegistryIndexes,
    findRegistryEntry,
    listActiveRegistryEntries,
    lockRegistryIdent,
    registryFilter
};
