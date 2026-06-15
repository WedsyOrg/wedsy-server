const Setting = require("../models/Setting");
const { KIARA_DEFAULT_SYSTEM_PROMPT } = require("./kiaraDefaultPrompt");

// ─── Defaults: the EXACT current hardcoded values. Empty collection ⇒ identical
// behavior to before this service existed. WhatsApp strings lifted verbatim from
// the cockpit frontend with {{name}}/{{caller}}/{{time}} placeholders. ───────────
const DEFAULTS = {
  "assignment.poolRoles": ["Sales Intern"],
  "assignment.overflowRoles": ["Sales Executive"],
  "assignment.dailyCap": 15,
  "assignment.autoAssignEnabled": true,
  // MB5 Slice 4: 'auto' = round-robin exactly as before (zero behavior change
  // on deploy); 'triage' = new leads land unassigned in the Triage queue.
  "assignment.mode": "auto",
  "triage.escalateAfterMinutes": 10,
  // MB5 Slice 5: founder-approved default changes — golden window 15 min,
  // working hours 11:00–19:00 IST.
  "golden.windowMinutes": 15,
  "golden.workStartHour": 11,
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
  // Kiara (the WhatsApp AI agent). systemPrompt seeds VERBATIM from the former
  // hardcoded text — empty settings ⇒ zero behavior change. Qualification
  // FIELDS stay code-defined (extractor + QualifiedLead + Sheets coupling).
  "kiara.systemPrompt": KIARA_DEFAULT_SYSTEM_PROMPT,
  "kiara.reengageTemplateName": "",
  // MB5 Slice 5: the safety net's approved welcome template. '' = the whole
  // safety net is DORMANT (ships off; founder arms it in Settings → Kiara).
  "kiara.welcomeTemplateName": "",
  // MB6 Slice 6: the services master list (qualification multi-select chips).
  "services.available": [
    "Venue",
    "Decor",
    "Catering",
    "Photography",
    "Makeup",
    "Mehendi",
    "Logistics",
    "Entertainment",
  ],
  // MB6 Slice 6: cockpit call scripts — founder-editable in Settings (the
  // settings_scripts category). Draft v1 texts; the cockpit renders these live.
  "cockpit.briefScript":
    "Hi {{name}}! This is {{caller}} from Wedsy — first of all, congratulations on the wedding! 🎉 " +
    "I saw your enquiry come in and wanted to call right away. A quick line about us: we're a Bengaluru " +
    "wedding company that takes care of everything under one roof — planning, decor, catering, photography, " +
    "makeup, mehendi, and all the running-around on the day itself. But before I talk shop — tell me about " +
    "you two! When's the big day, and how far along are the preparations?",
  "cockpit.servicesScript":
    "Lovely — so here's how we usually help. Some couples hand us the entire wedding, others just the pieces " +
    "they don't want to worry about: the venue hunt, decor, catering, photography, makeup, mehendi, " +
    "entertainment, or simply the day-of logistics so the family actually gets to enjoy the wedding. " +
    "Which parts are still open for you? I'll note them down so the right team preps before we meet.",
  "cockpit.budgetScript":
    "And just so I point you to the right options — do you have a rough budget in mind? Even a ballpark " +
    "for the pieces you want us to handle helps us tailor things properly. And honestly, if you'd rather " +
    "not put a number on it yet, that's completely fine — most couples figure it out with us as we go.",
  "cockpit.qualificationIntro":
    "Before I let you go — let me make sure I have everything so the team can hit the ground running: " +
    "both your names, the date or month you're aiming for, whether the venue is sorted, and the best email " +
    "to send our ideas to (yours and your partner's, if you like — that way nobody misses anything). " +
    "Two quick minutes, promise!",
  // MB7a Slice 3 — e-sign agreement terms (founder-editable, settings_agreement).
  // PLACEHOLDER, not legal text — the founder pastes the real terms later.
  "agreement.terms":
    "[PLACEHOLDER — replace with Wedsy's real service agreement before going live.] " +
    "This Wedsy wedding services agreement sets out what we'll deliver, the payment " +
    "milestones (onboarding fee, advance, and balance), timelines, and cancellation " +
    "terms. By accepting, you confirm you've read and agree to these terms. " +
    "Edit this in Settings → Agreement.",
  // Bump when the terms change materially — stamped onto each acceptance.
  "agreement.version": "v1",
  // MB7b Slice 4 — nurture cadence (days between CS touches in the couple's
  // WhatsApp group). Founder-editable; the rolling nurture task reschedules to
  // now + this many days on every completed touch or couple inbound.
  "nurture.cadenceDays": 2,
  // MB8c-2a-ii — the ONE accountability threshold. A step in_progress (or
  // assigned & not_started) with no movement in this many days needs attention.
  // The command-center banner, the chat follow-up cards, and the Pipeline
  // "stuck" flag ALL derive from this single value (default 3 days).
  "accountability.staleDays": 3,
  // MB9a-2 — speed-to-lead SLA. The golden-window clock duration (minutes from
  // "human needed" to first human contact) + the rescue-escalation thresholds.
  // Distinct from the legacy MB5 golden.windowMinutes (the cockpit/safety-net
  // display) so neither changes the other.
  "sla.goldenWindowMinutes": 30,
  "sla.rescueTier1Minutes": 5,
  "sla.rescueTier2Minutes": 1,
};

