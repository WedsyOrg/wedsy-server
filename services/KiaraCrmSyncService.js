const Enquiry = require("../models/Enquiry");
const WAAgentMessage = require("../models/WAAgentMessage");
const User = require("../models/User");
const Event = require("../models/Event");
const VendorContact = require("../models/VendorContact");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const WAConversationRepository = require("../repositories/WAConversationRepository");
const LeadInternalEventService = require("./LeadInternalEventService");
const ActivityLogService = require("./ActivityLogService");

// Kiara → CRM bridge. Hook 2 outcomes (escalation + classification) and the
// Hook 3 qualification sync live here so the surgical edits inside
// WhatsAppAgentService stay one-line call-outs.

const CLASSIFICATIONS = ["lead", "vendor", "birthday", "corporate", "destination"];
const NOT_A_LEAD = { vendor: "vendor", birthday: "birthday", corporate: "corporate" };

// All ten extractor answers, stored raw under additionalInfo.kiaraAnswers
// (the adFormAnswers idiom).
const ANSWER_KEYS = [
  "name", "eventType", "city", "eventDate", "numberOfEvents",
  "venueStatus", "venueName", "servicesRequired", "budget", "weddingStyle",
];

// ── System lead close (vendor/birthday/corporate) ────────────────────────────
// Mirrors EnquiryService's direct-approve write shape. Bypasses both the
// lost.reasons validation and the approval queue — founder-approved system
// action: a vendor pitch is not a sales decision anyone needs to sign off on.
// Won/already-lost leads are never touched.
const closeLeadAsSystem = async (enquiryId, reason) => {
  const lead = await EnquiryRepository.findById(enquiryId);
  if (!lead) return null;
  if (lead.stage === "won" || lead.stage === "lost" || lead.lostStatus === "approved") {
    return lead;
  }
  const updated = await EnquiryRepository.updateFieldsById(enquiryId, {
    lostStatus: "approved",
    lostReason: reason,
    lostNote: "",
    lostRequestedBy: null,
    lostRequestedAt: new Date(),
    lostDecidedBy: null,
    lostDecidedAt: new Date(),
    lostDecisionNote: "Kiara system action (approval bypassed)",
    stageBeforeLost: lead.stage,
    isLost: true,
    stage: "lost",
  });
  await ActivityLogService.record({
    actorId: null,
    action: "lead.disqualify_approved",
    entityType: "lead",
    entityId: String(enquiryId),
    summary: `Closed by Kiara (${reason})`,
    meta: { reason, system: true },
  });
  return updated;
};

// ── Escalation ────────────────────────────────────────────────────────────────
// Journey event types are channel-prefixed (wa_* / ig_* — MB6 Slice 7).
const evType = (conversation, suffix) =>
  `${conversation && conversation.channel === "instagram" ? "ig" : "wa"}_${suffix}`;

const escalate = async (conversation, reason) => {
  const updated = await WAConversationRepository.updateFieldsById(conversation._id, {
    needsHuman: true,
    needsHumanReason: reason || "Needs a human",
    needsHumanAt: new Date(),
  });
  if (conversation.enquiryId) {
    await LeadInternalEventService.record({
      leadId: conversation.enquiryId,
      type: evType(conversation, "escalated"),
      actorId: null,
      payload: { reason: reason || "" },
    });
    // ⚠️ REVIEW-REQUIRED (Phase 2 flagged): one-time transcript→facts extraction
    // at HANDOFF (escalation is when a human takes over and the transcript is
    // richest). Haiku, guarded once-per-lead by additionalInfo.factsExtractedAt.
    // A NEW AI call on real conversations — parked for human review (prompt +
    // trigger + cost shape in services/KiaraFactExtractionService.js).
    await require("./KiaraFactExtractionService").extractFactsForLead(
      conversation.enquiryId,
      conversation.phone
    );
  }
  return updated;
};

