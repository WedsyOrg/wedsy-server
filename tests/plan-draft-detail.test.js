// PLANNER DÉCOR FE-GAPS test. Run: node tests/plan-draft-detail.test.js
// Covers:
//   1. DraftEventService.getDraftDetail — ONE draft with full day→item detail
//      (decor name/thumbnail hydrated, every editor field present, totals).
//   2. composeItem now persists setupLocationImage (+ user_notes/admin_notes),
//      round-tripping through add → getDraftDetail → patch.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const User = require("../models/User");
const Event = require("../models/Event");
const Decor = require("../models/Decor");
const DraftEventService = require("../services/DraftEventService");

const TAG = `pdetail-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], users: [], events: [], decors: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const admin = await Admin.create({ name: `${TAG}-admin`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: admin._id,
      qualificationData: { eventDays: [{ date: "2026-12-09", functions: [{ type: "Wedding", time: "19:00", venue: "Palace", space: "Lawn" }] }] },
    });
    created.leads.push(lead._id);

    const decor = await Decor.create({
      category: "Mandap", name: `${TAG}-mandap`, unit: "unit", tags: [],
      image: "m.jpg", thumbnail: "m-thumb.jpg", rating: 0,
      productTypes: [{ name: "Standard", costPrice: 500, sellingPrice: 1000 }],
    });
    created.decors.push(decor._id);

    // ── setup: a draft with a day + a decor item carrying editor fields ──
    const draft = await DraftEventService.createDraft(lead._id, { name: "Dream" }, admin._id);
    created.events.push(draft._id);
    const day = await DraftEventService.addDay(lead._id, draft._id, { name: "Wedding", date: "2026-12-09", time: "19:00", venue: "Palace" });
    const added = await DraftEventService.addItem(lead._id, draft._id, day._id, {
      decorId: decor._id, quantity: 2, category: "Mandap", variant: "Natural",
      platform: true, dimensions: { length: 10, breadth: 8 },
      addOns: [{ name: "Fairy lights", price: 3000 }, { name: "Loyalty", price: -1000 }],
      included: ["Setup", "Teardown"],
      user_notes: "Blush palette please", admin_notes: "Confirm crew of 4",
      setupLocationImage: "https://cdn.example/setup-ref.jpg",
    });

    // ── FIX 2: item write persisted the new + note fields ──
    ok(added.setupLocationImage === "https://cdn.example/setup-ref.jpg", "addItem persists setupLocationImage");
    ok(added.user_notes === "Blush palette please", "addItem persists user_notes");
    ok(added.admin_notes === "Confirm crew of 4", "addItem persists admin_notes");
    ok(Array.isArray(added.addOns) && added.addOns.length === 2, "addItem persists addOns (incl. negative)");

    // ── FIX 1: getDraftDetail returns the full day→item shape the table renders ──
    const detail = await DraftEventService.getDraftDetail(lead._id, draft._id);
    ok(detail.eventId === String(draft._id) && detail.origin === "os", "getDraftDetail: identity + origin");
    ok(detail.totals && typeof detail.totals.grandTotal === "number", "getDraftDetail: totals via eventDecorPricing");
    ok(Array.isArray(detail.days) && detail.days.length >= 1, "getDraftDetail: days[] present");

    const d = detail.days.find((x) => x.dayId === String(day._id));
    ok(!!d && d.functionKey === "wedding", "day carries lowercased functionKey");
    const it = d && d.decorItems.find((x) => x._id === String(added._id));
    ok(!!it, "the decor item is in the day");
    ok(it && it.name === `${TAG}-mandap`, "decor NAME hydrated from Decor");
    ok(it && it.thumbnail === "m-thumb.jpg", "decor THUMBNAIL hydrated from Decor");
    ok(it && it.variant === "Natural", "variant surfaced");
    ok(it && it.quantity === 2 && typeof it.unit === "string", "quantity + unit surfaced");
    ok(it && it.platform === true && it.dimensions.length === 10 && it.dimensions.breadth === 8, "platform + dimensions surfaced");
    ok(it && typeof it.flooring === "string", "flooring surfaced (string)");
    ok(it && it.addOns.length === 2 && it.included.length === 2, "addOns + included surfaced");
    ok(it && it.user_notes === "Blush palette please" && it.admin_notes === "Confirm crew of 4", "notes surfaced");
    ok(it && it.setupLocationImage === "https://cdn.example/setup-ref.jpg", "setupLocationImage surfaced");
    ok(it && typeof it.price === "number" && it.price > 0, "line price surfaced");

    // ── PATCH round-trips setupLocationImage (and can clear it) ──
    const patched = await DraftEventService.patchItem(lead._id, draft._id, day._id, added._id, { setupLocationImage: "https://cdn.example/new-ref.jpg" });
    ok(patched.setupLocationImage === "https://cdn.example/new-ref.jpg", "patchItem updates setupLocationImage");
    const cleared = await DraftEventService.patchItem(lead._id, draft._id, day._id, added._id, { setupLocationImage: "" });
    ok(cleared.setupLocationImage === "", "patchItem clears setupLocationImage");
    // untouched patch keeps it (composeItem echoes the existing value)
    const kept = await DraftEventService.patchItem(lead._id, draft._id, day._id, added._id, { quantity: 3 });
    ok(kept.setupLocationImage === "" && kept.quantity === 3, "untouched setupLocationImage survives an unrelated patch");

    // ── bad ids → 400/404 (defensive) ──
    let bad = null;
    try { await DraftEventService.getDraftDetail(lead._id, "nope"); } catch (e) { bad = e; }
    ok(bad && bad.status === 400, "getDraftDetail bad id → 400");
    let missing = null;
    try { await DraftEventService.getDraftDetail(lead._id, new mongoose.Types.ObjectId()); } catch (e) { missing = e; }
    ok(missing && missing.status === 404, "getDraftDetail unknown draft → 404");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await Event.deleteMany({ _id: { $in: created.events } }).catch(() => {});
    await Decor.deleteMany({ _id: { $in: created.decors } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await User.deleteMany({ _id: { $in: created.users } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
