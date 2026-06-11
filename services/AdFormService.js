const SettingsService = require("./SettingsService");
const CustomFieldService = require("./CustomFieldService");

// Whitelisted qualificationData targets for ad-form mapping (mirrors the
// cockpit qualification whitelist).
const QUALIFICATION_TARGETS = [
  "groomName", "brideName", "weddingStyle", "venueStatus", "venueName",
  "venueTypeWanted", "venueArea", "venueBudget", "venueShortlistNote",
  "email", "whatsappNumber",
];

const MAX_ANSWERS_BYTES = 20 * 1024; // 20KB raw-answers guard
const MAX_VALUE_CHARS = 2000;

// Everything in the payload beyond the known intake fields is an ad-form answer.
const KNOWN_INTAKE_KEYS = new Set(["name", "phone", "email"]);

// Raw answers object from a webhook body: key → stringified answer, size-guarded.
// Unknown fields are NEVER dropped — oversize values are truncated, and if the
// total still exceeds the cap, remaining keys are noted under _truncated.
const extractAnswers = (body = {}) => {
  const answers = {};
  let bytes = 2;
  const truncatedKeys = [];
  for (const [key, raw] of Object.entries(body)) {
    if (KNOWN_INTAKE_KEYS.has(key)) continue;
    if (raw === undefined || raw === null) continue;
    let value = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (value.length > MAX_VALUE_CHARS) value = value.slice(0, MAX_VALUE_CHARS) + "…";
    const entryBytes = key.length + value.length + 6;
    if (bytes + entryBytes > MAX_ANSWERS_BYTES) {
      truncatedKeys.push(key);
      continue;
    }
    answers[key] = value;
    bytes += entryBytes;
  }
  if (truncatedKeys.length) {
    answers._truncated = `payload over ${MAX_ANSWERS_BYTES / 1024}KB — keys dropped: ${truncatedKeys.join(", ")}`;
  }
  return Object.keys(answers).length ? answers : null;
};

// Resolve adform.fieldMap into concrete $set entries for a NEW lead doc.
// Targets: "qualificationData.<whitelisted>", "customFields.<active key>", "ignore".
// Never overwrites a non-empty existing value (relevant on re-enquiry merges).
const mappedSetsFor = async (answers, existingLead = null) => {
  if (!answers) return { sets: {}, mappedKeys: [] };
  const fieldMap = await SettingsService.get("adform.fieldMap");
  const activeDefs = await CustomFieldService.listDefs({ activeOnly: true });
  const activeKeys = new Set(activeDefs.map((d) => d.key));
  const sets = {};
  const mappedKeys = [];
  for (const [fbKey, target] of Object.entries(fieldMap || {})) {
    if (!(fbKey in answers) || target === "ignore" || typeof target !== "string") continue;
    const value = answers[fbKey];
    if (target.startsWith("qualificationData.")) {
      const field = target.slice("qualificationData.".length);
      if (!QUALIFICATION_TARGETS.includes(field)) continue;
      const current = existingLead?.qualificationData?.[field];
      if (current === undefined || current === null || current === "") {
        sets[`qualificationData.${field}`] = value;
        mappedKeys.push(fbKey);
      }
    } else if (target.startsWith("customFields.")) {
      const key = target.slice("customFields.".length);
      if (!activeKeys.has(key)) continue;
      const current = existingLead?.customFields?.[key];
      if (current === undefined || current === null || current === "") {
        sets[`customFields.${key}`] = value;
        mappedKeys.push(fbKey);
      }
    }
  }
  return { sets, mappedKeys };
};

module.exports = { extractAnswers, mappedSetsFor, QUALIFICATION_TARGETS, MAX_ANSWERS_BYTES };