// ── Hook 2: apply the extractor's escalate/classification verdicts ───────────
// vendor      → VendorContact capture, conversation closed, lead lost
// birthday /
// corporate   → conversation closed, lead lost
// destination → escalate (specialist), conversation stays open
// qualified   → ALWAYS escalates ("Qualified — ready for your call")
const applyExtraction = async (conversation, extraction) => {
  if (!conversation || !extraction) return conversation;
  try {
    const classification = CLASSIFICATIONS.includes(extraction.classification)
      ? extraction.classification
      : null;

    if (classification && conversation.classification !== classification) {
      conversation = await WAConversationRepository.updateFieldsById(conversation._id, {
        classification,
      });
    }

    if (classification && NOT_A_LEAD[classification] && conversation.status !== "closed") {
      if (classification === "vendor") {
        const firstMsg = await WAAgentMessage.findOne({
          phone: conversation.phone,
          role: "user",
        })
          .sort({ createdAt: 1 })
          .lean();
        await VendorContact.create({
          phone: conversation.phone,
          name: (extraction.data && extraction.data.name) || "",
          offering: (extraction.data && extraction.data.servicesRequired) || "",
          firstMessage: firstMsg ? firstMsg.message : "",
          source: conversation.channel === "instagram" ? "instagram" : "whatsapp",
          conversationId: conversation._id,
        });
      }
      conversation = await WAConversationRepository.updateFieldsById(conversation._id, {
        status: "closed",
        needsHuman: false,
        needsHumanReason: "",
        needsHumanAt: null,
      });
      if (conversation.enquiryId) {
        const reason = `Not a lead — ${NOT_A_LEAD[classification]}`;
        await closeLeadAsSystem(conversation.enquiryId, reason);
        await LeadInternalEventService.record({
          leadId: conversation.enquiryId,
          type: evType(conversation, "classified"),
          actorId: null,
          payload: { classification, action: "conversation_closed_lead_lost", reason },
        });
      }
      return conversation;
    }

    if (classification === "destination" && !conversation.needsHuman) {
      return await escalate(conversation, "Destination wedding — specialist needed");
    }

    if (extraction.qualified && !conversation.needsHuman) {
      return await escalate(conversation, "Qualified — ready for your call");
    }

    if (extraction.escalate && !conversation.needsHuman) {
      return await escalate(
        conversation,
        (extraction.escalateReason || "").trim() || "Needs a human"
      );
    }
    return conversation;
  } catch (e) {
    console.error("[KiaraCrmSync] applyExtraction failed:", e.message);
    return conversation;
  }
};

// ── Hook 3 helpers ────────────────────────────────────────────────────────────

// Best-effort date parse → Date at the start of the day, or null.
const parseEventDate = (raw) => {
  const str = String(raw || "").trim();
  if (!str) return null;
  const d = new Date(str);
  if (!Number.isNaN(d.getTime()) && d.getFullYear() > 2000) return d;
  return null;
};

const parseCount = (raw, fallback = 1) => {
  const m = String(raw || "").match(/\d+/);
  if (!m) return fallback;
  return Math.min(10, Math.max(1, parseInt(m[0], 10)));
};

