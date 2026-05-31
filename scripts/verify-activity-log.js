/**
 * Verify ActivityLog wiring through StageService (LOCAL DEV ONLY).
 * Exercises createStage / updateStage (rename) / deleteStage and asserts each writes
 * the expected ActivityLog entry. Self-cleans: hard-deletes the temp stage and any
 * ActivityLog rows it created. Aborts if DATABASE_URL is not localhost.
 *
 * Run: node scripts/verify-activity-log.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Stage = require("../models/Stage");
const ActivityLog = require("../models/ActivityLog");
const StageService = require("../services/StageService");
const ActivityLogService = require("../services/ActivityLogService");

const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.startsWith("mongodb://localhost")) {
  console.error("ABORT: DATABASE_URL is not localhost.");
  console.error(`DATABASE_URL = ${dbUrl || "(empty)"}`);
  process.exit(1);
}

const TEST_NAME = "Temp Log Test";
const TEST_SLUG = "temp_log_test";
const FAKE_ACTOR = new mongoose.Types.ObjectId();

let pass = 0;
let fail = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  cond ? pass++ : fail++;
};

(async () => {
  let createdStageId = null;
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}\n`);

    // ---------- Step 1: createStage logs "stage.created" ----------
    console.log(`=== Step 1: createStage('${TEST_NAME}') ===`);
    const created = await StageService.createStage(
      { name: TEST_NAME },
      FAKE_ACTOR
    );
    createdStageId = created._id;
    check(`stage created with slug='${TEST_SLUG}'`, created.slug === TEST_SLUG);

    const r1 = await ActivityLogService.getRecent({
      entityType: "stage",
      limit: 5,
    });
    const createdLog = r1.items.find(
      (i) => i.action === "stage.created" && i.entityId === TEST_SLUG
    );
    check("activity log contains 'stage.created' for this stage", !!createdLog);
    check(
      `created log has non-empty summary ('${createdLog?.summary}')`,
      !!(createdLog && createdLog.summary && createdLog.summary.length > 0)
    );
    check(
      "created log has createdAt timestamp",
      !!(createdLog && createdLog.createdAt instanceof Date)
    );
    // The populate(actorId) above returns null for our synthetic id (no matching Admin
    // doc), so check the raw stored value instead — that's the contract we care about.
    const rawCreatedLog = await ActivityLog.findOne({
      action: "stage.created",
      entityId: TEST_SLUG,
    }).lean();
    check(
      "raw created log actorId matches the actorId we passed in",
      !!(rawCreatedLog && String(rawCreatedLog.actorId) === String(FAKE_ACTOR))
    );

    // ---------- Step 2: updateStage (rename) logs "stage.renamed" ----------
    console.log(`\n=== Step 2: rename to '${TEST_NAME} Done' ===`);
    const renamed = await StageService.updateStage(
      String(createdStageId),
      { name: `${TEST_NAME} Done` },
      FAKE_ACTOR
    );
    check(
      "name changed but slug unchanged",
      renamed.name === `${TEST_NAME} Done` && renamed.slug === TEST_SLUG
    );

    const r2 = await ActivityLogService.getRecent({
      entityType: "stage",
      limit: 5,
    });
    const renamedLog = r2.items.find(
      (i) => i.action === "stage.renamed" && i.entityId === TEST_SLUG
    );
    check("activity log contains 'stage.renamed'", !!renamedLog);
    check(
      `renamed log has non-empty summary ('${renamedLog?.summary}')`,
      !!(renamedLog && renamedLog.summary && renamedLog.summary.length > 0)
    );

    // ---------- Step 3: deleteStage logs "stage.deleted" with movedTo ----------
    console.log("\n=== Step 3: deleteStage with moveTo='new' ===");
    const delResult = await StageService.deleteStage(
      String(createdStageId),
      "new",
      FAKE_ACTOR
    );
    check(
      `delete returned movedTo='new' (movedLeads=${delResult.movedLeads})`,
      delResult.movedTo === "new"
    );

    const r3 = await ActivityLogService.getRecent({
      entityType: "stage",
      limit: 5,
    });
    const deletedLog = r3.items.find(
      (i) => i.action === "stage.deleted" && i.entityId === TEST_SLUG
    );
    check("activity log contains 'stage.deleted'", !!deletedLog);
    check(
      "deleted log meta.movedTo === 'new'",
      deletedLog?.meta?.movedTo === "new"
    );
    check(
      `deleted log has non-empty summary ('${deletedLog?.summary}')`,
      !!(deletedLog && deletedLog.summary && deletedLog.summary.length > 0)
    );

    console.log(`\nResult: ${pass} passed, ${fail} failed.`);
    if (fail > 0) process.exitCode = 1;
  } catch (error) {
    console.error("Verification error:", error);
    process.exitCode = 1;
  } finally {
    // ---------- Cleanup ----------
    // Hard-delete the temp stage doc (whether soft-deleted or still active).
    await Stage.deleteOne({ slug: TEST_SLUG }).catch(() => {});
    if (createdStageId) {
      await Stage.deleteOne({ _id: createdStageId }).catch(() => {});
    }
    // Hard-delete the activity rows tied to this test slug.
    const purge = await ActivityLog.deleteMany({
      entityType: "stage",
      entityId: TEST_SLUG,
    }).catch(() => ({ deletedCount: 0 }));
    console.log(
      `Cleanup: removed ${purge.deletedCount || 0} activity rows for entityId='${TEST_SLUG}'.`
    );
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
