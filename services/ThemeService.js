// A1 — THEMES (Settings → Planner → Themes). A theme is a whole-EVENT
// aesthetic direction spanning all categories inside it. Founder/RH manage
// the library; planners USE it mid-lead. The learning loop tags every product
// added under a theme back onto it — an ADDITIVE suggestion signal: the
// catalogue read surfaces tagged products first per category and NEVER hides
// the rest.
const mongoose = require("mongoose");
const DecorTheme = require("../models/DecorTheme");
const Decor = require("../models/Decor");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const EVENT_TYPES = ["haldi", "sangeet", "wedding", "reception", "custom"];

const list = async ({ eventType, includeInactive } = {}) => {
  const q = {};
  if (eventType) {
    if (!EVENT_TYPES.includes(eventType)) throw err(400, `eventType must be one of: ${EVENT_TYPES.join(", ")}`);
    q.eventType = eventType;
  }
  if (!includeInactive) q.active = true;
  return await DecorTheme.find(q).sort({ name: 1 }).lean();
};

const create = async ({ name, eventType, backgroundImageUrl, active, taggedDecorIds } = {}, actorId) => {
  const clean = String(name || "").trim();
  if (!clean) throw err(400, "A theme needs a name.");
  if (!EVENT_TYPES.includes(eventType)) throw err(400, `eventType must be one of: ${EVENT_TYPES.join(", ")}`);
  return (
    await DecorTheme.create({
      name: clean.slice(0, 120),
      eventType,
      backgroundImageUrl: String(backgroundImageUrl || "").slice(0, 1000),
      active: active !== false,
      taggedDecorIds: Array.isArray(taggedDecorIds) ? taggedDecorIds.filter(isId) : [],
      createdBy: actorId || null,
    })
  ).toObject();
};

// Whitelisted patch — name/eventType/backgroundImageUrl/active/taggedDecorIds.
const patch = async (themeId, fields = {}) => {
  if (!isId(themeId)) throw err(400, "Invalid theme id");
  const set = {};
  if (fields.name !== undefined) {
    const n = String(fields.name || "").trim();
    if (!n) throw err(400, "A theme needs a name.");
    set.name = n.slice(0, 120);
  }
  if (fields.eventType !== undefined) {
    if (!EVENT_TYPES.includes(fields.eventType)) throw err(400, `eventType must be one of: ${EVENT_TYPES.join(", ")}`);
    set.eventType = fields.eventType;
  }
  if (fields.backgroundImageUrl !== undefined) set.backgroundImageUrl = String(fields.backgroundImageUrl || "").slice(0, 1000);
  if (fields.active !== undefined) set.active = !!fields.active;
  if (fields.taggedDecorIds !== undefined) {
    if (!Array.isArray(fields.taggedDecorIds)) throw err(400, "taggedDecorIds must be an array");
    set.taggedDecorIds = [...new Set(fields.taggedDecorIds.filter(isId).map(String))];
  }
  if (!Object.keys(set).length) throw err(400, "Nothing to update.");
  const doc = await DecorTheme.findByIdAndUpdate(themeId, { $set: set }, { new: true }).lean();
  if (!doc) throw err(404, "Theme not found");
  return doc;
};

const remove = async (themeId) => {
  if (!isId(themeId)) throw err(400, "Invalid theme id");
  const gone = await DecorTheme.findByIdAndDelete(themeId).lean();
  if (!gone) throw err(404, "Theme not found");
  return { ok: true };
};

// THE LEARNING LOOP — adding a product to a plan under this theme tags it
// back (dedupe via $addToSet, additive, fire-safe).
const tagDecor = async (themeId, decorId) => {
  if (!isId(themeId) || !isId(decorId)) return;
  try {
    await DecorTheme.updateOne({ _id: themeId }, { $addToSet: { taggedDecorIds: decorId } });
  } catch (e) {
    console.error("[Theme] learning-loop tag failed:", e.message);
  }
};

// The catalogue read for a theme: tagged products FIRST (per category when
// filtered), then the rest of the visible catalogue — never hidden.
const catalogue = async (themeId, { categoryKey, limit } = {}) => {
  if (!isId(themeId)) throw err(400, "Invalid theme id");
  const theme = await DecorTheme.findById(themeId).lean();
  if (!theme) throw err(404, "Theme not found");
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const base = { productVisibility: true };
  if (categoryKey) base.category = new RegExp(`^${String(categoryKey).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const PROJ = { name: 1, category: 1, thumbnail: 1, image: 1, productTypes: 1, "productInfo.id": 1 };

  const tagged = theme.taggedDecorIds.length
    ? await Decor.find({ ...base, _id: { $in: theme.taggedDecorIds } }, PROJ).limit(lim).lean()
    : [];
  const rest = await Decor.find(
    { ...base, _id: { $nin: theme.taggedDecorIds } },
    PROJ
  )
    .sort({ createdAt: -1 })
    .limit(lim)
    .lean();

  const row = (d, suggested) => ({
    decorId: String(d._id),
    name: d.name,
    category: d.category,
    image: d.thumbnail || d.image || "",
    productId: (d.productInfo && d.productInfo.id) || "",
    price: Number((d.productTypes || [])[0]?.sellingPrice) || 0,
    suggested,
  });
  return {
    theme: { _id: String(theme._id), name: theme.name, eventType: theme.eventType, backgroundImageUrl: theme.backgroundImageUrl },
    suggested: tagged.map((d) => row(d, true)),
    catalogue: rest.map((d) => row(d, false)),
  };
};

module.exports = { list, create, patch, remove, tagDecor, catalogue, EVENT_TYPES };
