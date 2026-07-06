/**
 * AIRAC (Aeronautical Information Regulation And Control) cycle math.
 *
 * Cycles are exactly 28 days, anchored to the published ICAO calendar.
 * The epoch below is AIRAC cycle 2001, effective 2020-01-02 00:00 UTC.
 * Cycle identifiers are YYNN (two-digit year + ordinal within that year).
 */
const AIRAC_EPOCH_UTC_MS = Date.UTC(2020, 0, 2);
const CYCLE_LENGTH_MS = 28 * 24 * 60 * 60 * 1000;

function getCycleForDate(date = new Date()) {
    const timestamp = date.getTime();

    if (!Number.isFinite(timestamp) || timestamp < AIRAC_EPOCH_UTC_MS) {
        throw new Error(`Cannot resolve AIRAC cycle for date: ${date}`);
    }

    const cyclesSinceEpoch = Math.floor((timestamp - AIRAC_EPOCH_UTC_MS) / CYCLE_LENGTH_MS);
    const effectiveFromMs = AIRAC_EPOCH_UTC_MS + cyclesSinceEpoch * CYCLE_LENGTH_MS;
    const effectiveToMs = effectiveFromMs + CYCLE_LENGTH_MS;
    const effectiveFrom = new Date(effectiveFromMs);
    const year = effectiveFrom.getUTCFullYear();

    // Ordinal = how many cycle starts fall in the same UTC year, up to this one.
    // Scan backward from the current cycle until the year changes.
    let ordinal = 1;
    for (let ms = effectiveFromMs - CYCLE_LENGTH_MS; ms >= AIRAC_EPOCH_UTC_MS; ms -= CYCLE_LENGTH_MS) {
        if (new Date(ms).getUTCFullYear() !== year) {
            break;
        }
        ordinal += 1;
    }

    return {
        ident: `${String(year % 100).padStart(2, "0")}${String(ordinal).padStart(2, "0")}`,
        effectiveFrom: effectiveFrom.toISOString(),
        effectiveTo: new Date(effectiveToMs).toISOString()
    };
}

function isCycleCurrent(cycle, date = new Date()) {
    const now = date.getTime();
    const from = Date.parse(cycle?.effectiveFrom);
    const to = Date.parse(cycle?.effectiveTo);

    return Number.isFinite(from) && Number.isFinite(to) && now >= from && now < to;
}

module.exports = {
    getCycleForDate,
    isCycleCurrent,
    CYCLE_LENGTH_MS
};
