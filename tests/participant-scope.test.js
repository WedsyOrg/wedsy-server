// C1 — PARTICIPANT SCOPE test. Run: node tests/participant-scope.test.js
// Covers: each membership leg qualifies (owner / roster / lane / open task),
// closed task + removed roster row + stranger leads do NOT, the board and the
// list/counts scope filter respect the id-set, ?adminId gating, and no N+1.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const LeadTeamMember = require("../models/LeadTeamMember");
const LeadLane = require("../models/LeadLane");
const LeadTask = require("../models/LeadTask");
const ParticipantScopeService = require("../services/ParticipantScopeService");
const BoardService = require("../services/BoardService");
const { effectiveScopeFilter } = require("../controllers/enquiry");

const TAG = `partscope-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], roles: [], depts: [], lanes: [], tasks: [], roster: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = new Date();

    const dept = await Department.create({ name: `${TAG}-dept`, slug: `${TAG}-d` });
    created.depts.push(dept._id);
    const mgrRole = await Role.create({ name: `${TAG}-mgr`, departmentId: dept._id, permissions: ["leads:view:team"] });
    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: dept._id, permissions: ["leads:view:own"] });
    created.roles.push(mgrRole._id, icRole._id);
    const mkAdmin = (s, roleId, extra = {}) =>
      Admin.create({ name: `${TAG}-${s}`, email: `${TAG}-${s}@x.com`, phone: `${TAG}${s}`, password: "x", roles: ["sales"], status: "active", roleId, departmentId: dept._id, ...extra });
    const manager = await mkAdmin("mgr", mgrRole._id);
    const member = await mkAdmin("member", icRole._id, { reportingManagerId: manager._id });
    const outsider = await mkAdmin("outsider", icRole._id);
    created.admins.push(manager._id, member._id, outsider._id);

    const mkLead = (s, extra = {}) =>
      Enquiry.create({
        name: `${TAG}-${s}`, phone: `${TAG}-${s}`, verified: false, isInterested: false,
        isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
        assignedTo: outsider._id, firstRespondedAt: now, ...extra,
      });

    const Lown = await mkLead("own", { assignedTo: member._id });
    const Lroster = await mkLead("roster");
    created.roster.push((await LeadTeamMember.create({ leadId: Lroster._id, personId: member._id, activeTo: null }))._id);
    const Llane = await mkLead("lane", { qualified: true, qualifiedAt: now });
    created.lanes.push((await LeadLane.create({ leadId: Llane._id, key: "venue", name: "Venue", state: "active", ownerId: member._id }))._id);
    const Ltask = await mkLead("task");
    created.tasks.push((await LeadTask.create({ leadId: Ltask._id, title: `${TAG} t`, assigneeId: member._id, assignerId: manager._id, status: "open", dueAt: now }))._id);
    const Lclosed = await mkLead("closedtask");
    created.tasks.push((await LeadTask.create({ leadId: Lclosed._id, title: `${TAG} done`, assigneeId: member._id, assignerId: manager._id, status: "done", completedAt: now, dueAt: now }))._id);
    const Lremoved = await mkLead("removedroster");
    created.roster.push((await LeadTeamMember.create({ leadId: Lremoved._id, personId: member._id, activeTo: now }))._id);
    const Lnone = await mkLead("none");
    created.leads.push(Lown._id, Lroster._id, Llane._id, Ltask._id, Lclosed._id, Lremoved._id, Lnone._id);

    // ── the id-set ──
    const ids = (await ParticipantScopeService.participantLeadIds(member._id)).map(String);
    ok(ids.includes(String(Lown._id)), "assignedTo qualifies");
    ok(ids.includes(String(Lroster._id)), "active roster row qualifies");
    ok(ids.includes(String(Llane._id)), "lane ownership qualifies");
    ok(ids.includes(String(Ltask._id)), "open task assignment qualifies");
    ok(!ids.includes(String(Lclosed._id)), "a DONE task does not qualify");
    ok(!ids.includes(String(Lremoved._id)), "a removed roster row does not qualify");
    ok(!ids.includes(String(Lnone._id)), "an unrelated lead is excluded");

    // ── list/counts wiring (effectiveScopeFilter) ──
    const fakeReq = { query: { scope: "participant" }, auth: { user_id: member._id, user: member }, scope: "own", scopeFilter: { assignedTo: member._id } };
    const filter = await effectiveScopeFilter(fakeReq);
    ok(filter._id && Array.isArray(filter._id.$in), "list/counts filter becomes an id-set");
    const fIds = filter._id.$in.map(String);
    ok(fIds.includes(String(Lroster._id)) && !fIds.includes(String(Lnone._id)), "the filter carries the participant set");

    // ── ?adminId gating ──
    const mgrReq = { query: { scope: "participant", adminId: String(member._id) }, auth: { user_id: manager._id, user: manager }, scope: "team", scopeFilter: {} };
    const mgrFilter = await effectiveScopeFilter(mgrReq);
    ok(mgrFilter._id.$in.map(String).includes(String(Lown._id)), "manager may read a report's participant set");
    let denied = null;
    try {
      await effectiveScopeFilter({ query: { scope: "participant", adminId: String(member._id) }, auth: { user_id: outsider._id, user: outsider }, scope: "own", scopeFilter: {} });
    } catch (e) { denied = e; }
    ok(denied && denied.status === 403, "own-scope caller cannot read someone else's set (403)");

    // ── board respects the scope + full column set ──
    const board = await BoardService.board(member._id, "own", { _id: { $in: ids } }, { fullColumns: true });
    ok(board.columnKeys.length === 9, "participant board ships the FULL column set");
    const inBoard = new Set();
    for (const k of board.columnKeys) for (const l of board.columns[k].leads) inBoard.add(String(l._id));
    ok(inBoard.has(String(Llane._id)) && inBoard.has(String(Lown._id)), "participant leads land on the board");
    ok(!inBoard.has(String(Lnone._id)), "non-participant leads stay off the board");

    // ── no N+1 (the id-set is ONE aggregation) ──
    let queries = 0;
    mongoose.set("debug", () => { queries += 1; });
    await ParticipantScopeService.participantLeadIds(member._id);
    mongoose.set("debug", false);
    console.log(`    id-set queries: ${queries}`);
    ok(queries <= 2, `id-set resolves in one aggregation (${queries} queries)`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    mongoose.set("debug", false);
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
