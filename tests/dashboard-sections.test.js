// W4 — DASHBOARD SECTIONS test. Run: node tests/dashboard-sections.test.js
// Covers: valueStrip gating (RH/founder only) + station sums + won-this-month,
// wins (last 5, NO amounts), awaitingHumanQualification rows (channel/since
// from WAConversation), escalationsTop scoping, rescue exposure (manager+ only)
// + snooze-awareness, and that the sections ride the FULL dashboard payload
// without dropping existing keys.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const LeadLane = require("../models/LeadLane");
const LeadPayment = require("../models/LeadPayment");
const EscalationMark = require("../models/EscalationMark");
const WAConversation = require("../models/WAConversation");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const DashboardSectionsService = require("../services/DashboardSectionsService");
const DashboardService = require("../services/DashboardService");

const TAG = `dashsec-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], roles: [], depts: [], lanes: [], marks: [], convs: [], events: [], payments: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = new Date();

    const dept = await Department.create({ name: `${TAG}-dept`, slug: `${TAG}-d` });
    created.depts.push(dept._id);
    const rhRole = await Role.create({ name: "Revenue Head", departmentId: dept._id, permissions: ["leads:view:team"], description: TAG });
    const mgrRole = await Role.create({ name: `${TAG}-mgr`, departmentId: dept._id, permissions: ["leads:view:team"] });
    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: dept._id, permissions: ["leads:view:own"] });
    created.roles.push(rhRole._id, mgrRole._id, icRole._id);

    const mkAdmin = (s, roleId, extra = {}) =>
      Admin.create({ name: `${TAG}-${s}`, email: `${TAG}-${s}@x.com`, phone: `${TAG}${s}`, password: "x", roles: ["sales"], status: "active", roleId, departmentId: dept._id, ...extra });
    const rh = await mkAdmin("rh", rhRole._id);
    const mgr = await mkAdmin("mgr", mgrRole._id);
    const seller = await mkAdmin("seller", icRole._id, { reportingManagerId: rh._id });
    created.admins.push(rh._id, mgr._id, seller._id);

    const mkLead = (s, extra = {}) =>
      Enquiry.create({
        name: `${TAG}-${s}`, phone: `${TAG}-${s}`, verified: false, isInterested: false,
        isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
        assignedTo: seller._id, firstRespondedAt: now, ...extra,
      });

    // Station-value fixtures.
    const Lprop = await mkLead("prop", { qualified: true, qualifiedAt: now, proposalSentAt: now, dealValue: { amount: 200000, history: [] } });
    const Lagree = await mkLead("agree", { qualified: true, qualifiedAt: now, proposalSentAt: now, agreementSentAt: { at: now, by: seller._id }, dealValue: { amount: 300000, history: [] } });
    created.payments.push((await LeadPayment.create({ leadId: Lagree._id, amount: 25000, mode: "bank" }))._id);
    // Won this month vs last month.
    const WonNow = await mkLead("won-now", { stage: "won", qualified: true, qualifiedAt: now, dealValue: { amount: 500000, history: [] } });
    const evNow = await LeadInternalEvent.create({ leadId: WonNow._id, type: "client_onboarded", actorId: seller._id, payload: {} });
    const WonOld = await mkLead("won-old", { stage: "won", qualified: true, qualifiedAt: new Date(+now - 60 * DAY), dealValue: { amount: 100000, history: [] } });
    // createdAt is immutable under mongoose timestamps — insert at driver level
    // to backdate the old win's event.
    const evOldId = new mongoose.Types.ObjectId();
    await LeadInternalEvent.collection.insertOne({ _id: evOldId, leadId: WonOld._id, type: "client_onboarded", actorId: seller._id, payload: {}, createdAt: new Date(+now - 40 * DAY) });
    created.events.push(evNow._id, evOldId);
    // needsHumanQualification + IG conversation.
    const NH = await mkLead("needshuman", { needsHumanQualification: true });
    const conv = await WAConversation.create({ phone: `${TAG}-ig`, channel: "instagram", enquiryId: NH._id, needsHuman: true, needsHumanAt: new Date(+now - 3600e3) });
    created.convs.push(conv._id);
    // escalation (lane) for escalationsTop.
    const EL = await mkLead("esc");
    const anchor = new Date(+now - 5 * DAY);
    const lane = await LeadLane.create({ leadId: EL._id, key: "venue", name: "Venue", state: "active", ownerId: seller._id, lastUpdateAt: anchor });
    created.lanes.push(lane._id);
    created.marks.push((await EscalationMark.create({ key: `lane:${EL._id}:${lane.key}:2:${+anchor}`, leadId: EL._id, kind: "lane", rung: 2, firedAt: now }))._id);
    // rescue fixtures: breached unresponded lead + a snoozed twin.
    const Resc = await mkLead("rescue", { stage: "new", firstRespondedAt: null, firstCalledAt: null, createdAt: new Date(+now - 2 * 3600e3) });
    const RescSnooze = await mkLead("rescue-snoozed", { stage: "new", firstRespondedAt: null, firstCalledAt: null, createdAt: new Date(+now - 2 * 3600e3), snoozedUntil: new Date(+now + 30 * DAY) });
    created.leads.push(Lprop._id, Lagree._id, WonNow._id, WonOld._id, NH._id, EL._id, Resc._id, RescSnooze._id);

    const teamFilter = { assignedTo: { $in: [rh._id, seller._id] } };

    // ── RH caller (team scope): valueStrip present + exact sums ──
    const s = await DashboardSectionsService.buildWorkspaceSections(rh._id, "team", teamFilter);
    ok(!!s.valueStrip, "valueStrip present for a Revenue Head");
    ok(s.valueStrip.proposal === 200000, `valueStrip.proposal sums the proposal station (${s.valueStrip.proposal})`);
    ok(s.valueStrip.agreement === 300000, `valueStrip.agreement sums the agreement station (${s.valueStrip.agreement})`);
    ok(s.valueStrip.onboardedThisMonth === 500000, `onboardedThisMonth counts ONLY this IST month (${s.valueStrip.onboardedThisMonth})`);

    // wins — no amounts, newest first, event-dated.
    const winRows = s.wins.filter((w) => (w.name || "").startsWith(TAG));
    ok(winRows.length === 2, "wins carries both won fixtures");
    ok(winRows[0].leadId === String(WonNow._id), "wins ordered newest-first by wonAt");
    ok(winRows.every((w) => !("amount" in w) && !("dealValue" in w) && !("value" in w)), "wins rows carry NO amounts");
    ok(winRows.every((w) => w.ownerName === `${TAG}-seller` && w.wonAt), "wins rows carry ownerName + wonAt");

    // awaitingHumanQualification.
    const nhRows = s.awaitingHumanQualification.rows.filter((r) => (r.name || "").startsWith(TAG));
    ok(s.awaitingHumanQualification.count >= 1 && nhRows.length === 1, "awaitingHumanQualification counts the flagged lead");
    ok(nhRows[0].channel === "instagram" && !!nhRows[0].since, "row carries channel + since from the WA conversation");

    // escalationsTop.
    const escRows = s.escalationsTop.filter((r) => (r.leadName || "").startsWith(TAG));
    ok(escRows.some((r) => r.leadId === String(EL._id) && r.rung === 2), "escalationsTop surfaces the open escalation");
    ok(s.escalationsTop.length <= 3, "escalationsTop caps at 3");

    // rescue — exposed for manager+, snooze-aware.
    ok(s.rescue && Array.isArray(s.rescue.rows) && typeof s.rescue.count === "number", "rescue exposed for manager+ scope");
    const rescueIds = s.rescue.rows.map((r) => String(r._id));
    ok(rescueIds.includes(String(Resc._id)), "breached unresponded lead appears in rescue");
    ok(!rescueIds.includes(String(RescSnooze._id)), "snoozed twin is EXCLUDED from rescue (snooze-aware)");

    // ── plain manager (non-RH): valueStrip null, rescue still exposed ──
    const sm = await DashboardSectionsService.buildWorkspaceSections(mgr._id, "team", teamFilter);
    ok(sm.valueStrip === null, "valueStrip is null for a non-RH manager");
    ok(sm.rescue !== null, "rescue still exposed for the manager");

    // ── own-scope caller: rescue null ──
    const so = await DashboardSectionsService.buildWorkspaceSections(seller._id, "own", { assignedTo: seller._id });
    ok(so.rescue === null, "rescue is null for own-scope callers");
    ok(so.valueStrip === null, "valueStrip is null for own-scope callers");
    ok(Array.isArray(so.escalationsTop), "escalationsTop present (own-scoped) for ICs");

    // ── full payload ride-along (nothing dropped) ──
    const payload = await DashboardService.buildDashboard(rh._id, "team", teamFilter);
    for (const key of ["todaysMission", "atRisk", "counts", "teamRollup", "parked", "valueStrip", "escalationsTop", "awaitingHumanQualification", "wins", "rescue"]) {
      ok(key in payload, `dashboard payload carries "${key}"`);
    }
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await EscalationMark.deleteMany({ _id: { $in: created.marks } }).catch(() => {});
    await LeadLane.deleteMany({ _id: { $in: created.lanes } }).catch(() => {});
    await WAConversation.deleteMany({ _id: { $in: created.convs } }).catch(() => {});
    await LeadInternalEvent.deleteMany({ _id: { $in: created.events } }).catch(() => {});
    await LeadPayment.deleteMany({ _id: { $in: created.payments } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await Department.deleteMany({ _id: { $in: created.depts } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
