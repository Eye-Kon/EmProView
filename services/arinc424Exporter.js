/**
 * Deterministic ARINC 424-18 PD exporter.
 *
 * Consumes a locked, verified canonical procedure plus NASR ground truth
 * (runway true heading → magnetic via trueToMagnetic, navaid ident/region).
 * Never reads raw LLM tokens and never invents coordinates. Any missing
 * 424-bound field is a DataIntegrityError (HTTP 422).
 */
const { DataIntegrityError } = require("../backend/geo/DataIntegrityError");
const { GeoMath } = require("../backend/geo/GeoMath");
const { parseProcedureIdentity } = require("../backend/models/canonicalProcedure");
const { encodePdRecord, RECORD_LENGTH } = require("../utils/arinc424Catalog");
const { collectCanonicalLegs, mapCanonicalLeg } = require("../utils/arinc424Mappers");
const navDb = require("../utils/navDbQuery");

const LINE_TERMINATOR = "\r\n";

/** FAA CIFP ICAO region from the navaid's US state. Missing state is 422. */
const STATE_TO_ICAO_REGION = {
    CT: "K1", DE: "K1", MA: "K1", MD: "K1", ME: "K1", NH: "K1", NJ: "K1",
    NY: "K1", PA: "K1", RI: "K1", VT: "K1", VA: "K1", WV: "K1", DC: "K1",
    CO: "K2", IA: "K2", ID: "K2", IL: "K2", IN: "K2", KS: "K2", KY: "K2",
    MI: "K2", MN: "K2", MO: "K2", MT: "K2", ND: "K2", NE: "K2", OH: "K2",
    OR: "K2", SD: "K2", UT: "K2", WA: "K2", WI: "K2", WY: "K2",
    AL: "K3", FL: "K3", GA: "K3", MS: "K3", NC: "K3", SC: "K3", TN: "K3",
    AR: "K4", AZ: "K4", CA: "K4", LA: "K4", NM: "K4", NV: "K4", OK: "K4", TX: "K4",
    AK: "K5",
    HI: "K6",
    AS: "K7", GU: "K7", MP: "K7"
};

function icaoRegionFromState(state, ident) {
    const region = STATE_TO_ICAO_REGION[String(state || "").trim().toUpperCase()];

    if (!region) {
        throw new DataIntegrityError(
            `ARINC 424 export failed: no ICAO region for navaid/airport state ` +
                `${JSON.stringify(state)} (ident ${ident}).`
        );
    }

    return region;
}

function requireAiracCycle(airacCycle) {
    if (!airacCycle?.ident || !/^\d{4}$/.test(String(airacCycle.ident))) {
        throw new DataIntegrityError(
            "ARINC 424 export failed: AIRAC cycle ident (YYNN) is required."
        );
    }

    return String(airacCycle.ident);
}

function assertVerified(procedure) {
    const rows = Array.isArray(procedure?.procedureRows) ? procedure.procedureRows : [];
    const failed = rows.filter((row) => row.integrity && row.integrity.status !== "enriched");

    if (failed.length > 0) {
        throw new DataIntegrityError(
            `ARINC 424 export refused: ${failed.length} unverified row(s). Only locked verified procedures are serialized.`
        );
    }
}

function runwayFixIdent(transition) {
    const ident = String(transition || "").trim().toUpperCase();

    if (!/^\d{1,2}[LRC]?$/.test(ident)) {
        throw new DataIntegrityError(
            `ARINC 424 export failed: transition ${JSON.stringify(transition)} is not a runway identifier.`
        );
    }

    return `RW${ident}`.slice(0, 5);
}

/**
 * Serializes one locked procedure to 132-character PD records.
 *
 * @param {object} procedure - verified canonical document
 * @param {object} options
 * @param {{ident:string}} options.airacCycle
 * @param {Date|string|number} [options.flightDate]
 * @param {object} [options.navDb] - injectable query layer
 * @param {number} [options.fileRecordStart]
 */
