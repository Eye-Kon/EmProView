const { DataIntegrityError } = require("./DataIntegrityError");

/**
 * Thrown when the ground-truth database's AIRAC cycle does not cover the
 * current UTC time. Subclasses DataIntegrityError so the engine's existing
 * fail-fast machinery severs the path calculation identically — stale
 * ground truth is corrupt ground truth.
 */
class AiracExpiredError extends DataIntegrityError {
    constructor(message) {
        super(message);
        this.name = "AiracExpiredError";
    }
}

module.exports = {
    AiracExpiredError
};
