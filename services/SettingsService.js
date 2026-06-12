const Setting = require("../models/Setting");

// ─── Defaults: the EXACT current hardcoded values. Empty collection ⇒ identical
// behavior to before this service existed. WhatsApp strings lifted verbatim from
// the cockpit frontend with {{name}}/{{caller}}/{{time}} placeholders. ───────────
const DEFAULTS = {
  "assignment.poolRoles": ["Sales Intern"],
  "assignment.overflowRoles": ["Sales Executive"],
  "assignment.dailyCap": 15,
  "assignment.autoAssignEnabled": true,
  "golden.windowMinutes": 30,
  "golden.workStartHour": 10,
  "golden.workEndHour": 19,
  "cadence.attemptOffsetsDays": [0, 1, 3, 5],
  "cadence.maxAttempts": 4,
  "lost.reasons": ["budget", "competitor", "not_responsive", "not_a_fit", "other"],
  "lost.approvalRequired": true,
  "recycle.reasons": ["wedding_next_year", "budget_mismatch_now", "venue_not_booked", "other"],
  "whatsapp.templates": {
    busy: "Hi {{name}}! This is {{caller}} from Wedsy. We just connected over a call but unfortunately couldn't get to speak — so I've rescheduled our call for {{time}}. Talk to you then!",
    unknown:
      "Hi {{name}}! This is {{caller}} from Wedsy, a wedding planning company. You'd dropped in an enquiry with us and I tried giving you a call, but we couldn't connect. Whenever you have a moment, do let me know a good time to chat — I'd love to help plan your big day!",
    reschedule:
      "Hi {{name}}! This is {{caller}} from Wedsy. We just connected over a call but unfortunately couldn't get to speak. I'll reschedule our call and be in touch shortly. Talk to you soon!",
  },
  "atRisk.newHours": 24,
  "atRisk.contactedHours": 24,
  "tags.available": ["Premium", "NRI", "Destination"],
  "adform.fieldMap": {},
  // Lead visibility cutoff: hide leads created before this date from lists and
  // dashboards (imported + recently re-enquired leads always show). null = off.
  "leads.visibilityCutoff": null,
};

// key → settings permission category. Every write is gated by ITS category.
const KEY_CATEGORY = {
  "assignment.poolRoles": "settings_assignment",
  "assignment.overflowRoles": "settings_assignment",
  "assignment.dailyCap": "settings_assignment",
  "assignment.autoAssignEnabled": "settings_assignment",
  "golden.windowMinutes": "settings_sla",
  "golden.workStartHour": "settings_sla",
  "golden.workEndHour": "settings_sla",
  "atRisk.newHours": "settings_sla",
  "atRisk.contactedHours": "settings_sla",
  "cadence.attemptOffsetsDays": "settings_cadence",
  "cadence.maxAttempts": "settings_cadence",
  "lost.reasons": "settings_reasons",
  "lost.approvalRequired": "settings_reasons",
  "recycle.reasons": "settings_reasons",
  "whatsapp.templates": "settings_templates",
  "tags.available": "settings_templates",
  "adform.fieldMap": "settings_integrations",
  // Visibility cutoff governs what the working pipeline shows → pipeline category.
  "leads.visibilityCutoff": "settings_pipeline",
};

const err = (status, message) => Object.assign(new Error(message), { status });

