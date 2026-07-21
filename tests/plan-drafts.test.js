// P3+P4 — DRAFT EVENTS + OS ITEM WRITES test. Run: node tests/plan-drafts.test.js
// Covers: draft create (phone bridge, discovery seeding, 3-cap 422), the
// couple-origin listing via the Onboarding bridge, server-authoritative item
// pricing (config rate snapshots, pathway math, variant resolve), PATCH
// recompute from STORED snapshots (live config change must not reprice),
// flooring re-snapshot on material change only, reorder, package variant
// snapshot, custom/mandatory ES/TS + the filtered draft totals, and the
// couple-event write wall.
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const User = require("../models/User");
const Event = require("../models/Event");
const Decor = require("../models/Decor");
const DecorPackage = require("../models/DecorPackage");
const Config = require("../models/Config");
const Onboarding = require("../models/Onboarding");
const DraftEventService = require("../services/DraftEventService");

const TAG = `plandraft-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], users: [], events: [], decors: [], packages: [], onboardings: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // Live config rates (the REAL singletons — read, never mutated).
    const platformCfg = await Config.findOne({ code: "platform" }).lean();
    const flooringCfg = await Config.findOne({ code: "flooring" }).lean();
    const PR = Number(platformCfg?.data?.price) || 0;
    const flooring0 = (flooringCfg?.data?.flooringList || [])[0] || {};
    const FR = Number(flooring0.price) || 0;
    const FLOOR_NAME = flooring0.title || "";
    ok(PR > 0 && FR > 0 && !!FLOOR_NAME, `live config rates read (platform ₹${PR}, "${FLOOR_NAME}" ₹${FR})`);

    const admin = await Admin.create({ name: `${TAG}-admin`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const couple = await User.create({ name: `${TAG}-couple`, phone: `${TAG}-ph` });
    created.users.push(couple._id);
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: admin._id,
      qualificationData: { eventDays: [{ date: "2026-12-09", functions: [{ type: "Sangeet", time: "19:00", venue: "Palace Grounds", space: "Lawn" }] }] },
    });
    const bareLead = await Enquiry.create({
      name: `${TAG}-bare`, phone: `${TAG}-bare`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: admin._id,
    });
    created.leads.push(lead._id, bareLead._id);

    const decor = await Decor.create({
      category: "Pathway", name: `${TAG}-pathway`, unit: "unit", tags: [],
      image: "p.jpg", thumbnail: "p.jpg", rating: 0,
      productTypes: [
        { name: "Standard", costPrice: 500, sellingPrice: 1000 },
        { name: "Premium", costPrice: 900, sellingPrice: 1800 },
      ],
    });
    created.decors.push(decor._id);
    const pkg = await DecorPackage.create({
      name: `${TAG}-pkg`,
      variant: {
        artificialFlowers: { costPrice: 10000, sellingPrice: 20000, discount: 0 },
        mixedFlowers: { costPrice: 15000, sellingPrice: 30000, discount: 0 },
        naturalFlowers: { costPrice: 20000, sellingPrice: 40000, discount: 0 },
      },
    });
    created.packages.push(pkg._id);

    // ── P3: create (bridge + seed) ──
    const d1 = await DraftEventService.createDraft(lead._id, { name: "Dream" }, admin._id);
    created.events.push(d1._id);
    ok(String(d1.user) === String(couple._id), "phone bridge links the consumer account");
    ok(String(d1.leadId) === String(lead._id) && d1.draftName === "Dream", "draft carries leadId + draftName");
    ok(d1.eventDays.length === 1 && d1.eventDays[0].name === "Sangeet" && d1.eventDays[0].venue === "Palace Grounds" && d1.eventDays[0].eventSpace === "Lawn", "discovery days seed the draft");
    const dBare = await DraftEventService.createDraft(bareLead._id, { name: "Solo" }, admin._id);
    created.events.push(dBare._id);
    ok(dBare.user === null && dBare.eventDays.length === 0, "no consumer account / no discovery → null user, empty days (schema relaxed)");

    // cap (addendum: raised to 5 per the locked flow)
    for (const n of ["Realistic", "Budget", "Fourth", "Fifth"]) {
      created.events.push((await DraftEventService.createDraft(lead._id, { name: n }, admin._id))._id);
    }
    let cap = null;
    try { await DraftEventService.createDraft(lead._id, { name: "Sixth" }, admin._id); } catch (e) { cap = e; }
    ok(cap && cap.status === 422, "the sixth draft is refused (422 cap, addendum)");

    // couple-origin listing via the Onboarding bridge
    const coupleEvent = await Event.create({ user: couple._id, name: `${TAG}-couple-event` });
    created.events.push(coupleEvent._id);
    created.onboardings.push((await Onboarding.create({ leadId: lead._id, eventId: coupleEvent._id }))._id);
    const listed = await DraftEventService.listDrafts(lead._id);
    ok(listed.filter((r) => r.origin === "os").length === 5, "all OS drafts list");
    const coupleRow = listed.find((r) => r.origin === "couple");
    ok(!!coupleRow && coupleRow.eventId === String(coupleEvent._id), "the couple-origin event lists via the Onboarding bridge");

    // couple events are read-only here
    let wall = null;
    try { await DraftEventService.addDay(lead._id, coupleEvent._id, { name: "Nope" }); } catch (e) { wall = e; }
    ok(wall && wall.status === 404, "OS writes refuse couple-origin events");

    // ── P4: day + server-priced item ──
    const day = await DraftEventService.addDay(lead._id, d1._id, { name: "Haldi", date: "2026-12-08", time: "10:00", venue: "Home" });
    ok(!!day._id && day.name === "Haldi", "day added");

    const item = await DraftEventService.addItem(lead._id, d1._id, day._id, {
      decorId: decor._id, quantity: 3, platform: true, flooring: FLOOR_NAME,
      dimensions: { length: 2, breadth: 2, height: 0 },
      addOns: [{ name: "Lights", price: 500 }, { name: "Early-bird", price: -200 }],
    });
    const expected = Math.round(
      3 * 1000 + 2 * 2 * PR * 3 + (2 + 0) * (2 + 0) * FR * 3 + 300
    );
    ok(item.price === expected, `Pathway item priced server-side (${item.price} vs ${expected})`);
    ok(item.platformRate === PR && item.flooringRate === FR, "rates SNAPSHOTTED from config at add");
    ok(item.decorPrice === 1000 && item.category === "Pathway" && item.unit === "unit", "decorPrice/category/unit resolved server-side");

    // PATCH recompute from STORED snapshots — a variant change re-resolves price
    const patched = await DraftEventService.patchItem(lead._id, d1._id, day._id, item._id, { productVariant: "Premium", quantity: 2 });
    const expected2 = Math.round(2 * 1800 + 2 * 2 * PR * 2 + 2 * 2 * FR * 2 + 300);
    ok(patched.price === expected2, `variant + qty patch recomputes (${patched.price} vs ${expected2})`);
    ok(patched.platformRate === PR, "platform rate snapshot survives the patch (not re-read)");
    // flooring OFF clears the leg
    const noFloor = await DraftEventService.patchItem(lead._id, d1._id, day._id, item._id, { flooring: "" });
    ok(noFloor.flooringRate === 0 && noFloor.price === Math.round(2 * 1800 + 2 * 2 * PR * 2 + 300), "clearing flooring re-snapshots rate 0 + recomputes");

    // ── package variant snapshot ──
    const row = await DraftEventService.addPackage(lead._id, d1._id, day._id, { packageId: pkg._id, variant: "mixedFlowers", quantity: 2 });
    ok(row.price === 60000 && row.variant === "mixedFlowers", "package row snapshots variant price × qty");
    let badVar = null;
    try { await DraftEventService.addPackage(lead._id, d1._id, day._id, { packageId: pkg._id, variant: "plastic" }); } catch (e) { badVar = e; }
    ok(badVar && badVar.status === 400, "unknown package variant → 400");

    // ── custom + mandatory w/ ES/TS + filtered totals ──
    await DraftEventService.addCustomItem(lead._id, d1._id, day._id, { name: "DJ", price: 800 });
    await DraftEventService.addCustomItem(lead._id, d1._id, day._id, { name: "Transport", price: 999, includeInTotalSummary: true });
    await DraftEventService.addMandatoryItem(lead._id, d1._id, day._id, { title: "Genset", price: 400, itemRequired: true });
    await DraftEventService.addMandatoryItem(lead._id, d1._id, day._id, { title: "Offer", price: 555, itemRequired: false });
    const event = await DraftEventService.getDraft(lead._id, d1._id);
    const totals = await DraftEventService.totalsFor(event);
    const hal = totals.days.find((d) => d.name === "Haldi");
    ok(hal.customItems === 800 && hal.mandatoryItems === 400, "day totals honor the ES/TS + itemRequired filters");
    ok(totals.eventLevelItems.length === 1 && totals.eventLevelItems[0].name === "Transport", "ES/TS item itemizes at event level");
    ok(totals.gross === totals.grandTotal && totals.net === totals.gross && totals.discount === 0, "gross/net exposed (no discount yet)");

    // ── reorder ──
    const item2 = await DraftEventService.addItem(lead._id, d1._id, day._id, { decorId: decor._id, quantity: 1, category: "Pathway" });
    const dayNow = (await DraftEventService.getDraft(lead._id, d1._id)).eventDays.id(day._id);
    const ids = dayNow.decorItems.map((i) => String(i._id)).reverse();
    await DraftEventService.reorderItems(lead._id, d1._id, day._id, { ids });
    const after = (await DraftEventService.getDraft(lead._id, d1._id)).eventDays.id(day._id);
    ok(String(after.decorItems[0]._id) === String(item2._id), "reorder persists by subdoc id");
    let badOrder = null;
    try { await DraftEventService.reorderItems(lead._id, d1._id, day._id, { ids: [ids[0]] }); } catch (e) { badOrder = e; }
    ok(badOrder && badOrder.status === 400, "partial id list → 400 (must be the exact set)");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await Onboarding.deleteMany({ _id: { $in: created.onboardings } }).catch(() => {});
    await Event.deleteMany({ _id: { $in: created.events } }).catch(() => {});
    await Decor.deleteMany({ _id: { $in: created.decors } }).catch(() => {});
    await DecorPackage.deleteMany({ _id: { $in: created.packages } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await User.deleteMany({ _id: { $in: created.users } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
