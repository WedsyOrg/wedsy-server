// L5 — CLIENT-TASKS PROXY test. Run: node tests/client-tasks.test.js
// The couple's WeddingMilestone timeline, proxied through the lead via the
// Onboarding leadId→eventId bridge. Covers: list, toggle (COMPLETED stamps
// completedAt; PENDING clears), cross-event rejection, no-bridge 404, and the
// activity echo.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Onboarding = require("../models/Onboarding");
const Event = require("../models/Event");
const User = require("../models/User");
const WeddingMilestone = require("../models/WeddingMilestone");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const leadPageV3 = require("../controllers/leadPageV3");

const TAG = `clienttasks-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

// Minimal express stand-ins for controller-level calls.
const call = async (handler, { params = {}, body = {}, query = {}, auth, scopeFilter = {} }) => {
  let statusCode = 200, payload = null;
  const res = { status(c) { statusCode = c; return this; }, json(p) { payload = p; return this; }, send(p) { payload = p; return this; } };
  await handler({ params, body, query, auth, scopeFilter }, res);
  return { statusCode, payload };
};

const created = { leads: [], admins: [], onboardings: [], milestones: [], events: [], users: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const admin = await Admin.create({ name: `${TAG}-admin`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "won", source: "Default", lostStatus: "none", assignedTo: admin._id,
    });
    const bareLead = await Enquiry.create({
      name: `${TAG}-bare`, phone: `${TAG}-bare`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: admin._id,
    });
    created.leads.push(lead._id, bareLead._id);

    // The timeline service asserts the Event EXISTS (even for admins) — give
    // the bridge a real minimal Event doc.
    const couple = await User.create({ name: `${TAG}-couple`, phone: `${TAG}-ph` });
    created.users.push(couple._id);
    const event = await Event.create({ user: couple._id, name: `${TAG} wedding` });
    created.events.push(event._id);
    const eventId = event._id;
    const otherEventId = new mongoose.Types.ObjectId();
    created.onboardings.push((await Onboarding.create({ leadId: lead._id, eventId }))._id);
    const t1 = await WeddingMilestone.create({ eventId, title: `${TAG} book the venue`, dueDate: new Date(), source: "AI" });
    const t2 = await WeddingMilestone.create({ eventId, title: `${TAG} taste the menu`, dueDate: new Date(), source: "Custom" });
    const foreign = await WeddingMilestone.create({ eventId: otherEventId, title: `${TAG} other`, dueDate: new Date(), source: "AI" });
    created.milestones.push(t1._id, t2._id, foreign._id);

    const auth = { user_id: admin._id, user: admin };
    const scopeFilter = { assignedTo: admin._id };

    // ── GET list ──
    const list = await call(leadPageV3.ListClientTasks, { params: { _id: String(lead._id) }, auth, scopeFilter });
    ok(list.statusCode === 200 && list.payload.eventId === String(eventId), "list resolves the event via the Onboarding bridge");
    ok(list.payload.tasks.length === 2, "list carries the couple's timeline tasks");

    // no bridge → empty, not an error
    const bare = await call(leadPageV3.ListClientTasks, { params: { _id: String(bareLead._id) }, auth, scopeFilter });
    ok(bare.statusCode === 200 && bare.payload.eventId === null && bare.payload.tasks.length === 0, "no linked event → empty list, 200");

    // ── PUT toggle ──
    const done = await call(leadPageV3.PutClientTask, {
      params: { _id: String(lead._id) }, body: { milestoneId: String(t1._id), status: "COMPLETED" }, auth, scopeFilter,
    });
    ok(done.statusCode === 200 && done.payload.task.status === "COMPLETED" && !!done.payload.task.completedAt, "COMPLETED stamps completedAt");
    const undone = await call(leadPageV3.PutClientTask, {
      params: { _id: String(lead._id) }, body: { milestoneId: String(t1._id), status: "PENDING" }, auth, scopeFilter,
    });
    ok(undone.statusCode === 200 && undone.payload.task.status === "PENDING" && undone.payload.task.completedAt === null, "PENDING clears completedAt");
    const act = await LeadActivityEvent.find({ leadId: lead._id, kind: "task" }).lean();
    ok(act.length === 2 && act.every((e) => e.voice === "wedsy"), "on-behalf toggles echo wedsy-voice task events");

    // cross-event rejection + missing bridge + bad id
    const cross = await call(leadPageV3.PutClientTask, {
      params: { _id: String(lead._id) }, body: { milestoneId: String(foreign._id), status: "COMPLETED" }, auth, scopeFilter,
    });
    ok(cross.statusCode === 404, "a milestone from another event is rejected (404)");
    const noBridge = await call(leadPageV3.PutClientTask, {
      params: { _id: String(bareLead._id) }, body: { milestoneId: String(t2._id), status: "COMPLETED" }, auth, scopeFilter,
    });
    ok(noBridge.statusCode === 404, "no linked event → 404 on write");
    const badId = await call(leadPageV3.PutClientTask, {
      params: { _id: String(lead._id) }, body: { milestoneId: "nope", status: "COMPLETED" }, auth, scopeFilter,
    });
    ok(badId.statusCode === 400, "malformed milestoneId → 400");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await WeddingMilestone.deleteMany({ _id: { $in: created.milestones } }).catch(() => {});
    await Onboarding.deleteMany({ _id: { $in: created.onboardings } }).catch(() => {});
    await Event.deleteMany({ _id: { $in: created.events } }).catch(() => {});
    await User.deleteMany({ _id: { $in: created.users } }).catch(() => {});
    await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
