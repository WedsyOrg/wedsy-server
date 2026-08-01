// BUILD & BILL — COLOURS + TERTIARY test (Bug 35). Run: node tests/build-bill-colors-tertiary.test.js
// Covers: GET /color palette shape; item tertiaryColor write/patch/read with
// echo discipline; the whole-event theme (partial write, clear, detail read,
// locked 409); and the pricing assertion — no colour field ever moves a price
// (item price + draft totals byte-identical before/after, and the pricing
// util's source references no colour at all).
require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");

const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Decor = require("../models/Decor");
const Event = require("../models/Event");
const Color = require("../models/Color");
const LeadPlan = require("../models/LeadPlan");
const PlanSnapshot = require("../models/PlanSnapshot");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const DraftEventService = require("../services/DraftEventService");
const colorController = require("../controllers/color");

const TAG = `bb35-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], leads: [], decors: [], events: [], colors: [] };

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
    created.decors.push(decor._id);

    // ── 1. GET /color shape ──
    const c1 = await Color.create({ title: `${TAG}-Deep Maroon` });
    created.colors.push(c1._id);
    const palette = await call(colorController.GetAll, { auth: { user_id: String(admin._id), isAdmin: true } });
    const mine = (Array.isArray(palette.body) ? palette.body : []).find((r) => r.title === `${TAG}-Deep Maroon`);
    ok(Array.isArray(palette.body) && !!mine && !!mine._id,
      "GET /color returns a bare array of {_id, title} rows (field is `title`)");

    // ── 2. item tertiaryColor ──
    const draft = await DraftEventService.createDraft(lead._id, { name: "Colours" }, admin._id);
    created.events.push(draft._id);
    const day = await DraftEventService.addDay(lead._id, draft._id, { name: "Sangeet" }, admin._id);
    const item = await DraftEventService.addItem(lead._id, draft._id, day._id, {
      decorId: decor._id, quantity: 2, primaryColor: "Red", tertiaryColor: "Gold",
    }, admin._id);
    ok(item.primaryColor === "Red" && item.tertiaryColor === "Gold",
      "tertiaryColor accepted on item ADD alongside primary");
    const priceBefore = item.price;
    const patched = await DraftEventService.patchItem(lead._id, draft._id, day._id, item._id, { secondaryColor: "Ivory" }, admin._id);
    ok(patched.tertiaryColor === "Gold" && patched.primaryColor === "Red" && patched.secondaryColor === "Ivory",
      "untouched patch echoes tertiary (same discipline as the other colours)");
    const patched2 = await DraftEventService.patchItem(lead._id, draft._id, day._id, item._id, { tertiaryColor: "Emerald" }, admin._id);
    ok(patched2.tertiaryColor === "Emerald", "tertiaryColor PATCHes through the OS item write");
    const detail = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const dItem = detail.days[0].decorItems[0];
    ok(dItem.tertiaryColor === "Emerald" && dItem.primaryColor === "Red",
      "draft detail exposes tertiaryColor next to primary/secondary");

    // ── 3. event-level theme ──
    let t = await DraftEventService.setEventTheme(lead._id, draft._id, { primaryColor: "Red", tertiaryColor: "Gold" }, admin._id);
    ok(t.eventTheme.primaryColor === "Red" && t.eventTheme.secondaryColor === "" && t.eventTheme.tertiaryColor === "Gold",
      "theme partial write sets only the sent keys");
    t = await DraftEventService.setEventTheme(lead._id, draft._id, { secondaryColor: "Ivory" }, admin._id);
    ok(t.eventTheme.primaryColor === "Red" && t.eventTheme.secondaryColor === "Ivory" && t.eventTheme.tertiaryColor === "Gold",
      "second partial write leaves the other slots intact");
    t = await DraftEventService.setEventTheme(lead._id, draft._id, { tertiaryColor: "" }, admin._id);
    ok(t.eventTheme.tertiaryColor === "", "empty string clears a slot");
    const detail2 = await DraftEventService.getDraftDetail(lead._id, draft._id);
    ok(detail2.eventTheme.primaryColor === "Red" && detail2.eventTheme.secondaryColor === "Ivory",
      "draft detail read exposes the event theme");
    // locked draft refuses the theme write
    await Event.updateOne({ _id: draft._id }, { $set: { locked: true } });
    let locked = null;
    try { await DraftEventService.setEventTheme(lead._id, draft._id, { primaryColor: "X" }, admin._id); } catch (e) { locked = e; }
    ok(locked && locked.status === 409, "locked draft → 409 on theme write");
    await Event.updateOne({ _id: draft._id }, { $set: { locked: false } });

    // ── 4. NO pricing impact ──
    const after = await Event.findById(draft._id).lean();
    const afterItem = after.eventDays[0].decorItems[0];
    ok(afterItem.price === priceBefore, `item price unchanged through every colour write (${afterItem.price})`);
    const totals = await DraftEventService.totalsFor(after);
    ok(totals.grandTotal === priceBefore, "draft grand total unchanged (colours are display-only)");
    const pricingSrc = fs.readFileSync(require.resolve("../utils/eventDecorPricing"), "utf8");
    ok(!/color/i.test(pricingSrc), "the pricing law's source references NO colour field at all");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await Color.deleteMany({ _id: { $in: created.colors } }).catch(() => {});
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
