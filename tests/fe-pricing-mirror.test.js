// BUG 45 PROOF — the FE pricing mirror computes the law EXACTLY.
// Run: node tests/fe-pricing-mirror.test.js
// 1) Loads the REAL FE source (wedsy-crm .../planner/pricing.ts), strips the
//    type annotations, executes it, and compares clientLineTotal against
//    utils/eventDecorPricing.lineTotal across adversarial fixtures (Pathway
//    multiplier, ungated flooring, negative add-ons, NaN garbage, qty 0).
// 2) Creates a REAL draft item through DraftEventService (server snapshots the
//    rates + prices the line) and reconciles the stored price with the FE
//    mirror to the rupee.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const { lineTotal } = require("../utils/eventDecorPricing");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

// ── load + strip the actual FE mirror ────────────────────────────────────────
const FE_PRICING = path.join(__dirname, "../../wedsy-crm/src/app/(app)/leads/[_id]/command/v3/planner/pricing.ts");
function loadFeMirror() {
  let src = fs.readFileSync(FE_PRICING, "utf8");
  src = src
    .replace(/^import type.*$/m, "")
    .replace(/export const/g, "const")
    .replace(/: DraftItem\[\]/g, "")
    .replace(/: DraftItem\b/g, "")
    .replace(/: number\b/g, "")
    .replace(/: boolean\b/g, "")
    .replace(/: unknown\b/g, "");
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${src}; return { clientLineTotal, platformCost, flooringCost, addOnsSum };`);
  return factory();
}

(async () => {
  let connected = false;
  const created = { admins: [], leads: [], decors: [], events: [] };
  try {
    if (!fs.existsSync(FE_PRICING)) {
      console.log("FE pricing.ts not found next to this repo — skipping (dev-only proof test).");
      process.exit(0);
    }
    const fe = loadFeMirror();

    // ── 1: formula parity across adversarial fixtures ──
    const fixtures = [
      { label: "plain", item: { quantity: 2, decorPrice: 1000, priceModifier: 0, priceAdj: 0, category: "Stage", platform: false, platformRate: 0, flooringRate: 0, dimensions: {}, addOns: [] } },
      { label: "platform+flooring", item: { quantity: 1, decorPrice: 185000, priceModifier: 2500, priceAdj: -500, category: "Stage", platform: true, platformRate: 50, flooringRate: 120, dimensions: { length: 12, breadth: 8, height: 2 }, addOns: [] } },
      { label: "Pathway multiplier", item: { quantity: 4, decorPrice: 9000, priceModifier: 0, priceAdj: 0, category: "Pathway", platform: true, platformRate: 50, flooringRate: 80, dimensions: { length: 10, breadth: 4, height: 1 }, addOns: [] } },
      { label: "negative add-ons × qty", item: { quantity: 1, decorPrice: 50000, priceModifier: 0, priceAdj: 0, category: "Mandap", platform: false, platformRate: 0, flooringRate: 0, dimensions: {}, addOns: [{ name: "Extra", price: 4500, quantity: 2 }, { name: "Loyalty", price: -8000, quantity: 1 }, { name: "legacy no qty", price: 100 }] } },
      { label: "NaN garbage → 0", item: { quantity: "x", decorPrice: "abc", priceModifier: null, priceAdj: undefined, category: "Pathway", platform: true, platformRate: "rate?", flooringRate: NaN, dimensions: { length: "L", breadth: 5, height: null }, addOns: [{ price: "nope", quantity: "?" }] } },
      { label: "qty 0 prices 0 base", item: { quantity: 0, decorPrice: 99999, priceModifier: 100, priceAdj: 100, category: "Stage", platform: true, platformRate: 50, flooringRate: 10, dimensions: { length: 2, breadth: 3, height: 1 }, addOns: [{ price: 500, quantity: 1 }] } },
      { label: "flooring UNGATED (rate w/o title)", item: { quantity: 1, decorPrice: 0, priceModifier: 0, priceAdj: 0, category: "Stage", platform: false, platformRate: 0, flooring: "", flooringRate: 100, dimensions: { length: 3, breadth: 4, height: 2 }, addOns: [] } },
    ];
    for (const f of fixtures) {
      const server = lineTotal(f.item);
      const mirror = fe.clientLineTotal(f.item);
      ok(server === mirror, `${f.label}: server ₹${server} === fe ₹${mirror}`);
    }

    // ── 2: a REAL server-priced item reconciles to the rupee ──
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    connected = true;
    const Admin = require("../models/Admin");
    const Enquiry = require("../models/Enquiry");
    const Decor = require("../models/Decor");
    const Event = require("../models/Event");
    const LeadPlan = require("../models/LeadPlan");
    const LeadActivityEvent = require("../models/LeadActivityEvent");
    const LeadInternalEvent = require("../models/LeadInternalEvent");
    const DraftEventService = require("../services/DraftEventService");

    const TAG = `femirror-${Date.now()}`;
    const admin = await Admin.create({ name: `${TAG}-a`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const lead = await Enquiry.create({ name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false, isLost: false, stage: "qualified", source: "Default", lostStatus: "none", assignedTo: admin._id });
    created.leads.push(lead._id);
    const decor = await Decor.create({
      category: "Pathway", name: `${TAG}-pathway`, unit: "pc", tags: [], image: "p.jpg", thumbnail: "p.jpg", rating: 0,
      productTypes: [{ name: "Standard", costPrice: 3000, sellingPrice: 9000 }, { name: "Premium", costPrice: 5000, sellingPrice: 15000 }],
    });
    created.decors.push(decor._id);

    const draft = await DraftEventService.createDraft(lead._id, { name: "Mirror" }, admin._id);
    created.events.push(draft._id);
    const day = await DraftEventService.addDay(lead._id, draft._id, { name: "Sangeet" }, admin._id);
    const item = await DraftEventService.addItem(lead._id, draft._id, day._id, {
      decorId: decor._id, quantity: 3, platform: true,
      dimensions: { length: 10, breadth: 4, height: 1 },
      priceModifier: 1200, priceAdj: -200,
      addOns: [{ name: "Petals top-up", price: 2000, quantity: 2 }, { name: "Loyalty", price: -1500, quantity: 1 }],
    }, admin._id);

    const detail = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const read = detail.days.find((d) => d.name === "Sangeet").decorItems.find((i) => String(i._id) === String(item._id));
    const feTotal = fe.clientLineTotal(read);
    ok(read.price === feTotal, `REAL item reconciles: server-stored ₹${read.price} === fe ₹${feTotal}`);
    ok(read.price === lineTotal(read), "stored price === server util recompute (sanity)");
    // the Pathway multiplier actually bit (platform leg × qty)
    ok(read.category === "Pathway" && read.platform === true, "fixture exercised Pathway + platform");

    // Bug 34 read-side: pricings expose the REAL productTypes
    ok(Array.isArray(read.pricings) && read.pricings.length === 2 && read.pricings[1].name === "Premium" && read.pricings[1].price === 15000,
      "item read carries the product's REAL pricings (tier dropdown source)");
    // Bug 40/44: notes round-trip
    await DraftEventService.patchItem(lead._id, draft._id, day._id, String(item._id), { notes: [{ text: "gate 2 entry", image: "https://x/img.jpg" }] }, admin._id);
    const detail2 = await DraftEventService.getDraftDetail(lead._id, draft._id);
    const read2 = detail2.days.find((d) => d.name === "Sangeet").decorItems.find((i) => String(i._id) === String(item._id));
    ok(read2.notes.length === 1 && read2.notes[0].text === "gate 2 entry" && read2.notes[0].image === "https://x/img.jpg", "item notes[] {text,image} round-trips");

    // ── 3: Bug 57 parity — an UNCHECKED alternative: line prices, totals skip ──
    const { dayTotal } = require("../utils/eventDecorPricing");
    const alt = await DraftEventService.addItem(lead._id, draft._id, day._id, {
      decorId: decor._id, quantity: 1, includedInTotal: false,
    }, admin._id);
    ok(alt.price === 9000 && alt.includedInTotal === false,
      "unchecked alternative: its OWN line price still computes (₹9000)");
    ok(fe.clientLineTotal(alt) === alt.price,
      "FE mirror prices the unchecked line identically (display parity)");
    const eventDoc = await Event.findById(draft._id).lean();
    const dayDoc = eventDoc.eventDays.find((d) => d.name === "Sangeet");
    ok(dayTotal(dayDoc).decorItems === read.price,
      `dayTotal sums ONLY included items (₹${dayTotal(dayDoc).decorItems} = the checked item alone)`);
    const totals = await DraftEventService.totalsFor(eventDoc);
    ok(totals.grandTotal === read.price, "grand total skips the alternative too");
    // FE day/grand sums must apply the same skip: includedInTotal !== false.

    // ── 4: Bug 74 parity — the variation modifier folds into the decorPrice
    // SNAPSHOT (tier + modifier), so the law and the mirror need no change.
    const varDecor = await Decor.create({
      category: "Stage", name: `${TAG}-vstage`, unit: "unit", tags: [], image: "v.jpg", thumbnail: "v.jpg", rating: 0,
      productTypes: [{ name: "Standard", costPrice: 400, sellingPrice: 1000 }, { name: "Premium", costPrice: 2000, sellingPrice: 6000 }],
      productVariants: [{ name: "Red drape", priceModifier: 4000, image: "https://x/red.jpg" }],
    });
    created.decors.push(varDecor._id);
    const varItem = await DraftEventService.addItem(lead._id, draft._id, day._id, {
      decorId: varDecor._id, quantity: 2, productVariant: "Premium", variant: "Red drape", includedInTotal: false,
    }, admin._id);
    ok(varItem.decorPrice === 10000, "variation modifier folded into the snapshot (6000 tier + 4000 mod)");
    ok(varItem.price === 20000 && fe.clientLineTotal(varItem) === varItem.price,
      "FE mirror stays rupee-exact — the fold lives in decorPrice, not the law");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (connected) {
      const Event = require("../models/Event");
      const Enquiry = require("../models/Enquiry");
      const Admin = require("../models/Admin");
      const Decor = require("../models/Decor");
      const LeadPlan = require("../models/LeadPlan");
      const LeadActivityEvent = require("../models/LeadActivityEvent");
      const LeadInternalEvent = require("../models/LeadInternalEvent");
      await Event.deleteMany({ _id: { $in: created.events } }).catch(() => {});
      await LeadPlan.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await Decor.deleteMany({ _id: { $in: created.decors } }).catch(() => {});
      await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
      await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
      await mongoose.disconnect();
    }
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
