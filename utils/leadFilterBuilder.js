// Filter builder (Settings Suite, Slice 7c). Parses a `filters` query param —
// JSON array of { field, op, value } — into Mongo conditions with STRICT
// whitelists. Unknown field or op → 400. The caller's scope filter is ALWAYS
// ANDed separately; nothing here can widen scope.
const CustomFieldService = require("../services/CustomFieldService");

const err = (status, message) => Object.assign(new Error(message), { status });

const QUALIFICATION_KEYS = [
  "groomName", "brideName", "weddingStyle", "venueStatus", "venueName",
  "venueTypeWanted", "venueArea", "venueBudget", "venueShortlistNote",
  "email", "whatsappNumber",
];

// field → allowed ops + value kind
const STATIC_FIELDS = {
  stage: { ops: ["eq", "in"], kind: "string" },
  source: { ops: ["eq", "in", "contains"], kind: "string" },
  assignedTo: { ops: ["eq", "in", "exists"], kind: "string" },
  tags: { ops: ["eq", "in", "contains"], kind: "string" }, // array field: eq/in match elements
  createdAt: { ops: ["gte", "lte"], kind: "date" },
  reEnquiredAt: { ops: ["gte", "lte", "exists"], kind: "date" },
  qualified: { ops: ["eq"], kind: "boolean" },
  "recycled.isRecycled": { ops: ["eq"], kind: "boolean" },
  importedAt: { ops: ["exists"], kind: "date" },
  // ── MB6 Slice 9 additions ──
  // Event month ("January"…) — the same field the legacy eventMonth param reads.
  "additionalInfo.eventMonth": { ops: ["eq", "in"], kind: "string" },
  // Services any-of: array field, "in" matches any element.
  "qualificationData.servicesRequired": { ops: ["eq", "in", "contains"], kind: "string" },
  // Budget range.
  "qualificationData.budgetAmount": { ops: ["eq", "gte", "lte", "exists"], kind: "number" },
  // Last activity recency (any write touches updatedAt).
  updatedAt: { ops: ["gte", "lte"], kind: "date" },
};

// ── MB6 Slice 9: derived/virtual filters ──────────────────────────────────────
// The list-level health score (computed WITHOUT the events join, matching the
// list display): qualified base 20 + venue 15 + email/not-willing 20 + future
// follow-up 20. Hot ≥75, Warm ≥45, Cold below (or unqualified).
const healthScoreExpr = (now) => ({
  $add: [
    20,
    { $cond: [{ $gt: [{ $ifNull: ["$qualificationData.venueStatus", ""] }, ""] }, 15, 0] },
    {
      $cond: [
        {
          $or: [
            { $gt: [{ $ifNull: ["$qualificationData.email", ""] }, ""] },
            { $eq: ["$qualificationData.emailNotWilling", true] },
          ],
        },
        20,
        0,
      ],
    },
    {
      $cond: [
        {
          $gt: [
            {
              $size: {
                $filter: {
                  input: { $ifNull: ["$followUps", []] },
                  as: "f",
                  cond: { $gt: ["$$f.scheduledAt", now] },
                },
              },
            },
            0,
          ],
        },
        20,
        0,
      ],
    },
  ],
});

const healthBandCondition = (value, now = new Date()) => {
  const score = healthScoreExpr(now);
  if (value === "Hot") return { qualified: true, $expr: { $gte: [score, 75] } };
  if (value === "Warm")
    return { qualified: true, $expr: { $and: [{ $gte: [score, 45] }, { $lt: [score, 75] }] } };
  if (value === "Cold")
    return { $or: [{ qualified: { $ne: true } }, { $expr: { $lt: [score, 45] } }] };
  throw err(400, 'healthBand must be "Hot", "Warm" or "Cold"');
};

const boolValue = (value, field) => {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw err(400, `Invalid boolean for ${field}`);
};

// Virtual fields: derived conditions (some need a conversation lookup, hence async).
const VIRTUAL_FIELDS = {
  healthBand: async (op, value) => {
    if (op !== "eq") throw err(400, 'healthBand supports only "eq"');
    return healthBandCondition(value);
  },
  hasMeetingBooked: async (op, value) => {
    if (op !== "eq") throw err(400, 'hasMeetingBooked supports only "eq"');
    return boolValue(value, "hasMeetingBooked")
      ? { followUps: { $elemMatch: { type: "meet", completedAt: null } } }
      : { followUps: { $not: { $elemMatch: { type: "meet", completedAt: null } } } };
  },
  overdueFollowUps: async (op, value) => {
    if (op !== "eq") throw err(400, 'overdueFollowUps supports only "eq"');
    return boolValue(value, "overdueFollowUps")
      ? { followUps: { $elemMatch: { completedAt: null, scheduledAt: { $lt: new Date() } } } }
      : { followUps: { $not: { $elemMatch: { completedAt: null, scheduledAt: { $lt: new Date() } } } } };
  },
  reEnquired: async (op, value) => {
    if (op !== "eq") throw err(400, 'reEnquired supports only "eq"');
    return boolValue(value, "reEnquired")
      ? { reEnquiredAt: { $ne: null } }
      : { $or: [{ reEnquiredAt: { $exists: false } }, { reEnquiredAt: null }] };
  },
  kiaraChatting: async (op, value) => {
    if (op !== "eq") throw err(400, 'kiaraChatting supports only "eq"');
    const WAConversation = require("../models/WAConversation");
    const ids = await WAConversation.distinct("enquiryId", {
      mode: "ai",
      status: "active",
      enquiryId: { $ne: null },
    });
    return boolValue(value, "kiaraChatting") ? { _id: { $in: ids } } : { _id: { $nin: ids } };
  },
  needsHuman: async (op, value) => {
    if (op !== "eq") throw err(400, 'needsHuman supports only "eq"');
    const WAConversation = require("../models/WAConversation");
    const ids = await WAConversation.distinct("enquiryId", {
      needsHuman: true,
      status: "active",
      enquiryId: { $ne: null },
    });
    return boolValue(value, "needsHuman") ? { _id: { $in: ids } } : { _id: { $nin: ids } };
  },
};

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const castValue = (kind, value, field) => {
  if (kind === "date") {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw err(400, `Invalid date for ${field}`);
    return d;
  }
  if (kind === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw err(400, `Invalid boolean for ${field}`);
  }
  if (kind === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw err(400, `Invalid number for ${field}`);
    return n;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw err(400, `Invalid value for ${field}`);
  }
  return value;
};

