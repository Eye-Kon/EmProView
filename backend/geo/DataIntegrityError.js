class DataIntegrityError extends Error {
    constructor(message) {
        super(message);
        this.name = "DataIntegrityError";
    }
}

module.exports = {
    DataIntegrityError
};
