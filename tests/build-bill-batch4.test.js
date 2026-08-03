// BUILD & BILL BATCH 4 test. Run: node tests/build-bill-batch4.test.js
// Covers: Bug 69 legacy-question dedupe (unconfigured transport/generator
// look-alikes removed once configured rows exist; configured look-alikes and
// unrelated rows survive; idempotent) and Bug 74 variation pricing (modifier
// folds into the decorPrice snapshot; tier/variation re-resolution both ways;
// the planner's manual priceModifier lever stays independent; untouched
// patches keep the snapshot).
require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Decor = require("../models/Decor");
const Event = require("../models/Event");
const EventMandatoryQuestion = require("../models/EventMandatoryQuestion");
const LeadPlan = require("../models/LeadPlan");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const DraftEventService = require("../services/DraftEventService");
const emq = require("../controllers/event-mandatory-question");

const TAG = `bbb4-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], leads: [], decors: [], events: [], questions: [] };

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

    // ── Bug 69: legacy dedupe ──
    // plant a legacy look-alike (unconfigured), a CONFIGURED look-alike that
    // must survive, and an unrelated unconfigured row that must survive.
    const legacy = await EventMandatoryQuestion.create({ title: `Is transportation required? ${TAG}` });
    const configuredLookalike = await EventMandatoryQuestion.create({
      title: `Transportation Extra ${TAG}`,
      config: { type: "note", noteMaxLen: 40, axes: [], priceMatrix: {} },
    });
    const unrelated = await EventMandatoryQuestion.create({ title: `Valet parking ${TAG}` });
    created.questions.push(configuredLookalike._id, unrelated._id);

    const list1 = await call(emq.GetAll, { auth: { user_id: String(admin._id), isAdmin: true } });
    ok(list1.status === 200, "list read (seed + dedupe) succeeds");
    const titles = list1.body.map((q) => q.title);
    ok(!titles.includes(`Is transportation required? ${TAG}`),
      "legacy unconfigured transport look-alike REMOVED");
    ok(titles.includes(`Transportation Extra ${TAG}`),
      "a CONFIGURED look-alike is never touched");
    ok(titles.includes(`Valet parking ${TAG}`), "unrelated unconfigured rows survive");
    ok(titles.includes("Transportation") && titles.includes("Generator"),
      "the configured seed rows exist");
    const unconfiguredDupes = list1.body.filter(
      (q) => /transport|generator/i.test(q.title) && !(q.config && q.config.type)
    );
    ok(unconfiguredDupes.length === 0, "ZERO unconfigured transport/generator rows remain (no duplicates render)");
    const count1 = list1.body.length;
    const list2 = await call(emq.GetAll, { auth: { user_id: String(admin._id), isAdmin: true } });
    ok(list2.body.length === count1, "second run is a no-op (idempotent)");
    ok(!(await EventMandatoryQuestion.findOne({ _id: legacy._id })), "legacy row is gone from the store");

    // ── Bug 74: variation pricing ──
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false, isLost: false,
      stage: "qualified", source: "Default", lostStatus: "none", assignedTo: admin._id,
    });
    created.leads.push(lead._id);
    const decor = await Decor.create({
      category: "Stage", name: `${TAG}-stage`, unit: "unit", tags: [], image: "s.jpg", thumbnail: "s.jpg", rating: 0,
      productTypes: [{ name: "Standard", costPrice: 400, sellingPrice: 1000 }, { name: "Premium", costPrice: 2000, sellingPrice: 6000 }],
      productVariants: [
        { name: "Red drape", priceModifier: 500, image: "https://x/red.jpg" },
        { name: "Ivory drape", priceModifier: 800, image: "https://x/ivory.jpg" },
      ],
    });
    created.decors.push(decor._id);
    const draft = await DraftEventService.createDraft(lead._id, { name: "Variation" }, admin._id);
    created.events.push(draft._id);
    const day = await DraftEventService.addDay(lead._id, draft._id, { name: "Sangeet" }, admin._id);

    const item = await DraftEventService.addItem(lead._id, draft._id, day._id, {
      decorId: decor._id, quantity: 2, productVariant: "Premium", variant: "Red drape",
    }, admin._id);
    ok(item.decorPrice === 6500, "ADD: decorPrice = tier 6000 + variation +500");
    ok(item.price === 13000, "line = qty × folded decorPrice");
    ok(item.priceModifier === 0, "the planner's manual priceModifier lever untouched (0)");

    const v2 = await DraftEventService.patchItem(lead._id, draft._id, day._id, item._id, { variant: "Ivory drape" }, admin._id);
    ok(v2.decorPrice === 6800 && v2.price === 13600, "re-selecting the variation re-resolves (+800)");

    const v3 = await DraftEventService.patchItem(lead._id, draft._id, day._id, item._id, { productVariant: "Standard" }, admin._id);
    ok(v3.decorPrice === 1800, "a TIER change re-resolves WITH the current variation (1000 + 800)");

    const v4 = await DraftEventService.patchItem(lead._id, draft._id, day._id, item._id, { priceModifier: 200 }, admin._id);
    ok(v4.decorPrice === 1800 && v4.price === 2 * (1800 + 200),
      "manual priceModifier stacks as its own operand — snapshot untouched, no clash");

    const v5 = await DraftEventService.patchItem(lead._id, draft._id, day._id, item._id, { quantity: 3 }, admin._id);
    ok(v5.decorPrice === 1800 && v5.price === 3 * 2000, "an untouched patch keeps the folded snapshot");

    // the chooser data: variants[] carries the modifier for "+₹X" display
    const detail = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const read = detail.days[0].decorItems.find((i) => String(i._id) === String(item._id));
    ok(read.variants.length === 2 && read.variants.find((v) => v.name === "Ivory drape").priceModifier === 800,
      "item read variants[] carries priceModifier (FE renders '+₹800')");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await EventMandatoryQuestion.deleteMany({ _id: { $in: created.questions } }).catch(() => {});
      await EventMandatoryQuestion.deleteMany({ title: `Is transportation required? ${TAG}` }).catch(() => {});
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
