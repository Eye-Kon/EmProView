/**
 * Smoke test for utils/nasrUpdater.js.
 *
 * Builds a synthetic NASR CSV subscriber zip (2,340 runway-end rows to
 * force multiple 1,000-doc batches, plus dirty rows that must be dropped)
 * and streams it through ingestNasrZip against an in-memory fake Db that
 * records every bulk call. Verifies:
 *   - batching: no insertMany/bulkWrite call exceeds BATCH_SIZE
 *   - data integrity: rows without finite WGS-84 coords are dropped
 *   - sexagesimal fallback parsing produces correct decimal degrees
 *   - duplicate navaid idents merge into one doc with N candidates
 *   - AIRAC tagging from EFF_DATE + meta doc committed last
 *   - idempotency: a second run against the same fake Db is a no-op
 *
 * Usage: node scripts/smoke_nasr_updater.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");
const { ingestNasrZip, sexagesimalToDecimal, BATCH_SIZE } = require("../utils/nasrUpdater");

let failures = 0;

function check(label, condition, detail = "") {
    if (condition) {
        console.log(`  PASS  ${label}`);
    } else {
        failures += 1;
        console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    }
}

/* ---------------- synthetic NASR zip ---------------- */

const EFF_DATE = "2026/06/11"; // AIRAC 2606 boundary within the current window

function buildZip(zipPath) {
    const aptBase = ["EFF_DATE,SITE_NO,ARPT_ID,ICAO_ID,MAG_VARN,MAG_HEMIS"];
    const rwyEnd = ["EFF_DATE,SITE_NO,ARPT_ID,RWY_END_ID,LAT_DECIMAL,LONG_DECIMAL,LAT_DEG,LAT_MIN,LAT_SEC,LAT_HEMIS,LONG_DEG,LONG_MIN,LONG_SEC,LONG_HEMIS,TRUE_ALIGNMENT"];
    const navBase = ["EFF_DATE,NAV_ID,NAV_TYPE,NAME,STATE_CODE,LAT_DECIMAL,LONG_DECIMAL,MAG_VARN,MAG_VARN_HEMIS"];

    // 1,170 synthetic ICAO airports x 2 runway ends = 2,340 clean runway rows.
    for (let i = 0; i < 1170; i += 1) {
        const site = `${10000 + i}.*A`;
        const arpt = `X${String(i).padStart(3, "0")}`;
        const icao = `KZ${String(i).padStart(2, "0")}${String.fromCharCode(65 + (i % 26))}`;
        aptBase.push(`${EFF_DATE},${site},${arpt},${icao},12,E`);

        const lat = (30 + (i % 20) + 0.123).toFixed(6);
        const lon = (-(80 + (i % 40)) - 0.456).toFixed(6);
        rwyEnd.push(`${EFF_DATE},${site},${arpt},18,${lat},${lon},,,,,,,,,184`);
        rwyEnd.push(`${EFF_DATE},${site},${arpt},36,${lat},${lon},,,,,,,,,4`);
    }

    // DMS-columns-only runway end (no LAT_DECIMAL): must parse via DEG/MIN/SEC.
    aptBase.push(`${EFF_DATE},99999.*A,DMS,KDMS,8,W`);
    rwyEnd.push(`${EFF_DATE},99999.*A,DMS,09,,,38,51,7.5,N,104,42,29.1,W,92`);

    // Dirty rows that MUST be dropped, never zero-coerced:
    rwyEnd.push(`${EFF_DATE},10000.*A,X000,27,,,,,,,,,,,270`);           // no coordinates at all
    rwyEnd.push(`${EFF_DATE},10000.*A,X000,09,33.1,-101.2,,,,,,,,,`);    // no true heading
    rwyEnd.push(`${EFF_DATE},55555.*A,NOPE,18,33.1,-101.2,,,,,,,,,180`); // unknown airport (no join)
    aptBase.push(`${EFF_DATE},88888.*A,NOMV,KNMV,,`);                    // airport without mag var
    rwyEnd.push(`${EFF_DATE},88888.*A,NOMV,18,33.1,-101.2,,,,,,,,,180`); // -> dropped

    // Navaids: 3 clean, one duplicated ident, 2 dirty (dropped).
    navBase.push(`${EFF_DATE},ICT,VORTAC,WICHITA,KS,37.746,-97.583,5,E`);
    navBase.push(`${EFF_DATE},TCH,VOR/DME,TACHE,CO,39.012,-104.85,8,E`);
    navBase.push(`${EFF_DATE},TCH,NDB,TEACH,ME,44.5,-68.9,17,W`);   // duplicate ident -> 2nd candidate
    navBase.push(`${EFF_DATE},BAD,NDB,NOCOORD,TX,,-97.0,4,E`);      // missing latitude -> dropped
    navBase.push(`${EFF_DATE},DME1,DME,NOMAGVAR,CA,36.1,-115.2,,`); // DME without mag var -> dropped

    const zip = new AdmZip();
    // Nested folder on purpose: entry matching must use basenames.
    zip.addFile("CSV_Data/APT_BASE.csv", Buffer.from(aptBase.join("\r\n"), "utf8"));
    zip.addFile("CSV_Data/APT_RWY_END.csv", Buffer.from(rwyEnd.join("\r\n"), "utf8"));
    zip.addFile("CSV_Data/NAV_BASE.csv", Buffer.from(navBase.join("\r\n"), "utf8"));
    zip.writeZip(zipPath);
}

/* ---------------- in-memory fake Mongo Db ---------------- */