const isStringArray = (v) =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.trim().length > 0);
const isIntInRange = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// Strict per-key validation. Throws 400 on anything off.
const validateValue = (key, value) => {
  switch (key) {
    case "assignment.poolRoles":
    case "assignment.overflowRoles":
    case "lost.reasons":
    case "recycle.reasons":
    case "tags.available":
      if (!isStringArray(value)) throw err(400, `${key} must be a non-empty array of non-empty strings`);
      return value.map((s) => s.trim());
    case "assignment.dailyCap":
      if (!isIntInRange(value, 1, 100)) throw err(400, "assignment.dailyCap must be an integer 1–100");
      return value;
    case "assignment.autoAssignEnabled":
    case "lost.approvalRequired":
      if (typeof value !== "boolean") throw err(400, `${key} must be a boolean`);
      return value;
    case "golden.windowMinutes":
      if (!isIntInRange(value, 5, 480)) throw err(400, "golden.windowMinutes must be an integer 5–480");
      return value;
    case "golden.workStartHour":
      if (!isIntInRange(value, 0, 23)) throw err(400, "golden.workStartHour must be an hour 0–23");
      return value;
    case "golden.workEndHour":
      if (!isIntInRange(value, 1, 24)) throw err(400, "golden.workEndHour must be an hour 1–24");
      return value;
    case "atRisk.newHours":
    case "atRisk.contactedHours":
      if (!isIntInRange(value, 1, 720)) throw err(400, `${key} must be an integer 1–720`);
      return value;
    case "cadence.maxAttempts":
      if (!isIntInRange(value, 1, 20)) throw err(400, "cadence.maxAttempts must be an integer 1–20");
      return value;
    case "cadence.attemptOffsetsDays": {
      const ok =
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((n) => Number.isInteger(n) && n >= 0) &&
        value.every((n, i) => i === 0 || n > value[i - 1]);
      if (!ok) throw err(400, "cadence.attemptOffsetsDays must be a strictly ascending array of non-negative integers");
      return value;
    }
    case "whatsapp.templates": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw err(400, "whatsapp.templates must be an object of template strings");
      }
      const allowed = ["busy", "unknown", "reschedule"];
      const out = {};
      for (const k of allowed) {
        const t = value[k];
        if (typeof t !== "string" || t.length === 0 || t.length > 1000) {
          throw err(400, `whatsapp.templates.${k} must be a string of 1–1000 chars`);
        }
        out[k] = t;
      }
      return out;
    }
    case "leads.visibilityCutoff": {
      if (value === null || value === "") return null;
      if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
        throw err(400, "leads.visibilityCutoff must be null or a parseable ISO date string");
      }
      return new Date(value).toISOString();
    }
    case "adform.fieldMap": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw err(400, "adform.fieldMap must be an object of { fbKey: target }");
      }
      for (const [k, v] of Object.entries(value)) {
        if (typeof k !== "string" || typeof v !== "string") {
          throw err(400, "adform.fieldMap entries must be string → string");
        }
      }
      return value;
    }
    default:
      throw err(400, `Unknown setting key: ${key}`);
  }
};

// ─── 60s read cache ──────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 1000;
let cache = { values: null, expires: 0 };

const loadAll = async () => {
  if (cache.values && cache.expires > Date.now()) return cache.values;
  const docs = await Setting.find({}).lean();
  const values = {};
  for (const d of docs) values[d.key] = d.value;
  cache = { values, expires: Date.now() + CACHE_TTL_MS };
  return values;
};

const invalidate = () => {
  cache = { values: null, expires: 0 };
};

// Read one key — stored value if present, else the hardcoded default.
const get = async (key) => {
  if (!(key in DEFAULTS)) throw err(400, `Unknown setting key: ${key}`);
  const values = await loadAll();
  return key in values ? values[key] : DEFAULTS[key];
};

const getMany = async (keys) => {
  const values = await loadAll();
  const out = {};
  for (const key of keys) {
    if (!(key in DEFAULTS)) throw err(400, `Unknown setting key: ${key}`);
    out[key] = key in values ? values[key] : DEFAULTS[key];
  }
  return out;
};

// Write one key (validated). Returns the stored value.
const set = async (key, value, updatedBy) => {
  const clean = validateValue(key, value);
  await Setting.findOneAndUpdate(
    { key },
    { $set: { value: clean, updatedBy: updatedBy || null } },
    { upsert: true, new: true }
  );
  invalidate();
  return clean;
};

// All keys of one category with effective values (for GET /settings?category=).
const getCategory = async (category) => {
  const keys = Object.entries(KEY_CATEGORY)
    .filter(([, cat]) => cat === category)
    .map(([k]) => k);
  if (keys.length === 0) throw err(400, `Unknown settings category: ${category}`);
  return await getMany(keys);
};

const categoryForKey = (key) => KEY_CATEGORY[key] || null;
const CATEGORIES = [...new Set(Object.values(KEY_CATEGORY))];

module.exports = {
  DEFAULTS,
  KEY_CATEGORY,
  CATEGORIES,
  get,
  getMany,
  set,
  getCategory,
  categoryForKey,
  validateValue,
  invalidate, // exported for tests
};
