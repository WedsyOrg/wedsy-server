const mongoose = require("mongoose");
const CustomFieldDef = require("../models/CustomFieldDef");
const Enquiry = require("../models/Enquiry");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const LeadInternalEventService = require("./LeadInternalEventService");

const err = (status, message) => Object.assign(new Error(message), { status });
const TYPES = ["text", "number", "select", "date", "boolean"];

const slugify = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const listDefs = async ({ activeOnly = false } = {}) => {
  const q = activeOnly ? { status: "active" } : {};
  return await CustomFieldDef.find(q).sort({ order: 1, createdAt: 1 }).lean();
};

const createDef = async ({ key, label, type, options, showInCockpit, required, order } = {}) => {
  if (typeof label !== "string" || !label.trim()) throw err(400, "label is required");
  if (!TYPES.includes(type)) throw err(400, `type must be one of: ${TYPES.join(", ")}`);
  const slug = slugify(key || label);
  if (!slug) throw err(400, "key produces an empty slug");
  const existing = await CustomFieldDef.findOne({ key: slug });
  if (existing) throw err(409, `A field with key "${slug}" already exists`);
  if (type === "select" && (!Array.isArray(options) || options.length === 0)) {
    throw err(400, "select fields need a non-empty options array");
  }
  return await CustomFieldDef.create({
    key: slug,
    label: label.trim(),
    type,
    options: type === "select" ? options.map(String) : [],
    showInCockpit: showInCockpit !== false,
    required: required === true,
    order: Number.isFinite(order) ? order : (await CustomFieldDef.countDocuments({})),
  });
};

// Update label/options/showInCockpit/required/order/status. key+type are immutable
// (values already stored under the key with that type).
const updateDef = async (id, body = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw err(400, "Invalid field id");
  const def = await CustomFieldDef.findById(id);
  if (!def) throw err(404, "Field not found");
  const fields = {};
  if (typeof body.label === "string" && body.label.trim()) fields.label = body.label.trim();
  if (Array.isArray(body.options)) {
    if (def.type !== "select") throw err(400, "options only apply to select fields");
    if (body.options.length === 0) throw err(400, "select fields need at least one option");
    fields.options = body.options.map(String);
  }
  if (typeof body.showInCockpit === "boolean") fields.showInCockpit = body.showInCockpit;
  if (typeof body.required === "boolean") fields.required = body.required;
  if (Number.isFinite(body.order)) fields.order = body.order;
  if (body.status !== undefined) {
    if (!["active", "archived"].includes(body.status)) throw err(400, "status must be active|archived");
    fields.status = body.status;
  }
  if (!Object.keys(fields).length) throw err(400, "No valid fields to update");
  return await CustomFieldDef.findByIdAndUpdate(id, { $set: fields }, { new: true }).lean();
};

// Delete only while NO lead holds a value; otherwise the def must be archived.
const deleteDef = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw err(400, "Invalid field id");
  const def = await CustomFieldDef.findById(id);
  if (!def) throw err(404, "Field not found");
  const holding = await Enquiry.countDocuments({
    [`customFields.${def.key}`]: { $exists: true, $nin: [null, ""] },
  });
  if (holding > 0) {
    await CustomFieldDef.findByIdAndUpdate(id, { $set: { status: "archived" } });
    return { archived: true, holdingLeads: holding, message: `${holding} lead(s) hold a value — archived instead of deleted` };
  }
  await CustomFieldDef.findByIdAndDelete(id);
  return { deleted: true };
};

// Validate a {key: value} payload against ACTIVE defs. Unknown key → 400.
const validateValues = async (values) => {
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw err(400, "customFields must be an object of { key: value }");
  }
  const defs = await listDefs({ activeOnly: true });
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const clean = {};
  for (const [key, value] of Object.entries(values)) {
    const def = byKey.get(key);
    if (!def) throw err(400, `Unknown custom field: ${key}`);
    if (value === null || value === "") {
      clean[key] = value === null ? null : "";
      continue;
    }
    switch (def.type) {
      case "text":
        if (typeof value !== "string" || value.length > 2000) throw err(400, `${key} must be a string ≤2000 chars`);
        clean[key] = value;
        break;
      case "number": {
        const n = Number(value);
        if (!Number.isFinite(n)) throw err(400, `${key} must be a number`);
        clean[key] = n;
        break;
      }
      case "select":
        if (!def.options.includes(value)) throw err(400, `${key} must be one of: ${def.options.join(", ")}`);
        clean[key] = value;
        break;
      case "date": {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) throw err(400, `${key} must be a valid date`);
        clean[key] = d;
        break;
      }
      case "boolean":
        if (typeof value !== "boolean") throw err(400, `${key} must be a boolean`);
        clean[key] = value;
        break;
      default:
        throw err(400, `Unknown field type for ${key}`);
    }
  }
  return clean;
};

// PUT /enquiry/:_id/custom-fields — partial merge of validated values.
const setLeadValues = async (enquiryId, values, actorId) => {
  if (!mongoose.Types.ObjectId.isValid(enquiryId)) throw err(400, "Invalid enquiry id");
  const clean = await validateValues(values);
  if (Object.keys(clean).length === 0) throw err(400, "No custom field values provided");
  const set = {};
  for (const [k, v] of Object.entries(clean)) set[`customFields.${k}`] = v;
  const updated = await EnquiryRepository.updateFieldsById(enquiryId, set);
  if (!updated) throw err(404, "Enquiry not found");
  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "custom_fields_updated",
    actorId,
    payload: { fields: Object.keys(clean) },
  });
  return updated;
};

module.exports = { listDefs, createDef, updateDef, deleteDef, validateValues, setLeadValues };
