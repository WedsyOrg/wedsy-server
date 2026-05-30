/**
 * RBAC Phase 2B — Slice 3 enforcement verification (LOCAL DEV ONLY).
 * Part A: assert the permission gate for all 8 seeded roles against "roles:view:all".
 * Part B: assert own/team/department/all scope filters against real Enquiry data,
 *         using a TEMPORARY owner->crm reporting link + 2 temporarily-assigned leads,
 *         all reverted in the finally block (non-destructive).
 * Aborts if DATABASE_URL is not localhost.
 * Run: node scripts/rbac-phase-2b-verify-enforcement.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Enquiry = require("../models/Enquiry");
const {
  permissionSatisfies,
  buildScopeFilter,
  getSubordinateIds,
  _teamCache,
} = require("../middlewares/requirePermission");

const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.startsWith("mongodb://localhost")) {
  console.error("ABORT: DATABASE_URL is not a localhost URI. Verification runs on the local dev DB only.");
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

    // ---------- Part A: permission gate ----------
    console.log("=== Part A - gate: roles:view:all ===");
    const roles = await Role.find({ deletedAt: null }).sort({ name: 1 }).lean();
    const EXPECT_PASS = new Set(["Founder", "CRM Admin"]);
    for (const r of roles) {
      const { allowed } = permissionSatisfies(r.permissions, "roles:view:all");
      const shouldPass = EXPECT_PASS.has(r.name);
      check(`${r.name} -> ${allowed ? "ALLOW" : "DENY"} (expected ${shouldPass ? "ALLOW" : "DENY"})`, allowed === shouldPass);
    }

    // ---------- Part B: scope filters ----------
    console.log("\n=== Part B - scope filters (assignedTo) ===");
    const owner = await Admin.findOne({ roles: "owner" });
    const crm = await Admin.findOne({ roles: "crm" });
    const totalLeads = await Enquiry.countDocuments({});
    const someLeads = await Enquiry.find({}).limit(2).select({ _id: 1, assignedTo: 1 }).lean();

    if (!owner || !crm || someLeads.length < 2) {
      console.warn("SKIP Part B - need owner + crm admins and at least 2 enquiries.");
    } else {
      restore = {
        crmId: crm._id,
        crmReporting: crm.reportingManagerId ?? null,
        leadA: { id: someLeads[0]._id, assignedTo: someLeads[0].assignedTo ?? null },
        leadB: { id: someLeads[1]._id, assignedTo: someLeads[1].assignedTo ?? null },
      };

      await Admin.updateOne({ _id: crm._id }, { $set: { reportingManagerId: owner._id } });
      await Enquiry.updateOne({ _id: someLeads[0]._id }, { $set: { assignedTo: owner._id } });
      await Enquiry.updateOne({ _id: someLeads[1]._id }, { $set: { assignedTo: crm._id } });
      _teamCache.clear();

      const ownerFresh = await Admin.findById(owner._id);
      const subs = await getSubordinateIds(owner._id);
      check("team traversal: owner's subordinates include crm", subs.map(String).includes(String(crm._id)));

      const fOwn = await buildScopeFilter("own", ownerFresh, "assignedTo");
      const fTeam = await buildScopeFilter("team", ownerFresh, "assignedTo");
      const fDept = await buildScopeFilter("department", ownerFresh, "assignedTo");
      const fAll = await buildScopeFilter("all", ownerFresh, "assignedTo");

      const cOwn = await Enquiry.countDocuments(fOwn);
      const cTeam = await Enquiry.countDocuments(fTeam);
      const cDept = await Enquiry.countDocuments(fDept);
      const cAll = await Enquiry.countDocuments(fAll);

      console.log(`  own filter:        ${JSON.stringify(fOwn)} -> ${cOwn} leads`);
      console.log(`  team filter:       ${JSON.stringify(fTeam)} -> ${cTeam} leads`);
      console.log(`  department filter: ${JSON.stringify(fDept)} -> ${cDept} leads`);
      console.log(`  all filter:        ${JSON.stringify(fAll)} -> ${cAll} leads`);

      check("own >= 1 (owner's assigned lead)", cOwn >= 1);
      check("team > own (team includes crm's lead)", cTeam > cOwn);
      check("team >= 2 (owner + crm leads)", cTeam >= 2);
      check("department == own (owner alone in Founders dept)", cDept === cOwn);
      check("all == total enquiries", cAll === totalLeads);
    }

    console.log(`\nResult: ${pass} passed, ${fail} failed.`);
    if (fail > 0) process.exitCode = 1;
  } catch (error) {
    console.error("Verification error:", error);
    process.exitCode = 1;
  } finally {
    if (restore) {
      await Admin.updateOne({ _id: restore.crmId }, { $set: { reportingManagerId: restore.crmReporting } });
      await Enquiry.updateOne({ _id: restore.leadA.id }, { $set: { assignedTo: restore.leadA.assignedTo } });
      await Enquiry.updateOne({ _id: restore.leadB.id }, { $set: { assignedTo: restore.leadB.assignedTo } });
      console.log("Reverted temporary hierarchy + lead assignments.");
    }
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
