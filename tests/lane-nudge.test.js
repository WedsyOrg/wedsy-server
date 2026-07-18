// C3 — LANE NUDGE test. Run: node tests/lane-nudge.test.js
// Covers: auto entry + notification to the LEAD OWNER, the fallback ladder
// (disabled owner → reporting manager → Revenue Head), 24h dedupe (409), and
// the actor gate (lane owner / lead owner / roster only).
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const LeadLane = require("../models/LeadLane");
const LaneEntry = require("../models/LaneEntry");
const AdminNotification = require("../models/AdminNotification");
const LeadLaneService = require("../services/LeadLaneService");

const TAG = `nudge-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], roles: [], depts: [], lanes: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = new Date();

    const dept = await Department.create({ name: `${TAG}-dept`, slug: `${TAG}-d` });
    created.depts.push(dept._id);
    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: dept._id, permissions: ["leads:view:own"] });
    created.roles.push(icRole._id);
    // revenueHeadIds() resolves the role by findOne({name:"Revenue Head"}) —
    // attach the fixture admin to the REAL seeded role (create only if absent).
    let rhRole = await Role.findOne({ name: "Revenue Head", deletedAt: null });
    if (!rhRole) {
      rhRole = await Role.create({ name: "Revenue Head", departmentId: dept._id, permissions: ["leads:view:team"], description: TAG });
      created.roles.push(rhRole._id);
    }
    const mkAdmin = (s, roleId, extra = {}) =>
      Admin.create({ name: `${TAG}-${s}`, email: `${TAG}-${s}@x.com`, phone: `${TAG}${s}`, password: "x", roles: ["sales"], status: "active", roleId, departmentId: dept._id, ...extra });
    const leadOwner = await mkAdmin("leadowner", icRole._id);
    const laneOwner = await mkAdmin("laneowner", icRole._id);
    const stranger = await mkAdmin("stranger", icRole._id);
    const manager = await mkAdmin("manager", icRole._id);
    const rh = await mkAdmin("rh", rhRole._id);
    const disabledOwner = await mkAdmin("disabled", icRole._id, { isDisabled: true, reportingManagerId: manager._id });
    const orphanOwner = await mkAdmin("orphan", icRole._id, { isDisabled: true });
    created.admins.push(leadOwner._id, laneOwner._id, stranger._id, manager._id, rh._id, disabledOwner._id, orphanOwner._id);

    const mkFixture = async (s, assignedTo) => {
      const lead = await Enquiry.create({
        name: `${TAG}-${s}`, phone: `${TAG}-${s}`, verified: false, isInterested: false,
        isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo,
      });
      const lane = await LeadLane.create({
        leadId: lead._id, key: "decor", name: "Decor", state: "paused", pausedReason: "Waiting on client",
        ownerId: laneOwner._id, lastUpdateAt: new Date(+now - 3 * DAY),
      });
      created.leads.push(lead._id);
      created.lanes.push(lane._id);
      return { lead, lane };
    };

    // ── happy path: entry + notification to the lead owner ──
    const A = await mkFixture("A", leadOwner._id);
    const out = await LeadLaneService.nudge(A.lead._id, A.lane._id, laneOwner._id);
    ok(out.waitingDays === 3, `waitingDays computed from lane silence (${out.waitingDays})`);
    ok(out.entry.autoType === "nudge" && out.entry.kind === "auto", "auto lane entry written");
    ok(out.entry.text === `Nudge: waiting on client 3d — flagged to ${TAG}-leadowner`, `entry text exact ("${out.entry.text}")`);
    const notifA = await AdminNotification.find({ leadId: A.lead._id, type: "lane_nudge" }).lean();
    ok(notifA.length === 1 && String(notifA[0].adminId) === String(leadOwner._id), "lead owner notified");
    // lane heartbeat untouched (a nudge is not client progress)
    const laneAfter = await LeadLane.findById(A.lane._id).lean();
    ok(+new Date(laneAfter.lastUpdateAt) === +new Date(A.lane.lastUpdateAt), "nudge does not reset the silence clock");

    // ── dedupe: second nudge within 24h → 409 ──
    let dup = null;
    try { await LeadLaneService.nudge(A.lead._id, A.lane._id, leadOwner._id); } catch (e) { dup = e; }
    ok(dup && dup.status === 409, "second nudge within 24h → 409");
    ok((await AdminNotification.countDocuments({ leadId: A.lead._id, type: "lane_nudge" })) === 1, "no duplicate notification");

    // ── actor gate ──
    let denied = null;
    try { await LeadLaneService.nudge(A.lead._id, A.lane._id, stranger._id); } catch (e) { denied = e; }
    ok(denied && denied.status === 403, "a stranger cannot nudge (403)");

    // ── fallback: disabled lead owner → reporting manager ──
    const B = await mkFixture("B", disabledOwner._id);
    const outB = await LeadLaneService.nudge(B.lead._id, B.lane._id, laneOwner._id);
    ok(outB.notified.length === 1 && outB.notified[0] === String(manager._id), "disabled owner → reporting manager notified");
    ok(/flagged to the reporting manager/.test(outB.entry.text), "entry names the fallback tier");

    // ── fallback: disabled owner with no manager → Revenue Head ──
    const C = await mkFixture("C", orphanOwner._id);
    const outC = await LeadLaneService.nudge(C.lead._id, C.lane._id, laneOwner._id);
    ok(outC.notified.includes(String(rh._id)), "no manager → Revenue Head notified");
    ok(/flagged to the Revenue Head/.test(outC.entry.text), "entry names the RH tier");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await LaneEntry.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadLane.deleteMany({ _id: { $in: created.lanes } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await Department.deleteMany({ _id: { $in: created.depts } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