const conditionFor = (field, op, value, kind) => {
  switch (op) {
    case "eq":
      return { [field]: castValue(kind, value, field) };
    case "in": {
      if (!Array.isArray(value) || value.length === 0) {
        throw err(400, `"in" needs a non-empty array for ${field}`);
      }
      return { [field]: { $in: value.map((v) => castValue(kind, v, field)) } };
    }
    case "contains": {
      if (typeof value !== "string" || !value.trim()) {
        throw err(400, `"contains" needs a string for ${field}`);
      }
      return { [field]: { $regex: new RegExp(escapeRegExp(value.trim()), "i") } };
    }
    case "gte":
      return { [field]: { $gte: castValue(kind, value, field) } };
    case "lte":
      return { [field]: { $lte: castValue(kind, value, field) } };
    case "exists": {
      const wants = value === true || value === "true" || value === undefined;
      // exists ⇒ present AND non-null (an unset importedAt is stored as null).
      return wants
        ? { [field]: { $exists: true, $nin: [null, ""] } }
        : { $or: [{ [field]: { $exists: false } }, { [field]: null }] };
    }
    default:
      throw err(400, `Unknown op: ${op}`);
  }
};

// Parse + validate, returning an array of Mongo conditions to AND in.
const buildFilterConditions = async (filtersRaw) => {
  if (filtersRaw === undefined || filtersRaw === null || filtersRaw === "") return [];
  let filters;
  try {
    filters = typeof filtersRaw === "string" ? JSON.parse(filtersRaw) : filtersRaw;
  } catch {
    throw err(400, "filters must be valid JSON");
  }
  if (!Array.isArray(filters)) throw err(400, "filters must be an array");
  if (filters.length > 20) throw err(400, "Too many filters (max 20)");

  const activeDefs = await CustomFieldService.listDefs({ activeOnly: true });
  const customKinds = new Map(
    activeDefs.map((d) => [
      d.key,
      d.type === "number" ? "number" : d.type === "date" ? "date" : d.type === "boolean" ? "boolean" : "string",
    ])
  );

  const conditions = [];
  for (const f of filters) {
    if (!f || typeof f.field !== "string" || typeof f.op !== "string") {
      throw err(400, "Each filter needs { field, op, value }");
    }
    const { field, op, value } = f;

    if (field in VIRTUAL_FIELDS) {
      conditions.push(await VIRTUAL_FIELDS[field](op, value));
      continue;
    }
    if (field in STATIC_FIELDS) {
      const spec = STATIC_FIELDS[field];
      if (!spec.ops.includes(op)) throw err(400, `Op "${op}" not allowed for ${field}`);
      conditions.push(conditionFor(field, op, value, spec.kind));
      continue;
    }
    if (field.startsWith("qualificationData.")) {
      const key = field.slice("qualificationData.".length);
      if (!QUALIFICATION_KEYS.includes(key)) throw err(400, `Unknown field: ${field}`);
      if (!["eq", "in", "contains", "exists"].includes(op)) {
        throw err(400, `Op "${op}" not allowed for ${field}`);
      }
      conditions.push(conditionFor(field, op, value, "string"));
      continue;
    }
    if (field.startsWith("customFields.")) {
      const key = field.slice("customFields.".length);
      if (!customKinds.has(key)) throw err(400, `Unknown field: ${field}`);
      const kind = customKinds.get(key);
      const allowed =
        kind === "number" || kind === "date" ? ["eq", "gte", "lte", "exists"] : ["eq", "in", "contains", "exists"];
      if (!allowed.includes(op)) throw err(400, `Op "${op}" not allowed for ${field}`);
      conditions.push(conditionFor(field, op, value, kind));
      continue;
    }
    throw err(400, `Unknown field: ${field}`);
  }
  return conditions;
};

module.exports = { buildFilterConditions, STATIC_FIELDS, QUALIFICATION_KEYS };
