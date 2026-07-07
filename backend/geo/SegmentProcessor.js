/**
 * SegmentProcessor: dynamic Strategy Pattern router for spatial triggers.
 *
 * The processor holds a registry of pluggable solver strategies keyed by
 * triggerType (ARINC 424 path-and-terminator inspired). It knows nothing
 * about airports, runways, aircraft, or the math itself — it only validates
 * the envelope, resolves the strategy, and delegates. New trigger types are
 * added by registering a solver module; the router core never changes.
 */
const { DataIntegrityError } = require("./DataIntegrityError");
const { requireField, requireNonEmptyString } = require("./validation");

class SegmentProcessor {
    /**
     * @param {object} dependencies
     * @param {object} dependencies.navDb - ground-truth query layer (navDbQuery)
     *   exposing async getRunway(airportCode, runwayId) and getNavaid(identifier).
     */
    constructor({ navDb } = {}) {
        this.navDb = requireField(navDb, "SegmentProcessor dependency: navDb");
        this.solverRegistry = new Map();
    }

    /**
     * Registers a pluggable solver strategy for a triggerType.
     * A solver module must expose { triggerType: string, solve: function }.
     */
    registerSolver(solverModule) {
        const triggerType = requireNonEmptyString(
            solverModule?.triggerType,
            "solverModule.triggerType"
        );

        if (typeof solverModule.solve !== "function") {
            throw new DataIntegrityError(
                `Solver for ${triggerType} must expose a solve(segment, row, context) function.`
            );
        }

        if (this.solverRegistry.has(triggerType)) {
            throw new DataIntegrityError(`Duplicate solver registration for trigger type: ${triggerType}`);
        }

        this.solverRegistry.set(triggerType, solverModule.solve);

        return this;
    }

    getRegisteredTriggerTypes() {
        return [...this.solverRegistry.keys()];
    }

    /**
     * Routes a segment to its registered solver.
     *
     * Solvers are async (ground truth is resolved from MongoDB), so this
     * returns a Promise (or null when the segment carries no spatial trigger
     * — nothing to compute). Rejects with DataIntegrityError for any
     * malformed or unsupported payload so the path calculation terminates
     * immediately.
     */
    process(segment, row, context) {
        if (!segment?.spatialTrigger) {
            return null;
        }

        const triggerType = requireNonEmptyString(
            segment.spatialTrigger.triggerType,
            "segment.spatialTrigger.triggerType"
        );
        const solve = this.solverRegistry.get(triggerType);

        if (!solve) {
            throw new DataIntegrityError(
                `Unsupported spatial trigger type: ${triggerType}. Registered types: ${
                    this.getRegisteredTriggerTypes().join(", ") || "none"
                }`
            );
        }

        return solve(segment, row, { ...context, navDb: this.navDb });
    }
}

module.exports = {
    SegmentProcessor
};
