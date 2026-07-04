/**
 * scripts/e2e-activity-immutable.js — DB-level proof that the D10 activity
 * spine is append-only: every mutating model op must throw. LOCAL Mongo only.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const VenueActivity = require("../models/VenueActivity");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`✓ PASS  ${name}`); }
  else { fail++; console.log(`✗ FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
async function refuses(name, fn) {
  try {
    await fn();
    ok(name, false, "operation succeeded");
  } catch (e) {
    ok(name, /append-only/.test(e.message), e.message);
  }
}

async function run() {
  const host = new URL(process.env.DATABASE_URL || "").hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`Refusing: non-local Mongo host "${host}"`);
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });

  const row = await VenueActivity.create({
    venue: new mongoose.Types.ObjectId(),
    actorType: "system",
    actorName: "immutability-test",
    action: "test_row",
  });
  ok("append (create) works", Boolean(row._id));

  await refuses("updateOne refused", () => VenueActivity.updateOne({ _id: row._id }, { $set: { action: "tampered" } }));
  await refuses("updateMany refused", () => VenueActivity.updateMany({}, { $set: { severity: "low" } }));
  await refuses("findOneAndUpdate refused", () => VenueActivity.findOneAndUpdate({ _id: row._id }, { action: "tampered" }));
  await refuses("deleteOne refused", () => VenueActivity.deleteOne({ _id: row._id }));
  await refuses("deleteMany refused", () => VenueActivity.deleteMany({ action: "test_row" }));
  await refuses("re-save refused", async () => {
    const doc = await VenueActivity.findById(row._id);
    doc.action = "tampered";
    await doc.save();
  });

  const intact = await VenueActivity.findById(row._id).lean();
  ok("row intact after every attempt", intact && intact.action === "test_row", intact && intact.action);

  console.log(`\n[e2e-activity-immutable] ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => { console.error(`[e2e-activity-immutable] FAILED: ${err.message}`); process.exit(1); });
