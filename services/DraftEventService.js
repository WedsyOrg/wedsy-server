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
// Addendum A7 — the locked flow allows up to 5 drafts (was 3).
const DRAFT_CAP = 5;

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
  if (existing >= DRAFT_CAP) throw err(422, `${DRAFT_CAP} drafts is the cap — retire one before adding "${clean}".`);
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

// ONE draft with its full day→item detail — the shape the FE item table
// renders. Read-only (OS *or* couple-origin events on this lead, like the
// list). The list carries totals but not items; this fills that gap.
const getDraftDetail = async (leadId, eventId) => {
  if (!isId(leadId) || !isId(eventId)) throw err(400, "Invalid id");
  const event = await Event.findOne({ _id: eventId, leadId }).lean();
  if (!event) {
    // Couple-origin events are reachable through the Onboarding bridge; still
    // read-only, but visible in the list, so readable here too.
    const bridge = await Onboarding.findOne({ leadId, eventId }, { eventId: 1 }).lean();
    if (!bridge) throw err(404, "Draft not found on this lead");
  }
  const doc = event || (await Event.findById(eventId).lean());
  if (!doc) throw err(404, "Draft not found");

  // Batch-hydrate the decor display fields (name / category / thumbnail) the
  // item table needs — the subdoc stores only the decor ObjectId.
  const decorIds = [
    ...new Set(
      (doc.eventDays || [])
        .flatMap((d) => d.decorItems || [])
        .map((it) => String(it.decor || ""))
        .filter(Boolean)
    ),
  ];
  const decors = decorIds.length
    ? await Decor.find({ _id: { $in: decorIds } }, { name: 1, category: 1, thumbnail: 1, image: 1 }).lean()
    : [];
  const decorById = new Map(decors.map((d) => [String(d._id), d]));

  const mapItem = (it) => {
    const d = decorById.get(String(it.decor || "")) || {};
    return {
      _id: String(it._id),
      decor: it.decor ? String(it.decor) : null,
      decorId: it.decor ? String(it.decor) : null,
      name: d.name || "",
      category: it.category || d.category || "",
      thumbnail: d.thumbnail || d.image || "",
      variant: it.variant || "Standard",
      productVariant: it.productVariant || "",
      quantity: it.quantity != null ? it.quantity : 1,
      unit: it.unit || "",
      platform: !!it.platform,
      platformRate: Number(it.platformRate) || 0,
      flooring: it.flooring || "",
      flooringRate: Number(it.flooringRate) || 0,
      decorPrice: Number(it.decorPrice) || 0,
      priceModifier: Number(it.priceModifier) || 0,
      dimensions: {
        length: (it.dimensions && it.dimensions.length) || 0,
        breadth: (it.dimensions && it.dimensions.breadth) || 0,
        height: (it.dimensions && it.dimensions.height) || 0,
      },
      addOns: (it.addOns || []).map((a) => ({ name: a.name || "", price: Number(a.price) || 0, notes: a.notes || "" })),
      included: it.included || [],
      user_notes: it.user_notes || "",
      admin_notes: it.admin_notes || "",
      setupLocationImage: it.setupLocationImage || "",
      price: Number(it.price) || 0,
    };
  };

  const days = (doc.eventDays || []).map((day) => ({
    dayId: String(day._id),
    name: day.name || "",
    date: day.date || "",
    time: day.time || "",
    venue: day.venue || "",
    // FE derives functionKey from the day name (lowercased); expose it too.
    functionKey: String(day.name || "").toLowerCase(),
    decorItems: (day.decorItems || []).map(mapItem),
    packages: day.packages || [],
    customItems: day.customItems || [],
    mandatoryItems: day.mandatoryItems || [],
  }));

  return {
    eventId: String(doc._id),
    name: doc.draftName || doc.name,
    origin: event ? "os" : "couple",
    status: doc.status || {},
    totals: await totalsFor(doc),
    days,
  };
};

