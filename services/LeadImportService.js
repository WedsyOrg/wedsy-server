const Papa = require("papaparse");
const Enquiry = require("../models/Enquiry");
const Stage = require("../models/Stage");
const LeadIntakeService = require("./LeadIntakeService");
const LeadAssignmentService = require("./LeadAssignmentService");

const IMPORT_SOURCE = "zoho_import";
const BATCH_SIZE = 500;

// Our target fields and the header aliases we auto-map from (lowercased).
const FIELD_ALIASES = {
  name: ["name", "full name", "lead name", "first name", "contact name", "contact"],
  phone: ["phone", "mobile", "mobile number", "phone number", "contact number", "phone no"],
  email: ["email", "e-mail", "email address", "email id"],
  source: ["source", "lead source", "channel", "lead channel"],
  stage: ["stage", "status", "lead status", "pipeline stage", "lead stage"],
  notes: ["notes", "note", "description", "remarks", "comments"],
  createdAt: ["created", "created time", "created at", "created date", "date", "created_date", "created on"],
};

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const parseCsv = (buffer) => {
  const text = buffer.toString("utf8");
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (!parsed.data || parsed.data.length === 0) {
    throw httpError(400, "The CSV appears to be empty or unparseable");
  }
  return parsed;
};

// Header → field auto-mapping by similarity (exact alias, then contains).
const detectMapping = (headers) => {
  const mapping = {};
  const taken = new Set();
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    let match = headers.find(
      (h) => !taken.has(h) && aliases.includes(String(h).trim().toLowerCase())
    );
    if (!match) {
      match = headers.find((h) => {
        if (taken.has(h)) return false;
        const low = String(h).trim().toLowerCase();
        return aliases.some((a) => low.includes(a) || a.includes(low));
      });
    }
    if (match) {
      mapping[field] = match;
      taken.add(match);
    }
  }
  return mapping;
};

// Set of normalized phones already in the CRM (founder import tool — full scan is fine).
const existingPhoneMap = async () => {
  const existing = await Enquiry.find({}, { phone: 1 }).lean();
  const map = new Map();
  for (const e of existing) {
    const normalized = LeadIntakeService.normalizePhone(e.phone);
    if (normalized.length >= 7) map.set(normalized, e._id);
  }
  return map;
};

const preview = async (buffer) => {
  const parsed = parseCsv(buffer);
  const headers = parsed.meta.fields || [];
  const detectedMapping = detectMapping(headers);

  const phoneHeader = detectedMapping.phone;
  let duplicates = 0;
  if (phoneHeader) {
    const phones = await existingPhoneMap();
    for (const row of parsed.data) {
      const normalized = LeadIntakeService.normalizePhone(row[phoneHeader]);
      if (normalized.length >= 7 && phones.has(normalized)) duplicates += 1;
    }
  }

  return {
    headers,
    detectedMapping,
    rowCount: parsed.data.length,
    sampleRows: parsed.data.slice(0, 10),
    duplicates,
  };
};

const commit = async (buffer, options = {}, actorId) => {
  const {
    mapping = {},
    stageMapping = {},
    skipDuplicates = true,
    assignOnImport = false,
  } = options;
  if (!mapping.phone || !mapping.name) {
    throw httpError(400, "Mapping must include at least name and phone columns");
  }

  const parsed = parseCsv(buffer);
  const validStages = new Set(
    (await Stage.find({ deletedAt: null }, { slug: 1 }).lean()).map((s) => s.slug)
  );
  const phones = await existingPhoneMap();
  const seenInFile = new Set();
  const now = new Date();

  const toCreate = [];
  const errors = [];
  let skippedDuplicates = 0;

  parsed.data.forEach((row, index) => {
    const rowNo = index + 2; // 1-based + header row
    const name = String(row[mapping.name] || "").trim();
    const phone = String(row[mapping.phone] || "").trim();
    const normalized = LeadIntakeService.normalizePhone(phone);
    if (!name || normalized.length < 7) {
      errors.push({ row: rowNo, error: "Missing/invalid name or phone" });
      return;
    }
    if (seenInFile.has(normalized)) {
      skippedDuplicates += 1;
      return;
    }
    seenInFile.add(normalized);

    const existingId = phones.get(normalized);
    if (existingId) {
      if (skipDuplicates) {
        skippedDuplicates += 1;
        // Re-enquiry event on the existing lead (Slice B dedup semantics).
        LeadIntakeService.recordReEnquiry(existingId, {
          source: IMPORT_SOURCE,
          message: "Matched during CSV import",
        });
        return;
      }
      // skipDuplicates=false: fall through and try to insert; exact-equal phones
      // will land in errors[] via the unique index.
    }

    const zohoStage = mapping.stage ? String(row[mapping.stage] || "").trim() : "";
    let stage = stageMapping[zohoStage] || "new";
    if (!validStages.has(stage)) stage = "new";

    let createdAt = now;
    if (mapping.createdAt && row[mapping.createdAt]) {
      const d = new Date(row[mapping.createdAt]);
      if (!Number.isNaN(d.getTime())) createdAt = d;
    }

    toCreate.push({
      name,
      phone,
      email: mapping.email ? String(row[mapping.email] || "").trim() : "",
      verified: false,
      source: IMPORT_SOURCE,
      stage,
      additionalInfo: mapping.notes && row[mapping.notes] ? { importNotes: row[mapping.notes] } : {},
      importedAt: now,
      createdAt,
      updatedAt: createdAt,
      _assign: assignOnImport && stage === "new",
    });
  });

  let created = 0;
  const createdForAssignment = [];
  for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
    const batch = toCreate.slice(i, i + BATCH_SIZE);
    const docs = batch.map(({ _assign, ...doc }) => doc);
    try {
      // timestamps:false → the provided historical createdAt/updatedAt are kept.
      const inserted = await Enquiry.insertMany(docs, { ordered: false, timestamps: false });
      created += inserted.length;
      inserted.forEach((doc, j) => {
        if (batch[j] && batch[j]._assign) createdForAssignment.push(doc._id);
      });
    } catch (e) {
      // ordered:false → successful docs in the batch were still written.
      const okCount = e.insertedDocs ? e.insertedDocs.length : 0;
      created += okCount;
      (e.writeErrors || []).forEach((we) => {
        errors.push({ row: "batch", error: we.errmsg || "Insert failed (likely duplicate phone)" });
      });
    }
  }

  // Historical imports stay unassigned by design; only stage-New rows with the
  // explicit assignOnImport flag go through the round-robin.
  for (const id of createdForAssignment) {
    await LeadAssignmentService.assignLead(id);
  }

  return { created, skippedDuplicates, errors };
};

module.exports = { preview, commit, detectMapping, FIELD_ALIASES, IMPORT_SOURCE };
