// W5 — ESCALATIONS READ test. Run: node tests/escalations-read.test.js
// Covers: kind mapping (lane/engagement/deal/snooze-wake), episode collapse to
// max rung, openness (moved-on lane episode excluded), scope (team vs all,
// downward-only ?scope), severity ordering, notified trail reconstruction.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const LeadLane = require("../models/LeadLane");
const EscalationMark = require("../models/EscalationMark");
const AdminNotification = require("../models/AdminNotification");
const EscalationReadService = require("../services/EscalationReadService");

const TAG = `escread-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], roles: [], depts: [], lanes: [], marks: [], notifs: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = new Date();

    const dept = await Department.create({ name: `${TAG}-dept`, slug: `${TAG}-d` });
    created.depts.push(dept._id);
    const founderRole = await Role.create({ name: `${TAG}-founder`, departmentId: dept._id, permissions: ["*:*:all"] });
    const mgrRole = await Role.create({ name: `${TAG}-mgr`, departmentId: dept._id, permissions: ["leads:view:team"] });
    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: dept._id, permissions: ["leads:view:own"] });
    created.roles.push(founderRole._id, mgrRole._id, icRole._id);

    const mkAdmin = (s, roleId, extra = {}) =>
      Admin.create({ name: `${TAG}-${s}`, email: `${TAG}-${s}@x.com`, phone: `${TAG}${s}`, password: "x", roles: ["sales"], status: "active", roleId, departmentId: dept._id, ...extra });
    const founder = await mkAdmin("founder", founderRole._id);
    const manager = await mkAdmin("mgr", mgrRole._id, { reportingManagerId: founder._id });
    const seller = await mkAdmin("seller", icRole._id, { reportingManagerId: manager._id });
    const outsider = await mkAdmin("outsider", icRole._id); // reports to nobody in this chain
    created.admins.push(founder._id, manager._id, seller._id, outsider._id);

    const mkLead = (s, extra = {}) =>
      Enquiry.create({
        name: `${TAG}-${s}`, phone: `${TAG}-${s}`, verified: false, isInterested: false,
        isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
        assignedTo: seller._id, ...extra,
      });

    // A — lane escalation, rung 1 then rung 2 (same episode).
    const A = await mkLead("lane");
    const anchorA = new Date(+now - 5 * DAY);
    const laneA = await LeadLane.create({ leadId: A._id, key: "venue", name: "Venue", state: "active", ownerId: seller._id, lastUpdateAt: anchorA });
    for (const rung of [1, 2]) {
      const m = await EscalationMark.create({ key: `lane:${A._id}:${laneA.key}:${rung}:${+anchorA}`, leadId: A._id, kind: "lane", rung, firedAt: new Date(+now - (3 - rung) * DAY) });
      created.marks.push(m._id);
    }
    created.lanes.push(laneA._id);
    // trail: rung1 → seller, rung2 → manager
    const n1 = await AdminNotification.create({ adminId: seller._id, type: "lane_silent", title: "t", message: "m", leadId: A._id, payload: { laneId: String(laneA._id), rung: 1 } });
    const n2 = await AdminNotification.create({ adminId: manager._id, type: "lane_silent", title: "t", message: "m", leadId: A._id, payload: { laneId: String(laneA._id), rung: 2 } });
    created.notifs.push(n1._id, n2._id);

    // B — engagement lane escalation.
    const B = await mkLead("engage");
    const anchorB = new Date(+now - 3 * DAY);
    const laneB = await LeadLane.create({ leadId: B._id, key: "engagement", name: "Client engagement", state: "active", ownerId: seller._id, lastUpdateAt: anchorB });
    const mB = await EscalationMark.create({ key: `lane:${B._id}:${laneB.key}:1:${+anchorB}`, leadId: B._id, kind: "lane", rung: 1, firedAt: new Date(+now - DAY) });
    created.lanes.push(laneB._id); created.marks.push(mB._id);

    // C — deal stalled at meeting_set (fresh qual, spine.current === meeting_set).
    const C = await mkLead("deal", { qualified: true, qualifiedAt: new Date(+now - 10 * DAY) });
    const mC = await EscalationMark.create({ key: `deal:${C._id}:meeting_set:1:${+new Date(+now - 6 * DAY)}`, leadId: C._id, kind: "deal", rung: 1, firedAt: new Date(+now - 0.5 * DAY) });
    created.marks.push(mC._id);

    // D — snooze-wake warn.
    const D = await mkLead("wake", { snoozedUntil: new Date(+now + 2 * DAY) });
    const mD = await EscalationMark.create({ key: `snooze:${D._id}:wake:1:${+now}`, leadId: D._id, kind: "snooze", rung: 1, firedAt: now });
    created.marks.push(mD._id);

    // E — CLOSED lane episode (lane updated after the mark's anchor).
    const E = await mkLead("closedlane");
    const oldAnchor = new Date(+now - 9 * DAY);
    const laneE = await LeadLane.create({ leadId: E._id, key: "decor", name: "Decor", state: "active", ownerId: seller._id, lastUpdateAt: new Date(+now - 1 * 3600e3) });
    const mE = await EscalationMark.create({ key: `lane:${E._id}:${laneE.key}:2:${+oldAnchor}`, leadId: E._id, kind: "lane", rung: 2, firedAt: new Date(+now - 8 * DAY) });
    created.lanes.push(laneE._id); created.marks.push(mE._id);

    // F — out-of-team lead (outsider's) with a live lane escalation.
    const F = await mkLead("foreign", { assignedTo: outsider._id });
    const anchorF = new Date(+now - 4 * DAY);
    const laneF = await LeadLane.create({ leadId: F._id, key: "venue", name: "Venue", state: "active", ownerId: outsider._id, lastUpdateAt: anchorF });
    const mF = await EscalationMark.create({ key: `lane:${F._id}:${laneF.key}:1:${+anchorF}`, leadId: F._id, kind: "lane", rung: 1, firedAt: now });
    created.lanes.push(laneF._id); created.marks.push(mF._id);

    created.leads.push(A._id, B._id, C._id, D._id, E._id, F._id);

    const teamFilter = { assignedTo: { $in: [manager._id, seller._id] } };
    const mine = (out) => out.items.filter((i) => (i.leadName || "").startsWith(TAG));

    // ── Manager (team scope) ──
    const t = await EscalationReadService.list({ callerId: manager._id, reqScope: "team", reqScopeFilter: teamFilter, page: 1, limit: 50 });
    const tItems = mine(t);
    const byLead = (doc) => tItems.find((i) => i.leadId === String(doc._id));
    ok(!!byLead(A) && byLead(A).kind === "lane" && byLead(A).rung === 2, "lane episode surfaces once at MAX rung");
    ok(!!byLead(A) && byLead(A).laneName === "Venue" && /Venue lane silent \d+d/.test(byLead(A).what), "lane item carries laneName + what");
    ok(!!byLead(B) && byLead(B).kind === "engagement", "engagement lane maps to kind engagement");
    ok(!!byLead(C) && byLead(C).kind === "deal" && /Meeting scheduled/.test(byLead(C).what), "deal item names the stalled station");
    ok(!!byLead(D) && byLead(D).kind === "snooze-wake", "snooze mark maps to snooze-wake");
    ok(!byLead(E), "moved-on lane episode is CLOSED (excluded)");
    ok(!byLead(F), "manager (team) does not see the outsider's escalation");
    const rungs = tItems.map((i) => i.rung);
    ok(rungs.every((r, i) => i === 0 || rungs[i - 1] >= r), "items ordered severest-first");
    const trail = byLead(A) && byLead(A).notifiedTrail;
    ok(Array.isArray(trail) && trail.includes(`${TAG}-seller`) && trail.includes(`${TAG}-mgr`), "notified trail reconstructed from AdminNotification recipients");
    ok(!!byLead(A) && byLead(A).ownerName === `${TAG}-seller`, "owner resolved");
    ok(!!byLead(A) && +new Date(byLead(A).since) === +anchorA, "since = the episode anchor");

    // ── Founder — upgraded to all ──
    const f = await EscalationReadService.list({ callerId: founder._id, reqScope: "team", reqScopeFilter: teamFilter, page: 1, limit: 50 });
    ok(f.scope === "all", "founder is upgraded to all regardless of req scope");
    ok(mine(f).some((i) => i.leadId === String(F._id)), "founder sees the outsider's escalation");

    // ── Founder + ?scope=team — honored downward ──
    const fd = await EscalationReadService.list({ callerId: founder._id, reqScope: "team", reqScopeFilter: teamFilter, requestedScope: "team", page: 1, limit: 50 });
    ok(fd.scope === "team", "?scope=team downgrades an all-scope caller");
    ok(!mine(fd).some((i) => i.leadId === String(F._id)), "downgraded view excludes out-of-chain leads");
    ok(mine(fd).some((i) => i.leadId === String(A._id)), "downgraded view keeps the chain's leads");

    // ── pagination ──
    const p1 = await EscalationReadService.list({ callerId: manager._id, reqScope: "team", reqScopeFilter: teamFilter, page: 1, limit: 2 });
    ok(p1.items.length <= 2 && p1.total >= 4, "pagination slices items but reports full total");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await EscalationMark.deleteMany({ _id: { $in: created.marks } }).catch(() => {});
    await AdminNotification.deleteMany({ _id: { $in: created.notifs } }).catch(() => {});
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
