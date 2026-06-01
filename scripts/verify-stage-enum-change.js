/**
 * Verify the Stage 2 dynamic-stages change end-to-end (LOCAL DEV ONLY).
 * Proves the Enquiry.stage enum is gone AND the service now validates against the Stage collection.
 * Picks a real enquiry, exercises updateStage with valid + invalid slugs, restores the original stage.
 * Aborts if DATABASE_URL is not localhost. Run: node scripts/verify-stage-enum-change.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const EnquiryService = require("../services/EnquiryService");
const StageRepository = require("../repositories/StageRepository");

const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.startsWith("mongodb://localhost")) {
  console.error("ABORT: DATABASE_URL is not localhost.");
  console.error(`DATABASE_URL = ${dbUrl || "(empty)"}`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  cond ? pass++ : fail++;
};

(async () => {
  let restore = null;
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}\n`);

    // ---------- Pick a test enquiry ----------
    const target = await Enquiry.findOne({}).lean();
    if (!target) {
      console.error("ABORT: no enquiries in local DB to test against.");
      process.exitCode = 1;
      return;
    }
    restore = { id: target._id, stage: target.stage };
    console.log(
      `Test enquiry: ${target._id} (name=${target.name}, current stage="${target.stage}")\n`
    );

    // ---------- Test A: valid slug succeeds ----------
    console.log("=== Test A: valid slug 'contacted' ===");
    try {
      const updated = await EnquiryService.updateStage(
        String(target._id),
        "contacted",
        null
      );
      check(
        "updateStage('contacted') returned an enquiry",
        !!(updated && updated._id)
      );
      check(
        "enquiry.stage === 'contacted' after valid update",
        updated.stage === "contacted"
      );
    } catch (e) {
      check(`Test A unexpectedly threw: ${e.status} ${e.message}`, false);
    }

    // ---------- Test B: invalid slug rejected with 400 ----------
    console.log("\n=== Test B: invalid slug 'not_a_real_stage' ===");
    try {
      await EnquiryService.updateStage(
        String(target._id),
        "not_a_real_stage",
        null
      );
      check("invalid slug should have thrown (it didn't)", false);
    } catch (e) {
      check(
        `invalid slug threw with status ${e.status} (${e.message})`,
        e.status === 400
      );
    }

    // ---------- Test C: a seeded slug resolves via the repo ----------
    console.log("\n=== Test C: StageRepository.findBySlug('meeting_scheduled') ===");
    const seeded = await StageRepository.findBySlug("meeting_scheduled");
    check(
      `findBySlug('meeting_scheduled') returned a stage doc (name=${seeded?.name})`,
      !!(seeded && seeded.slug === "meeting_scheduled")
    );

    // ---------- Bonus: confirm the enquiry doc reflects Test A's write ----------
    const afterA = await Enquiry.findById(target._id).lean();
    check(
      "post-Test-A read confirms stage persisted as 'contacted'",
      afterA && afterA.stage === "contacted"
    );

    console.log(`\nResult: ${pass} passed, ${fail} failed.`);
    if (fail > 0) process.exitCode = 1;
  } catch (error) {
    console.error("Verification error:", error);
    process.exitCode = 1;
  } finally {
    if (restore) {
      await Enquiry.updateOne(
        { _id: restore.id },
        { $set: { stage: restore.stage } }
      );
      console.log(`\nRestored enquiry ${restore.id} to stage="${restore.stage}".`);
    }
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
