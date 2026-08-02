// BUILD & BILL BATCH 2 test. Run: node tests/build-bill-batch2.test.js
// Covers: Bug 51+53 day-propagation heal (new lead function → empty draft day,
// per-function granularity, idempotent, existing items untouched, orphan flag,
// locked drafts not healed); Bug 50 admin upload path (S3 stubbed — admin key
// under os/, venue key unchanged); Bug 57 includedInTotal (write/patch/read,
// totals + discount basis + earnings basis); Bug 54 eventTotals ES/TS shape;
// Bug 49a discount gate disabled (over-band applies immediately).
require("dotenv").config();
const mongoose = require("mongoose");

// Stub S3 BEFORE the file controller is exercised — no real AWS calls.
const AWSS3 = require("@aws-sdk/client-s3");
const putCalls = [];
AWSS3.S3.prototype.putObject = async function (args) { putCalls.push(args); return {}; };

const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Decor = require("../models/Decor");
const Event = require("../models/Event");
const DealDiscount = require("../models/DealDiscount");
const AdminNotification = require("../models/AdminNotification");
const LeadPlan = require("../models/LeadPlan");
const PlanSnapshot = require("../models/PlanSnapshot");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const SettingsService = require("../services/SettingsService");
const DraftEventService = require("../services/DraftEventService");
const PlanSnapshotService = require("../services/PlanSnapshotService");
const fileController = require("../controllers/file");
const { eventTotals } = require("../utils/eventDecorPricing");

