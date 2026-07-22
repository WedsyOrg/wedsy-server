// ITEM-EDITOR FIELDS test (B1–B6). Run: node tests/planner-item-editor-fields.test.js
// Covers: add-on qty multiplies (negatives × qty subtract), ests never moves
// the price, priceAdj folds PER-UNIT and scales with quantity, legacy items
// price identically (backward compatibility), the write path round-trips the
// new fields (echo on untouched patches), and the publish freeze carries them
// while priceAdj stays folded (never a separate couple-visible line).
require("dotenv").config();
const mongoose = require("mongoose");

const { lineTotal } = require("../utils/eventDecorPricing");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Decor = require("../models/Decor");
const Event = require("../models/Event");
const LeadPlan = require("../models/LeadPlan");
const PlanSnapshot = require("../models/PlanSnapshot");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const DraftEventService = require("../services/DraftEventService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);
const TAG = `itemfields-${Date.now()}`;

const created = { leads: [], admins: [], decors: [], events: [] };

(async () => {
  try {
    // ── B5: pure pricing units (no DB) ──
    eq(lineTotal({ quantity: 1, decorPrice: 1000, category: "Stage", addOns: [{ price: 200, quantity: 3 }] }),
      1000 + 600, "add-on price × quantity");
    eq(lineTotal({ quantity: 1, decorPrice: 1000, category: "Stage", addOns: [{ price: -150, quantity: 4 }] }),
      1000 - 600, "negative add-on × qty subtracts (sign-flip deduction)");
    eq(lineTotal({ quantity: 1, decorPrice: 1000, category: "Stage", addOns: [{ price: 200 }] }),
      1200, "add-on with NO quantity defaults to 1 (legacy rows unchanged)");
    const withEs = lineTotal({ quantity: 2, decorPrice: 1000, category: "Stage", addOns: [{ price: 300, quantity: 2, ests: "es" }] });
    const withTs = lineTotal({ quantity: 2, decorPrice: 1000, category: "Stage", addOns: [{ price: 300, quantity: 2, ests: "ts" }] });
    const withNull = lineTotal({ quantity: 2, decorPrice: 1000, category: "Stage", addOns: [{ price: 300, quantity: 2 }] });
    ok(withEs === withTs && withTs === withNull, "ests is a flag ONLY — never moves the price");
    eq(lineTotal({ quantity: 3, decorPrice: 1000, priceModifier: 200, priceAdj: -100, category: "Stage" }),
      3 * (1000 + 200 - 100), "priceAdj folds PER-UNIT and scales with quantity");
    eq(lineTotal({ quantity: 1, decorPrice: 1000, category: "Stage" }),
      1000, "legacy item with no priceAdj prices identically (default 0)");
    // pathway multiplier untouched
    eq(lineTotal({ quantity: 2, decorPrice: 500, priceAdj: 50, category: "Pathway", platform: true, platformRate: 10, dimensions: { length: 2, breadth: 2 } }),
      2 * 550 + 2 * 2 * 10 * 2, "pathway multiplier + priceAdj coexist correctly");

    // ── B4/B6: the write path + publish freeze (DB) ──
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const admin = await Admin.create({ name: `${TAG}-a`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: admin._id,
    });
    created.leads.push(lead._id);
    const decor = await Decor.create({
      category: "Stage", name: `${TAG}-stage`, unit: "unit", tags: [], image: "s.jpg", thumbnail: "s.jpg", rating: 0,
      productTypes: [{ name: "Standard", costPrice: 500, sellingPrice: 1000 }],
    });
    created.decors.push(decor._id);
    const draft = await DraftEventService.createDraft(lead._id, { name: "Editor" }, admin._id);
    created.events.push(draft._id);
    const day = await DraftEventService.addDay(lead._id, draft._id, { name: "Sangeet" }, admin._id);

    const item = await DraftEventService.addItem(lead._id, draft._id, day._id, {
      decorId: decor._id, quantity: 2, priceAdj: 250, setupLocation: "Poolside lawn, north corner",
      addOns: [
        { name: "Fairy lights", price: 500, quantity: 3, ests: "es", photo: "https://x/l.jpg" },
        { name: "Combo deduction", price: -400, quantity: 2, ests: "ts" },
      ],
    }, admin._id);
    eq(item.price, 2 * (1000 + 250) + (500 * 3 - 400 * 2), "server prices the full editor field set");
    ok(item.addOns[0].quantity === 3 && item.addOns[0].ests === "es" && item.addOns[0].photo === "https://x/l.jpg", "add-on qty/ests/photo persist");
    ok(item.addOns[1].price === -400, "no min guard — negative add-on stored (verified none exists in the path)");
    ok(item.setupLocation === "Poolside lawn, north corner" && item.priceAdj === 250, "setupLocation text + priceAdj persist");
    ok(item.addOns[1].ests === "ts", "ts flag persists");

    // echo discipline: an untouched patch keeps every new field
    const patched = await DraftEventService.patchItem(lead._id, draft._id, day._id, item._id, { quantity: 3 }, admin._id);
    ok(patched.setupLocation === "Poolside lawn, north corner" && patched.priceAdj === 250 && patched.addOns[0].photo === "https://x/l.jpg",
      "untouched patch echoes the new fields (setupLocationImage discipline)");
    eq(patched.price, 3 * 1250 + (1500 - 800), "recompute after patch keeps the folded math");
    // invalid ests falls to null
    const badEsts = await DraftEventService.patchItem(lead._id, draft._id, day._id, item._id, { addOns: [{ name: "X", price: 100, ests: "both" }] }, admin._id);
    ok(badEsts.addOns[0].ests === null, "unknown ests value coerces to null (flag whitelist)");

    // ── B6: publish freeze ──
    await DraftEventService.patchItem(lead._id, draft._id, day._id, item._id, {
      addOns: [{ name: "Fairy lights", price: 500, quantity: 3, ests: "es", photo: "https://x/l.jpg" }],
    }, admin._id);
    await DraftEventService.publishDraft(lead._id, draft._id, { pricingVisible: true }, admin._id);
    const frozen = await DraftEventService.publishedSnapshotFor(lead._id, draft._id);
    const fi = frozen.content.days[0].items.find((i) => i.kind === "decor");
    ok(fi.addOns[0].quantity === 3 && fi.addOns[0].ests === "es" && fi.addOns[0].photo === "https://x/l.jpg", "frozen snapshot carries add-on qty/ests/photo");
    ok(fi.setupLocation === "Poolside lawn, north corner", "frozen snapshot carries the setup-location text");
    ok(!("priceAdj" in fi), "priceAdj is NOT a separate couple-visible field…");
    eq(fi.price, 3 * 1250 + 1500, "…but the per-line price the couple sees has it folded in");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await PlanSnapshot.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadPlan.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await Event.deleteMany({ _id: { $in: created.events } }).catch(() => {});
      await Decor.deleteMany({ _id: { $in: created.decors } }).catch(() => {});
      await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
      await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
      await mongoose.disconnect();
    }
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
