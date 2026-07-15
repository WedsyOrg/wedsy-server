// W2 — MY WORK test. Run: node tests/my-work.test.js
// Covers: ranking ladder (overdue → respond → due-today → triage → upcoming),
// BOTH follow-up stores, snooze exclusion + waking inclusion, triage gating,
// schedule day-grouping + wake-date inclusion, and fixed query counts (no N+1).
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const Followup = require("../models/Followup");
const LeadTask = require("../models/LeadTask");
const CalendarEvent = require("../models/CalendarEvent");
const MyWorkService = require("../services/MyWorkService");
const { istDayStart, toIstWallClock } = require("../utils/goldenWindow");

const TAG = `mywork-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const dayKey = (d) => toIstWallClock(new Date(d)).toISOString().slice(0, 10);

const created = { leads: [], admins: [], roles: [], depts: [], events: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const nowD = new Date();
    const todayStart = istDayStart(nowD);

    // ── Fixtures ──
    const dept = await Department.create({ name: `${TAG}-dept`, slug: `${TAG}-d` });
    created.depts.push(dept._id);
    const icRole = await Role.create({ name: `${TAG}-ic`, departmentId: dept._id, permissions: ["leads:view:own"] });
    const triageRole = await Role.create({ name: `${TAG}-lead`, departmentId: dept._id, permissions: ["leads:view:own", "leads:triage:all"] });
    created.roles.push(icRole._id, triageRole._id);

    const mkAdmin = (s, roleId) =>
      Admin.create({ name: `${TAG}-${s}`, email: `${TAG}-${s}@x.com`, phone: `${TAG}${s}`, password: "x", roles: ["sales"], status: "active", roleId, departmentId: dept._id });
    const owner = await mkAdmin("owner", icRole._id);
    const triager = await mkAdmin("triager", triageRole._id);
    created.admins.push(owner._id, triager._id);

    const mkLead = (s, extra = {}) =>
      Enquiry.create({
        name: `${TAG}-${s}`, phone: `${TAG}-${s}`, verified: false, isInterested: false,
        isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
        assignedTo: owner._id, firstRespondedAt: new Date(+nowD - DAY), ...extra,
      });

    // L1 — overdue cadence follow-up (yesterday).
    const L1 = await mkLead("overdue-cadence", {
      followUps: [{ type: "call", scheduledAt: new Date(+todayStart - 3600e3), promiseNote: "chase venue", createdBy: owner._id }],
    });
    // L2 — respond-now (fresh, never responded).
    const L2 = await mkLead("respond", { stage: "new", firstRespondedAt: null });
    // L3 — journey follow-up due today (a bit earlier than now, but after day start → due-today not overdue).
    const L3 = await mkLead("journey-today", {});
    await Followup.create({ leadId: L3._id, title: `${TAG} send moodboard`, dueAt: new Date(+todayStart + 3600e3), ownerId: owner._id, status: "open" });
    // L4 — task due in 3 days (upcoming).
    const L4 = await mkLead("task-upcoming", {});
    await LeadTask.create({ leadId: L4._id, title: `${TAG} prep proposal`, assigneeId: owner._id, assignerId: owner._id, dueAt: new Date(+nowD + 3 * DAY), status: "open" });
    // L5 — PARKED far out (30d): journey follow-up due today must be EXCLUDED.
    const L5 = await mkLead("parked", { snoozedUntil: new Date(+nowD + 30 * DAY) });
    await Followup.create({ leadId: L5._id, title: `${TAG} parked touch`, dueAt: new Date(+todayStart + 3600e3), ownerId: owner._id, status: "open" });
    // L6 — WAKING (snoozedUntil tomorrow, inside the warn window): INCLUDED.
    const L6 = await mkLead("waking", { snoozedUntil: new Date(+nowD + 1 * DAY) });
    await Followup.create({ leadId: L6._id, title: `${TAG} waking touch`, dueAt: new Date(+todayStart + 3600e3), ownerId: owner._id, status: "open" });
    // Triage lead — unassigned, pending.
    const LT = await Enquiry.create({
      name: `${TAG}-triage`, phone: `${TAG}-tri`, verified: false, isInterested: false,
      isLost: false, stage: "new", source: "Default", lostStatus: "none",
      assignedTo: null, triagePending: true,
    });
    created.leads.push(L1._id, L2._id, L3._id, L4._id, L5._id, L6._id, LT._id);

    // ── /my-work/now — owner ──
    const q = await MyWorkService.now(owner._id);
    const mine = q.items.filter((i) => (i.leadName || "").startsWith(TAG));
    const kindsInOrder = mine.map((i) => `${i.kind}:${i.urgencyRank}`);
    console.log("    queue:", kindsInOrder.join(" · "));

    const find = (doc) => mine.find((i) => i.leadId === String(doc._id));
    ok(!!find(L1) && find(L1).urgencyRank === 0 && find(L1).overdue, "overdue cadence ranks 0 (overdue)");
    ok(!!find(L2) && find(L2).kind === "respond" && find(L2).urgencyRank === 1, "respond-now ranks 1");
    ok(!!find(L3) && find(L3).store === "journey" && find(L3).urgencyRank === 2, "journey due-today ranks 2");
    ok(!!find(L4) && find(L4).kind === "task" && find(L4).urgencyRank === 4, "task in 3d ranks 4 (upcoming)");
    ok(!find(L5), "parked lead (far snooze) is EXCLUDED from the queue");
    ok(!!find(L6), "waking lead (snooze inside warn window) is INCLUDED");
    const ranks = mine.map((i) => i.urgencyRank);
    ok(ranks.every((r, i) => i === 0 || ranks[i - 1] <= r), "queue is sorted by urgencyRank");
    ok(mine.every((i) => i.leadId && typeof i.title === "string"), "every item carries leadId + title");
    ok(!mine.some((i) => i.kind === "triage"), "no triage items for a caller without triage rights");
    ok(q.canTriage === false, "canTriage=false for the IC");

    // ── triage gating — triager ──
    const tq = await MyWorkService.now(triager._id);
    ok(tq.canTriage === true, "canTriage=true for the triage-rights caller");
    ok(tq.items.some((i) => i.kind === "triage" && i.leadId === String(LT._id)), "triager's queue contains the pending-triage lead");

    // ── query-count discipline (no N+1) ──
    let queries = 0;
    mongoose.set("debug", () => { queries += 1; });
    await MyWorkService.now(owner._id);
    const q1 = queries;
    // add three more journey follow-ups + two tasks → count must not grow
    for (let i = 0; i < 3; i++) {
      await Followup.create({ leadId: L3._id, title: `${TAG} extra ${i}`, dueAt: new Date(+todayStart + 2 * 3600e3), ownerId: owner._id, status: "open" });
    }
    for (let i = 0; i < 2; i++) {
      await LeadTask.create({ leadId: L4._id, title: `${TAG} extra task ${i}`, assigneeId: owner._id, assignerId: owner._id, dueAt: new Date(+nowD + 2 * DAY), status: "open" });
    }
    queries = 0;
    await MyWorkService.now(owner._id);
    const q2 = queries;
    mongoose.set("debug", false);
    console.log(`    queries: ${q1} → ${q2}`);
    // +1 tolerance: the settings cache (5-min TTL) can expire between runs and
    // add one read — what matters is the count not scaling with item count
    // (5 extra items would otherwise mean 5+ extra queries).
    ok(q2 <= q1 + 1, `query count does not scale with item count (${q1} → ${q2})`);

    // ── /my-work/schedule ──
    const meetAt = new Date(+todayStart + 2 * DAY + 11 * 3600e3);
    const ev = await CalendarEvent.create({
      ownerId: owner._id, type: "gmeet", title: `${TAG} intro call`, start: meetAt,
      end: new Date(+meetAt + 3600e3), leadId: L4._id, status: "scheduled",
    });
    created.events.push(ev._id);
    // wake-date follow-up on a parked lead lands inside the range (+2d)
    const L7 = await mkLead("wake-sched", { snoozedUntil: new Date(+todayStart + 2 * DAY) });
    await Followup.create({ leadId: L7._id, title: `${TAG} wake touch`, dueAt: new Date(+todayStart + 2 * DAY + 3600e3), ownerId: owner._id, status: "open" });
    created.leads.push(L7._id);

    const sched = await MyWorkService.schedule(owner._id, { from: dayKey(todayStart), to: dayKey(new Date(+todayStart + 3 * DAY)) });
    ok(sched.days.length === 4, "dense day array covers every day in range");
    ok(sched.days.every((d, i) => i === 0 || d.date > sched.days[i - 1].date), "days are ordered");
    const dayOf = (at) => sched.days.find((d) => d.date === dayKey(at));
    const today = sched.days[0];
    ok(today.items.some((i) => i.store === "journey" && i.leadId === String(L3._id)), "journey follow-up appears on today");
    const meetDay = dayOf(meetAt);
    ok(!!meetDay && meetDay.items.some((i) => i.kind === "meeting" && i.eventId === String(ev._id)), "meeting appears on its IST day");
    ok(!!meetDay && meetDay.counts.meeting >= 1 && meetDay.counts.total >= meetDay.counts.meeting, "day counts add up");
    ok(sched.days.some((d) => d.items.some((i) => i.leadId === String(L7._id))), "parked lead's wake-date follow-up DOES appear on the schedule");
    ok(sched.overdue && sched.overdue.items.some((i) => i.leadId === String(L1._id)), "overdue block present (from<=today) and carries the overdue item");

    // future-only range → no overdue block
    const future = await MyWorkService.schedule(owner._id, { from: dayKey(new Date(+todayStart + 5 * DAY)), to: dayKey(new Date(+todayStart + 6 * DAY)) });
    ok(future.overdue === null, "future-only range omits the overdue block");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    mongoose.set("debug", false);
    await Followup.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadTask.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await CalendarEvent.deleteMany({ _id: { $in: created.events } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
    await Department.deleteMany({ _id: { $in: created.depts } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
