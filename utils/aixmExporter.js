/**
 * aixmExporter: AIXM 5.1 presentation layer for the geodetic engine.
 *
 * Serializes an enriched procedure (the engine's verified output) into an
 * AIXM 5.1 <aixm:Route> XML document for FAA SWIM consumers. Each computed
 * track (one per runway per spatial trigger) becomes an <aixm:routeSegment>
 * carrying a <gml:LineString>. Coordinates are emitted as space-separated
 * "latitude longitude" pairs (GML/EPSG:4326 axis order — the reverse of
 * GeoJSON's [longitude, latitude] arrays).
 *
 * Temporal compliance is embedded twice: the AIRAC cycle's effective window
 * as the feature's <gml:validTime> / <aixm:featureLifetime>, and the
 * resolved cycle ident + flight date as <aixm:annotation> notes.
 *
 * Failsafe: only mathematically verified routes are serialized. Any failed
 * row, missing geometry, or absent verified track throws
 * UnserializableRouteError (HTTP 422 at the API boundary) before any XML is
 * generated.
 */
const crypto = require("crypto");

/** Payload is not a verified route; the API maps this to HTTP 422. */
class UnserializableRouteError extends Error {
    constructor(message) {
        super(message);
        this.name = "UnserializableRouteError";
        this.statusCode = 422;
    }
}

function escapeXml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

/** gml:id values must be NCNames: alphanumeric, no spaces, non-digit start. */
function gmlId(prefix, ...parts) {
    const suffix = parts
        .map((part) => String(part).replace(/[^A-Za-z0-9_.-]/g, "_"))
        .filter((part) => part.length > 0)
        .join("-");

    return suffix ? `${prefix}-${suffix}` : prefix;
}

/** GeoJSON [longitude, latitude] positions -> GML "latitude longitude" posList. */
function toGmlPosList(coordinates) {
    return coordinates.map(([longitude, latitude]) => `${latitude} ${longitude}`).join(" ");
}

function toIsoString(value) {
    const date = value instanceof Date ? value : new Date(value);

    if (!Number.isFinite(date.getTime())) {
        throw new UnserializableRouteError(`Invalid temporal value for AIXM serialization: ${value}`);
    }

    return date.toISOString();
}

function annotationNote(indent, id, propertyName, note) {
    return [
        `${indent}<aixm:annotation>`,
        `${indent}  <aixm:Note gml:id="${escapeXml(id)}">`,
        `${indent}    <aixm:propertyName>${escapeXml(propertyName)}</aixm:propertyName>`,
        `${indent}    <aixm:purpose>OTHER:TEMPORAL_COMPLIANCE</aixm:purpose>`,
        `${indent}    <aixm:translatedNote>`,
        `${indent}      <aixm:LinguisticNote gml:id="${escapeXml(id)}-en">`,
        `${indent}        <aixm:note lang="en">${escapeXml(note)}</aixm:note>`,
        `${indent}      </aixm:LinguisticNote>`,
        `${indent}    </aixm:translatedNote>`,
        `${indent}  </aixm:Note>`,
        `${indent}</aixm:annotation>`
    ].join("\n");
}

/**
 * Collects every verified track from the enriched procedure: one entry per
 * runway per solved spatial trigger, in row order.
 */
function collectVerifiedTracks(procedure) {
    const tracks = [];

    for (const row of procedure.procedureRows) {
        for (const segment of row.geometry?.segments || []) {
            const turnPoints = segment.computedSpatialTrigger?.computedTurnPoints || [];

            for (const turnPoint of turnPoints) {
                const lineString = (turnPoint.path?.geojson?.features || []).find(
                    (feature) => feature.geometry?.type === "LineString" && feature.properties?.role === "track"
                );

                if (!lineString || !Array.isArray(lineString.geometry.coordinates) || lineString.geometry.coordinates.length < 2) {
                    throw new UnserializableRouteError(
                        `Row ${row.rowId ?? "(unidentified)"} runway ${turnPoint.runway ?? "?"} carries a computed ` +
                        "trigger without a verified track LineString; route is not serializable."
                    );
                }

                tracks.push({
                    runway: turnPoint.runway,
                    legType: lineString.properties?.legType ?? turnPoint.path?.parametric?.legType,
                    segmentLabel: segment.label ?? null,
                    coordinates: lineString.geometry.coordinates
                });
            }
        }
    }

    return tracks;
}

/**
 * Serializes the engine's verified output into an AIXM 5.1 route document.
 *
 * @param {object} geoJsonPayload - enriched procedure from the geodetic engine
 *   (procedureRows with per-row integrity reports and computed GeoJSON paths)
 * @param {{ident:string,effectiveFrom:string,effectiveTo:string,source?:string}} airacCycle
 *   - the AIRAC cycle that produced the geometry (from determineActiveCycle)
 * @param {Date|string|number} flightDate - the flight date the geometry was resolved for
 * @returns {string} AIXM 5.1 XML document
 * @throws {UnserializableRouteError} for failed rows or missing geometry (HTTP 422)
 */