// OS-draft guard: writes NEVER touch couple-origin events. A5: a LOCKED
// (finalised) draft refuses writes with 409 until explicitly unlocked.
const getDraft = async (leadId, eventId, { forWrite = false } = {}) => {
  if (!isId(leadId) || !isId(eventId)) throw err(400, "Invalid id");
  const event = await Event.findOne({ _id: eventId, leadId });
  if (!event) throw err(404, "Draft not found on this lead (couple events are read-only here)");
  if (forWrite && event.locked) {
    throw err(409, `"${event.draftName || event.name}" is finalised and locked — unlock it to amend.`);
  }
  return event;
};

// A6 — every draft write marks a PUBLISHED draft dirty (the couple sees the
// frozen snapshot; the FE gets its "update their view" nudge from this flag).
const saveDraftWrite = async (event) => {
  if (event.published) event.hasUnpublishedChanges = true;
  await event.save();
};

const planChangeLog = require("../utils/planChangeLog");

// ── P4: days ─────────────────────────────────────────────────────────────────
const addDay = async (leadId, eventId, { name, date, time, venue, eventSpace } = {}, actorId = null) => {
  const event = await getDraft(leadId, eventId, { forWrite: true });
  event.eventDays.push({
    name: String(name || `Day ${event.eventDays.length + 1}`).slice(0, 120),
    date: String(date || "TBD").slice(0, 40),
    time: String(time || "TBD").slice(0, 40),
    venue: String(venue || "TBD").slice(0, 200),
    eventSpace: String(eventSpace || "").slice(0, 200),
  });
  await saveDraftWrite(event);
  const savedDay = event.eventDays[event.eventDays.length - 1].toObject();
  await planChangeLog.record(leadId, actorId, { op: "add", kind: "day", name: savedDay.name, draftName: event.draftName || event.name });
  return savedDay;
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
      ? merged.addOns.map((a) => ({
          name: String((a && a.name) || ""),
          price: Number(a && a.price) || 0, // negatives valid — sign-flip deductions
          notes: String((a && a.notes) || ""),
          quantity: Number.isFinite(Number(a && a.quantity)) && Number(a.quantity) > 0 ? Number(a.quantity) : 1,
          ests: a && (a.ests === "es" || a.ests === "ts") ? a.ests : null, // flag only, never priced
          photo: String((a && a.photo) || ""),
        }))
      : item.addOns || [],
    included: Array.isArray(merged.included) ? merged.included.map(String) : item.included || [],
    user_notes: String(merged.user_notes ?? item.user_notes ?? ""),
    admin_notes: String(merged.admin_notes ?? item.admin_notes ?? ""),
    // Setup-reference image URL (the ⚙ editor's "setup reference"). Subdoc-backed
    // (Event.decorItems.setupLocationImage); whitelist-added here so it round-trips.
    setupLocationImage: String(merged.setupLocationImage ?? item.setupLocationImage ?? ""),
    // Item-editor fields (additive) — same echo discipline as setupLocationImage.
    setupLocation: String(merged.setupLocation ?? item.setupLocation ?? ""),
    priceAdj: Number(merged.priceAdj ?? item.priceAdj ?? 0) || 0,
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

const addItem = async (leadId, eventId, dayId, input = {}, actorId = null) => {
  const event = await getDraft(leadId, eventId, { forWrite: true });
  const day = getDay(event, dayId);
  const item = await composeItem(input, null);
  day.decorItems.push(item);
  await saveDraftWrite(event);
  const savedItem = day.decorItems[day.decorItems.length - 1].toObject();
  await planChangeLog.record(leadId, actorId, {
    op: "add", kind: "item", name: savedItem.category, price: savedItem.price,
    draftName: event.draftName || event.name, dayName: day.name,
  });
  return savedItem;
};

const patchItem = async (leadId, eventId, dayId, itemId, input = {}, actorId = null) => {
  const event = await getDraft(leadId, eventId, { forWrite: true });
  const day = getDay(event, dayId);
  const item = day.decorItems.id(itemId); // KEYED BY SUBDOC _id
  if (!item) throw err(404, "Item not found");
  const next = await composeItem(input, item);
  Object.assign(item, next);
  await saveDraftWrite(event);
  await planChangeLog.record(leadId, actorId, {
    op: "edit", kind: "item", name: item.category, price: item.price,
    draftName: event.draftName || event.name, dayName: day.name,
  });
  return item.toObject();
};

const removeItem = async (leadId, eventId, dayId, itemId, actorId = null) => {
  const event = await getDraft(leadId, eventId, { forWrite: true });
  const day = getDay(event, dayId);
  const item = day.decorItems.id(itemId);
  if (!item) throw err(404, "Item not found");
  const what = { name: item.category, price: item.price };
  item.deleteOne();
  await saveDraftWrite(event);
  await planChangeLog.record(leadId, actorId, {
    op: "delete", kind: "item", ...what, draftName: event.draftName || event.name, dayName: day.name,
  });
  return { ok: true };
};

const reorderItems = async (leadId, eventId, dayId, { ids } = {}) => {
  if (!Array.isArray(ids) || !ids.length) throw err(400, "Pass the ordered item ids");
  const event = await getDraft(leadId, eventId, { forWrite: true });
  const day = getDay(event, dayId);
  const byId = new Map(day.decorItems.map((i) => [String(i._id), i]));
  if (ids.length !== day.decorItems.length || !ids.every((id) => byId.has(String(id)))) {
    throw err(400, "ids must be exactly the day's items, reordered");
  }
  day.decorItems = ids.map((id) => byId.get(String(id)));
  await saveDraftWrite(event);
  return { ok: true, order: ids.map(String) };
};

// ── P4: packages (the legacy add was disabled — built properly) ──────────────
const addPackage = async (leadId, eventId, dayId, { packageId, variant, quantity } = {}, actorId = null) => {
  if (!isId(packageId)) throw err(400, "Pass a packageId");
  const variants = ["artificialFlowers", "naturalFlowers", "mixedFlowers"];
  if (!variants.includes(variant)) throw err(400, `variant must be one of: ${variants.join(", ")}`);
  const qty = Number.isFinite(Number(quantity)) && Number(quantity) > 0 ? Number(quantity) : 1;
  const event = await getDraft(leadId, eventId, { forWrite: true });
  const day = getDay(event, dayId);
  const pkg = await DecorPackage.findById(packageId, { name: 1, variant: 1 }).lean();
  if (!pkg) throw err(404, "Package not found");
  // Snapshot the chosen variant's selling price AT ADD.
  const unitPrice = Number(pkg.variant && pkg.variant[variant] && pkg.variant[variant].sellingPrice) || 0;
  day.packages.push({ package: pkg._id, variant, price: Math.round(unitPrice * qty), decorItems: [] });
  await saveDraftWrite(event);
  await planChangeLog.record(leadId, actorId, {
    op: "add", kind: "package", name: pkg.name, price: Math.round(unitPrice * qty),
    draftName: event.draftName || event.name, dayName: day.name,
  });
  return day.packages[day.packages.length - 1].toObject();
};

const removePackage = async (leadId, eventId, dayId, packageRowId) => {
  const event = await getDraft(leadId, eventId, { forWrite: true });
  const day = getDay(event, dayId);
  const row = day.packages.id(packageRowId);
  if (!row) throw err(404, "Package row not found");
  row.deleteOne();
  await saveDraftWrite(event);
  return { ok: true };
};

// ── P4: custom + mandatory (with ES/TS) ──────────────────────────────────────
const addCustomItem = async (leadId, eventId, dayId, { name, price, quantity, image, includeInTotalSummary } = {}) => {
  const clean = String(name || "").trim();
  if (!clean) throw err(400, "The custom item needs a name");
  const event = await getDraft(leadId, eventId, { forWrite: true });
  const day = getDay(event, dayId);
  day.customItems.push({
    name: clean.slice(0, 200),
    price: Number(price) || 0,
    quantity: Number.isFinite(Number(quantity)) && Number(quantity) > 0 ? Number(quantity) : 1,
    image: String(image || ""),
    includeInTotalSummary: !!includeInTotalSummary,
  });
  await saveDraftWrite(event);
  return day.customItems[day.customItems.length - 1].toObject();
};

const addMandatoryItem = async (leadId, eventId, dayId, { title, description, price, image, itemRequired, includeInTotalSummary } = {}) => {
  const clean = String(title || "").trim();
  if (!clean) throw err(400, "The mandatory item needs a title");
  const event = await getDraft(leadId, eventId, { forWrite: true });
  const day = getDay(event, dayId);
  day.mandatoryItems.push({
    title: clean.slice(0, 200),
    description: String(description || ""),
    price: Number(price) || 0,
    image: String(image || ""),
    itemRequired: !!itemRequired,
    includeInTotalSummary: !!includeInTotalSummary,
  });
  await saveDraftWrite(event);
  return day.mandatoryItems[day.mandatoryItems.length - 1].toObject();
};

const patchSideItem = async (leadId, eventId, dayId, kind, itemId, fields = {}) => {
  const event = await getDraft(leadId, eventId, { forWrite: true });
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
  await saveDraftWrite(event);
  return item.toObject();
};

const removeSideItem = async (leadId, eventId, dayId, kind, itemId) => {
  const event = await getDraft(leadId, eventId, { forWrite: true });
  const day = getDay(event, dayId);
  const list = kind === "custom" ? day.customItems : day.mandatoryItems;
  const item = list.id(itemId);
  if (!item) throw err(404, "Item not found");
  item.deleteOne();
  await saveDraftWrite(event);
  return { ok: true };
};

// ── A5: finalise / unlock ────────────────────────────────────────────────────
// The finalise gate: pricing is whole-wedding. "Complete" is ultimately the
// planner's JUDGMENT (the locked doc keeps readiness human-inferred), so the
// machine check is soft: every day of THIS draft must carry at least one
// priced row, OR the planner sets the plan-level selectionComplete flag.
// Neither → 422 with the override hint (warn, never imprison).
const finalise = async (leadId, eventId, { by } = {}, actorId) => {
  if (!["couple", "admin"].includes(by)) throw err(400, 'by must be "couple" | "admin"');
  const event = await getDraft(leadId, eventId);
  if (event.locked) throw err(409, "Already finalised — unlock to amend, then re-finalise.");

  const LeadPlan = require("../models/LeadPlan");
  const plan = await LeadPlan.findOne({ leadId }, { selectionComplete: 1 }).lean();
  const emptyDays = (event.eventDays || []).filter(
    (d) => !(d.decorItems || []).length && !(d.packages || []).length && !(d.customItems || []).length
  );
  if (emptyDays.length && !(plan && plan.selectionComplete)) {
    throw err(
      422,
      `Selection looks incomplete — ${emptyDays.map((d) => d.name).join(", ")} ${emptyDays.length === 1 ? "has" : "have"} no items. ` +
        "Complete the selection, or set the plan's selectionComplete flag to finalise anyway."
    );
  }

  event.locked = true;
  event.lockedAt = new Date();
  event.lockedBy = actorId || null;
  event.finalisedBy = by;
  await event.save(); // deliberate raw save — the lock itself isn't a couple-visible edit

  // The money membrane: the finalised total feeds the Décor lane (never re-typed).
  let fed = null;
  try {
    fed = await require("./PlanSnapshotService").feedDecorLane(leadId, eventId, actorId);
  } catch (e) {
    console.error("[Draft] finalise lane feed failed:", e.message);
  }
  try {
    await require("./LeadActivityService").ingest(
      {
        leadId,
        kind: "other",
        text: `"${event.draftName || event.name}" finalised${by === "couple" ? " by the couple" : " (planner on-behalf)"} — the bill of materials is locked`,
        meta: { eventId: String(eventId), finalisedBy: by },
        voice: "wedsy",
      },
      { adminId: actorId }
    );
  } catch (e) {
    console.error("[Draft] finalise echo failed:", e.message);
  }
  await planChangeLog.record(leadId, actorId, { op: "finalise", kind: "draft", name: event.draftName || event.name, by });
  return { locked: true, lockedAt: event.lockedAt, finalisedBy: by, laneFeed: fed };
};

// Unlock = the deliberate reopening of the deal value (owner/manager only —
// the controller enforces the stricter gate). Logged; re-finalise re-locks.
const unlock = async (leadId, eventId, actorId) => {
  const event = await getDraft(leadId, eventId);
  if (!event.locked) throw err(400, "Not locked.");
  event.locked = false;
  event.lockedAt = null;
  event.lockedBy = null;
  await event.save();
  await planChangeLog.record(leadId, actorId, { op: "unlock", kind: "draft", name: event.draftName || event.name });
  try {
    await require("./LeadActivityService").ingest(
      { leadId, kind: "other", text: `"${event.draftName || event.name}" unlocked for amendment`, meta: { eventId: String(eventId) }, voice: "wedsy" },
      { adminId: actorId }
    );
  } catch (e) {
    console.error("[Draft] unlock echo failed:", e.message);
  }
  return { locked: false };
};

// ── A6: per-draft publish / revoke ───────────────────────────────────────────
const publishDraft = async (leadId, eventId, { coverNote, pricingVisible = true } = {}, actorId) => {
  const event = await getDraft(leadId, eventId); // publish allowed on locked drafts (read-freeze)
  const PlanSnapshotService = require("./PlanSnapshotService");
  const snap = await PlanSnapshotService.publish(
    leadId,
    { kind: "draft", eventId, title: event.draftName || event.name, coverNote, pricingVisible, full: true },
    actorId
  );
  event.published = true;
  event.publishedAt = new Date();
  event.publishedSnapshotId = snap._id;
  event.hasUnpublishedChanges = false;
  await event.save();
  await planChangeLog.record(leadId, actorId, { op: "publish", kind: "draft", name: event.draftName || event.name });
  return { published: true, snapshotId: String(snap._id), publishedAt: event.publishedAt };
};

const revokeDraft = async (leadId, eventId, actorId) => {
  const event = await getDraft(leadId, eventId);
  if (!event.published) throw err(400, "Not published.");
  event.published = false;
  event.hasUnpublishedChanges = false;
  await event.save(); // the snapshot itself is kept (audit); the couple read hides it
  await planChangeLog.record(leadId, actorId, { op: "revoke", kind: "draft", name: event.draftName || event.name });
  return { published: false };
};

// The couple-facing read: ONLY the frozen snapshot of a still-published draft.
const publishedSnapshotFor = async (leadId, eventId) => {
  const event = await Event.findOne({ _id: eventId, leadId }).lean();
  if (!event || !event.published || !event.publishedSnapshotId) throw err(404, "Nothing published for this draft.");
  return await require("./PlanSnapshotService").get(leadId, event.publishedSnapshotId);
};

// ── A7: multi-draft ops (independent copies — fresh subdoc _id every time) ──
const dayForFunction = (event, functionKey) => {
  const fn = String(functionKey || "").trim().toLowerCase();
  if (fn) {
    const hit = event.eventDays.find((d) => String(d.name || "").trim().toLowerCase() === fn);
    if (hit) return hit;
  }
  return event.eventDays[0] || null;
};

const ensureDay = async (event, functionKey) => {
  let day = dayForFunction(event, functionKey);
  if (!day) {
    event.eventDays.push({ name: functionKey || "Day 1", date: "TBD", time: "TBD", venue: "TBD" });
    day = event.eventDays[event.eventDays.length - 1];
  }
  return day;
};

// Push shortlisted looks INTO drafts — COPY, never consume (the shortlist
// stays intact). Only decor-source looks materialize as priced items; other
// sources are skipped and reported.
const pushToBuild = async (leadId, { lookIds, draftIds } = {}, actorId) => {
  if (!Array.isArray(lookIds) || !lookIds.length) throw err(400, "Pass lookIds");
  if (!Array.isArray(draftIds) || !draftIds.length) throw err(400, "Pass draftIds");
  const LeadPlan = require("../models/LeadPlan");
  const plan = await LeadPlan.findOne({ leadId }).lean();
  if (!plan) throw err(404, "No plan yet");
  const wanted = new Set(lookIds.map(String));
  const looks = (plan.looks || []).filter((l) => wanted.has(String(l._id)));
  if (!looks.length) throw err(404, "No matching looks");

  const added = [];
  const skipped = [];
  for (const draftId of draftIds) {
    const event = await getDraft(leadId, draftId, { forWrite: true });
    for (const look of looks) {
      if (look.source !== "decor" || !look.decorId) {
        skipped.push({ lookId: String(look._id), reason: "not a decor look" });
        continue;
      }
      const day = await ensureDay(event, look.functionKey);
      const item = await composeItem({ decorId: look.decorId, quantity: 1 }, null);
      day.decorItems.push(item);
      added.push({ draftId: String(draftId), lookId: String(look._id), itemId: null });
    }
    await saveDraftWrite(event);
    await planChangeLog.record(leadId, actorId, {
      op: "add", kind: "item", name: `${looks.length} from shortlist`, draftName: event.draftName || event.name, count: looks.length,
    });
  }
  return { added: added.length, skipped, shortlistIntact: true };
};

// Copy an item into other drafts (independent copies, day matched by name).
const copyItem = async (leadId, eventId, dayId, itemId, { toDraftIds } = {}, actorId) => {
  if (!Array.isArray(toDraftIds) || !toDraftIds.length) throw err(400, "Pass toDraftIds");
  const source = await getDraft(leadId, eventId);
  const day = getDay(source, dayId);
  const item = day.decorItems.id(itemId);
  if (!item) throw err(404, "Item not found");
  const plain = item.toObject();
  delete plain._id;
  const copies = [];
  for (const target of toDraftIds) {
    const event = await getDraft(leadId, target, { forWrite: true });
    const tDay = await ensureDay(event, day.name);
    tDay.decorItems.push(plain);
    await saveDraftWrite(event);
    copies.push({ draftId: String(target), itemId: String(tDay.decorItems[tDay.decorItems.length - 1]._id) });
    await planChangeLog.record(leadId, actorId, {
      op: "add", kind: "item", name: plain.category, price: plain.price, draftName: event.draftName || event.name, dayName: tDay.name,
    });
  }
  return { copies };
};

const moveItem = async (leadId, eventId, dayId, itemId, { toDraftId } = {}, actorId) => {
  if (!isId(toDraftId)) throw err(400, "Pass toDraftId");
  const { copies } = await copyItem(leadId, eventId, dayId, itemId, { toDraftIds: [toDraftId] }, actorId);
  await removeItem(leadId, eventId, dayId, itemId, actorId);
  return { moved: copies[0] };
};

// Multi-target add: write the same product into several drafts at once —
// each an independent row.
const addItemMulti = async (leadId, primaryEventId, dayId, input = {}, draftIds = [], actorId = null) => {
  const item = await addItem(leadId, primaryEventId, dayId, input, actorId);
  const replicated = [];
  for (const target of draftIds.filter((d) => String(d) !== String(primaryEventId))) {
    const event = await getDraft(leadId, target, { forWrite: true });
    const srcEvent = await getDraft(leadId, primaryEventId);
    const srcDay = getDay(srcEvent, dayId);
    const tDay = await ensureDay(event, srcDay.name);
    const plain = { ...item };
    delete plain._id;
    tDay.decorItems.push(plain);
    await saveDraftWrite(event);
    replicated.push({ draftId: String(target), itemId: String(tDay.decorItems[tDay.decorItems.length - 1]._id) });
  }
  return { item, replicated };
};

module.exports = {
  createDraft, listDrafts, getDraftDetail, getDraft, totalsFor,
  finalise, unlock, publishDraft, revokeDraft, publishedSnapshotFor,
  pushToBuild, copyItem, moveItem, addItemMulti,
  addDay, addItem, patchItem, removeItem, reorderItems,
  addPackage, removePackage,
  addCustomItem, addMandatoryItem, patchSideItem, removeSideItem,
  DRAFT_CAP,
};
