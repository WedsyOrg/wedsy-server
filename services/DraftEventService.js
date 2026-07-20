// P3+P4+P5 — THE BUILD LAYER. OS draft Events (leadId-linked, 3-cap) with
// SERVER-AUTHORITATIVE item pricing: rates snapshot from Config AT ADD, every
// change recomputes via the shared price util from the STORED snapshots. The
// couple-facing event endpoints are untouched — these writes accept ONLY
// OS drafts (event.leadId === lead).
const mongoose = require("mongoose");
const Event = require("../models/Event");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Decor = require("../models/Decor");
const DecorPackage = require("../models/DecorPackage");
const Config = require("../models/Config");
const Onboarding = require("../models/Onboarding");
const DealDiscount = require("../models/DealDiscount");
const { lineTotal, eventTotals } = require("../utils/eventDecorPricing");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const DRAFT_CAP = 3;

// ── Rate snapshots (Config → numbers; string prices in the live docs) ────────
const platformRateNow = async () => {
  const c = await Config.findOne({ code: "platform" }).lean();
  const n = Number(c && c.data && c.data.price);
  return Number.isFinite(n) ? n : 0;
};
const flooringRateNow = async (flooringTitle) => {
  if (!flooringTitle) return 0;
  const c = await Config.findOne({ code: "flooring" }).lean();
  const list = (c && c.data && c.data.flooringList) || [];
  const hit = list.find((f) => f && f.title === flooringTitle);
  const n = Number(hit && hit.price);
  return Number.isFinite(n) ? n : 0;
};

// ── Totals + discount overlay ────────────────────────────────────────────────
const totalsFor = async (event) => {
  const t = eventTotals(event);
  const discounts = await DealDiscount.find({ eventId: event._id, status: "approved" }, { amount: 1 }).lean();
  const discount = discounts.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  return { ...t, gross: t.grandTotal, discount, net: Math.max(0, t.grandTotal - discount) };
};

// ── P3: drafts ───────────────────────────────────────────────────────────────
const seedDaysFromDiscovery = (lead) => {
  const days = (lead.qualificationData && lead.qualificationData.eventDays) || [];
  return days
    .filter((d) => d)
    .map((d, i) => {
      const fn = (d.functions || [])[0] || {};
      return {
        name: fn.type || `Day ${i + 1}`,
        date: d.date || "TBD",
        time: fn.time || "TBD",
        venue: fn.venue || "TBD",
        eventSpace: fn.space || "",
      };
    });
};

const createDraft = async (leadId, { name } = {}, actorId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  const clean = String(name || "").trim();
  if (!clean) throw err(400, "Name the draft (e.g. Dream, Realistic).");
  const lead = await Enquiry.findById(leadId, { name: 1, phone: 1, qualificationData: 1 }).lean();
  if (!lead) throw err(404, "Enquiry not found");
  const existing = await Event.countDocuments({ leadId });
  if (existing >= DRAFT_CAP) throw err(422, `Three drafts is the cap — retire one before adding "${clean}".`);
  // The phone bridge: link the consumer account when one exists (else null —
  // Event.user was relaxed to optional for exactly this).
  const user = lead.phone ? await User.findOne({ phone: lead.phone, deleted: { $ne: true } }, { _id: 1 }).lean() : null;
  const event = await Event.create({
    user: user ? user._id : null,
    leadId,
    draftName: clean.slice(0, 120),
    name: `${lead.name} — ${clean}`.slice(0, 200),
    eventDays: seedDaysFromDiscovery(lead),
  });
  void actorId;
  return event.toObject();
};

