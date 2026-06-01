/**
 * Verify the Stage 3a disqualify + approval flow at the SERVICE layer (LOCAL DEV ONLY).
 * Exercises requestDisqualification / decideDisqualification (approve + reject), the
 * approver-eligibility gate (via the canApprove flag), and the updateStage interception
 * that turns a move into a "lost"-category stage into a disqualification REQUEST.
 *
 * Creates its own throwaway test leads (does NOT mutate real leads) and deletes them on
 * exit. Aborts if DATABASE_URL is not localhost.
 *
 * Run: node scripts/verify-disqualify.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Stage = require("../models/Stage");
const ActivityLog = require("../models/ActivityLog");
const EnquiryService = require("../services/EnquiryService");

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
    check(`${label} (expected ${status} throw)`, false);
  } catch (e) {
    check(`${label} -> ${e.status || "?"} ${e.message}`, e.status === status);
  }
};

const PHONE_1 = "9990000001";
const PHONE_2 = "9990000002";
const PHONE_3 = "9990000003";

const reopenedLogCount = async (entityId) =>
  ActivityLog.countDocuments({
    entityType: "lead",
    action: "lead.reopened",
    entityId: String(entityId),
  });
const latestReopenedLog = async (entityId) =>
  ActivityLog.findOne({
    entityType: "lead",
    action: "lead.reopened",
    entityId: String(entityId),
  })
    .sort({ createdAt: -1 })
    .lean();

const mkLead = async (phone, name, assignedTo) =>
  Enquiry.create({
    name,
    phone,
    verified: true,
    isInterested: false,
    isLost: false,
    source: "VerifyScript",
    stage: "contacted",
    assignedTo,
  });

(async () => {
  let lead1Id = null;
  let lead2Id = null;
  let lead3Id = null;
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}\n`);

    // ---------- Step 1: ensure "lost" stage exists (idempotent upsert) ----------
    console.log("=== Step 1: ensure 'lost' stage ===");
    await Stage.updateOne(
      { slug: "lost" },
      {
        $set: {
          name: "Lost",
          slug: "lost",
          order: 99,
          color: "#8B0000",
          category: "lost",
          isSystem: true,
          deletedAt: null,
        },
      },
      { upsert: true }
    );
    const lostStage = await Stage.findOne({ slug: "lost", deletedAt: null }).lean();
    check("'lost' stage exists with category 'lost'", !!lostStage && lostStage.category === "lost");

    // ---------- Step 2: create test leads ----------
    console.log("\n=== Step 2: create test leads (stage='contacted') ===");
    const anAdmin = await Admin.findOne({}).lean();
    const adminId = anAdmin ? anAdmin._id : new mongoose.Types.ObjectId();
    const mgrId = new mongoose.Types.ObjectId(); // a stand-in approver id
    // clean any leftovers from a previous run first
    await Enquiry.deleteMany({ phone: { $in: [PHONE_1, PHONE_2, PHONE_3] } });
    const lead1 = await mkLead(PHONE_1, "Verify Lead One", adminId);
    const lead2 = await mkLead(PHONE_2, "Verify Lead Two", adminId);
    lead1Id = lead1._id;
    lead2Id = lead2._id;
    check("lead1 created (stage='contacted')", lead1.stage === "contacted");
    check("lead2 created (stage='contacted')", lead2.stage === "contacted");

    // ---------- Step 3: request disqualification ----------
    console.log("\n=== Step 3: requestDisqualification(reason='budget') ===");
    let r = await EnquiryService.requestDisqualification(
      String(lead1Id),
      { reason: "budget", note: "test" },
      adminId
    );
    check("lostStatus='pending'", r.lostStatus === "pending");
    check("stageBeforeLost='contacted'", r.stageBeforeLost === "contacted");
    check("lostReason='budget'", r.lostReason === "budget");
    check("lostNote='test'", r.lostNote === "test");
    check("stage unchanged (still 'contacted')", r.stage === "contacted");

    // ---------- Step 4: re-request while pending -> 400 ----------
    console.log("\n=== Step 4: re-request while pending rejected ===");
    await expectThrow("re-request rejected", 400, () =>
      EnquiryService.requestDisqualification(String(lead1Id), { reason: "budget" }, adminId)
    );

    // ---------- Step 5: reject -> restores stage ----------
    console.log("\n=== Step 5: decide reject (canApprove=true) ===");
    r = await EnquiryService.decideDisqualification(
      String(lead1Id),
      { decision: "reject", note: "keep it" },
      mgrId,
      true
    );
    check("lostStatus='rejected'", r.lostStatus === "rejected");
    check("stage restored to 'contacted'", r.stage === "contacted");
    check("isLost still false", r.isLost === false);

    // ---------- Step 6: request again (allowed after rejection) ----------
    console.log("\n=== Step 6: request again after rejection ===");
    r = await EnquiryService.requestDisqualification(
      String(lead1Id),
      { reason: "competitor", note: "second try" },
      adminId
    );
    check("lostStatus='pending' again", r.lostStatus === "pending");
    check("stageBeforeLost='contacted'", r.stageBeforeLost === "contacted");

    // ---------- Step 7: decide with canApprove=false -> 403 ----------
    console.log("\n=== Step 7: decide approve with canApprove=false rejected ===");
    await expectThrow("ineligible approver rejected", 403, () =>
      EnquiryService.decideDisqualification(
        String(lead1Id),
        { decision: "approve" },
        mgrId,
        false
      )
    );

    // ---------- Step 8: approve -> lost ----------
    console.log("\n=== Step 8: decide approve (canApprove=true) ===");
    r = await EnquiryService.decideDisqualification(
      String(lead1Id),
      { decision: "approve", note: "agreed" },
      mgrId,
      true
    );
    check("lostStatus='approved'", r.lostStatus === "approved");
    check("stage='lost'", r.stage === "lost");
    check("isLost=true", r.isLost === true);

    // ---------- Step 9: updateStage interception (move to 'lost' -> request) ----------
    console.log("\n=== Step 9: updateStage(lead2,'lost') intercepted into a request ===");
    r = await EnquiryService.updateStage(String(lead2Id), "lost", adminId);
    check("interception -> lostStatus='pending'", r.lostStatus === "pending");
    check("interception did NOT set stage='lost'", r.stage !== "lost");
    check("interception kept stage='contacted'", r.stage === "contacted");
    check("interception captured stageBeforeLost='contacted'", r.stageBeforeLost === "contacted");

    // ---------- Step 10: REOPEN from approved (approved-lost -> open stage) ----------
    console.log("\n=== Step 10: updateStage(lead1,'contacted') reopens an approved-lost lead ===");
    // lead1 is approved/lost from Step 8.
    r = await EnquiryService.updateStage(String(lead1Id), "contacted", adminId);
    check("reopen -> stage='contacted'", r.stage === "contacted");
    check("reopen -> lostStatus='none'", r.lostStatus === "none");
    check("reopen -> isLost=false", r.isLost === false);
    check("reopen -> stageBeforeLost cleared ('')", r.stageBeforeLost === "");
    check("reopen KEEPS historical lostReason ('competitor')", r.lostReason === "competitor");
    check("reopen KEEPS historical lostDecidedBy", !!r.lostDecidedBy);
    const reopenLog1 = await latestReopenedLog(lead1Id);
    check("reopen logged 'lead.reopened' for lead1", !!reopenLog1);
    check(
      "reopen log meta.fromLostStatus='approved'",
      !!reopenLog1 && reopenLog1.meta && reopenLog1.meta.fromLostStatus === "approved"
    );
    check(
      "reopen log meta.toStage='contacted'",
      !!reopenLog1 && reopenLog1.meta && reopenLog1.meta.toStage === "contacted"
    );

    // ---------- Step 11: REOPEN from pending (pending request cancelled by move-out) ----------
    console.log("\n=== Step 11: updateStage(lead2,'new') reopens a pending lead ===");
    // lead2 is pending from the Step 9 interception.
    r = await EnquiryService.updateStage(String(lead2Id), "new", adminId);
    check("pending reopen -> stage='new'", r.stage === "new");
    check("pending reopen -> lostStatus='none'", r.lostStatus === "none");
    check("pending reopen -> isLost=false", r.isLost === false);
    check("pending reopen -> stageBeforeLost cleared ('')", r.stageBeforeLost === "");
    const reopenLog2 = await latestReopenedLog(lead2Id);
    check("pending reopen logged 'lead.reopened' for lead2", !!reopenLog2);
    check(
      "pending reopen log meta.fromLostStatus='pending'",
      !!reopenLog2 && reopenLog2.meta && reopenLog2.meta.fromLostStatus === "pending"
    );

    // ---------- Step 12: SANITY — normal move on a never-lost lead (no reopen, no lost writes) ----------
    console.log("\n=== Step 12: normal updateStage on a never-lost lead is unaffected ===");
    const lead3 = await mkLead(PHONE_3, "Verify Lead Three", adminId);
    lead3Id = lead3._id;
    const reopenedBefore = await reopenedLogCount(lead3Id);
    r = await EnquiryService.updateStage(String(lead3Id), "meeting_scheduled", adminId);
    check("normal move -> stage='meeting_scheduled'", r.stage === "meeting_scheduled");
    check("normal move -> lostStatus stays 'none'", r.lostStatus === "none");
    check("normal move -> isLost stays false", r.isLost === false);
    const reopenedAfter = await reopenedLogCount(lead3Id);
    check("normal move logged NO 'lead.reopened'", reopenedAfter === reopenedBefore);

    console.log(`\nResult: ${pass} passed, ${fail} failed.`);
    if (fail > 0) process.exitCode = 1;
  } catch (error) {
    console.error("Verification error:", error);
    process.exitCode = 1;
  } finally {
    // ---------- Cleanup: delete throwaway test leads + their activity logs ----------
    const testLeadIds = [lead1Id, lead2Id, lead3Id].filter(Boolean).map(String);
    if (lead1Id) await Enquiry.deleteOne({ _id: lead1Id }).catch(() => {});
    if (lead2Id) await Enquiry.deleteOne({ _id: lead2Id }).catch(() => {});
    if (lead3Id) await Enquiry.deleteOne({ _id: lead3Id }).catch(() => {});
    await Enquiry.deleteMany({ phone: { $in: [PHONE_1, PHONE_2, PHONE_3] } }).catch(() => {});
    if (testLeadIds.length) {
      await ActivityLog.deleteMany({
        entityType: "lead",
        entityId: { $in: testLeadIds },
      }).catch(() => {});
    }
    console.log("Cleaned up test leads + activity logs.");
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
