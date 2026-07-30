// BUILD & BILL BACKEND test (G1–G5 patches). Run: node tests/build-bill-backend.test.js
// Covers: G3 earnings read (per-category CP from catalog variant costPrice ×
// qty, SP from stored line price, extras with cpKnown:false, mandatory
// itemRequired-only, totals) and the NO-LEAK assertion (draft detail + the
// published couple snapshot contain no costPrice anywhere); G1/G5 draft
// send-to-client + booking-reminder falling back to the LEAD's phone when
// Event.user is null (and 422 when neither exists); representative /event
// routes against a draft (lost, event-access, share link).
require("dotenv").config();
const mongoose = require("mongoose");

// Stub the WhatsApp sender BEFORE the event controller destructures it — the
// test must never fire a real template send.
const updateUtil = require("../utils/update");
const sent = [];
updateUtil.SendUpdate = (args) => { sent.push(args); };

const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Decor = require("../models/Decor");
const Event = require("../models/Event");
const EventShare = require("../models/EventShare");
const PlanSnapshot = require("../models/PlanSnapshot");
const LeadPlan = require("../models/LeadPlan");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const DraftEventService = require("../services/DraftEventService");
const eventController = require("../controllers/event");
const eventShareController = require("../controllers/eventShare");

const TAG = `buildbill-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

const created = { admins: [], leads: [], decors: [], events: [] };

const call = (fn, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      send(body) { resolve({ status: this.statusCode, body }); },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    fn(req, res);
  });

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const admin = await Admin.create({ name: `${TAG}-a`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false, isLost: false,
      stage: "qualified", source: "Default", lostStatus: "none", assignedTo: admin._id,
    });
    created.leads.push(lead._id);
    const decor = await Decor.create({
      category: "Stage", name: `${TAG}-stage`, unit: "unit", tags: [], image: "s.jpg", thumbnail: "s.jpg", rating: 0,
      productTypes: [{ name: "Standard", costPrice: 400, sellingPrice: 1000 }],
    });
    const decor2 = await Decor.create({
      category: "Mandap", name: `${TAG}-mandap`, unit: "unit", tags: [], image: "m.jpg", thumbnail: "m.jpg", rating: 0,
      productTypes: [{ name: "Premium", costPrice: 2500, sellingPrice: 6000 }],
    });
    created.decors.push(decor._id, decor2._id);

    const draft = await DraftEventService.createDraft(lead._id, { name: "Bill" }, admin._id);
    created.events.push(draft._id);
    const day = await DraftEventService.addDay(lead._id, draft._id, { name: "Sangeet" }, admin._id);
    await DraftEventService.addItem(lead._id, draft._id, day._id, { decorId: decor._id, quantity: 2 }, admin._id);
    await DraftEventService.addItem(lead._id, draft._id, day._id, { decorId: decor2._id, quantity: 1 }, admin._id);
    await DraftEventService.addCustomItem(lead._id, draft._id, day._id, { name: "LED wall", price: 500 });
    await DraftEventService.addMandatoryItem(lead._id, draft._id, day._id, { title: "Cleaning", price: 300, itemRequired: true });
    await DraftEventService.addMandatoryItem(lead._id, draft._id, day._id, { title: "Generator", price: 900, itemRequired: false });

    // ── G3: earnings ──
    const earn = await DraftEventService.draftEarnings(lead._id, draft._id);
    const stage = earn.categories.find((c) => c.category === "Stage");
    const mandap = earn.categories.find((c) => c.category === "Mandap");
    ok(stage && stage.cp === 800 && stage.sp === 2000 && stage.earnings === 1200 && stage.cpKnown === true,
      "Stage: cp = 2×400 catalog cost, sp = stored line price, earnings = sp−cp");
    ok(mandap && mandap.cp === 2500 && mandap.sp === 6000 && mandap.earnings === 3500,
      "Mandap: per-category split is independent");
    const custom = earn.extras.find((e) => e.key === "customItems");
    const mand = earn.extras.find((e) => e.key === "mandatoryItems");
    ok(custom && custom.sp === 500 && custom.cp === 0 && custom.cpKnown === false,
      "custom items: sp counted, cp honestly unknown (cpKnown:false)");
    ok(mand && mand.sp === 300, "mandatory: only itemRequired rows count (900 offer excluded)");
    eq(earn.totals.cp, 3300, "totals.cp");
    eq(earn.totals.sp, 8800, "totals.sp");
    eq(earn.totals.earnings, 5500, "totals.earnings");

    // ── G3: cost data NEVER in couple-facing reads ──
    const detail = await DraftEventService.getDraftDetail(lead._id, draft._id);
    ok(!JSON.stringify(detail).includes("costPrice"), "draft detail read carries NO costPrice anywhere");
    ok(!JSON.stringify(detail).includes("earnings"), "draft detail read carries NO earnings field");
    await DraftEventService.publishDraft(lead._id, draft._id, { pricingVisible: true }, admin._id);
    const snap = await DraftEventService.publishedSnapshotFor(lead._id, draft._id);
    ok(!JSON.stringify(snap.content).includes("costPrice"), "published couple snapshot carries NO costPrice");

    // ── G1/G5: send-to-client + reminder fall back to the LEAD phone ──
    sent.length = 0;
    const s1 = await call(eventController.SendEventToClient, { params: { _id: String(draft._id) }, auth: { user_id: String(admin._id), isAdmin: true } });
    ok(s1.status === 200 && sent.length === 1 && sent[0].parameters.phone === `${TAG}-ph`,
      "send-to-client on a user-less draft WhatsApps the LEAD's phone");
    ok(sent[0].parameters.link.includes(`/event/${draft._id}/view`), "…with the standard wedsy.in event view link");
    sent.length = 0;
    const s2 = await call(eventController.SendEventBookingReminder, { params: { _id: String(draft._id) }, auth: { user_id: String(admin._id), isAdmin: true } });
    ok(s2.status === 200 && sent.length === 1 && sent[0].parameters.phone === `${TAG}-ph`,
      "booking reminder falls back to the lead phone too");
    // an event with neither user nor lead → clean 422, no send
    const orphan = await Event.create({ user: null, name: `${TAG}-orphan`, eventDays: [] });
    created.events.push(orphan._id);
    sent.length = 0;
    const s3 = await call(eventController.SendEventToClient, { params: { _id: String(orphan._id) }, auth: { user_id: String(admin._id), isAdmin: true } });
    ok(s3.status === 422 && sent.length === 0, "no user + no lead → 422, nothing sent");

    // ── G1: representative /event routes against a DRAFT ──
    const l1 = await call(eventController.MarkEventLost, {
      params: { _id: String(draft._id) }, body: { lostResponse: "Test lost" },
      auth: { user_id: String(admin._id), isAdmin: true },
    });
    const afterLost = await Event.findById(draft._id, { status: 1, lostResponse: 1 }).lean();
    ok(l1.status === 200 && afterLost.status.lost === true && afterLost.lostResponse === "Test lost",
      "POST /event/:id/lost works against a draft");
    const a1 = await call(eventController.AddEventAccess, {
      params: { _id: String(draft._id) }, body: { phone: "+919999999999" },
      auth: { user_id: String(admin._id), isAdmin: true },
    });
    const afterAccess = await Event.findById(draft._id, { eventAccess: 1 }).lean();
    ok(a1.status === 200 && (afterAccess.eventAccess || []).includes("+919999999999"),
      "event-access add works against a draft");
    const sh = await call(eventShareController.CreateShare, {
      params: { _id: String(draft._id) }, body: { name: "Admin Share", relationship: "Admin" },
      auth: { user_id: String(admin._id), isAdmin: true },
    });
    ok(sh.status === 201 && sh.body.shareLink && sh.body.shareLink.includes(`/event/${draft._id}/view?share=`),
      "share link created for a draft → wedsy.in view URL with token");

    // ── AUDIT STAMPS: every /event action writes one event_action row ──
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const adminAuth = { user_id: String(admin._id), isAdmin: true };
    const draft2 = await DraftEventService.createDraft(lead._id, { name: "Audit" }, admin._id);
    created.events.push(draft2._id);
    const day2 = await DraftEventService.addDay(lead._id, draft2._id, { name: "Reception" }, admin._id);
    const d2 = String(draft2._id);
    const stampsFor = async (action) =>
      LeadInternalEvent.find({ leadId: lead._id, type: "event_action", "payload.eventId": d2, "payload.action": action }).lean();

    await call(eventController.FinalizeEvent, { params: { _id: d2 }, body: {}, auth: adminAuth });
    await call(eventController.ApproveEventDay, { params: { _id: d2, dayId: String(day2._id) }, body: {}, auth: adminAuth });
    await call(eventController.RemoveEventDayApproval, { params: { _id: d2, dayId: String(day2._id) }, body: {}, auth: adminAuth });
    await call(eventController.ApproveEventDay, { params: { _id: d2, dayId: String(day2._id) }, body: {}, auth: adminAuth });
    await call(eventController.ApproveEvent, { params: { _id: d2 }, body: { discount: 100 }, auth: adminAuth });
    await call(eventController.RemoveEventApproval, { params: { _id: d2 }, body: {}, auth: adminAuth });
    await call(eventController.RemoveEventFinalize, { params: { _id: d2 }, body: {}, auth: adminAuth });
    await call(eventController.UpdateCustomItemsInEventDay, {
      params: { _id: d2, dayId: String(day2._id) }, body: { customItems: [{ name: "Arch", price: 10 }] }, auth: adminAuth,
    });
    await call(eventController.UpdateMandatoryItemsInEventDay, {
      params: { _id: d2, dayId: String(day2._id) }, body: { mandatoryItems: [{ title: "Cleanup", price: 5 }] }, auth: adminAuth,
    });
    await call(eventController.SendEventToClient, { params: { _id: d2 }, auth: adminAuth });
    await call(eventController.SendEventBookingReminder, { params: { _id: d2 }, auth: adminAuth });
    await call(eventController.MarkEventLost, { params: { _id: d2 }, body: { lostResponse: "Audit lost" }, auth: adminAuth });
    await sleep(600); // stamps are fire-and-forget

    const expectOne = [
      "finalize", "unapprove_day", "approve", "unapprove", "remove_finalize",
      "custom_items_update", "mandatory_items_update", "send_to_client", "booking_reminder", "lost",
    ];
    for (const action of expectOne) {
      const rows = await stampsFor(action);
      ok(rows.length === 1 && String(rows[0].actorId) === String(admin._id) && rows[0].payload.by === "admin",
        `one "${action}" stamp with the admin actor`);
    }
    ok((await stampsFor("approve_day")).length === 2, "approve_day stamped once per action (2 calls → 2 rows)");

    // finalize_day is the couple-only route ({user} filter, no admin bypass):
    // exercise it as the client and expect actorId:null, by:"client".
    const coupleUser = await User.create({ name: `${TAG}-couple`, phone: `${TAG}-cp` });
    const coupleEvent = await Event.create({
      user: coupleUser._id, leadId: lead._id, name: `${TAG}-couple-ev`,
      eventDays: [{ name: "Day", date: "TBD", time: "TBD", venue: "TBD" }],
    });
    created.events.push(coupleEvent._id);
    const cDay = (await Event.findById(coupleEvent._id).lean()).eventDays[0];
    await call(eventController.FinalizeEventDay, {
      params: { _id: String(coupleEvent._id), dayId: String(cDay._id) }, body: {},
      auth: { user_id: String(coupleUser._id), isAdmin: false },
    });
    await sleep(400);
    const fd = await LeadInternalEvent.find({
      leadId: lead._id, type: "event_action", "payload.eventId": String(coupleEvent._id), "payload.action": "finalize_day",
    }).lean();
    ok(fd.length === 1 && fd[0].actorId === null && fd[0].payload.by === "client",
      "client-side finalize_day stamps actorId:null, by:client");

    // an event with NO leadId → the stamp skips silently
    const noLead = await Event.create({ user: coupleUser._id, name: `${TAG}-nolead`, eventDays: [] });
    created.events.push(noLead._id);
    await call(eventController.MarkEventLost, { params: { _id: String(noLead._id) }, body: { lostResponse: "x" }, auth: adminAuth });
    await sleep(400);
    ok((await LeadInternalEvent.countDocuments({ type: "event_action", "payload.eventId": String(noLead._id) })) === 0,
      "no leadId → no stamp, action still succeeds (silent skip)");
    await User.deleteOne({ _id: coupleUser._id }).catch(() => {});
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await EventShare.deleteMany({ event: { $in: created.events } }).catch(() => {});
      await PlanSnapshot.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadPlan.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await Event.deleteMany({ _id: { $in: created.events } }).catch(() => {});
      await Decor.deleteMany({ _id: { $in: created.decors } }).catch(() => {});
      await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
      await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
      await User.deleteMany({ phone: `${TAG}-ph` }).catch(() => {});
      await mongoose.disconnect();
    }
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