const listDrafts = async (leadId) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  const drafts = await Event.find({ leadId }).sort({ createdAt: 1 }).lean();
  const osIds = new Set(drafts.map((d) => String(d._id)));
  // Couple-origin events reachable through the Onboarding bridge list too.
  const bridges = await Onboarding.find({ leadId, eventId: { $ne: null } }, { eventId: 1 }).lean();
  const coupleIds = [...new Set(bridges.map((b) => String(b.eventId)))].filter((id) => !osIds.has(id));
  const coupleEvents = coupleIds.length ? await Event.find({ _id: { $in: coupleIds } }).lean() : [];

  const rows = [];
  for (const e of drafts) {
    rows.push({
      eventId: String(e._id),
      name: e.draftName || e.name,
      origin: "os",
      status: e.status || {},
      totals: await totalsFor(e),
      days: (e.eventDays || []).length,
      createdAt: e.createdAt,
    });
  }
  for (const e of coupleEvents) {
    rows.push({
      eventId: String(e._id),
      name: e.name,
      origin: "couple",
      status: e.status || {},
      totals: await totalsFor(e),
      days: (e.eventDays || []).length,
      createdAt: e.createdAt,
    });
  }
  return rows;
};

// OS-draft guard: writes NEVER touch couple-origin events.
const getDraft = async (leadId, eventId) => {
  if (!isId(leadId) || !isId(eventId)) throw err(400, "Invalid id");
  const event = await Event.findOne({ _id: eventId, leadId });
  if (!event) throw err(404, "Draft not found on this lead (couple events are read-only here)");
  return event;
};

// ── P4: days ─────────────────────────────────────────────────────────────────
const addDay = async (leadId, eventId, { name, date, time, venue, eventSpace } = {}) => {
  const event = await getDraft(leadId, eventId);
  event.eventDays.push({
    name: String(name || `Day ${event.eventDays.length + 1}`).slice(0, 120),
    date: String(date || "TBD").slice(0, 40),
    time: String(time || "TBD").slice(0, 40),
    venue: String(venue || "TBD").slice(0, 200),
    eventSpace: String(eventSpace || "").slice(0, 200),
  });
  await event.save();
  return event.eventDays[event.eventDays.length - 1].toObject();
};

const getDay = (event, dayId) => {
  const day = event.eventDays.id(dayId);
  if (!day) throw err(404, "Day not found");
  return day;
};

// ── P4: decor items (server-priced) ──────────────────────────────────────────
const composeItem = async (input = {}, existing = null) => {
  // Selection facts come from the caller; RATES are server snapshots.
  const item = existing ? existing.toObject() : {};
  const merged = { ...item, ...input };
  const decorId = merged.decorId || (item.decor ? item.decor : null);
  if (!existing) {
    if (!isId(decorId)) throw err(400, "Pass a decorId");
  }
  let decor = null;
  const needDecor = !existing || input.productVariant !== undefined;
  if (needDecor) {
    decor = await Decor.findById(decorId || item.decor, { name: 1, category: 1, unit: 1, productTypes: 1 }).lean();
    if (!decor) throw err(404, "Decor not found");
  }

  const out = {
    decor: decorId || item.decor,
    quantity: Number.isFinite(Number(merged.quantity)) && Number(merged.quantity) > 0 ? Number(merged.quantity) : 1,
    unit: existing ? item.unit : (decor && decor.unit) || "",
    platform: !!merged.platform,
    flooring: String(merged.flooring || ""),
    dimensions: {
      length: Number(merged.dimensions && merged.dimensions.length) || 0,
      breadth: Number(merged.dimensions && merged.dimensions.breadth) || 0,
      height: Number(merged.dimensions && merged.dimensions.height) || 0,
    },
    category: String(merged.category || (decor && decor.category) || item.category || "").trim(),
    variant: String(merged.variant || item.variant || "Standard"),
    productVariant: String(merged.productVariant ?? item.productVariant ?? ""),
    priceModifier: Number(merged.priceModifier) || 0,
    addOns: Array.isArray(merged.addOns)
      ? merged.addOns.map((a) => ({ name: String((a && a.name) || ""), price: Number(a && a.price) || 0, notes: String((a && a.notes) || "") }))
      : item.addOns || [],
    included: Array.isArray(merged.included) ? merged.included.map(String) : item.included || [],
    user_notes: String(merged.user_notes ?? item.user_notes ?? ""),
    admin_notes: String(merged.admin_notes ?? item.admin_notes ?? ""),
    primaryColor: String(merged.primaryColor ?? item.primaryColor ?? ""),
    secondaryColor: String(merged.secondaryColor ?? item.secondaryColor ?? ""),
  };
  if (!out.category) throw err(400, "The item needs a category");

  // decorPrice: resolve by productVariant name (else the first productType) —
  // a NEW selection re-resolves; an untouched existing item keeps its snapshot.
  if (needDecor) {
    const types = (decor && decor.productTypes) || [];
    const hit = out.productVariant ? types.find((t) => t && t.name === out.productVariant) : null;
    out.decorPrice = Number((hit || types[0] || {}).sellingPrice) || 0;
  } else {
    out.decorPrice = Number(item.decorPrice) || 0;
  }

  // platformRate: keep the stored snapshot; snapshot fresh only when platform
  // turns on with no rate yet.
  out.platformRate = Number(item.platformRate) || 0;
  if (out.platform && !out.platformRate) out.platformRate = await platformRateNow();

  // flooringRate: re-snapshot ONLY when the flooring material changes.
  const flooringChanged = !existing || input.flooring !== undefined;
  out.flooringRate = flooringChanged ? await flooringRateNow(out.flooring) : Number(item.flooringRate) || 0;

  out.price = lineTotal(out);
  return out;
};

