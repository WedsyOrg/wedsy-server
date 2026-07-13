/**
 * MEGA BUILD — H1/H2/M1/M2/M5/M6 + item-7 assertions.
 *
 *   node tests/mega-fixes.test.js
 *
 * • H1  — "qualified" list view excludes lost leads (flag intentionally kept)
 * • H2  — ResetPassword + SetMemberAccess survive a dirty legacy field
 * • M1  — triage assign guard + idsByRoleName exclude disabled admins
 * • M2  — manager rollup dueToday/overdue count BOTH follow-up stores
 * • M5  — bulkStage rejects won/lost (422) and stamps lastActivityAt
 * • M6  — leadClock.nextAction sees journey-store follow-ups
 * • #7  — no opaque {message:"error"} literals remain in the CRM surface;
 *         CheckLogin expired token → 401 with the session message
 */
require("dotenv").config();
const fs = require("fs");
const crypto = require("crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const Enquiry = require("../models/Enquiry");
const Followup = require("../models/Followup");
const LeadTask = require("../models/LeadTask");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const AdminNotification = require("../models/AdminNotification");
const ActivityLog = require("../models/ActivityLog");
const LeadChatMessageCleanup = mongoose.models.LeadChatMessage || null;

const { CheckHash } = require("../utils/password");
const authController = require("../controllers/auth");
const adminController = require("../controllers/admin");
const enquiryController = require("../controllers/enquiry");
const { CheckLogin } = require("../middlewares/auth");
const TriageService = require("../services/TriageService");
const LeadTaskService = require("../services/LeadTaskService");
const LeadBulkService = require("../services/LeadBulkService");
const GoldenWindowService = require("../services/GoldenWindowService");
const DashboardService = require("../services/DashboardService");

const TAG = `mega-${Date.now()}`;
const DAY_MS = 24 * 3600 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const throwsStatus = async (fn, status) => { try { await fn(); return false; } catch (e) { return e && e.status === status; } };
const mockRes = () => ({
  statusCode: 0, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
  send(b) { this.body = b; return this; },
});
const waitFor = async (cond, ms = 4000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (cond()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return cond();
};
const makeLead = (suffix, extra = {}) =>
  Enquiry.create({
    name: `${TAG}-${suffix}`, phone: `${TAG}-${suffix}`, verified: false, isInterested: false,
    isLost: false, stage: "new", source: "Default", lostStatus: "none", ...extra,
  });

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const created = { admins: [], leads: [] };
  let dept = null, role = null;
  try {
    dept = await Department.create({ name: `${TAG}-dept` });
    role = await Role.create({ name: `${TAG}-role`, permissions: [], deletedAt: null, departmentId: dept._id });
    const manager = await Admin.create({
      name: `${TAG}-mgr`, email: `${TAG}-m@x.com`, phone: `${TAG}m`, password: "x",
      roles: ["sales"], status: "active", roleId: role._id, departmentId: dept._id,
    });
    const member = await Admin.create({
      name: `${TAG}-member`, email: `${TAG}-mem@x.com`, phone: `${TAG}mem`, password: "x",
      roles: ["sales"], status: "active", roleId: role._id, departmentId: dept._id,
      reportingManagerId: manager._id,
    });
    const disabled = await Admin.create({
      name: `${TAG}-dis`, email: `${TAG}-d@x.com`, phone: `${TAG}d`, password: "x",
      roles: ["sales"], status: "active", isDisabled: true, roleId: role._id, departmentId: dept._id,
    });
    created.admins.push(manager._id, member._id, disabled._id);

    // ── H1: qualified view excludes lost ─────────────────────────────────────
    const qLive = await makeLead("qlive", { assignedTo: member._id, qualified: true, stage: "contacted" });
    const qLost = await makeLead("qlost", {
      assignedTo: member._id, qualified: true, stage: "lost", isLost: true, lostStatus: "approved",
    });
    created.leads.push(qLive._id, qLost._id);
    const reqQ = {
      query: { view: "qualified", page: "1", limit: "100" },
      scopeFilter: { assignedTo: member._id },
      auth: { user_id: String(member._id) },
    };
    const resQ = mockRes();
    enquiryController.GetAll(reqQ, resQ);
    await waitFor(() => resQ.body !== null);
    const listIds = ((resQ.body && resQ.body.list) || []).map((l) => String(l._id));
    ok(listIds.includes(String(qLive._id)), "H1: live qualified lead IS in the qualified view");
    ok(!listIds.includes(String(qLost._id)), "H1: qualified-then-LOST lead is EXCLUDED from the qualified view");
    ok((await Enquiry.findById(qLost._id).lean()).qualified === true,
      "H1: the qualified flag itself untouched (permanent credit semantics)");

    // ── H2: ResetPassword + SetMemberAccess on a dirty doc ───────────────────
    const dirty = await Admin.create({
      name: `${TAG}-dirty`, email: `${TAG}-dirty@x.com`, phone: `${TAG}dirty`, password: "old",
      roles: ["sales"], status: "active",
    });
    created.admins.push(dirty._id);
    const rawToken = crypto.randomBytes(32).toString("hex");
    await Admin.collection.updateOne(
      { _id: dirty._id },
      { $set: {
        roles: ["legacy-bogus"], // fails full-doc validation → old save() would throw
        resetToken: crypto.createHash("sha256").update(rawToken).digest("hex"),
        resetTokenExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } }
    );
    let sanity = false;
    try { await (await Admin.findById(dirty._id)).validate(); } catch (_) { sanity = true; }
    ok(sanity, "H2 sanity: dirty admin doc fails full-doc validation");
    const resR = mockRes();
    await authController.ResetPassword(
      { body: { email: `${TAG}-dirty@x.com`, token: rawToken, newPassword: "fresh-pass-123" } }, resR
    );
    ok(resR.statusCode === 200, `H2: ResetPassword on dirty doc → 200 (got ${resR.statusCode}: ${JSON.stringify(resR.body)})`);
    const afterR = await Admin.findById(dirty._id).lean();
    ok(await CheckHash("fresh-pass-123", afterR.password), "H2: password actually reset");
    ok(afterR.resetToken === null && afterR.resetTokenExpiresAt === null, "H2: reset token cleared");

    const resD = mockRes();
    await adminController.SetMemberAccess(
      { body: { targetAdminId: String(dirty._id), disabled: true }, auth: { user_id: String(manager._id) } }, resD
    );
    ok(resD.statusCode === 200 && (await Admin.findById(dirty._id).lean()).isDisabled === true,
      `H2: SetMemberAccess (disable) on dirty doc → 200 + flag written (got ${resD.statusCode})`);

    // ── M1: triage assign guard + idsByRoleName ──────────────────────────────
    const triageLead = await makeLead("triage", { triagePending: true, assignedTo: null });
    created.leads.push(triageLead._id);
    ok(await throwsStatus(() => TriageService.assign(String(triageLead._id), String(disabled._id), manager._id), 404),
      "M1: triage assign to a DISABLED (status still active) admin → rejected");
    const assigned = await TriageService.assign(String(triageLead._id), String(member._id), manager._id);
    ok(assigned && String(assigned.assignedTo) === String(member._id), "M1: triage assign to an enabled admin works");
    const roleIds = await LeadTaskService.idsByRoleName(`${TAG}-role`);
    ok(roleIds.map(String).includes(String(member._id)) && !roleIds.map(String).includes(String(disabled._id)),
      "M1: idsByRoleName pool excludes the disabled admin");

    // ── M2: manager rollup bridges both stores ───────────────────────────────
    // Member's due item lives ONLY in the journey store (no embedded followUps).
    const jLead = await makeLead("jlead", { assignedTo: member._id, stage: "contacted" });
    created.leads.push(jLead._id);
    await Followup.create({
      leadId: jLead._id, title: `${TAG} journey due`, dueAt: new Date(), ownerId: member._id, status: "open",
    });
    await Followup.create({
      leadId: jLead._id, title: `${TAG} journey overdue`, dueAt: new Date(Date.now() - 2 * DAY_MS), ownerId: member._id, status: "open",
    });
    const dash = await DashboardService.buildDashboard(String(manager._id), "team", {
      assignedTo: { $in: [manager._id, member._id] },
    });
    const row = (dash.teamRollup || []).find((r) => String(r.adminId) === String(member._id));
    ok(row && row.dueToday >= 1, `M2: journey-store due-today row counted in the manager rollup (dueToday=${row && row.dueToday})`);
    ok(row && row.overdue >= 1, `M2: journey-store overdue row counted too (overdue=${row && row.overdue})`);

    // ── M5: bulkStage terminal rejection + activity stamp ────────────────────
    const bulkLead = await makeLead("bulk", { assignedTo: member._id });
    created.leads.push(bulkLead._id);
    ok(await throwsStatus(() => LeadBulkService.bulkStage({ leadIds: [String(bulkLead._id)], stage: "won" }, manager._id, {}), 422),
      "M5: bulkStage to 'won' → 422");
    ok(await throwsStatus(() => LeadBulkService.bulkStage({ leadIds: [String(bulkLead._id)], stage: "lost" }, manager._id, {}), 422),
      "M5: bulkStage to 'lost' → 422");
    const moved = await LeadBulkService.bulkStage({ leadIds: [String(bulkLead._id)], stage: "contacted" }, manager._id, {});
    const afterBulk = await Enquiry.findById(bulkLead._id).lean();
    ok(moved.updated === 1 && afterBulk.stage === "contacted", "M5: non-terminal bulk move still works");
    ok(afterBulk.lastActivityAt && +new Date(afterBulk.lastActivityAt) > Date.now() - 60000,
      "M5: bulk move stamps lastActivityAt");

    // ── M6: leadClock.nextAction sees journey rows ───────────────────────────
    const bannerLead = await makeLead("banner", { assignedTo: member._id, firstRespondedAt: new Date() });
    created.leads.push(bannerLead._id);
    await Followup.create({
      leadId: bannerLead._id, title: `${TAG} future step`, dueAt: new Date(Date.now() + 3 * DAY_MS),
      ownerId: member._id, status: "open",
    });
    const clock = await GoldenWindowService.leadClock(String(bannerLead._id));
    ok(clock.nextAction && clock.nextAction.type === "journey" && /future step/.test(clock.nextAction.title || ""),
      `M6: nextAction from the journey store (got ${JSON.stringify(clock.nextAction)})`);
    ok(clock.bannerState === "next_action_due", "M6: bannerState reflects the journey next step");

    // ── #7: opaque literals gone + auth middleware messages ──────────────────
    for (const f of ["controllers/enquiry.js", "controllers/auth.js", "middlewares/auth.js"]) {
      const src = fs.readFileSync(f, "utf8");
      const liveOpaque = src.split("\n").filter((l) => !l.trim().startsWith("//") && l.includes('message: "error"')).length;
      ok(liveOpaque === 0, `#7: no live {message:"error"} left in ${f}`);
    }
    const expired = jwt.sign({ _id: String(member._id), isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "-10s" });
    const resL = mockRes();
    await new Promise((resolve) => {
      CheckLogin({ headers: { authorization: `Bearer ${expired}` } }, resL, resolve);
      setTimeout(resolve, 600);
    });
    ok(resL.statusCode === 401 && /session expired/i.test(resL.body && resL.body.message),
      `#7: CheckLogin expired token → 401 session message (got ${resL.statusCode} ${JSON.stringify(resL.body && resL.body.message)})`);

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    const leadIds = created.leads;
    await Followup.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await LeadTask.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await AdminNotification.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await ActivityLog.deleteMany({ entityId: { $in: [...created.admins.map(String), ...leadIds.map(String)] } }).catch(() => {});
    if (LeadChatMessageCleanup) await LeadChatMessageCleanup.deleteMany({ leadId: { $in: leadIds } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: leadIds } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    if (role) await Role.deleteOne({ _id: role._id }).catch(() => {});
    if (dept) await Department.deleteOne({ _id: dept._id }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