const normalizeVenueStatus = (raw) => {
  const s = String(raw || "").toLowerCase();
  if (!s) return "";
  if (/(not|n't|no |looking|search|need|help)/.test(s)) return "looking";
  if (/book|confirm|final|done|yes/.test(s)) return "booked";
  return "";
};

// Budget normalizer (CRM-scoped). Kiara / FB-form budget answers arrive as free
// text — single values ("15k", "1.5 lakh", "50000") or RANGES ("10-15k",
// "10 – 15k", "10 to 15 lakh"). The cockpit needs ONE scalar (budgetAmount); the
// original phrasing is always kept in budgetNote so a span is never lost.
//
// Range handling is the whole point of this helper: the old digit-strip
// (raw.replace(/[^\d.]/g,"")) deleted the hyphen, concatenating "10-15k" into
// "1015" → ×1000 → ₹10.15L. We instead detect a range, parse BOTH bounds, apply
// the unit suffix to EACH, and store the LOWER bound — a conservative floor that
// never inflates a lead into a higher budget tier.
//
// Units (case-insensitive, applied to the parsed number, not a stripped concat):
//   k        → ×1e3      l / lakh / lac → ×1e5      cr / crore → ×1e7
// Absurd / unparseable output (NaN, ≤0, or > ₹100 crore) yields amount=null so a
// garbage scalar is never stored — only the raw note survives.
const BUDGET_MAX = 1e9; // ₹100 crore — anything above is implausible for a lead

// Unit may be attached to a digit ("2cr", "15k") or spaced ("2 lakh"). We match a
// trailing word boundary and use a (?<![a-z]) lookbehind so the token isn't part of
// a longer word (won't fire on "micro", "while", etc.) yet still fires after a digit.
const budgetUnitFactor = (s) => {
  const lower = String(s).toLowerCase();
  if (/crore\b|(?<![a-z])cr\b/.test(lower)) return 1e7;
  if (/lakh\b|lac\b|(?<![a-z])l\b/.test(lower)) return 1e5;
  if (/(?<![a-z])k\b/.test(lower)) return 1e3; // "15k", "10-15k", "2k"
  return 1;
};

const normalizeBudget = (raw) => {
  const note = String(raw == null ? "" : raw).slice(0, 500);
  const str = String(raw == null ? "" : raw).trim();
  if (!str) return { amount: null, note };

  const factor = budgetUnitFactor(str);

  // Range first: two numbers separated by hyphen / en-dash / em-dash / "to".
  const range = str.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/i);
  let amount;
  if (range) {
    const a = parseFloat(range[1]);
    const b = parseFloat(range[2]);
    // Store the LOWER bound (conservative floor), unit applied to the parsed number.
    amount = Math.min(a, b) * factor;
  } else {
    // Single value: digit-strip is safe here (keeps thousands separators, e.g.
    // "50,000" → 50000) — the range case has already been handled above.
    const cleaned = str.replace(/[^\d.]/g, "");
    amount = cleaned ? parseFloat(cleaned) * factor : NaN;
  }

  // Guard absurd / unparseable output → null + keep the raw note.
  if (!Number.isFinite(amount) || amount <= 0 || amount > BUDGET_MAX) {
    return { amount: null, note };
  }
  return { amount, note };
};

const isoDay = (d) => d.toISOString().slice(0, 10);

// Event Store sync: User by phone (created if absent) → Event with
// numberOfEvents eventDays anchored on the parsed date. Unparseable dates →
// caller keeps the raw answer in kiaraAnswers only.
const ensureEventDays = async (lead, data) => {
  const baseDate = parseEventDate(data.eventDate);
  if (!baseDate) return false;

  let user = await User.findOne({ phone: lead.phone });
  if (!user) {
    user = await new User({ name: data.name || lead.name, phone: lead.phone }).save();
  }

  // Idempotent: an event already on file for this user means days exist — the
  // sales team curates from there, Kiara never overwrites.
  const existing = await Event.findOne({ user: user._id });
  if (existing) return true;

  const count = parseCount(data.numberOfEvents, 1);
  const eventDays = Array.from({ length: count }, (_, i) => ({
    name: count === 1 ? "Wedding" : `Day ${i + 1}`,
    date: isoDay(new Date(baseDate.getTime() + i * 24 * 3600 * 1000)),
    time: "TBD",
    venue: data.venueName || "TBD",
  }));

  await new Event({
    user: user._id,
    name: data.name || lead.name,
    community: "",
    eventType: data.eventType || "",
    eventDate: isoDay(baseDate),
    eventDays,
  }).save();
  return true;
};

// ── Hook 3: qualification → the linked CRM lead ───────────────────────────────
// Writes qualificationData (never clobbering non-empty values), stores ALL ten
// raw answers under additionalInfo.kiaraAnswers, creates the Event Store days
// (best-effort), flips the lead's qualified flag (Roadmap ✓), and records
// wa_qualified_by_kiara. Throws on failure so the caller's retry idiom
// (crmSynced, mirroring googleSheetSynced) can re-run it.
const syncQualifiedToCrm = async (phone, data = {}, conversation = null) => {
  let enquiryId = conversation && conversation.enquiryId;
  if (!enquiryId) {
    const LeadIntakeService = require("./LeadIntakeService");
    const existing = await LeadIntakeService.findExistingByNormalizedPhone(phone);
    enquiryId = existing && existing._id;
  }
  if (!enquiryId) throw new Error("No linked CRM lead for qualified conversation");

  const lead = await EnquiryRepository.findById(enquiryId);
  if (!lead) throw new Error("Linked enquiry not found");

  const set = {};

  // Raw answers — the adFormAnswers idiom (all ten, non-empty only).
  for (const key of ANSWER_KEYS) {
    const value = data[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      set[`additionalInfo.kiaraAnswers.${key}`] = String(value).slice(0, 2000);
    }
  }

  // qualificationData mapping — fill only what's empty.
  const qd = lead.qualificationData || {};
  const fillQd = (field, value) => {
    if (value && !qd[field]) set[`qualificationData.${field}`] = String(value);
  };
  // Bug #5: the extractor "name" is the WhatsApp contact's name — it belongs in
  // the top-level `name` field, NOT the couple's groom/bride names. Copying it
  // into qualificationData.groomName made the lead's display name (groom & bride)
  // show the contact name instead of the captured FB-form name. The contact name
  // is preserved on top-level `name` (and still upgrades placeholder names below).
  fillQd("venueStatus", normalizeVenueStatus(data.venueStatus));
  fillQd("venueName", data.venueName);
  fillQd("weddingStyle", data.weddingStyle);

  // MB6 Slice 6 (closes MB4 judgment-call #2): best-effort map Kiara's
  // servicesRequired/budget answers onto the cockpit-v2 fields — fill-only-
  // empty like everything above; the raw answers stay in kiaraAnswers.
  if (data.servicesRequired && !(qd.servicesRequired || []).length) {
    let available = [];
    try {
      available = await require("./SettingsService").get("services.available");
    } catch (_) { /* master list is advisory for matching */ }
    const rawParts = Array.isArray(data.servicesRequired)
      ? data.servicesRequired
      : String(data.servicesRequired).split(/[,/&+]|\band\b/i);
    const matched = [
      ...new Set(
        rawParts
          .map((s) => {
            const t = String(s).trim().toLowerCase();
            if (!t) return null;
            const hit = (available || []).find(
              (a) => t.includes(a.toLowerCase()) || a.toLowerCase().includes(t)
            );
            return hit || null;
          })
          .filter(Boolean)
      ),
    ];
    if (matched.length) set["qualificationData.servicesRequired"] = matched;
  }
  if (data.budget && qd.budgetAmount == null && !qd.budgetNote) {
    // OVERALL wedding budget → the headline scalar. Range-aware normalizer: parses
    // single values AND ranges (lower bound stored), preserves the raw phrasing in
    // budgetNote, nulls absurd output. See normalizeBudget.
    const { amount, note } = normalizeBudget(data.budget);
    if (amount != null) set["qualificationData.budgetAmount"] = amount;
    set["qualificationData.budgetNote"] = note;
  }
  // PER-SERVICE budget (e.g. "catering ~3L") is NOT the whole-wedding figure — store
  // the raw labeled string verbatim and NEVER run it through normalizeBudget into the
  // headline budgetAmount. Fill-only-empty, mirroring the overall-budget guard above.
  if (data.budgetPerService && !qd.budgetPerService) {
    set["qualificationData.budgetPerService"] = String(data.budgetPerService).slice(0, 500);
  }

  // Placeholder lead names ("WhatsApp 1234") upgrade to the real one.
  if (data.name && /^WhatsApp \d{4}$/.test(lead.name || "")) {
    set.name = String(data.name);
  }

  // Qualified flag — same write the cockpit's qualified-call outcome makes.
  set.qualified = true;

  await EnquiryRepository.updateFieldsById(enquiryId, set);

  // Event Store days (best-effort: an unparseable date stays answers-only).
  let eventCreated = false;
  try {
    eventCreated = await ensureEventDays(lead, data);
  } catch (e) {
    console.error("[KiaraCrmSync] event-day sync failed:", e.message);
  }

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: evType(conversation, "qualified_by_kiara"),
    actorId: null,
    payload: {
      answers: ANSWER_KEYS.reduce((acc, k) => {
        if (data[k]) acc[k] = String(data[k]).slice(0, 500);
        return acc;
      }, {}),
      eventCreated,
    },
  });

  // MB7b Slice 3: WhatsApp qualification also triggers the (Haiku) Kiara
  // summary — once, fire-safe.
  await require("./KiaraSummaryService").generateForQualified(enquiryId);

  return true;
};

module.exports = {
  applyExtraction,
  syncQualifiedToCrm,
  closeLeadAsSystem,
  escalate,
  parseEventDate,
  parseCount,
  normalizeVenueStatus,
  normalizeBudget,
};