function generateAixmRoute(geoJsonPayload, airacCycle, flightDate) {
    // --- Failsafe gate: verify before serializing anything. ---
    if (!geoJsonPayload || !Array.isArray(geoJsonPayload.procedureRows) || geoJsonPayload.procedureRows.length === 0) {
        throw new UnserializableRouteError("Payload carries no procedure rows; nothing to serialize.");
    }

    if (!airacCycle?.ident || !airacCycle.effectiveFrom || !airacCycle.effectiveTo) {
        throw new UnserializableRouteError("AIRAC cycle context (ident, effectiveFrom, effectiveTo) is required.");
    }

    const unverifiedRows = geoJsonPayload.procedureRows.filter((row) => row.integrity?.status !== "enriched");

    if (unverifiedRows.length > 0) {
        const details = unverifiedRows
            .map((row) => `${row.rowId ?? "(unidentified)"}: ${row.integrity?.status ?? "no integrity report"}`)
            .join("; ");

        throw new UnserializableRouteError(
            `Route contains ${unverifiedRows.length} unverified row(s) — only mathematically verified routes ` +
            `are serialized to AIXM. Rows: ${details}`
        );
    }

    const tracks = collectVerifiedTracks(geoJsonPayload);

    if (tracks.length === 0) {
        throw new UnserializableRouteError(
            "No computed track geometry found in payload; the procedure has no spatial triggers to serialize."
        );
    }

    const flightDateIso = toIsoString(flightDate);
    const effectiveFromIso = toIsoString(airacCycle.effectiveFrom);
    const effectiveToIso = toIsoString(airacCycle.effectiveTo);

    // --- Serialization. ---
    const routeUuid = crypto.randomUUID();
    const routeId = gmlId("route", routeUuid);
    const airportCode = geoJsonPayload.airportCode ?? geoJsonPayload.source?.airportCode ?? geoJsonPayload.airport?.icao ?? "UNKNOWN";

    const segmentBlocks = tracks.map((track, index) => {
        const segmentId = gmlId("rs", routeUuid, index, track.runway);
        const noteText = [
            track.segmentLabel ? `Leg: ${track.segmentLabel}.` : null,
            `Leg type ${track.legType ?? "UNKNOWN"} for runway ${track.runway}.`,
            `Ground truth AIRAC ${airacCycle.ident}, flight date ${flightDateIso}.`
        ].filter(Boolean).join(" ");

        return [
            "  <aixm:routeSegment>",
            `    <aixm:RouteSegment gml:id="${escapeXml(segmentId)}">`,
            annotationNote("      ", `${segmentId}-note`, "curveExtent", noteText),
            "      <aixm:curveExtent>",
            `        <aixm:Curve gml:id="${escapeXml(segmentId)}-curve" srsName="urn:ogc:def:crs:EPSG::4326">`,
            `          <gml:LineString gml:id="${escapeXml(segmentId)}-ls" srsName="urn:ogc:def:crs:EPSG::4326">`,
            `            <gml:posList>${toGmlPosList(track.coordinates)}</gml:posList>`,
            "          </gml:LineString>",
            "        </aixm:Curve>",
            "      </aixm:curveExtent>",
            "    </aixm:RouteSegment>",
            "  </aixm:routeSegment>"
        ].join("\n");
    });

    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<aixm:Route xmlns:aixm="http://www.aixm.aero/schema/5.1"`,
        `            xmlns:gml="http://www.opengis.net/gml/3.2"`,
        `            gml:id="${escapeXml(routeId)}">`,
        `  <gml:identifier codeSpace="urn:uuid">${routeUuid}</gml:identifier>`,
        "  <aixm:featureLifetime>",
        `    <gml:TimePeriod gml:id="${escapeXml(routeId)}-lifetime">`,
        `      <gml:beginPosition>${effectiveFromIso}</gml:beginPosition>`,
        `      <gml:endPosition>${effectiveToIso}</gml:endPosition>`,
        "    </gml:TimePeriod>",
        "  </aixm:featureLifetime>",
        annotationNote(
            "  ",
            `${routeId}-airac`,
            "featureLifetime",
            `Geometry computed from FAA NASR ground truth, AIRAC cycle ${airacCycle.ident} ` +
            `(effective ${effectiveFromIso} to ${effectiveToIso})${airacCycle.source ? `, source ${airacCycle.source}` : ""}.`
        ),
        annotationNote(
            "  ",
            `${routeId}-flightdate`,
            "featureLifetime",
            `Temporal targeting: route resolved for flight date ${flightDateIso}, which falls within the cycle's effective window.`
        ),
        annotationNote(
            "  ",
            `${routeId}-origin`,
            "designator",
            `Engine-out procedure at ${airportCode}${geoJsonPayload.airline ? `, operator ${geoJsonPayload.airline}` : ""}` +
            `${geoJsonPayload.aircraft ? `, aircraft ${geoJsonPayload.aircraft}` : ""}.`
        ),
        ...segmentBlocks,
        "</aixm:Route>"
    ].join("\n");

    return xml;
}

module.exports = {
    generateAixmRoute,
    UnserializableRouteError
};
