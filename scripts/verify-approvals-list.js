/**
 * Verify the pending-disqualification approval listing at the SERVICE layer (LOCAL DEV ONLY).
 * Exercises listPendingForApprover() scoping:
 *   - a manager sees only pending leads owned by their (transitive) reports,
 *   - a leads:approve holder sees ALL pending leads,
 *   - an unrelated admin sees none.
 *
 * Creates throwaway admins + leads on unique emails/phones and deletes them on exit.
 * Aborts if DATABASE_URL is not localhost.
 *
 * Run: node scripts/verify-approvals-list.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const EnquiryService = require("../services/EnquiryService");
const ApprovalEligibility = require("../services/ApprovalEligibility");

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

const FOUNDER_ID = "6545aacbff55fb354638d028"; // has *:*:all (verified)
const MGR_EMAIL = "verify-mgr@approvals.test";
const REP_EMAIL = "verify-rep@approvals.test";
const OUT_EMAIL = "verify-out@approvals.test";
const PHONE_A = "9990010001";
const PHONE_B = "9990010002";

const mkAdmin = (email, name, reportingManagerId = null) =>
  Admin.create({
    name,
    email,
    phone: "0000000000",
    password: "x",
    roles: ["sales"],
    reportingManagerId,
  });

const mkPendingLead = (phone, name, assignedTo) =>
  Enquiry.create({
    name,
    phone,
    verified: true,
    isInterested: false,
    isLost: false,
    source: "VerifyScript",
    stage: "contacted",
    assignedTo,
    lostStatus: "pending",
    lostReason: "budget",
    lostNote: "verify",
    lostRequestedBy: assignedTo,
    lostRequestedAt: new Date(),
  });

const hasLead = (items, id) => items.some((l) => String(l._id) === String(id));

(async () => {
  let mgrId = null;
  let repId = null;
  let outId = null;
  let leadAId = null;
  let leadBId = null;
  let throwawayApproverId = null;
  let throwawayRoleId = null;
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}\n`);

    // clean leftovers from a previous run
    await Admin.deleteMany({ email: { $in: [MGR_EMAIL, REP_EMAIL, OUT_EMAIL] } });
    await Enquiry.deleteMany({ phone: { $in: [PHONE_A, PHONE_B] } });

    // ---------- Step 1: throwaway admins (manager <- rep, plus outsider) ----------
    console.log("=== Step 1: create throwaway admins ===");
    const mgr = await mkAdmin(MGR_EMAIL, "Verify Manager");
    mgrId = mgr._id;
    const rep = await mkAdmin(REP_EMAIL, "Verify Rep", mgrId);
    repId = rep._id;
    const outsider = await mkAdmin(OUT_EMAIL, "Verify Outsider");
    outId = outsider._id;
    check("manager has no leads:approve permission", !(await ApprovalEligibility.actorHasApprovePermission(mgrId)));
    check("manager is rep's manager", await ApprovalEligibility.isManagerOfAssigned(mgrId, repId));

    // ---------- Step 2: two pending leads ----------
    console.log("\n=== Step 2: create two pending leads ===");
    const leadA = await mkPendingLead(PHONE_A, "Verify Lead A", repId); // owned by rep
    leadAId = leadA._id;
    const leadB = await mkPendingLead(PHONE_B, "Verify Lead B", outId); // owned by outsider
    leadBId = leadB._id;
    check("leadA pending (assignedTo=rep)", leadA.lostStatus === "pending");
    check("leadB pending (assignedTo=outsider)", leadB.lostStatus === "pending");

    // ---------- Step 3: manager view -> only leadA ----------
    console.log("\n=== Step 3: listPendingForApprover(manager) ===");
    const mgrList = await EnquiryService.listPendingForApprover(String(mgrId));
    check("manager sees leadA (their report's lead)", hasLead(mgrList, leadAId));
    check("manager does NOT see leadB (not their report)", !hasLead(mgrList, leadBId));

    // ---------- Step 4: approve-permission holder -> sees BOTH ----------
    console.log("\n=== Step 4: listPendingForApprover(approver with leads:approve) ===");
    let approverId = FOUNDER_ID;
    if (!(await ApprovalEligibility.actorHasApprovePermission(approverId))) {
      // Fallback: build a throwaway approver if the seeded Founder isn't available.
      const anyDept = await Role.findOne({ deletedAt: null }).lean();
      const role = await Role.create({
        name: "Verify Approver Role",
        departmentId: anyDept ? anyDept.departmentId : new mongoose.Types.ObjectId(),
        permissions: ["leads:approve:all"],
      });
      throwawayRoleId = role._id;
      const approver = await mkAdmin("verify-approver@approvals.test", "Verify Approver");
      approver.roleId = role._id;
      await approver.save();
      throwawayApproverId = approver._id;
      approverId = String(approver._id);
      console.log("  (used throwaway approver — seeded Founder not eligible)");
    }
    check("approver holds leads:approve", await ApprovalEligibility.actorHasApprovePermission(approverId));
    const approverList = await EnquiryService.listPendingForApprover(String(approverId));
    check("approver sees leadA", hasLead(approverList, leadAId));
    check("approver sees leadB", hasLead(approverList, leadBId));

    // ---------- Step 5: outsider -> sees neither ----------
    console.log("\n=== Step 5: listPendingForApprover(outsider) ===");
    const outList = await EnquiryService.listPendingForApprover(String(outId));
    check("outsider does NOT see leadA", !hasLead(outList, leadAId));
    check("outsider does NOT see leadB", !hasLead(outList, leadBId));

    console.log(`\nResult: ${pass} passed, ${fail} failed.`);
    if (fail > 0) process.exitCode = 1;
  } catch (error) {
    console.error("Verification error:", error);
    process.exitCode = 1;
  } finally {
    // ---------- Cleanup ----------
    if (leadAId) await Enquiry.deleteOne({ _id: leadAId }).catch(() => {});
    if (leadBId) await Enquiry.deleteOne({ _id: leadBId }).catch(() => {});
    await Enquiry.deleteMany({ phone: { $in: [PHONE_A, PHONE_B] } }).catch(() => {});
    const adminIds = [mgrId, repId, outId, throwawayApproverId].filter(Boolean);
    if (adminIds.length) await Admin.deleteMany({ _id: { $in: adminIds } }).catch(() => {});
    await Admin.deleteMany({
      email: { $in: [MGR_EMAIL, REP_EMAIL, OUT_EMAIL, "verify-approver@approvals.test"] },
    }).catch(() => {});
    if (throwawayRoleId) await Role.deleteOne({ _id: throwawayRoleId }).catch(() => {});
    console.log("Cleaned up throwaway admins, leads, role.");
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