function matches(doc, filter) {
    return Object.entries(filter).every(([key, value]) => {
        if (key === "$exists") {
            return true;
        }
        if (value && typeof value === "object" && "$exists" in value) {
            return (key in doc) === value.$exists;
        }
        return doc[key] === value;
    });
}

function makeFakeDb() {
    const docs = [];
    const calls = { insertMany: [], bulkWrite: [], insertOne: [] };
    let autoId = 0;

    const collection = {
        async findOne(filter) {
            return docs.find((doc) => matches(doc, filter)) ?? null;
        },
        async countDocuments(filter) {
            return docs.filter((doc) => matches(doc, filter)).length;
        },
        async deleteMany(filter) {
            let deletedCount = 0;
            for (let i = docs.length - 1; i >= 0; i -= 1) {
                if (matches(docs[i], filter)) {
                    docs.splice(i, 1);
                    deletedCount += 1;
                }
            }
            return { deletedCount };
        },
        async insertMany(batch) {
            calls.insertMany.push(batch.length);
            for (const doc of batch) {
                docs.push({ _id: doc._id ?? `auto_${autoId++}`, ...doc });
            }
            return { insertedCount: batch.length };
        },
        async insertOne(doc) {
            calls.insertOne.push(doc);
            docs.push({ _id: doc._id ?? `auto_${autoId++}`, ...doc });
            return { insertedId: doc._id };
        },
        async bulkWrite(operations) {
            calls.bulkWrite.push(operations.length);
            for (const op of operations) {
                const { filter, update, upsert } = op.updateOne;
                let target = docs.find((doc) => matches(doc, filter));
                if (!target && upsert) {
                    target = { _id: `auto_${autoId++}`, ...(update.$setOnInsert ?? {}) };
                    docs.push(target);
                }
                if (target && update.$push) {
                    for (const [field, value] of Object.entries(update.$push)) {
                        (target[field] = target[field] ?? []).push(value);
                    }
                }
            }
            return {};
        },
        async createIndex() {
            return "ok";
        }
    };

    return { db: { collection: () => collection }, docs, calls };
}

/* ---------------- run ---------------- */

async function main() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nasr-smoke-"));
    const zipPath = path.join(workDir, "nasr.zip");
    buildZip(zipPath);

    const { db, docs, calls } = makeFakeDb();

    console.log("Unit: sexagesimal conversion");
    check("formatted DMS south/west sign", sexagesimalToDecimal("104-42-29.1000W") < -104.7);
    check("formatted DMS value", Math.abs(sexagesimalToDecimal("38-51-07.5000N") - 38.852083) < 1e-6);
    check("total-seconds encoding", Math.abs(sexagesimalToDecimal("139867.5000N") - 38.852083) < 1e-6);
    check("garbage returns null", sexagesimalToDecimal("N/A") === null && sexagesimalToDecimal("") === null);

    console.log("Ingest: synthetic zip through fake Db");
    const { airacCycle, stats } = await ingestNasrZip(db, zipPath);

    const meta = docs.find((doc) => doc.docType === "meta");
    const runways = docs.filter((doc) => doc.docType === "runway");
    const navaids = docs.filter((doc) => doc.docType === "navaid");

    check("AIRAC cycle derived from EFF_DATE", airacCycle === "2606" && meta?.airacCycle === "2606",
        `got ${airacCycle} / meta ${meta?.airacCycle}`);
    check("meta doc committed last", calls.insertOne.length === 1 && calls.insertOne[0]._id === `airac_${airacCycle}`);

    check("runway count: 2340 clean + 1 DMS row", runways.length === 2341, `got ${runways.length}`);
    check("dirty runway rows dropped (4)", stats.runwaysDropped === 4, `got ${stats.runwaysDropped}`);
    check("insertMany batches never exceed BATCH_SIZE",
        calls.insertMany.length >= 3 && calls.insertMany.every((size) => size <= BATCH_SIZE),
        `sizes: ${calls.insertMany.join(",")}`);

    const dms = runways.find((doc) => doc.key === "KDMS_09");
    check("DMS-columns fallback parsed", dms &&
        Math.abs(dms.latitude - 38.852083) < 1e-5 && Math.abs(dms.longitude + 104.708083) < 1e-5 &&
        dms.trueHeading === 92 && dms.magneticVariation === -8,
        JSON.stringify(dms ?? null));

    const zeroCoerced = runways.some((doc) => doc.latitude === 0 || doc.longitude === 0 || doc.trueHeading === null);
    check("no zero-coerced physical data", !zeroCoerced);

    check("navaid idents: 2 docs (ICT, TCH; dirty rows gone)", navaids.length === 2, `got ${navaids.length}`);
    const tch = navaids.find((doc) => doc.identifier === "TCH");
    check("duplicate ident merged into candidates[2]", tch?.candidates?.length === 2,
        `got ${tch?.candidates?.length}`);
    check("west variation signed negative", tch?.candidates?.some((c) => c.magneticVariation === -17));
    check("dirty navaid rows dropped (2)", stats.navaidsDropped === 2, `got ${stats.navaidsDropped}`);

    console.log("Idempotency: second run must be a no-op");
    const before = docs.length;
    const secondRun = await ingestNasrZip(db, zipPath);
    check("second run skipped (cycle already committed)", secondRun.airacCycle === airacCycle && docs.length === before);

    fs.rmSync(workDir, { recursive: true, force: true });

    if (failures > 0) {
        console.error(`\n${failures} check(s) FAILED`);
        process.exit(1);
    }
    console.log("\nAll checks passed.");
}

main().catch((error) => {
    console.error(`Smoke test crashed: ${error.stack}`);
    process.exit(1);
});