const addItem = async (leadId, eventId, dayId, input = {}) => {
  const event = await getDraft(leadId, eventId);
  const day = getDay(event, dayId);
  const item = await composeItem(input, null);
  day.decorItems.push(item);
  await event.save();
  return day.decorItems[day.decorItems.length - 1].toObject();
};

const patchItem = async (leadId, eventId, dayId, itemId, input = {}) => {
  const event = await getDraft(leadId, eventId);
  const day = getDay(event, dayId);
  const item = day.decorItems.id(itemId); // KEYED BY SUBDOC _id
  if (!item) throw err(404, "Item not found");
  const next = await composeItem(input, item);
  Object.assign(item, next);
  await event.save();
  return item.toObject();
};

const removeItem = async (leadId, eventId, dayId, itemId) => {
  const event = await getDraft(leadId, eventId);
  const day = getDay(event, dayId);
  const item = day.decorItems.id(itemId);
  if (!item) throw err(404, "Item not found");
  item.deleteOne();
  await event.save();
  return { ok: true };
};

const reorderItems = async (leadId, eventId, dayId, { ids } = {}) => {
  if (!Array.isArray(ids) || !ids.length) throw err(400, "Pass the ordered item ids");
  const event = await getDraft(leadId, eventId);
  const day = getDay(event, dayId);
  const byId = new Map(day.decorItems.map((i) => [String(i._id), i]));
  if (ids.length !== day.decorItems.length || !ids.every((id) => byId.has(String(id)))) {
    throw err(400, "ids must be exactly the day's items, reordered");
  }
  day.decorItems = ids.map((id) => byId.get(String(id)));
  await event.save();
  return { ok: true, order: ids.map(String) };
};

// ── P4: packages (the legacy add was disabled — built properly) ──────────────
const addPackage = async (leadId, eventId, dayId, { packageId, variant, quantity } = {}) => {
  if (!isId(packageId)) throw err(400, "Pass a packageId");
  const variants = ["artificialFlowers", "naturalFlowers", "mixedFlowers"];
  if (!variants.includes(variant)) throw err(400, `variant must be one of: ${variants.join(", ")}`);
  const qty = Number.isFinite(Number(quantity)) && Number(quantity) > 0 ? Number(quantity) : 1;
  const event = await getDraft(leadId, eventId);
  const day = getDay(event, dayId);
  const pkg = await DecorPackage.findById(packageId, { name: 1, variant: 1 }).lean();
  if (!pkg) throw err(404, "Package not found");
  // Snapshot the chosen variant's selling price AT ADD.
  const unitPrice = Number(pkg.variant && pkg.variant[variant] && pkg.variant[variant].sellingPrice) || 0;
  day.packages.push({ package: pkg._id, variant, price: Math.round(unitPrice * qty), decorItems: [] });
  await event.save();
  return day.packages[day.packages.length - 1].toObject();
};

