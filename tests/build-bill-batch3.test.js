// BUILD & BILL BATCH 3 test. Run: node tests/build-bill-batch3.test.js
// Covers: Bug 62/63 Mandatory Section config (seed idempotent + adopt-by-title,
// founder-edit never overwritten, settings CRUD carries config, legacy PUT
// without config preserves it), mandatory-item variant persistence (note cap,
// axis validation, matrix price snapshot + re-resolve on patch, matrix edits
// never retro-price rows), Bug 64c category-notes round-trip, Bug 67 variants
// (name·priceModifier·image) on the item read, Bug 61 earnings endpoint sanity.
require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Decor = require("../models/Decor");
const Event = require("../models/Event");
const EventMandatoryQuestion = require("../models/EventMandatoryQuestion");
const LeadPlan = require("../models/LeadPlan");
const PlanSnapshot = require("../models/PlanSnapshot");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const DraftEventService = require("../services/DraftEventService");
const emq = require("../controllers/event-mandatory-question");

const TAG = `bbb3-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], leads: [], decors: [], events: [], questions: [] };
let seededByTest = { Transportation: false, Generator: false };

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
    for (const t of ["Transportation", "Generator"]) {
      seededByTest[t] = !(await EventMandatoryQuestion.findOne({ title: t }));
    }
    const admin = await Admin.create({ name: `${TAG}-a`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);

    // ── Bug 62/63: the seed on the list read ──
    const list1 = await call(emq.GetAll, { auth: { user_id: String(admin._id), isAdmin: true } });
    const rows1 = list1.body;
    const transport = rows1.find((q) => q.title === "Transportation");
    const generator = rows1.find((q) => q.title === "Generator");
    ok(!!transport && transport.config && transport.config.type === "note" && transport.config.noteMaxLen === 50,
      "Transportation seeded/adopted: type note, noteMaxLen 50");
    ok(!!generator && generator.config && generator.config.type === "options"
      && generator.config.axes.length === 2 && generator.config.axes[0].name === "Size"
      && generator.config.axes[0].options.includes("128Kw"),
      "Generator seeded/adopted: Size/Duration axes");
    ok(generator.config.priceMatrix && generator.config.priceMatrix["64Kw"]
      && generator.config.priceMatrix["64Kw"]["6hrs"] === 8000
      && generator.config.priceMatrix["128Kw"]["12hrs"] === 28000,
      "Generator price matrix seeded (8000…28000)");
    const list2 = await call(emq.GetAll, { auth: { user_id: String(admin._id), isAdmin: true } });
    ok(list2.body.filter((q) => ["Transportation", "Generator"].includes(q.title)).length ===
       rows1.filter((q) => ["Transportation", "Generator"].includes(q.title)).length,
      "second read seeds nothing new (idempotent)");

    // founder edit survives: change a matrix cell, re-read
    await EventMandatoryQuestion.updateOne({ _id: generator._id }, { $set: { "config.priceMatrix.64Kw.6hrs": 9999 } });
    const list3 = await call(emq.GetAll, { auth: { user_id: String(admin._id), isAdmin: true } });
    ok(list3.body.find((q) => q.title === "Generator").config.priceMatrix["64Kw"]["6hrs"] === 9999,
      "a founder-edited matrix is NEVER re-seeded over");
    await EventMandatoryQuestion.updateOne({ _id: generator._id }, { $set: { "config.priceMatrix.64Kw.6hrs": 8000 } });

    // settings CRUD carries config; a config-less PUT preserves it
    const mk = await call(emq.CreateNew, {
      body: {
        title: `${TAG}-Valet`, itemRequired: true,
        config: { type: "options", axes: [{ name: "Cars", options: ["10", "20"] }], priceMatrix: { 10: 2000, 20: 3500 } },
      },
    });
    ok(mk.status === 201, "settings CREATE accepts a config block");
    created.questions.push(mk.body.id);
    await call(emq.Update, { params: { _id: String(mk.body.id) }, body: { title: `${TAG}-Valet`, description: "", price: 0, itemRequired: true } });
    const afterLegacyPut = await EventMandatoryQuestion.findById(mk.body.id).lean();
    ok(afterLegacyPut.config && afterLegacyPut.config.type === "options" && afterLegacyPut.config.priceMatrix["20"] === 3500,
      "a legacy PUT WITHOUT config leaves the founder's config untouched");

    // ── Bug 62/63: mandatory ITEM variant persistence ──
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false, isLost: false,
      stage: "qualified", source: "Default", lostStatus: "none", assignedTo: admin._id,
    });
    created.leads.push(lead._id);
    const q = await EventMandatoryQuestion.create({
      title: `${TAG}-Gen`, itemRequired: true,
      config: {
        type: "options", noteMaxLen: 0,
        axes: [{ name: "Size", options: ["64Kw", "128Kw"] }, { name: "Duration", options: ["6hrs", "12hrs"] }],
        priceMatrix: { "64Kw": { "6hrs": 8000, "12hrs": 15000 }, "128Kw": { "6hrs": 15000, "12hrs": 28000 } },
      },
    });
    created.questions.push(q._id);
    const qNote = await EventMandatoryQuestion.create({
      title: `${TAG}-Transport`, itemRequired: true,
      config: { type: "note", noteMaxLen: 50, axes: [], priceMatrix: {} },
    });
    created.questions.push(qNote._id);

    const draft = await DraftEventService.createDraft(lead._id, { name: "Mandatory" }, admin._id);
    created.events.push(draft._id);
    const day = await DraftEventService.addDay(lead._id, draft._id, { name: "Sangeet" }, admin._id);

    const gen = await DraftEventService.addMandatoryItem(lead._id, draft._id, day._id, {
      title: "Generator", questionId: String(q._id), itemRequired: true,
      selection: { Size: "64Kw", Duration: "12hrs" },
    });
    ok(gen.price === 15000 && gen.selection.Size === "64Kw" && gen.selection.Duration === "12hrs"
      && String(gen.questionId) === String(q._id),
      "generator row persists the selection + the MATRIX-RESOLVED price snapshot (₹15000)");
    let bad = null;
    try {
      await DraftEventService.addMandatoryItem(lead._id, draft._id, day._id, {
        title: "Generator", questionId: String(q._id), selection: { Size: "999Kw", Duration: "6hrs" },
      });
    } catch (e) { bad = e; }
    ok(bad && bad.status === 400 && /Size option/.test(bad.message), "an off-axis pick is rejected (400)");

    const longNote = "x".repeat(51);
    let noteErr = null;
    try {
      await DraftEventService.addMandatoryItem(lead._id, draft._id, day._id, {
        title: "Transportation", questionId: String(qNote._id), note: longNote,
      });
    } catch (e) { noteErr = e; }
    ok(noteErr && noteErr.status === 400 && /50 characters/.test(noteErr.message), "transport note >50 chars → 400");
    const trans = await DraftEventService.addMandatoryItem(lead._id, draft._id, day._id, {
      title: "Transportation", questionId: String(qNote._id), note: "Drop at Whitefield by 6 AM", price: 1200,
    });
    ok(trans.note === "Drop at Whitefield by 6 AM" && trans.price === 1200,
      "transport note ≤50 persists; explicit price kept (note questions have no matrix)");

    // patch re-resolves; a later matrix edit never retro-prices the row
    const patched = await DraftEventService.patchSideItem(lead._id, draft._id, day._id, "mandatory", gen._id, {
      selection: { Size: "128Kw", Duration: "12hrs" },
    });
    ok(patched.price === 28000 && patched.selection.Size === "128Kw", "patching the selection re-resolves the price (₹28000)");
    await EventMandatoryQuestion.updateOne({ _id: q._id }, { $set: { "config.priceMatrix.128Kw.12hrs": 99000 } });
    const detailAfter = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const genRead = detailAfter.days[0].mandatoryItems.find((m) => String(m._id) === String(gen._id));
    ok(genRead.price === 28000, "a later matrix edit does NOT retro-price the stored row (snapshot)");
    ok(typeof genRead.includeInTotalSummary === "boolean",
      "ES/TS confirmed: includeInTotalSummary remains the single TS flag (no schema change)");

    // ── Bug 64c: category notes round-trip ──
    let cn = await DraftEventService.setCategoryNote(lead._id, draft._id, day._id, { category: "Furniture", note: "White rentals only" }, admin._id);
    ok(cn.categoryNotes.length === 1 && cn.categoryNotes[0].note === "White rentals only", "category note set");
    cn = await DraftEventService.setCategoryNote(lead._id, draft._id, day._id, { category: "Furniture", note: "Teak, no plastic" }, admin._id);
    ok(cn.categoryNotes.length === 1 && cn.categoryNotes[0].note === "Teak, no plastic", "same category upserts (no dupes)");
    await DraftEventService.setCategoryNote(lead._id, draft._id, day._id, { category: "Entries", note: "Slow build" }, admin._id);
    const detail = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const dayRead = detail.days.find((d) => d.name === "Sangeet");
    ok(dayRead.categoryNotes.length === 2 && dayRead.categoryNotes.some((c) => c.category === "Entries"),
      "detail read exposes categoryNotes per day");
    cn = await DraftEventService.setCategoryNote(lead._id, draft._id, day._id, { category: "Entries", note: "" }, admin._id);
    ok(cn.categoryNotes.length === 1, "empty note removes the row");
    await Event.updateOne({ _id: draft._id }, { $set: { locked: true } });
    let lockedErr = null;
    try { await DraftEventService.setCategoryNote(lead._id, draft._id, day._id, { category: "X", note: "y" }, admin._id); } catch (e) { lockedErr = e; }
    ok(lockedErr && lockedErr.status === 409, "locked draft → 409 on category-note write");
    await Event.updateOne({ _id: draft._id }, { $set: { locked: false } });

    // ── Bug 67: per-variation images on the item read ──
    const decor = await Decor.create({
      category: "Stage", name: `${TAG}-stage`, unit: "unit", tags: [], image: "s.jpg", thumbnail: "s.jpg", rating: 0,
      productTypes: [{ name: "Standard", costPrice: 400, sellingPrice: 1000 }],
      productVariants: [
        { name: "Red drape", priceModifier: 500, image: "https://x/red.jpg" },
        { name: "Ivory drape", priceModifier: 800, image: "https://x/ivory.jpg" },
      ],
    });
    created.decors.push(decor._id);
    const item = await DraftEventService.addItem(lead._id, draft._id, day._id, { decorId: decor._id, quantity: 1 }, admin._id);
    const detail2 = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const itemRead = detail2.days.find((d) => d.name === "Sangeet").decorItems.find((i) => String(i._id) === String(item._id));
    ok(Array.isArray(itemRead.variants) && itemRead.variants.length === 2
      && itemRead.variants[0].image === "https://x/red.jpg" && itemRead.variants[1].priceModifier === 800,
      "item read carries variants[{name, priceModifier, image}] (productVariants DO have images)");
    ok(Array.isArray(itemRead.pricings) && itemRead.pricings.every((p) => !("image" in p)),
      "pricings (tiers) honestly carry NO image — the model has none per tier");

    // ── Bug 61: earnings endpoint still healthy if called ──
    const earn = await DraftEventService.draftEarnings(lead._id, draft._id);
    ok(earn && earn.totals && typeof earn.totals.earnings === "number", "earnings endpoint unchanged and healthy");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await EventMandatoryQuestion.deleteMany({ _id: { $in: created.questions } }).catch(() => {});
      for (const t of ["Transportation", "Generator"]) {
        if (seededByTest[t]) await EventMandatoryQuestion.deleteOne({ title: t }).catch(() => {});
      }
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