const TAG = `bbb2-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

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
      qualificationData: {
        eventDays: [{ date: "2026-11-20", functions: [{ type: "Haldi", time: "10 AM", venue: "Home" }] }],
      },
    });
    created.leads.push(lead._id);
    const decor = await Decor.create({
      category: "Stage", name: `${TAG}-stage`, unit: "unit", tags: [], image: "s.jpg", thumbnail: "s.jpg", rating: 0,
      productTypes: [{ name: "Standard", costPrice: 400, sellingPrice: 1000 }],
    });
    created.decors.push(decor._id);

    // ── Bug 51+53: day propagation heal ──
    const draft = await DraftEventService.createDraft(lead._id, { name: "Heal" }, admin._id);
    created.events.push(draft._id);
    let detail = await DraftEventService.getDraftDetail(lead._id, draft._id);
    ok(detail.days.length === 1 && detail.days[0].name === "Haldi", "draft seeded with the original discovery day");
    const haldiDayId = detail.days[0]._id || (await Event.findById(draft._id).lean()).eventDays[0]._id;
    await DraftEventService.addItem(lead._id, draft._id, haldiDayId, { decorId: decor._id, quantity: 1 }, admin._id);

    // the lead grows: a SECOND function on the same date + a new day
    await Enquiry.updateOne({ _id: lead._id }, {
      $set: {
        "qualificationData.eventDays": [
          { date: "2026-11-20", functions: [{ type: "Haldi", time: "10 AM", venue: "Home" }, { type: "Mehendi", time: "4 PM", venue: "Lawn" }] },
          { date: "2026-11-21", functions: [{ type: "Sangeet", time: "7 PM", venue: "Hall" }] },
        ],
      },
    });
    detail = await DraftEventService.getDraftDetail(lead._id, draft._id);
    ok(detail.days.length === 3, `heal adds the missing functions as days (${detail.days.length})`);
    const mehendi = detail.days.find((d) => d.name === "Mehendi");
    const sangeet = detail.days.find((d) => d.name === "Sangeet");
    ok(!!mehendi && mehendi.decorItems.length === 0 && mehendi.venue === "Lawn",
      "second function on the SAME date healed as its own EMPTY day (per-function granularity)");
    ok(!!sangeet && sangeet.date === "2026-11-21", "new lead day healed with its date");
    const haldi = detail.days.find((d) => d.name === "Haldi");
    ok(haldi.decorItems.length === 1, "existing day + its items untouched by the heal");
    ok(detail.days.every((d) => d.orphaned === false), "every day matches discovery → nothing flagged orphaned");
    const detailAgain = await DraftEventService.getDraftDetail(lead._id, draft._id);
    ok(detailAgain.days.length === 3, "idempotent — a second read adds nothing");

    // the lead DROPS Haldi (which has items) → day stays, flagged orphaned
    await Enquiry.updateOne({ _id: lead._id }, {
      $set: {
        "qualificationData.eventDays": [
          { date: "2026-11-20", functions: [{ type: "Mehendi", time: "4 PM", venue: "Lawn" }] },
          { date: "2026-11-21", functions: [{ type: "Sangeet", time: "7 PM", venue: "Hall" }] },
        ],
      },
    });
    detail = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const haldi2 = detail.days.find((d) => d.name === "Haldi");
    ok(!!haldi2 && haldi2.decorItems.length === 1 && haldi2.orphaned === true,
      "a dropped lead function NEVER deletes the draft day — it survives, flagged orphaned");
    ok(detail.days.find((d) => d.name === "Mehendi").orphaned === false, "live days stay unflagged");

    // locked drafts are frozen — not healed
    await Event.updateOne({ _id: draft._id }, { $set: { locked: true } });
    await Enquiry.updateOne({ _id: lead._id }, {
      $push: { "qualificationData.eventDays": { date: "2026-11-22", functions: [{ type: "Reception", time: "7 PM", venue: "Hall" }] } },
    });
    detail = await DraftEventService.getDraftDetail(lead._id, draft._id);
    ok(!detail.days.some((d) => d.name === "Reception"), "a LOCKED draft is not healed (frozen bill)");
    await Event.updateOne({ _id: draft._id }, { $set: { locked: false } });

    // ── Bug 50: admin upload path ──
    const png = Buffer.from("fakepngdata").toString("base64");
    const up1 = await call(fileController.VenueOwnerUpload, {
      admin: { _id: String(admin._id), isAdmin: true },
      body: { filename: "setup.pdf", mimeType: "application/pdf", data: png, category: "build-bill" },
    });
    ok(up1.status === 200 && typeof up1.body.url === "string" && up1.body.url.includes("/os/build-bill/"),
      "ADMIN upload succeeds → S3 key under os/<category>/ (was: TypeError → 400)");
    const up2 = await call(fileController.VenueOwnerUpload, {
      venueOwner: { venueId: "venue123", type: "venue_owner" },
      body: { filename: "hall.pdf", mimeType: "application/pdf", data: png, category: "docs" },
    });
    ok(up2.status === 200 && up2.body.url.includes("/venues/venue123/docs/"),
      "venue-owner upload path unchanged (venues/<venueId>/<category>/)");

    // ── Bug 57: includedInTotal ──
    const day2 = await DraftEventService.addDay(lead._id, draft._id, { name: "AltDay" }, admin._id);
    const kept = await DraftEventService.addItem(lead._id, draft._id, day2._id, { decorId: decor._id, quantity: 2 }, admin._id);
    const alt = await DraftEventService.addItem(lead._id, draft._id, day2._id, { decorId: decor._id, quantity: 3, includedInTotal: false }, admin._id);
    ok(kept.includedInTotal === true && alt.includedInTotal === false, "flag accepted on ADD; default true");
    ok(alt.price === 3000, "the alternative's own line price still computes");
    let evDoc = await Event.findById(draft._id).lean();
    let totals = await DraftEventService.totalsFor(evDoc);
    const dayRow = totals.days.find((d) => d.name === "AltDay");
    ok(dayRow.decorItems === 2000 && dayRow.total === 2000, "day total sums ONLY the checked item");
    // discount % basis = included items only
    await SettingsService.set("dealDiscount.freePct", 5, null);
    const grossBefore = totals.gross;
    const disc = await PlanSnapshotService.grantDiscount(lead._id, draft._id, { pct: 10 }, admin._id);
    ok(disc.amount === Math.round(grossBefore * 0.1),
      `10% discount computed off the included-only gross (₹${disc.amount} of ₹${grossBefore})`);
    // Bug 49a — over-band discount applies IMMEDIATELY (hold disabled)
    ok(disc.status === "approved" && !!disc.decidedAt, "10% (> 5% free band) is auto-approved — no pending hold");
    totals = await DraftEventService.totalsFor(await Event.findById(draft._id).lean());
    ok(totals.net === Math.max(0, totals.gross - disc.amount), "the discount lands in net immediately");
    // earnings basis = included only
    const earn = await DraftEventService.draftEarnings(lead._id, draft._id);
    const stage = earn.categories.find((c) => c.category === "Stage");
    ok(stage.sp === 3000 && stage.cp === 1200,
      "earnings basis excludes the alternative (sp = haldi 1000 + kept 2000; cp = 3×400)");
    // patch the flag back on → totals pick it up
    const flipped = await DraftEventService.patchItem(lead._id, draft._id, day2._id, alt._id, { includedInTotal: true }, admin._id);
    ok(flipped.includedInTotal === true, "flag PATCHes through the item write");
    totals = await DraftEventService.totalsFor(await Event.findById(draft._id).lean());
    ok(totals.days.find((d) => d.name === "AltDay").decorItems === 5000, "re-checked → sums again");

    // ── Bug 54: eventTotals ES/TS shape ──
    await DraftEventService.addCustomItem(lead._id, draft._id, day2._id, { name: "Valet", price: 700, includeInTotalSummary: true });
    await DraftEventService.addCustomItem(lead._id, draft._id, day2._id, { name: "Normal custom", price: 200 });
    await DraftEventService.addMandatoryItem(lead._id, draft._id, day2._id, { title: "Cleaning", price: 300, itemRequired: true, includeInTotalSummary: true });
    evDoc = await Event.findById(draft._id).lean();
    const t = eventTotals(evDoc);
    const valet = t.eventLevelItems.find((i) => i.name === "Valet");
    const clean = t.eventLevelItems.find((i) => i.name === "Cleaning");
    ok(!!valet && valet.kind === "custom" && valet.price === 700 && !!valet.dayId,
      "TS custom item itemized at EVENT level with name + day pointer");
    ok(!!clean && clean.kind === "mandatory" && clean.price === 300, "TS mandatory (required) itemized at event level");
    const altRow = t.days.find((d) => d.name === "AltDay");
    ok(altRow.customItems === 200, "ES/normal custom stays in its DAY row");
    ok(t.grandTotal === t.days.reduce((s, d) => s + d.total, 0) + t.eventLevelTotal,
      "grandTotal = Σ day totals + event-level TS lines");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await SettingsService.set("dealDiscount.freePct", 5, null).catch(() => {});
      await DealDiscount.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
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
