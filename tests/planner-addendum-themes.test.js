// ADDENDUM A1–A4 test. Run: node tests/planner-addendum-themes.test.js
// Covers: theme CRUD + the learning loop + catalogue ordering (suggested
// first, nothing hidden), provenance classification (theme / cross_theme /
// more_options / direct), the persistent per-event theme selection, show-more
// request → notify → auto-fulfil, live_marked reactions, and the whole-wedding
// present publish (price-free default, first-send vs resend).
require("dotenv").config();
const mongoose = require("mongoose");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const User = require("../models/User");
const Decor = require("../models/Decor");
const DecorTheme = require("../models/DecorTheme");
const MoreOptionsRequest = require("../models/MoreOptionsRequest");
const LeadPlan = require("../models/LeadPlan");
const PlanSnapshot = require("../models/PlanSnapshot");
const AdminNotification = require("../models/AdminNotification");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const ThemeService = require("../services/ThemeService");
const PlanService = require("../services/PlanService");
const PlanSnapshotService = require("../services/PlanSnapshotService");

const TAG = `addthemes-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { leads: [], admins: [], users: [], decors: [], themes: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const admin = await Admin.create({ name: `${TAG}-meera`, email: `${TAG}@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(admin._id);
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none", assignedTo: admin._id,
    });
    created.leads.push(lead._id);
    const couple = await User.create({ name: `${TAG}-couple`, phone: `${TAG}-ph` });
    created.users.push(couple._id);

    const mkDecor = (s) =>
      Decor.create({
        category: "Stage", name: `${TAG}-${s}`, unit: "unit", tags: [], image: "x.jpg", thumbnail: "x.jpg",
        rating: 0, productVisibility: true, productTypes: [{ name: "Standard", costPrice: 100, sellingPrice: 200 }],
      });
    const dIn = await mkDecor("in-theme");
    const dOut = await mkDecor("outside");
    const dMore = await mkDecor("more");
    created.decors.push(dIn._id, dOut._id, dMore._id);

    // ── A1: CRUD + validation ──
    const theme = await ThemeService.create({ name: `${TAG} Sunshine Yellow`, eventType: "haldi", backgroundImageUrl: "https://x/bg.png" }, admin._id);
    created.themes.push(theme._id);
    ok(theme.active === true && theme.eventType === "haldi", "theme created (per-EVENT, active)");
    let bad = null;
    try { await ThemeService.create({ name: "X", eventType: "brunch" }, admin._id); } catch (e) { bad = e; }
    ok(bad && bad.status === 400, "unknown eventType → 400");
    await ThemeService.patch(theme._id, { taggedDecorIds: [String(dIn._id)] });
    const themesForHaldi = await ThemeService.list({ eventType: "haldi" });
    ok(themesForHaldi.some((t) => String(t._id) === String(theme._id)), "GET themes?eventType filters");

    // ── A2: provenance classification ──
    const inLook = await PlanService.addLook(lead._id, { source: "decor", decorId: dIn._id, functionKey: "haldi", categoryKey: "stage", themeId: theme._id }, admin._id);
    ok(inLook.provenance === "theme" && inLook.themeName === `${TAG} Sunshine Yellow`, "tagged product under its theme → provenance theme + name snapshot");
    const crossLook = await PlanService.addLook(lead._id, { source: "decor", decorId: dOut._id, functionKey: "haldi", categoryKey: "stage", themeId: theme._id }, admin._id);
    ok(crossLook.provenance === "cross_theme", "untagged product while browsing a theme → cross_theme");
    const directLook = await PlanService.addLook(lead._id, { source: "decor", decorId: dOut._id, functionKey: "sangeet", categoryKey: "stage" }, admin._id);
    ok(directLook.provenance === "direct" && directLook.themeId === null, "no theme → direct");

    // ── A1: the learning loop (both adds tagged back; dedupe) ──
    const themeNow = await DecorTheme.findById(theme._id).lean();
    const taggedSet = new Set(themeNow.taggedDecorIds.map(String));
    ok(taggedSet.has(String(dIn._id)) && taggedSet.has(String(dOut._id)), "learning loop: added products tag back onto the theme");
    ok(themeNow.taggedDecorIds.length === 2, "tag list dedupes");
    // catalogue: suggested first, rest never hidden
    const cat = await ThemeService.catalogue(theme._id, { categoryKey: "stage" });
    ok(cat.suggested.every((r) => r.suggested) && cat.suggested.length === 2, "catalogue surfaces tagged products as suggestions");
    ok(cat.catalogue.some((r) => r.decorId === String(dMore._id)), "the rest of the catalogue stays reachable (never hidden)");

    // ── addendum: persistent theme selection ──
    const sel = await PlanService.selectTheme(lead._id, { functionKey: "haldi", themeId: theme._id }, admin._id);
    ok(sel.length === 1 && sel[0].themeName === `${TAG} Sunshine Yellow`, "per-event theme selection persists ('Your Haldi · Sunshine Yellow')");

    // ── A3: show-more request → notify → auto-fulfil ──
    const reqDoc = await PlanService.requestMoreOptions({ userId: couple._id, functionKey: "haldi", categoryKey: "stage" });
    ok(String(reqDoc.leadId) === String(lead._id) && reqDoc.fulfilled === false, "couple's show-more lands via the phone bridge (pending)");
    const notif = await AdminNotification.find({ leadId: lead._id, type: "more_options" }).lean();
    ok(notif.length === 1 && String(notif[0].adminId) === String(admin._id), "lead owner notified of the slot");
    const open1 = await PlanService.listMoreRequests(lead._id, {});
    ok(open1.length === 1, "planner read shows the open request");
    const moreLook = await PlanService.addLook(lead._id, { source: "decor", decorId: dMore._id, functionKey: "haldi", categoryKey: "stage", themeId: theme._id, provenance: "more_options" }, admin._id);
    ok(moreLook.provenance === "more_options", "explicit more_options provenance wins over theme classification");
    const open2 = await PlanService.listMoreRequests(lead._id, {});
    ok(open2.length === 0, "adding the answering look auto-fulfils the request");
    const fulfilled = await MoreOptionsRequest.findById(reqDoc._id).lean();
    ok(fulfilled.fulfilled === true && String(fulfilled.fulfilledBy) === String(admin._id), "fulfilment stamped with the curator");

    // ── A4: live_marked reactions ──
    const live = await PlanService.reactToLook(lead._id, inLook._id, { kind: "love", source: "live_marked" }, { adminId: admin._id });
    const liveReaction = live.reactions[live.reactions.length - 1];
    ok(liveReaction.source === "live_marked" && liveReaction.voice === "wedsy", "present-mode mark: voice wedsy + source live_marked");
    await PlanService.reactToLook(lead._id, inLook._id, { kind: "love", voice: "couple", name: "Ananya", source: "live_marked" }, {});
    const planDoc = await LeadPlan.findOne({ leadId: lead._id }).lean();
    const lastR = planDoc.looks.find((l) => String(l._id) === String(inLook._id)).reactions.slice(-1)[0];
    ok(lastR.source === "default", "a non-admin actor cannot claim live_marked (falls to default)");

    // ── A4: present publish — price-free, first-send vs resend ──
    const first = await PlanSnapshotService.publishPresent(lead._id, { pricingVisible: false, coverNote: "Your wedding, three ways" }, admin._id);
    ok(first.wasFirstSend === true, "first present publish reports first-send ('Send to couple?')");
    const fn = first.snapshot.content.functions.find((f) => f.functionKey === "haldi");
    ok(!!fn && fn.theme && fn.theme.name === `${TAG} Sunshine Yellow` && fn.theme.backgroundImageUrl === "https://x/bg.png", "whole-wedding content carries the selected theme cover");
    ok(fn.looks.length === 3 && fn.looks.every((l) => l.priceChip === undefined), "price-free by default (no price chips)");
    ok(fn.looks.some((l) => l.provenance === "cross_theme"), "looks carry provenance into the frozen content");
    const second = await PlanSnapshotService.publishPresent(lead._id, { pricingVisible: true }, admin._id);
    ok(second.wasFirstSend === false, "second publish reports resend ('Update their dashboard?')");
    const fn2 = second.snapshot.content.functions.find((f) => f.functionKey === "haldi");
    ok(fn2.looks.every((l) => typeof l.priceChip === "string"), "pricingVisible toggles the chips on");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await PlanSnapshot.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadPlan.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await MoreOptionsRequest.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadActivityEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await DecorTheme.deleteMany({ _id: { $in: created.themes } }).catch(() => {});
    await Decor.deleteMany({ _id: { $in: created.decors } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await User.deleteMany({ _id: { $in: created.users } }).catch(() => {});
    await mongoose.disconnect();
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
