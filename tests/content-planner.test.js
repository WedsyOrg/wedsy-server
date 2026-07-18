// C4 — INSTAGRAM PLANNER test. Run: node tests/content-planner.test.js
// Covers: create/board grouping, Monday roll (order preserved, overdue flag +
// SINGLE manager notification, second roll no-op), posted stamps (postedAt +
// onTime truth), onTimePct math, stale-ideas trigger + episode dedupe + re-arm.
require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const ContentPost = require("../models/ContentPost");
const EscalationMark = require("../models/EscalationMark");
const AdminNotification = require("../models/AdminNotification");
const ContentPostService = require("../services/ContentPostService");
const CsAccessService = require("../services/CsAccessService");

const TAG = `content-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
const START = new Date();
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], roles: [], posts: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const now = new Date();

    const csDept = await CsAccessService.csDepartment();
    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: csDept._id, permissions: ["leads:view:own"] });
    created.roles.push(icRole._id);
    const mgr = await Admin.create({ name: `${TAG}-mgr`, email: `${TAG}-m@x.com`, phone: `${TAG}m`, password: "x", roles: ["sales"], status: "active", roleId: icRole._id });
    const csm = await Admin.create({ name: `${TAG}-csm`, email: `${TAG}-c@x.com`, phone: `${TAG}c`, password: "x", roles: ["sales"], status: "active", roleId: icRole._id, departmentId: csDept._id, reportingManagerId: mgr._id });
    created.admins.push(mgr._id, csm._id);

    // ── create + board grouping ──
    const i1 = await ContentPostService.create({ title: `${TAG} idea one`, desc: "reel idea" }, csm._id);
    const n1 = await ContentPostService.create({ title: `${TAG} next A`, column: "next_week" }, csm._id);
    const n2 = await ContentPostService.create({ title: `${TAG} next B`, column: "next_week", slot: "Wed" }, csm._id);
    const t1 = await ContentPostService.create({ title: `${TAG} this leftover`, column: "this_week" }, csm._id);
    const t2 = await ContentPostService.create({ title: `${TAG} this posted`, column: "this_week", slot: "Mon" }, csm._id);
    created.posts.push(i1._id, n1._id, n2._id, t1._id, t2._id);
    ok(n1.order < n2.order, "orders append within a column");
    let rejected = null;
    try { await ContentPostService.create({ title: `${TAG} nope`, column: "posted" }, csm._id); } catch (e) { rejected = e; }
    ok(rejected && rejected.status === 400, "cannot create directly into posted");

    const b0 = await ContentPostService.board();
    const mineIn = (col) => b0.columns[col].filter((p) => p.title.startsWith(TAG));
    ok(mineIn("ideas").length === 1 && mineIn("next_week").length === 2 && mineIn("this_week").length === 2, "board groups by column");

    // ── posting stamps ──
    const t2posted = await ContentPostService.patch(t2._id, { column: "posted" });
    ok(!!t2posted.postedAt && t2posted.onTime === true, "posting stamps postedAt + onTime=true (never overdue)");

    // ── Monday roll ──
    const roll1 = await ContentPostService.mondayRoll(now, { force: true });
    ok(roll1.rolled === 2, `roll moves next_week → this_week (${roll1.rolled})`);
    const t1After = await ContentPost.findById(t1._id).lean();
    ok(t1After.overdue === true && !!t1After.flaggedAt, "unposted this_week card flagged overdue");
    const mgrNotifs = await AdminNotification.countDocuments({ adminId: mgr._id, type: "content_overdue", "payload.contentPostId": String(t1._id) });
    ok(mgrNotifs === 1, "CS manager notified once about the missed card");
    const n1After = await ContentPost.findById(n1._id).lean();
    const n2After = await ContentPost.findById(n2._id).lean();
    ok(n1After.column === "this_week" && n2After.column === "this_week", "rolled cards land in this_week");
    ok(n1After.order < n2After.order && n1After.order > t1After.order, "roll preserves relative order after existing cards");

    // second roll (≈ next Monday) — the freshly-rolled cards n1/n2 sat a week
    // unposted so they flag NOW (correct); t1 must NOT be re-flagged.
    const roll2 = await ContentPostService.mondayRoll(now, { force: true });
    ok(roll2.flaggedOverdue === 2, `next roll flags the week's leftovers, not t1 again (${roll2.flaggedOverdue})`);
    const mgrNotifs2 = await AdminNotification.countDocuments({ adminId: mgr._id, type: "content_overdue", "payload.contentPostId": String(t1._id) });
    ok(mgrNotifs2 === 1, "still exactly one manager notification");

    // ── overdue card posted late → onTime=false; onTimePct = 50 ──
    const t1posted = await ContentPostService.patch(t1._id, { column: "posted" });
    ok(t1posted.onTime === false, "posting an overdue card stamps onTime=false");
    const b1 = await ContentPostService.board();
    const minePosted = b1.columns.posted.filter((p) => p.title.startsWith(TAG));
    ok(minePosted.length === 2, "posted column carries both posted cards");
    // onTimePct is global (new collection: only this suite's posts exist)
    ok(b1.onTimePct === 50, `onTimePct = posted-on-time / posted (${b1.onTimePct})`);

    // ── stale ideas: trigger + dedupe + re-arm ──
    // Backdate ALL ideas/shortlisted activity 4d (driver-level: updatedAt is immutable via mongoose).
    await ContentPost.collection.updateMany(
      { column: { $in: ["ideas", "shortlisted"] } },
      { $set: { updatedAt: new Date(+now - 4 * DAY) } }
    );
    const s1 = await ContentPostService.staleIdeasSweep(now);
    ok(s1.stale === true && s1.notified === true, "3d-quiet pipeline triggers the stale nudge");
    const csmStale = await AdminNotification.countDocuments({ adminId: csm._id, type: "content_stale", createdAt: { $gte: START } });
    ok(csmStale === 1, "CS member nudged");
    const s2 = await ContentPostService.staleIdeasSweep(now);
    ok(s2.stale === true && s2.notified === false, "same episode does not re-notify");
    // new activity re-arms the episode
    await ContentPostService.patch(i1._id, { desc: "fresh thought" });
    const s3 = await ContentPostService.staleIdeasSweep(now);
    ok(s3.stale === false, "fresh activity ends the episode (no longer stale)");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await ContentPost.deleteMany({ _id: { $in: created.posts } }).catch(() => {});
    await EscalationMark.deleteMany({ kind: "content", createdAt: { $gte: START } }).catch(() => {});
    await AdminNotification.deleteMany({ type: { $in: ["content_overdue", "content_stale"] }, createdAt: { $gte: START } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