// key → settings permission category. Every write is gated by ITS category.
const KEY_CATEGORY = {
  "assignment.poolRoles": "settings_assignment",
  "assignment.overflowRoles": "settings_assignment",
  "assignment.dailyCap": "settings_assignment",
  "assignment.autoAssignEnabled": "settings_assignment",
  "assignment.mode": "settings_assignment",
  "triage.escalateAfterMinutes": "settings_assignment",
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
  // Kiara's brain — founder-gated category.
  "kiara.systemPrompt": "settings_kiara",
  "kiara.reengageTemplateName": "settings_kiara",
  "kiara.welcomeTemplateName": "settings_kiara",
  // Services master list rides the templates/tag-library category.
  "services.available": "settings_templates",
  // Cockpit scripts — their own resource (seed-granted; founder wildcard covers).
  "cockpit.briefScript": "settings_scripts",
  "cockpit.servicesScript": "settings_scripts",
  "cockpit.budgetScript": "settings_scripts",
  "cockpit.qualificationIntro": "settings_scripts",
  "agreement.terms": "settings_agreement",
  "agreement.version": "settings_agreement",
  "nurture.cadenceDays": "settings_nurture",
  // Accountability threshold rides the SLA settings category.
  "accountability.staleDays": "settings_sla",
  "sla.goldenWindowMinutes": "settings_sla",
  "sla.rescueTier1Minutes": "settings_sla",
  "sla.rescueTier2Minutes": "settings_sla",
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
    case "services.available":
      if (!isStringArray(value)) throw err(400, `${key} must be a non-empty array of non-empty strings`);
      return value.map((s) => s.trim());
    case "cockpit.briefScript":
    case "cockpit.servicesScript":
    case "cockpit.budgetScript":
    case "cockpit.qualificationIntro":
      if (typeof value !== "string" || value.length > 5000) {
        throw err(400, `${key} must be a string of at most 5000 chars`);
      }
      return value;
    case "agreement.terms":
      if (typeof value !== "string" || value.trim().length === 0 || value.length > 50000) {
        throw err(400, "agreement.terms must be a non-empty string of at most 50000 chars");
      }
      return value;
    case "agreement.version":
      if (typeof value !== "string" || value.trim().length === 0 || value.length > 40) {
        throw err(400, "agreement.version must be a non-empty string of at most 40 chars");
      }
      return value.trim();
    case "assignment.dailyCap":
      if (!isIntInRange(value, 1, 100)) throw err(400, "assignment.dailyCap must be an integer 1–100");
      return value;
    case "assignment.mode":
      if (!["auto", "triage"].includes(value)) throw err(400, "assignment.mode must be 'auto' or 'triage'");
      return value;
    case "triage.escalateAfterMinutes":
      if (!isIntInRange(value, 1, 240)) throw err(400, "triage.escalateAfterMinutes must be an integer 1–240");
      return value;
    case "nurture.cadenceDays":
      if (!isIntInRange(value, 1, 30)) throw err(400, "nurture.cadenceDays must be an integer 1–30");
      return value;
    case "accountability.staleDays":
      if (!isIntInRange(value, 1, 30)) throw err(400, "accountability.staleDays must be an integer 1–30");
      return value;
    case "sla.goldenWindowMinutes":
      if (!isIntInRange(value, 5, 480)) throw err(400, "sla.goldenWindowMinutes must be an integer 5–480");
      return value;
    case "sla.rescueTier1Minutes":
      if (!isIntInRange(value, 1, 60)) throw err(400, "sla.rescueTier1Minutes must be an integer 1–60");
      return value;
    case "sla.rescueTier2Minutes":
      if (!isIntInRange(value, 1, 30)) throw err(400, "sla.rescueTier2Minutes must be an integer 1–30");
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
    case "kiara.systemPrompt": {
      if (typeof value !== "string" || value.trim().length === 0 || value.length > 20000) {
        throw err(400, "kiara.systemPrompt must be a non-empty string of at most 20000 chars");
      }
      return value;
    }
    case "kiara.reengageTemplateName":
    case "kiara.welcomeTemplateName": {
      if (typeof value !== "string" || value.length > 200) {
        throw err(400, `${key} must be a string of at most 200 chars`);
      }
      // Meta template names: lowercase/digits/underscores. Empty = unset.
      if (value && !/^[a-z0-9_]+$/.test(value)) {
        throw err(400, `${key} must match Meta's template-name format (lowercase letters, digits, underscores)`);
      }
      return value;
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
