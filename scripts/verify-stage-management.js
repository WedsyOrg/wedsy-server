/**
 * Verify the Stage 3a management endpoints at the SERVICE layer (LOCAL DEV ONLY).
 * Exercises createStage / updateStage (rename) / deleteStage (with reassign), plus the
 * system-stage and missing-moveTo guards. Restores any test data on exit so the DB is
 * left as it was. Aborts if DATABASE_URL is not localhost.
 *
 * Run: node scripts/verify-stage-management.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Stage = require("../models/Stage");
const Enquiry = require("../models/Enquiry");
const StageService = require("../services/StageService");
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
const expectThrow = async (label, status, fn) => {
  try {
    await fn();
    check(`${label} (expected ${status})`, false);
  } catch (e) {
    check(`${label} -> ${e.status || "?"} ${e.message}`, e.status === status);
  }
};

(async () => {
  let createdStageId = null;
  let restoreLead = null;
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}\n`);

    // ---------- Step 1: create "Site Visit" ----------
    console.log("=== Step 1: createStage('Site Visit') ===");
    const beforeMax = await StageRepository.maxOrder();
    const created = await StageService.createStage({ name: "Site Visit" });
    createdStageId = created._id;
    check("created stage has slug 'site_visit'", created.slug === "site_visit");
    check("created stage name is 'Site Visit'", created.name === "Site Visit");
    check(
      `created order > previous max (${created.order} > ${beforeMax})`,
      created.order > beforeMax
    );
    check("category defaults to 'open'", created.category === "open");

    // ---------- Step 2: duplicate create -> 409 ----------
    console.log("\n=== Step 2: duplicate createStage rejected ===");
    await expectThrow("duplicate 'Site Visit' rejected", 409, () =>
      StageService.createStage({ name: "Site Visit" })
    );

    // ---------- Step 3: rename without changing slug ----------
    console.log("\n=== Step 3: rename to 'Site Visit Done' ===");
    const renamed = await StageService.updateStage(String(createdStageId), {
      name: "Site Visit Done",
    });
    check("renamed name = 'Site Visit Done'", renamed.name === "Site Visit Done");
    check("slug unchanged after rename ('site_visit')", renamed.slug === "site_visit");

    // ---------- Step 4: delete with reassign (move leads to 'new') ----------
    console.log("\n=== Step 4: deleteStage with moveTo='new' (reassigns leads) ===");
    const testLead = await Enquiry.findOne({}).lean();
    if (!testLead) {
      console.warn("SKIP Step 4 lead-related checks — no enquiries in local DB.");
    } else {
      restoreLead = { id: testLead._id, stage: testLead.stage };
      await Enquiry.updateOne(
        { _id: testLead._id },
        { $set: { stage: "site_visit" } }
      );

      const result = await StageService.deleteStage(
        String(createdStageId),
        "new"
      );
      check(
        `deleteStage returned movedLeads >= 1 (got ${result.movedLeads})`,
        result.movedLeads >= 1
      );
      check("deleteStage returned movedTo 'new'", result.movedTo === "new");

      const afterLead = await Enquiry.findById(testLead._id).lean();
      check(
        `test lead's stage is now 'new' (was 'site_visit')`,
        afterLead.stage === "new"
      );

      const stillThere = await StageRepository.findBySlug("site_visit");
      check("stage no longer visible via findBySlug (soft-deleted)", !stillThere);

      const raw = await Stage.findById(createdStageId).lean();
      check(
        "soft-delete stamped deletedAt on the stage doc",
        raw && raw.deletedAt instanceof Date
      );
      // After soft-delete the doc is no longer fetchable via the active repo —
      // mark createdStageId as already gone so cleanup uses a hard deleteOne by slug.
    }

    // ---------- Step 5: can't delete a system stage ----------
    console.log("\n=== Step 5: deleteStage on 'new' (system) rejected ===");
    const newStage = await Stage.findOne({ slug: "new" }).lean();
    if (!newStage) {
      console.warn("SKIP — 'new' system stage missing (run seed-stages.js).");
    } else {
      await expectThrow("system stage delete rejected", 400, () =>
        StageService.deleteStage(String(newStage._id), "contacted")
      );
    }

    // ---------- Step 6: deleteStage without moveTo -> 400 ----------
    console.log("\n=== Step 6: deleteStage without moveTo ===");
    // Need a non-system, still-active stage to target this against. Create+attempt+cleanup.
    const tmp = await StageService.createStage({ name: "Tmp Delete Target" });
    await expectThrow("missing moveTo rejected", 400, () =>
      StageService.deleteStage(String(tmp._id), "")
    );
    await expectThrow("undefined moveTo rejected", 400, () =>
      StageService.deleteStage(String(tmp._id), undefined)
    );
    // hard-clean the tmp stage
    await Stage.deleteOne({ _id: tmp._id });

    console.log(`\nResult: ${pass} passed, ${fail} failed.`);
    if (fail > 0) process.exitCode = 1;
  } catch (error) {
    console.error("Verification error:", error);
    process.exitCode = 1;
  } finally {
    // ---------- Cleanup ----------
    if (createdStageId) {
      // hard-remove the test stage (soft-deleted or otherwise) so subsequent runs are clean
      await Stage.deleteOne({ _id: createdStageId }).catch(() => {});
      // also defensively remove any leftover by slug in case create/delete state is mixed
      await Stage.deleteOne({ slug: "site_visit", isSystem: { $ne: true } }).catch(
        () => {}
      );
    }
    if (restoreLead) {
      await Enquiry.updateOne(
        { _id: restoreLead.id },
        { $set: { stage: restoreLead.stage } }
      ).catch(() => {});
      console.log(`Restored lead ${restoreLead.id} stage="${restoreLead.stage}".`);
    }
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