async function generateArinc424Records(procedure, {
    airacCycle,
    flightDate = new Date(),
    navDb: nav = navDb,
    fileRecordStart = 1
} = {}) {
    let identity;

    try {
        identity = parseProcedureIdentity(procedure);
    } catch (error) {
        throw new DataIntegrityError(
            `ARINC 424 export failed: ${error.message}`
        );
    }

    assertVerified(procedure);

    const cycleDate = requireAiracCycle(airacCycle);
    const legs = collectCanonicalLegs({ ...procedure, ...identity });
    const runway = await nav.getRunway(identity.airport_icao, identity.transition, flightDate);
    const runwayMagneticHeading = GeoMath.trueToMagnetic(runway.trueHeading, runway.magneticVariation);

    if (!Number.isFinite(runwayMagneticHeading)) {
        throw new DataIntegrityError(
            `ARINC 424 export failed: runway magnetic heading for ${identity.airport_icao} ` +
                `${identity.transition} is not finite.`
        );
    }

    const dmeIdent = legs.find((leg) => leg.type === "TRACK_TO_DME")?.navaid;
    let icaoCode = null;

    if (dmeIdent) {
        const station = await nav.getNavaid(
            dmeIdent,
            { latitude: runway.latitude, longitude: runway.longitude },
            flightDate
        );
        icaoCode = icaoRegionFromState(station.state, station.identifier);
    }

    if (!icaoCode) {
        throw new DataIntegrityError(
            `ARINC 424 export failed: ICAO region could not be resolved from ground-truth navaid state.`
        );
    }

    const recordType = identity.operator_id === "FAA" ? "S" : "T";
    const customerAreaCode = identity.operator_id === "FAA" ? "USA" : identity.operator_id;
    const records = [];

    legs.forEach((leg, index) => {
        const mapped = mapCanonicalLeg(leg, {
            path: `legs[${index}]`,
            runwayMagneticHeading
        });

        const isFirst = index === 0;
        const sequenceNumber = (index + 1) * 10;

        records.push(encodePdRecord({
            recordType,
            customerAreaCode,
            sectionCode: "P",
            airportIdentifier: identity.airport_icao,
            icaoCode,
            subsectionCode: "D",
            procedureIdentifier: identity.procedure_ident,
            routeType: identity.route_type,
            transitionIdentifier: identity.transition,
            sequenceNumber,
            fixIdentifier: isFirst ? runwayFixIdent(identity.transition) : "",
            fixIcaoCode: isFirst ? icaoCode : "",
            fixSectionCode: isFirst ? "P" : "",
            fixSubsectionCode: isFirst ? "G" : "",
            continuationNumber: 0,
            pathTerminator: mapped.pathTerminator,
            turnDirection: mapped.turnDirection,
            turnDirectionValid: mapped.turnDirectionValid,
            recommendedNavaid: mapped.recommendedNavaid,
            recommendedNavaidIcao: mapped.recommendedNavaid ? icaoCode : "",
            rho: mapped.rho,
            routeDistance: mapped.routeDistance,
            magneticCourse: mapped.magneticCourse,
            altitude: mapped.altitude,
            fileRecordNumber: fileRecordStart + index,
            cycleDate
        }));
    });

    return records;
}

async function generateArinc424File(procedures, options = {}) {
    const list = Array.isArray(procedures) ? procedures : [procedures];
    const records = [];
    let fileRecordStart = 1;

    for (const procedure of list) {
        if (!procedure?.procedure_ident) {
            continue;
        }

        const batch = await generateArinc424Records(procedure, { ...options, fileRecordStart });
        records.push(...batch);
        fileRecordStart += batch.length;
    }

    if (records.length === 0) {
        throw new DataIntegrityError(
            "ARINC 424 export failed: no locked procedures with a 5-part identity were available."
        );
    }

    for (const record of records) {
        if (record.length !== RECORD_LENGTH) {
            throw new DataIntegrityError(
                `ARINC 424 export failed: a record was ${record.length} characters, not ${RECORD_LENGTH}.`
            );
        }
    }

    return records.join(LINE_TERMINATOR) + LINE_TERMINATOR;
}

module.exports = {
    LINE_TERMINATOR,
    generateArinc424Records,
    generateArinc424File
};
