/**
 * EmProView geodetic translation engine — composition root.
 *
 * The engine is location- and aircraft-agnostic. It wires the ground-truth
 * query layer (navDbQuery) into a Strategy Pattern router (SegmentProcessor)
 * whose pluggable solvers perform pure WGS-84 math via GeoMath.
 *
 * To support a new ARINC-style trigger type, create a solver module in
 * backend/geo/solvers exposing { triggerType, solve } and register it below.
 * The router core never changes.
 */
const navDb = require("../utils/navDbQuery");
const { DataIntegrityError } = require("./geo/DataIntegrityError");
const { AiracExpiredError } = require("./geo/AiracExpiredError");
const { GeoMath } = require("./geo/GeoMath");
const { SegmentProcessor } = require("./geo/SegmentProcessor");
const radialDistanceIntersection = require("./geo/solvers/radialDistanceIntersection");

function createSegmentProcessor(dependencies = { navDb }) {
    return new SegmentProcessor(dependencies)
        .registerSolver(radialDistanceIntersection);
}

const segmentProcessor = createSegmentProcessor();

module.exports = {
    DataIntegrityError,
    AiracExpiredError,
    GeoMath,
    SegmentProcessor,
    createSegmentProcessor,
    segmentProcessor
};