const removePackage = async (leadId, eventId, dayId, packageRowId) => {
  const event = await getDraft(leadId, eventId);
  const day = getDay(event, dayId);
  const row = day.packages.id(packageRowId);
  if (!row) throw err(404, "Package row not found");
  row.deleteOne();
  await event.save();
  return { ok: true };
};

// ── P4: custom + mandatory (with ES/TS) ──────────────────────────────────────
const addCustomItem = async (leadId, eventId, dayId, { name, price, quantity, image, includeInTotalSummary } = {}) => {
  const clean = String(name || "").trim();
  if (!clean) throw err(400, "The custom item needs a name");
  const event = await getDraft(leadId, eventId);
  const day = getDay(event, dayId);
  day.customItems.push({
    name: clean.slice(0, 200),
    price: Number(price) || 0,
    quantity: Number.isFinite(Number(quantity)) && Number(quantity) > 0 ? Number(quantity) : 1,
    image: String(image || ""),
    includeInTotalSummary: !!includeInTotalSummary,
  });
  await event.save();
  return day.customItems[day.customItems.length - 1].toObject();
};

const addMandatoryItem = async (leadId, eventId, dayId, { title, description, price, image, itemRequired, includeInTotalSummary } = {}) => {
  const clean = String(title || "").trim();
  if (!clean) throw err(400, "The mandatory item needs a title");
  const event = await getDraft(leadId, eventId);
  const day = getDay(event, dayId);
  day.mandatoryItems.push({
    title: clean.slice(0, 200),
    description: String(description || ""),
    price: Number(price) || 0,
    image: String(image || ""),
    itemRequired: !!itemRequired,
    includeInTotalSummary: !!includeInTotalSummary,
  });
  await event.save();
  return day.mandatoryItems[day.mandatoryItems.length - 1].toObject();
};

const patchSideItem = async (leadId, eventId, dayId, kind, itemId, fields = {}) => {
  const event = await getDraft(leadId, eventId);
  const day = getDay(event, dayId);
  const list = kind === "custom" ? day.customItems : day.mandatoryItems;
  const item = list.id(itemId);
  if (!item) throw err(404, "Item not found");
  if (fields.price !== undefined) item.price = Number(fields.price) || 0;
  if (fields.includeInTotalSummary !== undefined) item.includeInTotalSummary = !!fields.includeInTotalSummary;
  if (kind === "custom") {
    if (fields.name !== undefined) item.name = String(fields.name || "").slice(0, 200) || item.name;
    if (fields.quantity !== undefined) item.quantity = Number(fields.quantity) || 1;
  } else {
    if (fields.title !== undefined) item.title = String(fields.title || "").slice(0, 200) || item.title;
    if (fields.itemRequired !== undefined) item.itemRequired = !!fields.itemRequired;
    if (fields.description !== undefined) item.description = String(fields.description || "");
  }
  await event.save();
  return item.toObject();
};

const removeSideItem = async (leadId, eventId, dayId, kind, itemId) => {
  const event = await getDraft(leadId, eventId);
  const day = getDay(event, dayId);
  const list = kind === "custom" ? day.customItems : day.mandatoryItems;
  const item = list.id(itemId);
  if (!item) throw err(404, "Item not found");
  item.deleteOne();
  await event.save();
  return { ok: true };
};

module.exports = {
  createDraft, listDrafts, getDraft, totalsFor,
  addDay, addItem, patchItem, removeItem, reorderItems,
  addPackage, removePackage,
  addCustomItem, addMandatoryItem, patchSideItem, removeSideItem,
  DRAFT_CAP,
};
