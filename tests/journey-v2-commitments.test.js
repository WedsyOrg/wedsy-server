/**
 * Journey v2 — V8: commitments read + lead-row marks.
 *
 *   node tests/journey-v2-commitments.test.js
 *
 * Both follow-up stores + open tasks in one flat read (due-first, lane names,
 * owners); row marks scoped (own vs manager+), snoozed → zeros, and the no-N+1
 * guarantee asserted by COUNTING actual Mongo queries for a 6-lead page.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Followup = require("../models/Followup");
const LeadTask = require("../models/LeadTask");
const LeadLane = require("../models/LeadLane");
const CommitmentService = require("../services/CommitmentService");

const TAG = `jv2commit-${Date.now()}`;
const DAY_MS = 24 * 3600 * 1000;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const created = { leads: [], admins: [] };
  try {
    const owner = await Admin.create({
      name: `${TAG}-owner`, email: `${TAG}-o@x.com`, phone: `${TAG}o`, password: "x",
      roles: ["sales"], status: "active",
    });
    const intern = await Admin.create({
      name: `${TAG}-intern`, email: `${TAG}-i@x.com`, phone: `${TAG}i`, password: "x",
      roles: ["sales"], status: "active",
    });
    created.admins.push(owner._id, intern._id);

    const lead = await Enquiry.create({
      name: `${TAG}-couple`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
      assignedTo: owner._id,
      followUps: [
        { type: "call", scheduledAt: new Date(Date.now() - 1 * DAY_MS), createdBy: intern._id }, // overdue, intern's
        { type: "meet", scheduledAt: new Date(Date.now() + 5 * DAY_MS), createdBy: owner._id, completedAt: null },
        { type: "call", scheduledAt: new Date(Date.now() - 3 * DAY_MS), createdBy: owner._id, completedAt: new Date() }, // done — ignored
      ],
    });
    created.leads.push(lead._id);
    const lane = await LeadLane.create({
      leadId: lead._id, key: "decor", name: "Décor", state: "active", ownerId: owner._id,
    });
    await Followup.create({ leadId: lead._id, title: `${TAG} journey today`, dueAt: new Date(), ownerId: owner._id, status: "open" });
    await Followup.create({ leadId: lead._id, title: `${TAG} journey done`, dueAt: new Date(), ownerId: owner._id, status: "done" });
    await LeadTask.create({ leadId: lead._id, title: `${TAG} task overdue`, assigneeId: owner._id, assignerId: owner._id, status: "open", dueAt: new Date(Date.now() - 2 * DAY_MS), laneId: lane._id });
    await LeadTask.create({ leadId: lead._id, title: `${TAG} task done`, assigneeId: owner._id, assignerId: owner._id, status: "done", dueAt: new Date() });

    // ── The flat commitments read ─────────────────────────────────────────────
    const items = await CommitmentService.listCommitments(String(lead._id));
    ok(items.length === 4, `open items only: 2 cadence + 1 journey + 1 task (got ${items.length})`);
    ok(items.every((i) => ["task", "followup"].includes(i.kind)), "kinds are task|followup");
    const stores = items.filter((i) => i.kind === "followup").map((i) => i.store).sort();
    ok(JSON.stringify(stores) === JSON.stringify(["cadence", "cadence", "journey"]), "BOTH follow-up stores present + tagged");
    const task = items.find((i) => i.kind === "task");
    ok(task.laneName === "Décor" && task.laneKey === "decor" && String(task.laneId) === String(lane._id),
      "task rows carry laneId/laneName/laneKey");
    ok(task.ownerName === `${TAG}-owner` && task.overdue === true, "owners resolved + overdue derived");
    const dued = items.filter((i) => i.dueAt).map((i) => +new Date(i.dueAt));
    ok(JSON.stringify(dued) === JSON.stringify([...dued].sort((a, b) => a - b)), "sorted due-first");

    // ── Row marks: scoping ───────────────────────────────────────────────────
    // Manager+ (team scope): everything counts. today: journey(1); overdue: cadence(1) + task(1).
    let marks = await CommitmentService.rowMarks([await Enquiry.findById(lead._id).lean()], { scope: "team", callerId: owner._id });
    let m = marks.get(String(lead._id));
    ok(m.dueToday === 1 && m.overdue === 2, `manager+ counts ALL commitments (got ${JSON.stringify(m)})`);
    // Intern own-scope: only THEIR items — the overdue cadence call they created.
    marks = await CommitmentService.rowMarks([await Enquiry.findById(lead._id).lean()], { scope: "own", callerId: intern._id });
    m = marks.get(String(lead._id));
    ok(m.dueToday === 0 && m.overdue === 1, `own scope counts only the caller's items (got ${JSON.stringify(m)})`);
    // Snoozed → zeros.
    const snoozedDoc = { ...(await Enquiry.findById(lead._id).lean()), snoozedUntil: new Date(Date.now() + 40 * DAY_MS) };
    marks = await CommitmentService.rowMarks([snoozedDoc], { scope: "team", callerId: owner._id });
    m = marks.get(String(lead._id));
    ok(m.dueToday === 0 && m.overdue === 0, "snoozed lead reads zeros");

    // ── No N+1: count actual queries for a 6-lead page ───────────────────────
    const page = [await Enquiry.findById(lead._id).lean()];
    for (let i = 0; i < 5; i++) {
      const extra = await Enquiry.create({
        name: `${TAG}-extra${i}`, phone: `${TAG}-x${i}`, verified: false, isInterested: false,
        isLost: false, stage: "new", source: "Default", lostStatus: "none", assignedTo: owner._id,
        followUps: [{ type: "call", scheduledAt: new Date(), createdBy: owner._id }],
      });
      created.leads.push(extra._id);
      await LeadTask.create({ leadId: extra._id, title: `${TAG} t${i}`, assigneeId: owner._id, assignerId: owner._id, status: "open", dueAt: new Date() });
      page.push(await Enquiry.findById(extra._id).lean());
    }
    let queryCount = 0;
    mongoose.set("debug", () => { queryCount += 1; });
    const bigMarks = await CommitmentService.rowMarks(page, { scope: "team", callerId: owner._id });
    mongoose.set("debug", false);
    ok(queryCount === 2, `6-lead page costs EXACTLY 2 queries (got ${queryCount}) — no N+1`);
    ok([...bigMarks.values()].filter((v) => v.dueToday > 0).length >= 5, "marks computed for every lead on the page");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    mongoose.set("debug", false);
    await Followup.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadTask.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadLane.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
