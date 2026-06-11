const Papa = require("papaparse");
const Enquiry = require("../models/Enquiry");
const Stage = require("../models/Stage");
const LeadIntakeService = require("./LeadIntakeService");
const LeadAssignmentService = require("./LeadAssignmentService");
const SettingsService = require("./SettingsService");
const CustomFieldService = require("./CustomFieldService");
const Admin = require("../models/Admin");
const ProjectRepository = require("../repositories/ProjectRepository");

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
  owner: ["owner", "lead owner", "owner name", "assigned to", "assignee"],
  tags: ["tag", "tags", "rating", "labels"],
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

  // Slice 8: distinct owner names (for the ownerMap step in the wizard).
  let distinctOwners = [];
  if (detectedMapping.owner) {
    distinctOwners = [
      ...new Set(
        parsed.data.map((r) => String(r[detectedMapping.owner] || "").trim()).filter(Boolean)
      ),
    ].slice(0, 100);
  }

  return {
    headers,
    detectedMapping,
    rowCount: parsed.data.length,
    sampleRows: parsed.data.slice(0, 10),
    duplicates,
    distinctOwners,
  };
};

// Slice 8: a downloadable sample in OUR standard shape — static headers + every
// ACTIVE custom field key + two filled example rows.
const sampleCsv = async () => {
  const defs = await CustomFieldService.listDefs({ activeOnly: true });
  const headers = ["name", "phone", "email", "source", "stage", "notes", "createdAt", "owner", "tags", ...defs.map((d) => d.key)];
  const ex1 = ["Priya Sharma", "9876543210", "priya@example.com", "Website", "new", "Asked about Dec wedding", "2026-01-15", "Aafiya", "Premium", ...defs.map(() => "Bengaluru")];
  const ex2 = ["Arjun Rao", "9876500001", "", "Instagram DM", "contacted", "", "2026-02-02", "", "NRI;Destination", ...defs.map(() => "")];
  const quote = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
  return [headers, ex1, ex2].map((row) => row.map(quote).join(",")).join("\n");
};

const commit = async (buffer, options = {}, actorId) => {
  const {
    mapping = {},
    stageMapping = {},
    skipDuplicates = true,
    assignOnImport = false,
    ownerMap = {},
  } = options;
  if (!mapping.phone || !mapping.name) {
    throw httpError(400, "Mapping must include at least name and phone columns");
  }

  const parsed = parseCsv(buffer);
  const validStages = new Set(
    (await Stage.find({ deletedAt: null }, { slug: 1 }).lean()).map((s) => s.slug)
  );
  const tagLibrary = await SettingsService.get("tags.available");
  // ownerMap values are adminIds (validated) or null = leave unassigned.
  const ownerAdminIds = Object.values(ownerMap).filter(Boolean);
  const validOwners = ownerAdminIds.length
    ? new Set((await Admin.find({ _id: { $in: ownerAdminIds } }, { _id: 1 }).lean()).map((a) => String(a._id)))
    : new Set();
  const mappedHeaders = new Set(Object.values(mapping).filter(Boolean));
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
    // Slice 8: the special "convert_to_project" mapping → lead lands as won + Project.
    const convertToProject = stage === "convert_to_project";
    if (convertToProject) stage = "won";
    if (!validStages.has(stage)) stage = "new";

    let createdAt = now;
    if (mapping.createdAt && row[mapping.createdAt]) {
      const d = new Date(row[mapping.createdAt]);
      if (!Number.isNaN(d.getTime())) createdAt = d;
    }

    // Slice 8: owner mapping ({ name: adminId|null }).
    let assignedTo = null;
    if (mapping.owner && row[mapping.owner]) {
      const ownerName = String(row[mapping.owner]).trim();
      const mappedId = ownerMap[ownerName];
      if (mappedId && validOwners.has(String(mappedId))) assignedTo = mappedId;
    }

    // Slice 8: tag/rating column → real tags where they exist in the library,
    // a note in additionalInfo otherwise (nothing silently dropped).
    let tags = [];
    let unknownTagsNote = "";
    if (mapping.tags && row[mapping.tags]) {
      const rawTags = String(row[mapping.tags]).split(/[;,|]/).map((t) => t.trim()).filter(Boolean);
      tags = rawTags.filter((t) => tagLibrary.includes(t));
      const unknown = rawTags.filter((t) => !tagLibrary.includes(t));
      if (unknown.length) unknownTagsNote = `Unrecognized tags from import: ${unknown.join(", ")}`;
    }

    // Slice 8: every UNMAPPED column survives in additionalInfo.importedFields.
    const importedFields = {};
    for (const [header, cell] of Object.entries(row)) {
      if (mappedHeaders.has(header)) continue;
      const v = String(cell ?? "").trim();
      if (v) importedFields[header] = v.slice(0, 1000);
    }

    const additionalInfo = {};
    if (mapping.notes && row[mapping.notes]) additionalInfo.importNotes = row[mapping.notes];
    if (unknownTagsNote) additionalInfo.importTagNote = unknownTagsNote;
    if (Object.keys(importedFields).length) additionalInfo.importedFields = importedFields;

    toCreate.push({
      name,
      phone,
      email: mapping.email ? String(row[mapping.email] || "").trim() : "",
      verified: false,
      source: IMPORT_SOURCE,
      stage,
      tags,
      assignedTo,
      additionalInfo,
      importedAt: now,
      createdAt,
      updatedAt: createdAt,
      _assign: assignOnImport && stage === "new" && !assignedTo,
      _convert: convertToProject,
      _origStage: zohoStage,
    });
  });

  let created = 0;
  let projectsCreated = 0;
  const createdForAssignment = [];
  const ProjectServiceLazy = require("./ProjectService");
  for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
    const batch = toCreate.slice(i, i + BATCH_SIZE);
    const docs = batch.map(({ _assign, _convert, _origStage, ...doc }) => doc);
    try {
      // timestamps:false → the provided historical createdAt/updatedAt are kept.
      const inserted = await Enquiry.insertMany(docs, { ordered: false, timestamps: false });
      created += inserted.length;
      for (let j = 0; j < inserted.length; j++) {
        if (batch[j] && batch[j]._assign) createdForAssignment.push(inserted[j]._id);
        if (batch[j] && batch[j]._convert) {
          // "Convert to Project (active)": lead is already won; create the Project.
          try {
            const csOwner = await ProjectServiceLazy.defaultCsOwner();
            await ProjectRepository.create({
              leadId: inserted[j]._id,
              coupleNames: inserted[j].name,
              eventIds: [],
              csOwnerId: csOwner ? csOwner._id : null,
              convertedBy: actorId || null,
              value: 0,
              handoffNote: `Imported from Bigin – ${batch[j]._origStage || "active"}`,
            });
            projectsCreated += 1;
          } catch (pe) {
            errors.push({ row: "project", error: `Project create failed for ${inserted[j].name}: ${pe.message}` });
          }
        }
      }
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

  return { created, skippedDuplicates, errors, projectsCreated };
};

module.exports = { preview, commit, sampleCsv, detectMapping, FIELD_ALIASES, IMPORT_SOURCE };
