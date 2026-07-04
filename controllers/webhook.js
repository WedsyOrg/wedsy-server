const crypto = require("crypto");
const Enquiry = require("../models/Enquiry");
const LeadSource = require("../models/LeadSource");
const { SendUpdate } = require("../utils/update");
const LeadIntakeService = require("../services/LeadIntakeService");
const AdFormService = require("../services/AdFormService");

// Accepted intake sources for the Make→OS Meta-lead bridge. The value stored on
// the lead IS the LeadSource master title, so board grouping + the source filter
// (free-string eq/in) match exactly. "Ads (Landing Screen)" is the historical
// landing-page default and stays the fallback when `source` is absent.
//
// Campaign labels are open-ended: any facebook_* / instagram_* shape is accepted
// (facebook, facebook_general, facebook_june_decor, instagram, instagram_promo,
// …) so new campaigns need no code change. Anything else is rejected (no
// arbitrary junk). Campaign + landing_page values are lowercased for a
// consistent master/filter key; the default literal is preserved verbatim.
const DEFAULT_SOURCE = "Ads (Landing Screen)";
const META_SOURCE_RE = /^(facebook|instagram)(_[a-z0-9]+)*$/;

// Resolve the body's source to an accepted value. Absent → default. Unknown → null
// (caller rejects 400).
const resolveSource = (raw) => {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_SOURCE;
  const trimmed = String(raw).trim();
  if (trimmed === DEFAULT_SOURCE) return DEFAULT_SOURCE;
  const v = trimmed.toLowerCase();
  if (v === "landing_page") return "landing_page";
  if (META_SOURCE_RE.test(v)) return v;
  return null;
};

// Idempotently register a source in the lead-source master so it appears in the
// Source dropdown/filters. Fire-and-safe — never blocks intake.
const ensureLeadSource = async (title) => {
  try {
    await LeadSource.updateOne({ title }, { $setOnInsert: { title } }, { upsert: true });
  } catch (e) {
    console.warn("[ad-leads] ensureLeadSource failed:", e.message);
  }
};

// Constant-time shared-secret check. Returns true when the request is allowed.
// When AD_LEADS_INTAKE_SECRET is UNSET the endpoint stays OPEN (pre-config
// behavior preserved) but logs a warning so it's obvious it should be set.
const intakeAuthorized = (req) => {
  const secret = process.env.AD_LEADS_INTAKE_SECRET;
  if (!secret) {
    console.warn("[ad-leads] AD_LEADS_INTAKE_SECRET unset — endpoint is OPEN; set it to require x-wedsy-intake-key.");
    return true;
  }
  const provided = req.headers["x-wedsy-intake-key"];
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const CreateNewAdsLead = async (req, res) => {
  try {
    // AUTH: lightweight shared secret (not full admin JWT) for the Make bridge.
    if (!intakeAuthorized(req)) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    const { name, phone, email } = req.body;
    if (!name || !phone) {
      return res.status(400).send({ message: "Incomplete Data" });
    }
    const source = resolveSource(req.body.source);
    if (source === null) {
      return res.status(400).send({ message: "Unknown source" });
    }
    // Register the source in the master (idempotent) so it filters/displays.
    await ensureLeadSource(source);

    // Ad-form capture (Settings Suite, Slice 4): every extra payload field is an
    // answer — stored raw, size-guarded, never dropped. The adform.fieldMap
    // setting additionally maps answers into qualificationData/customFields,
    // never overwriting non-empty values. Contract preserved: 201 empty.
    const answers = AdFormService.extractAnswers(req.body);

    const existing = await LeadIntakeService.findExistingByNormalizedPhone(phone);
    if (existing) {
      if (answers) {
        // Merge NEW answer keys into the lead (existing answers win) + apply mapping
        // into still-empty fields only.
        const mergeSets = {};
        const existingAnswers = existing.additionalInfo?.adFormAnswers || {};
        for (const [k, v] of Object.entries(answers)) {
          if (!(k in existingAnswers)) mergeSets[`additionalInfo.adFormAnswers.${k}`] = v;
        }
        const { sets } = await AdFormService.mappedSetsFor(answers, existing);
        Object.assign(mergeSets, sets);
        if (Object.keys(mergeSets).length) {
          await Enquiry.findByIdAndUpdate(existing._id, { $set: mergeSets });
        }
      }
      // Dedup hit → re-enquiry (no duplicate lead), carrying the source + answers.
      await LeadIntakeService.recordReEnquiry(existing._id, {
        source,
        message: "",
        adFormAnswers: answers || undefined,
      });
      return res.status(201).send();
    }

    // New lead → the shared intake create path (stage:"new" + Bug-A-safe field
    // pinning + round-robin/triage assignment via afterCreate, identical to
    // Kiara/Instagram leads). createLead runs afterCreate itself.
    const created = await LeadIntakeService.createLead({
      name,
      phone,
      verified: false,
      source,
      additionalInfo: answers ? { adFormAnswers: answers } : {},
    });
    const { sets } = await AdFormService.mappedSetsFor(answers, null);
    const postSets = { ...sets };
    if (email) postSets.email = email;
    if (Object.keys(postSets).length) {
      await Enquiry.findByIdAndUpdate(created._id, { $set: postSets });
    }
    SendUpdate({
      channels: ["SMS", "Whatsapp"],
      message: "New Lead",
      parameters: { name, phone },
    });
    return res.status(201).send();
  } catch (error) {
    return res.status(400).send({ message: "error", error });
  }
};

module.exports = { CreateNewAdsLead };
