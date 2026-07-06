const navDatabase = require("../data/navDatabase.json");

function getNavaid(identifier) {
    const navaid = navDatabase.navaids[identifier];
    if (!navaid) {
        throw new Error(`Navaid not found: ${identifier}`);
    }
    return navaid;
}

function getRunway(identifier) {
    const runway = navDatabase.runways[identifier];
    if (!runway) {
        throw new Error(`Runway not found: ${identifier}`);
    }
    return runway;
}

module.exports = {
    getNavaid,
    getRunway
};
