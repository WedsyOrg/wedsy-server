// FIX 2 — PARTICIPANT READ GATE test. Run: node tests/participant-read-gate.test.js
// Covers: a lane-owner-only CS member passes the widened read gate (and each
// participant leg does), a stranger stays 403, and the DEFAULT (write-site)
// behavior is byte-identical — no participant admission without the opt-in.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const LeadTeamMember = require("../models/LeadTeamMember");
const LeadLane = require("../models/LeadLane");
const LeadTask = require("../models/LeadTask");
const { assertInScopeOrRoster } = require("../utils/leadScope");
const { isParticipantOnLead } = require("../services/ParticipantScopeService");

const TAG = `partgate-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const throws403 = async (fn) => { try { await fn(); return false; } catch (e) { return e.status === 403; } };

const created = { leads: [], admins: [], roles: [], depts: [], lanes: [], tasks: [], roster: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const dept = await Department.create({ name: `${TAG}-dept`, slug: `${TAG}-d` });
    created.depts.push(dept._id);
    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: dept._id, permissions: ["leads:view:own"] });
    created.roles.push(icRole._id);
    const mk = (s) => Admin.create({ name: `${TAG}-${s}`, email: `${TAG}-${s}@x.com`, phone: `${TAG}${s}`, password: "x", roles: ["sales"], status: "active", roleId: icRole._id, departmentId: dept._id });
    const owner = await mk("owner");
    const laneOwner = await mk("laneowner");   // lane ownership ONLY — no roster, no scope
    const taskee = await mk("taskee");         // open-task assignment ONLY
    const doneTaskee = await mk("donetaskee"); // completed task ONLY — must NOT pass
    const rosterite = await mk("rosterite");
    const stranger = await mk("stranger");
    created.admins.push(owner._id, laneOwner._id, taskee._id, doneTaskee._id, rosterite._id, stranger._id);

    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: owner._id,
    });
    created.leads.push(lead._id);
    created.lanes.push((await LeadLane.create({ leadId: lead._id, key: "decor", name: "Decor", state: "active", ownerId: laneOwner._id }))._id);
    created.tasks.push((await LeadTask.create({ leadId: lead._id, title: `${TAG} open`, assigneeId: taskee._id, assignerId: owner._id, status: "open", dueAt: new Date() }))._id);
    created.tasks.push((await LeadTask.create({ leadId: lead._id, title: `${TAG} done`, assigneeId: doneTaskee._id, assignerId: owner._id, status: "done", completedAt: new Date(), dueAt: new Date() }))._id);
    created.roster.push((await LeadTeamMember.create({ leadId: lead._id, personId: rosterite._id, activeTo: null }))._id);

    // A scope filter that matches NOBODY here except the owner.
    const notMyScope = { assignedTo: new mongoose.Types.ObjectId() };
    const READ = { includeParticipants: true };

    // ── the widened READ gate ──
    let threw = false;
    try { await assertInScopeOrRoster(lead._id, notMyScope, laneOwner._id, READ); } catch { threw = true; }
    ok(!threw, "lane-owner-only member passes the READ gate (200)");
    threw = false;
    try { await assertInScopeOrRoster(lead._id, notMyScope, taskee._id, READ); } catch { threw = true; }
    ok(!threw, "open-task assignee passes the READ gate");
    threw = false;
    try { await assertInScopeOrRoster(lead._id, notMyScope, rosterite._id, READ); } catch { threw = true; }
    ok(!threw, "roster member still passes (unchanged)");
    ok(await throws403(() => assertInScopeOrRoster(lead._id, notMyScope, doneTaskee._id, READ)), "a DONE task does not admit (403)");
    ok(await throws403(() => assertInScopeOrRoster(lead._id, notMyScope, stranger._id, READ)), "stranger still 403 with the widened gate");

    // ── DEFAULT (write sites) — byte-identical prior behavior ──
    ok(await throws403(() => assertInScopeOrRoster(lead._id, notMyScope, laneOwner._id)), "WRITE-site default: lane owner still 403 (writes keep their gate)");
    ok(await throws403(() => assertInScopeOrRoster(lead._id, notMyScope, taskee._id)), "WRITE-site default: task assignee still 403");
    threw = false;
    try { await assertInScopeOrRoster(lead._id, notMyScope, rosterite._id); } catch { threw = true; }
    ok(!threw, "WRITE-site default: roster admission unchanged");
    threw = false;
    try { await assertInScopeOrRoster(lead._id, { assignedTo: owner._id }, owner._id); } catch { threw = true; }
    ok(!threw, "scope match unchanged in both modes");

    // ── the per-lead probe itself ──
    ok(await isParticipantOnLead(lead._id, owner._id), "probe: assignedTo qualifies");
    ok(await isParticipantOnLead(lead._id, laneOwner._id), "probe: lane owner qualifies");
    ok(await isParticipantOnLead(lead._id, taskee._id), "probe: open-task assignee qualifies");
    ok(!(await isParticipantOnLead(lead._id, doneTaskee._id)), "probe: done-task assignee does not");
    ok(!(await isParticipantOnLead(lead._id, stranger._id)), "probe: stranger does not");
    ok(!(await isParticipantOnLead("not-an-id", laneOwner._id)), "probe: malformed lead id is false, not a throw");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await LeadTeamMember.deleteMany({ _id: { $in: created.roster } }).catch(() => {});
    await LeadLane.deleteMany({ _id: { $in: created.lanes } }).catch(() => {});
    await LeadTask.deleteMany({ _id: { $in: created.tasks } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await Department.deleteMany({ _id: { $in: created.depts } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
