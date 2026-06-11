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
