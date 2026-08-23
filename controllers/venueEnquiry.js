const mongoose = require("mongoose");
const VenueEnquiry = require("../models/VenueEnquiry");
const Venue = require("../models/Venue");
const VenueLeadImport = require("../models/VenueLeadImport");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");
const VenueHold = require("../models/VenueHold");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const VenueConversation = require("../models/VenueConversation");
const VenueBooking = require("../models/VenueBooking");
const { createOrGetConversation } = require("./venueConversation");
const { createDraftBookingForEnquiry } = require("./venueBooking");
const { writeBackLeadToSheet } = require("../utils/venueSheetWriteBack");
const { hasCapability } = require("../utils/venueRbac");
const { resolveCreateAssignment, validateAssignable, pickRoundRobinAssignee } = require("../utils/venueLeadAssign");
const { resolveActorMemberId } = require("../utils/venueOwnerMember");
const { canViewAllLeads, scopedLeadFilter, resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { applyLegacyFollowUpWrite } = require("../utils/venueFollowUp");
const VenueTask = require("../models/VenueTask");
const VenueFollowUp = require("../models/VenueFollowUp");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueOwner = require("../models/VenueOwner");

// Phase 3 lost-reason allowlist (mirrors models/VenueEnquiry.js; "" = none/legacy).
const LOST_REASON_ENUM = ["", "too_expensive", "date_unavailable", "chose_competitor", "no_response", "other"];
const { reqStr, optStr, optDate, optNumber, optCount, cleanStr, MAXLEN, eventWindow, approximatePeriod } = require("../utils/venueInput");
const { venueDateKey, addVenueDays } = require("../utils/venueTime");
const {
  rederiveCalendar,
  conflictSentence,
  bookingSpaceIds,
  desiredPairs,
  describeConflicts,
  pairKey,
} = require("../utils/venueEventWindow");
const { contentionForLead, approximateMonthDemand, monthKeyOfDay, monthKeyOfPeriod, leadDays } = require("../utils/venueContention");
const { resolveBlock, resolveRange } = require("../utils/weddingCalendar");
const { composeCalendarNote, HOLIDAY_ADJACENT_DAYS } = require("../utils/venueCalendarNote");
const { isTradition, cleanTraditions, labelList, PARENTS, TRADITION_PARENT, TRADITION_LABEL } = require("../utils/weddingTraditions");
const { sanitizeContacts } = require("../utils/venueContacts");

// The tradition vocabulary, served WITH the lead so the portal never keeps its
// own copy. A hardcoded frontend list would drift the moment a tradition is
// added here, and the drift would be silent: the owner would pick a value the
// date matching has never heard of. Grouped parent → children because that is
// how it is chosen ("South Indian", then "Tamil" if they know).
const TRADITION_OPTIONS = PARENTS.map((parent) => ({
  value: parent,
  label: TRADITION_LABEL[parent],
  children: Object.entries(TRADITION_PARENT)
    .filter(([, p]) => p === parent)
    .map(([value]) => ({ value, label: TRADITION_LABEL[value] })),
}));

// The acting principal's id for audit stamps: a member id when a team member is
// logged in, otherwise the owner anchor id.
const actorIdOf = (req) => req.venueOwner.memberId || req.venueOwner.venueOwnerId || null;

// Resolve activity `actor` ids to display names in one round trip per
// collection. An actor is a VenueTeamMember id or a VenueOwner id; entries with
// no actor are genuine system writes and stay unnamed (the client renders
// those as "System"). Ids that no longer resolve — a deleted member — also
// come back null rather than dropping the entry: the history stays.
const attachActorNames = async (activities) => {
  const list = activities || [];
  const ids = [...new Set(list.map((a) => a.actor).filter(Boolean).map(String))];
  if (!ids.length) return list;
  const [members, owners] = await Promise.all([
    VenueTeamMember.find({ _id: { $in: ids } }).select("name").lean(),
    VenueOwner.find({ _id: { $in: ids } }).select("name").lean(),
  ]);
  const names = new Map();
  for (const o of owners) names.set(String(o._id), o.name);
  // Members win on id collision (they are the more specific principal).
  for (const m of members) names.set(String(m._id), m.name);
  return list.map((a) => ({ ...a, actorName: a.actor ? names.get(String(a.actor)) || null : null }));
};
const toMemberIdOrNull = (v) => (mongoose.isValidObjectId(v) ? v : null);

// Valid enum values (kept in sync with models/VenueEnquiry.js) for import coercion.
const SOURCE_ENUM = ["wedsy", "instagram", "referral", "walk_in", "justdial", "wedmegood", "google", "other"];
const STAGE_ENUM = ["new", "contacted", "site_visit_scheduled", "site_visit_done", "proposal_sent", "negotiating", "booked", "lost"];
// BUILD A: the vocabularies are keyed off eventType and live in ONE place.
// The controller validates a write against the lead's type; the model accepts
// the union, so a type change never destroys already-stored rows.
const {
  cleanEventType, functionVocabulary, functionAllowed,
  relationVocabulary, relationAllowed, EVENT_TYPES,
} = require("../utils/venueEventType");
const { applyCoupleName, setManualCoupleName } = require("../utils/venueCoupleName");
const REQ_FOOD_ENUM = ["", "veg", "nonveg", "both"];
const REQ_CATERING_ENUM = ["", "inhouse", "outside", "both"];
const MAX_CONTACTS = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FUNCTIONS = 20;

// ── Import coercion helpers ──
const toStr = (v) => (v == null ? "" : String(v).trim());
const digitsOnly = (v) => toStr(v).replace(/\D/g, ""); // dedup key for couplePhone
function toDateOrNull(v) {
  const s = toStr(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
function toNumberOrNull(v) {
  const s = toStr(v);
  if (!s) return null;
  const n = Number(s.replace(/[,₹\s]/g, ""));
  return Number.isNaN(n) ? null : n;
}

// ── MB-CRM-2 S1 sanitizers ──
// Each returns { ok, value } or { ok:false, message } (venueInput convention).
// sanitizeContacts moved to utils/venueContacts — the Confirm Booking wizard
// writes the same contacts[] and importing it from here made venueEnquiry and
// venueBooking require each other. See that file.

// S1b functions[]: name from the enum (custom requires customLabel), strict
// date inside [checkIn, checkOut] when the window is set, space must be a
// bookable space of THIS venue (or absent), pax a positive count. Two
// functions on the same date are fine — different spaces is the normal case.
// BUILD2 S2(a): the functions a proposed window would strand, named well
// enough for a UI to list them ("Sangeet · 29 Sep") and for the owner to know
// what they are being asked to move. Day-granularity, venue calendar, same as
// every other window comparison here.
function outsideWindow(list, checkIn, checkOut) {
  if (!checkIn || !checkOut || !Array.isArray(list)) return [];
  const lo = venueDateKey(checkIn);
  const hi = venueDateKey(checkOut);
  return list
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => {
      if (!f || !f.date) return false;
      const day = venueDateKey(f.date);
      return day < lo || day > hi;
    })
    .map(({ f, i }) => ({
      index: i,
      _id: f._id,
      name: f.name,
      customLabel: f.customLabel || "",
      date: f.date,
      day: venueDateKey(f.date),
    }));
}

function sanitizeFunctions(list, venueSpaces, checkIn, checkOut, fnType) {
  if (!Array.isArray(list)) return { ok: false, message: "functions must be an array" };
  if (list.length > MAX_FUNCTIONS) return { ok: false, message: `functions is too long (max ${MAX_FUNCTIONS})` };
  // Venue-calendar-day (IST) comparison — mirrors the model hook so the 400 and
  // the save-time invalidate can never disagree, on any server timezone.
  const lo = checkIn && checkOut ? venueDateKey(checkIn) : null;
  const hi = checkIn && checkOut ? venueDateKey(checkOut) : null;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i] || {};
    if (!functionAllowed(fnType, f.name)) {
      return { ok: false, message: `functions[${i}].name must be one of ${functionVocabulary(fnType).join(", ")}` };
    }
    const customLabel = cleanStr(f.customLabel).slice(0, MAXLEN.label);
    if (f.name === "custom" && !customLabel) {
      return { ok: false, message: `functions[${i}].customLabel is required for a custom function` };
    }
    const dV = optDate(f.date, `functions[${i}].date`);
    if (!dV.ok) return { ok: false, message: dV.message };
    if (!dV.value) return { ok: false, message: `functions[${i}].date is required` };
    if (lo !== null) {
      const day = venueDateKey(dV.value);
      if (day < lo || day > hi) {
        return { ok: false, message: `functions[${i}].date must fall within the check-in/check-out window` };
      }
    }
    let space;
    if (f.space !== undefined && f.space !== null && f.space !== "") {
      const match = (venueSpaces || []).find((s) => String(s._id) === String(f.space));
      if (!match) return { ok: false, message: `functions[${i}].space is not a space of this venue` };
      if (match.isBookable === false) return { ok: false, message: `functions[${i}].space is not bookable` };
      space = match._id;
    }
    const paxV = optCount(f.expectedPax, `functions[${i}].expectedPax`);
    if (!paxV.ok) return { ok: false, message: paxV.message };
    out.push({
      name: f.name,
      customLabel: f.name === "custom" ? customLabel : "",
      date: dV.value,
      timeSlot: cleanStr(f.timeSlot).slice(0, MAXLEN.label),
      space,
      expectedPax: paxV.value != null ? paxV.value : undefined,
      notes: cleanStr(f.notes).slice(0, MAXLEN.text),
    });
  }
  return { ok: true, value: out };
}

// S1c requirements: partial object — only the keys sent are validated/applied.
function sanitizeRequirements(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "requirements must be an object" };
  }
  const out = {};
  if (body.food !== undefined) {
    if (!REQ_FOOD_ENUM.includes(body.food)) return { ok: false, message: `requirements.food must be one of ${REQ_FOOD_ENUM.filter(Boolean).join(", ")}` };
    out.food = body.food;
  }
  if (body.catering !== undefined) {
    if (!REQ_CATERING_ENUM.includes(body.catering)) return { ok: false, message: `requirements.catering must be one of ${REQ_CATERING_ENUM.filter(Boolean).join(", ")}` };
    out.catering = body.catering;
  }
  if (body.alcohol !== undefined) {
    if (typeof body.alcohol !== "boolean" && body.alcohol !== null) {
      return { ok: false, message: "requirements.alcohol must be a boolean" };
    }
    out.alcohol = body.alcohol === null ? undefined : body.alcohol;
  }
  if (body.roomsNeeded !== undefined) {
    if (body.roomsNeeded === null || body.roomsNeeded === "") {
      out.roomsNeeded = undefined;
    } else {
      const n = Number(body.roomsNeeded);
      if (!Number.isInteger(n) || n < 0 || n > 10000) return { ok: false, message: "requirements.roomsNeeded must be a non-negative whole number" };
      out.roomsNeeded = n;
    }
  }
  if (body.decorNotes !== undefined) {
    const r = optStr(body.decorNotes, "requirements.decorNotes", MAXLEN.text);
    if (!r.ok) return r;
    out.decorNotes = r.value;
  }
  if (body.specialRequests !== undefined) {
    const r = optStr(body.specialRequests, "requirements.specialRequests", MAXLEN.text);
    if (!r.ok) return r;
    out.specialRequests = r.value;
  }
  if (body.asks !== undefined) {
    if (body.asks == null || typeof body.asks !== "object" || Array.isArray(body.asks)) {
      return { ok: false, message: "requirements.asks must be an object" };
    }
    const asks = {};
    // `food` is retired as a question but still ACCEPTED on write: the portal
    // is a static export, so an owner with a stale tab open can still send it,
    // and silently dropping their answer is worse than folding it into the
    // question that replaced it.
    for (const key of [...ASK_KEYS, "food"]) {
      const a = body.asks[key];
      if (a === undefined) continue;
      if (a == null || typeof a !== "object" || Array.isArray(a)) {
        return { ok: false, message: `requirements.asks.${key} must be an object` };
      }
      const entry = {};
      if (a.answer !== undefined) {
        if (!ASK_ANSWERS.includes(a.answer)) {
          return { ok: false, message: `requirements.asks.${key}.answer must be one of yes, no, or "" for not asked` };
        }
        entry.answer = a.answer;
      }
      if (a.note !== undefined) {
        const r = optStr(a.note, `requirements.asks.${key}.note`, MAXLEN.text);
        if (!r.ok) return r;
        entry.note = r.value;
      }
      // A note only means something next to a yes. Answering "no" or taking
      // the answer back clears it, rather than leaving "veg only" attached to
      // a question they said no to.
      if (entry.answer === "no" || entry.answer === "") entry.note = "";
      // A late `food` answer is held aside rather than written straight into
      // catering: whether it applies depends on what the lead already says,
      // which this function cannot see. Resolved at the merge below.
      if (key === "food") out.asksFoodFallback = entry;
      else asks[key] = entry;
    }
    out.asks = asks;

    // ACCOMMODATION AND roomsNeeded ARE ONE FACT. The allotment planner and
    // the booking handoff read requirements.roomsNeeded and know nothing about
    // `asks`, so answering "no" here has to zero the number they read —
    // otherwise a lead says "no rooms" on this tab while the planner still
    // holds 20. Only an explicit no writes it; a yes leaves the count to the
    // number field, which is sent alongside.
    if (asks.accommodation && asks.accommodation.answer === "no" && body.roomsNeeded === undefined) {
      out.roomsNeeded = 0;
    }
  }
  return { ok: true, value: out };
}

/**
 * FOOD AND CATERING WERE THE SAME QUESTION ASKED TWICE.
 *
 * "Food: veg" and "Catering: in-house" are two halves of one conversation —
 * are we feeding this wedding, and how. Two tiles meant two places to record
 * it, two ways to leave it half-answered, and a checklist that counted the
 * same fact twice. `food` is gone as a question; `catering` is the one that
 * survives, and normaliseAsks() folds anything already recorded under `food`
 * into it (see the reconciliation rule there).
 *
 * `accommodation` is new and is the yes/no half of what `roomsNeeded` already
 * stored. The NUMBER still lives in requirements.roomsNeeded and nowhere else
 * — the rooms handoff and the allotment planner read that field, and a second
 * copy inside the ask would be two answers to one question.
 */
const ASK_KEYS = ["catering", "alcohol", "decor", "accommodation"];
const ASK_ANSWERS = ["", "yes", "no"];

/**
 * The one answer per question, whatever shape it was written in.
 *
 * A lead answered before `asks` existed carries its answer in the legacy
 * scalars, and those scalars can only say "yes, and here is the detail" or
 * "nobody said" — they were never able to record a "no". So: an explicit
 * answer in `asks` wins; otherwise a legacy value is read as a yes with the
 * old value as its note; otherwise not asked.
 *
 * Deriving on READ rather than migrating means no existing row is rewritten,
 * and there is still exactly one answer on screen.
 */
function normaliseAsks(requirements) {
  const r = requirements || {};
  const stored = r.asks || {};

  /**
   * THE FOOD → CATERING RECONCILIATION, in one place.
   *
   * A lead can carry an answer in up to four places: asks.catering (newest),
   * asks.food (the question we retired), and the two legacy scalars r.catering
   * and r.food. The rule, in order:
   *
   *   1. An explicit asks.catering answer wins outright — it is the question
   *      that survives and the most recent thing a human said.
   *   2. Otherwise an explicit asks.food answer is adopted AS the catering
   *      answer. Same question, old name.
   *   3. Otherwise the legacy scalars: either one set means yes, and BOTH
   *      details are kept, catering first — "In-house · Veg only". Nothing a
   *      human typed is thrown away to tidy a merge.
   *   4. If the two disagree — one yes, one no — YES WINS, and both notes are
   *      carried so the conflict is visible rather than silently resolved.
   *      Dropping a recorded requirement is worse than showing a stale one.
   */
  const cateringFromLegacy = () => {
    const parts = [REQ_CATERING_LABEL[r.catering], REQ_FOOD_LABEL[r.food]].filter(Boolean);
    if (parts.length) return { answer: "yes", note: parts.join(" · ") };
    return null;
  };
  const explicit = (key) => {
    const a = stored[key] || {};
    return a.answer === "yes" || a.answer === "no"
      ? { answer: a.answer, note: a.answer === "yes" ? a.note || "" : "" }
      : null;
  };

  const out = {};
  for (const key of ASK_KEYS) {
    if (key === "catering") {
      out.catering =
        explicit("catering") ||
        explicit("food") ||
        cateringFromLegacy() || { answer: "", note: "" };
      continue;
    }
    if (key === "accommodation") {
      // The number IS the answer. A lead that recorded rooms has said yes
      // whether or not anyone ever pressed a button, and an explicit 0 is a
      // real "no" — somebody asked and they do not need rooms.
      const rooms = r.roomsNeeded;
      out.accommodation =
        explicit("accommodation") ||
        (typeof rooms === "number" && rooms > 0
          ? { answer: "yes", note: "" }
          : rooms === 0
          ? { answer: "no", note: "" }
          : { answer: "", note: "" });
      continue;
    }
    const legacy = {
      // alcohol is the one question the old shape could already answer both
      // ways, so false genuinely means no.
      alcohol: { yes: r.alcohol === true, no: r.alcohol === false, note: "" },
      decor: { yes: Boolean(r.decorNotes), no: false, note: r.decorNotes || "" },
    }[key];
    const e = explicit(key);
    if (e) out[key] = e;
    else if (legacy.yes) out[key] = { answer: "yes", note: legacy.note };
    else if (legacy.no) out[key] = { answer: "no", note: "" };
    else out[key] = { answer: "", note: "" };
  }
  return out;
}

const REQ_FOOD_LABEL = { veg: "Veg only", nonveg: "Non-veg", both: "Veg + non-veg" };
const REQ_CATERING_LABEL = { inhouse: "In-house", outside: "Outside allowed", both: "Both" };

// Every dedup key (last-10 digits) a lead answers to: legacy couplePhone/phone
// mirrors + every contact phone. Dedup keys on ANY contact phone (S1a).
function leadPhoneKeys(e) {
  const keys = new Set();
  for (const p of [e.couplePhone, e.phone]) {
    const k = digitsOnly(p).slice(-10);
    if (k.length === 10) keys.add(k);
  }
  for (const c of e.contacts || []) {
    const k = digitsOnly(c.phone).slice(-10);
    if (k.length === 10) keys.add(k);
  }
  return keys;
}

// SCOPED dedup lookup: the most recent OTHER lead sharing any phone key with
// `enquiry`, restricted to what the requester may see (invariant #11 — a
// scoped Sales member is never shown another member's lead via the banner).
// Soft-deleted rows are excluded by the scoped filter. Returns a lean doc or null.
async function findDedupMatch(venueOwner, venueMember, venueId, enquiry) {
  const mine = leadPhoneKeys(enquiry);
  if (mine.size === 0) return null;
  const filter = await scopedLeadFilter(venueOwner, venueMember, venueId, {
    _id: { $ne: enquiry._id },
  });
  const candidates = await VenueEnquiry.find(filter)
    .select("coupleName name couplePhone phone contacts stage source createdAt")
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  return candidates.find((c) => {
    for (const k of leadPhoneKeys(c)) if (mine.has(k)) return true;
    return false;
  }) || null;
}

// Shape the dedup match for responses (the "enquired before" banner).
function matchedLeadPayload(m) {
  if (!m) return undefined;
  return {
    _id: m._id,
    name: m.coupleName || m.name || "Lead",
    stage: m.stage,
    source: m.source,
    enquiredOn: m.createdAt,
  };
}

const createEnquiry = async (req, res) => {
  try {
    const { slug } = req.params;
    const {
      name,
      phone,
      coupleName,
      couplePhone,
      email,
      eventDate,
      guestCount,
      budget,
      vibe,
      message,
      source,
      estimatedValue,
      notes,
      followUpDate,
      userId: bodyUserId,
    } = req.body;
    // Public endpoint: stage and assignedTo are NOT accepted from the client.
    // Couple enquiries always start in "new"; assignment is staff-only.

    const userId = bodyUserId || (req.auth && req.auth.user_id) || null;

    const effectiveName = cleanStr(coupleName || name);
    const effectivePhone = cleanStr(couplePhone || phone);

    if (!effectiveName || !effectivePhone) {
      return res.status(400).json({ message: "Name and phone are required" });
    }
    // Hostile-input validation on the PUBLIC endpoint (length caps, strict dates, numbers).
    for (const [v, f, max] of [[effectiveName, "name", MAXLEN.name], [effectivePhone, "phone", MAXLEN.phone], [email, "email", MAXLEN.email], [message, "message", MAXLEN.text], [budget, "budget", MAXLEN.label]]) {
      const r = optStr(v, f, max);
      if (!r.ok) return res.status(400).json({ message: r.message });
    }
    const edPub = optDate(eventDate, "eventDate"); if (!edPub.ok) return res.status(400).json({ message: edPub.message });
    const fuPub = optDate(followUpDate, "followUpDate"); if (!fuPub.ok) return res.status(400).json({ message: fuPub.message });
    const gcPub = optCount(guestCount, "guestCount"); if (!gcPub.ok) return res.status(400).json({ message: gcPub.message });
    const evPub = optNumber(estimatedValue, "estimatedValue"); if (!evPub.ok) return res.status(400).json({ message: evPub.message });

    const venue = await Venue.findOne({ slug }).select("_id name phone status settings").lean();
    if (!venue) {
      return res.status(404).json({ message: "Venue not found" });
    }

    // ── Auto-assign inbound leads (product map dead-end #5, J1) ──
    // Without this an inbound enquiry lands unassigned, and an unassigned lead
    // is INVISIBLE to every member without leads_view_all — so a scoped Sales
    // team never sees the leads the website generates. This is the day-one
    // team blocker the product map calls out.
    //
    // Venue-scoped round-robin only: utils/venueLeadAssign is deliberately
    // standalone and must never import services/LeadAssignmentService (that one
    // is Admin/Enquiry-scoped and cross-team locked). No creator to default to
    // here — this is a public, unauthenticated endpoint — so it is explicit
    // request (never accepted publicly) → round-robin → unassigned.
    let inboundAssign = { assignedTo: null, via: null, auto: false };
    if (venue.settings && venue.settings.autoAssignLeads) {
      try {
        const pick = await pickRoundRobinAssignee(venue._id);
        if (pick) inboundAssign = { assignedTo: pick, via: "round_robin", auto: true };
      } catch (assignErr) {
        // Intake must never die: an assignment failure leaves the lead
        // unassigned and visible to owners/managers rather than losing it.
        console.error("Auto-assign failed for inbound enquiry:", assignErr.message);
      }
    }

    let notesArray = [];
    if (Array.isArray(notes)) {
      notesArray = notes
        .map((n) => (typeof n === "string" ? { text: n } : n))
        .filter((n) => n && n.text);
    } else if (typeof notes === "string" && notes.trim()) {
      notesArray = [{ text: notes.trim() }];
    }

    const enquiry = await VenueEnquiry.create({
      venueId: venue._id,
      userId: userId || undefined,
      name: effectiveName,
      phone: effectivePhone,
      // Public intake is always a wedding enquiry — the couple site has no
      // corporate lane — and the name the couple typed is the name.
      coupleName: cleanStr(coupleName) || effectiveName,
      coupleNameManual: Boolean(cleanStr(coupleName) || effectiveName),
      couplePhone: cleanStr(couplePhone) || effectivePhone,
      email: cleanStr(email),
      eventDate: edPub.value,
      guestCount: gcPub.value != null ? gcPub.value : null,
      budget: cleanStr(budget),
      vibe: Array.isArray(vibe) ? vibe.slice(0, 50).map((x) => String(x).slice(0, 100)) : [],
      message: cleanStr(message),
      source: source || "wedsy",
      stage: "new", // forced server-side; client cannot set stage on the public endpoint
      estimatedValue: evPub.value != null ? evPub.value : 0,
      notes: notesArray,
      // Mirror of the follow-ups module — seeded below when the caller sent one.
      // Invariant #1 (>=1 contact): the public path never seeded contacts[], so
      // every inbound web lead arrived contact-less while manually-created ones
      // did not. The couple themselves are the primary contact.
      contacts: [{ name: effectiveName, phone: effectivePhone, role: "other", isPrimary: true }],
      assignedTo: inboundAssign.assignedTo,
      activities: [
        { type: "created", description: "Lead created", timestamp: new Date() },
        ...(inboundAssign.assignedTo
          ? [{ type: "auto_assigned", description: "Auto-assigned (round-robin)", via: inboundAssign.via, timestamp: new Date() }]
          : []),
      ],
      status: "new",
    });

    if (fuPub.value) {
      try {
        await applyLegacyFollowUpWrite({ lead: enquiry, venueId: venue._id, dueAt: fuPub.value, note: "", actorId: null });
      } catch (fuErr) {
        console.error("Failed to seed follow-up for enquiry:", fuErr.message);
      }
    }

    // Seed the communication log with the initial 'enquiry' interaction so the
    // timeline isn't empty on first contact. Never let this break enquiry creation.
    try {
      await VenueLeadInteraction.create({
        enquiry: enquiry._id,
        venue: venue._id,
        type: "enquiry",
        note: message || "",
      });
    } catch (interactionErr) {
      console.error("Failed to seed lead interaction:", interactionErr.message);
    }

    let conversation = null;
    if (userId) {
      try {
        conversation = await createOrGetConversation({
          venueId: venue._id,
          enquiryId: enquiry._id,
          userId,
        });
      } catch (convErr) {
        console.error("Failed to create conversation for enquiry:", convErr.message);
      }
    }

    return res.status(201).json({
      success: true,
      enquiryId: enquiry._id,
      enquiry,
      conversationId: conversation ? conversation._id : null,
      message: "Enquiry sent successfully",
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const getVenueEnquiries = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    // S0d scoped visibility via the shared boundary (utils/venueLeadScope):
    // a member without leads_view_all sees ONLY their own leads; deleted excluded.
    const canViewAll = await canViewAllLeads(req.venueOwner, req.venueMember);
    const query = await scopedLeadFilter(req.venueOwner, req.venueMember, venue._id);
    const enquiries = await VenueEnquiry.find(query).sort({ createdAt: -1 }).lean();
    // S1d: attach each lead's live hold (requested/approved) so list rows can
    // show "Date held · Nd left" without a per-row round-trip. Only holds for
    // leads THIS requester can see are queried (ids come from the scoped list).
    if (enquiries.length) {
      const holds = await VenueHold.find({
        venue: venue._id,
        linkedEnquiry: { $in: enquiries.map((e) => e._id) },
        status: { $in: ["requested", "approved"] },
      })
        .sort({ createdAt: 1 })
        .select("linkedEnquiry status expiresAt")
        .lean();
      const byLead = new Map(holds.map((h) => [String(h.linkedEnquiry), h]));
      for (const e of enquiries) {
        const h = byLead.get(String(e._id));
        e.hold = h ? { _id: h._id, status: h.status, holdExpiry: h.expiresAt } : null;
      }
    }
    return res.status(200).json({ enquiries, total: enquiries.length, scoped: !canViewAll });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// S0d single-lead read WITH the same scope boundary — a member without
// leads_view_all cannot read another member's lead by direct id (returns 404,
// not 403, so existence isn't leaked). Hydrated (not lean) so durationHours is
// included in the response.
const getEnquiryById = async (req, res) => {
  try {
    const { slug, enquiryId } = req.params;
    // state/city drive the calendar's region resolution (BUILD4) — without them
    // a Karnataka venue would silently resolve national-only dates.
    const venue = await Venue.findOne({ slug }).select("_id spaces state city").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const enquiry = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, enquiryId, {
      populate: { path: "assignedTo", select: "name" },
    });
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });

    const json = enquiry.toJSON();

    // Attribution: activities stamp `actor` with the acting principal's id (a
    // VenueTeamMember when a member is logged in, else the owner anchor).
    // Resolve those to names — without this the workbench has nothing to
    // render and every entry reads "System", so "who moved this lead?" is
    // unanswerable even though the audit data is right there.
    json.activities = await attachActorNames(json.activities);

    // S1b: resolve space subdoc ids to display names for the functions grid.
    const spaceName = new Map((venue.spaces || []).map((s) => [String(s._id), s.name]));
    json.functions = (json.functions || []).map((f) => ({
      ...f,
      spaceName: f.space ? spaceName.get(String(f.space)) || "" : "",
    }));

    // S1d: the lead's live hold (hold→lead is already linked via
    // VenueHold.linkedEnquiry) so the workbench can show "Held · expires in Nd"
    // from ONE source of truth. requested/approved are the live states.
    const hold = await VenueHold.findOne({
      venue: venue._id,
      linkedEnquiry: enquiry._id,
      status: { $in: ["requested", "approved"] },
    })
      .sort({ createdAt: -1 })
      .select("status expiresAt dates space")
      .lean();
    json.hold = hold
      ? { _id: hold._id, status: hold.status, holdExpiry: hold.expiresAt, dates: hold.dates, space: hold.space }
      : null;

    // S1e: chat↔lead link — the Wedsy conversation thread id when one exists.
    // Safe to expose here: this read is already scoped, so a member who can't
    // see the lead never reaches this point (404 above).
    const thread = await VenueConversation.findOne({ enquiryId: enquiry._id }).select("_id").lean();
    json.threadId = thread ? thread._id : null;

    // S2: booking↔lead link, lead side — "✓ Booked · open the booking ›".
    const booking = await VenueBooking.findOne({ enquiry: enquiry._id }).select("_id status").lean();
    json.bookingId = booking ? booking._id : null;
    // The status was already being selected and thrown away. The lead now owns
    // the booking-status control — the one thing the retired booking page
    // genuinely had — and it must render the CURRENT state rather than assume
    // "confirmed", or a cancelled booking reads as confirmed until someone
    // clicks something.
    json.bookingStatus = booking ? booking.status || null : null;

    // S1a: bidirectional dedup banner — the most recent other lead sharing any
    // contact phone, scoped to what THIS requester may see.
    const match = await findDedupMatch(req.venueOwner, req.venueMember, venue._id, json);
    json.matchedLead = matchedLeadPayload(match) || null;

    // BUILD3 S1a/S1c: "who else wants this date?" — the single most useful
    // thing to know mid-call, and until now it took manual searching.
    //
    // Aggregate ONLY: a count, the furthest-along stage, and which day is worst.
    // No names, no ids, no money — see utils/venueContention.js for why the
    // COUNT is venue-wide while every detail stays inside the requester's
    // scope. `scoped` tells the client it may show the number but must send the
    // user to the day view for anything more.
    json.contention = await contentionForLead(venue._id, enquiry);
    // The approximate-month signal, kept separate: unfinalised leads naming the
    // same month are demand, not contention — nobody is competing for a day
    // nobody has named.
    const monthKey = enquiry.checkIn
      ? monthKeyOfDay(venueDateKey(enquiry.checkIn))
      : monthKeyOfPeriod(enquiry.approximatePeriod);
    const monthCount = await approximateMonthDemand(venue._id, monthKey, enquiry._id);
    json.approximateDemand = monthCount > 0 ? { month: monthKey, count: monthCount } : null;
    json.contentionScoped = !(await canViewAllLeads(req.venueOwner, req.venueMember));

    // BUILD4 — ONE plain-English note instead of three boxes of flags.
    //
    // The calendar tips, the contention strip and the month-demand line were
    // three separate things saying related things about one date; an owner
    // reads the first and skims the rest. This composes them (see
    // utils/venueCalendarNote for the language rules — business terms only,
    // tradition strictly as neutral calendar fact, never as a customer
    // preference) and hands back the raw signals alongside, so the UI styles
    // from structure rather than parsing prose.
    const dayKeys = leadDays(enquiry);
    const [block, monthPicture] = await Promise.all([
      // The couple's own traditions narrow the calendar: a date that is
      // auspicious for Tamil weddings is only news if this couple is having
      // one. Empty stays wide open — see utils/weddingTraditions.js on why
      // unspecified means "applies unless we learn otherwise".
      dayKeys.length
        ? resolveBlock({ venue, dayKeys, traditions: cleanTraditions(enquiry.traditions) })
        : Promise.resolve(null),
      // Undecided leads get the shape of the month they named instead.
      !dayKeys.length && monthKey
        ? resolveRange({
            venue,
            from: `${monthKey}-01`,
            to: `${monthKey}-${new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)), 0)).getUTCDate()}`,
          })
        : Promise.resolve(null),
    ]);
    // Holidays just outside the block still ease guest travel, so look a couple
    // of days either side — same three-query cost, wider window.
    let adjacentHolidays = [];
    if (dayKeys.length) {
      const pad = HOLIDAY_ADJACENT_DAYS;
      const lo = new Date(Date.parse(`${dayKeys[0]}T00:00:00Z`) - pad * 86400000).toISOString().slice(0, 10);
      const hi = new Date(Date.parse(`${dayKeys[dayKeys.length - 1]}T00:00:00Z`) + pad * 86400000).toISOString().slice(0, 10);
      const around = await resolveRange({ venue, from: lo, to: hi });
      adjacentHolidays = [...around.values()].flatMap((d) => d.holidays);
    }

    const note = composeCalendarNote({
      block,
      contention: json.contention,
      approximateDemand: json.approximateDemand,
      monthPicture,
      adjacentHolidays,
      hasHold: Boolean(json.hold),
      isBooked: enquiry.stage === "booked" || Boolean(json.bookingId),
      checkIn: enquiry.checkIn,
      // BUILD A: the type decides whether muhurat advice appears at all, and
      // whether a blackout reads as a warning or as an opportunity.
      eventType: enquiry.eventType,
    });
    json.calendarNote = note.text ? note : null;
    json.traditionOptions = TRADITION_OPTIONS;
    // ONE answer per question, whatever shape it was stored in.
    json.requirements = { ...(json.requirements || {}), asks: normaliseAsks(json.requirements) };

    return res.status(200).json({ enquiry: json });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /venues/:slug/enquiries/exists?phone= — lightweight soft-warn lookup for
// the add-lead modal (venueOwnerAuth, open read). Matches on the last-10
// canonical digits so +91 / spacing variants of the same number collide.
// Returns the most recent matching lead's id + name, or { exists:false }.
const last10 = (v) => digitsOnly(v).slice(-10);
const checkEnquiryExists = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const key = last10(req.query.phone);
    if (key.length < 10) return res.status(200).json({ exists: false });
    // S1a: dedup keys on ANY contact phone (plus the legacy couplePhone/phone
    // mirrors), matched on the last-10 canonical digits.
    // Scoped + soft-delete-excluded: a member is only warned about their own dupes.
    const existsFilter = await scopedLeadFilter(req.venueOwner, req.venueMember, venue._id);
    const candidates = await VenueEnquiry.find(existsFilter)
      .select("coupleName name couplePhone phone contacts stage source createdAt")
      .sort({ createdAt: -1 })
      .lean();
    const match = candidates.find((e) => leadPhoneKeys(e).has(key));
    if (!match) return res.status(200).json({ exists: false });
    return res.status(200).json({
      exists: true,
      lead: {
        _id: match._id,
        name: match.coupleName || match.name || "Lead",
        stage: match.stage,
      },
      // The richer shape the CRM-2 dedup banner reads; `lead` stays for the
      // pre-existing add-lead consumers.
      matchedLead: matchedLeadPayload(match),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const updateEnquiry = async (req, res) => {
  try {
    const { slug, enquiryId } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id spaces").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // Scoped resolve: a member without leads_view_all cannot touch (or even
    // learn of) another member's lead — un-gated fields included. 404, not 403.
    const enquiry = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, enquiryId);
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });

    const {
      stage, estimatedValue, lostReason, followUpDate, followUpNote, addNote, assignedTo, checkIn, checkOut,
      // S3: profile fields are editable after creation ("nothing locked").
      coupleName, couplePhone, email, guestCount, source, budget, message,
      // MB-CRM-2 S1: structured lead shape (wholesale replace when sent).
      contacts, functions, requirements,
      // BUILD2 S1/S2: finalise, revert, and the caller's acknowledgement that
      // it has seen the holds a window move would strand.
      datesFinalised, approximatePeriod: approximatePeriodRaw, acknowledgeStaleHolds,
      // BUILD A: the event type, changeable after creation.
      eventType,
      // The couple's own community calendar. Wholesale replace when sent; []
      // clears it back to "nobody asked".
      traditions,
    } = req.body || {};

    if (lostReason !== undefined && !LOST_REASON_ENUM.includes(lostReason)) {
      return res.status(400).json({ message: `lostReason must be one of ${LOST_REASON_ENUM.filter(Boolean).join(", ")}` });
    }
    // S3 profile-field validation (all optional, additive).
    for (const [val, field, max] of [[coupleName, "coupleName", MAXLEN.name], [couplePhone, "couplePhone", MAXLEN.phone], [email, "email", MAXLEN.email], [budget, "budget", MAXLEN.label], [message, "message", MAXLEN.text]]) {
      if (val !== undefined) { const r = optStr(val, field, max); if (!r.ok) return res.status(400).json({ message: r.message }); }
    }
    const gcU = guestCount !== undefined ? optCount(guestCount, "guestCount") : null;
    if (gcU && !gcU.ok) return res.status(400).json({ message: gcU.message });
    // Traditions: an array of known tokens, or [] to clear. An unknown token is
    // refused rather than dropped — silently discarding "bengali" would tell
    // the owner it was saved when their date matching would never use it.
    let traditionsU;
    if (traditions !== undefined) {
      if (!Array.isArray(traditions)) {
        return res.status(400).json({ message: "traditions must be an array" });
      }
      const bad = traditions.filter((t) => !isTradition(t));
      if (bad.length) {
        return res.status(400).json({ message: `traditions has unknown values: ${bad.join(", ")}` });
      }
      traditionsU = cleanTraditions(traditions);
    }
    if (source !== undefined && !SOURCE_ENUM.includes(source)) {
      return res.status(400).json({ message: `source must be one of ${SOURCE_ENUM.join(", ")}` });
    }
    if (stage !== undefined && !STAGE_ENUM.includes(stage)) {
      return res.status(400).json({ message: `stage must be one of ${STAGE_ENUM.join(", ")}` });
    }
    const evV = optNumber(estimatedValue, "estimatedValue"); if (!evV.ok) return res.status(400).json({ message: evV.message });
    const fuV = optDate(followUpDate, "followUpDate"); if (!fuV.ok) return res.status(400).json({ message: fuV.message });
    // S0b event window (either/both may be sent; validated against the 7-day cap).
    const winSent = checkIn !== undefined || checkOut !== undefined;
    const win = eventWindow(
      checkIn !== undefined ? checkIn : enquiry.checkIn,
      checkOut !== undefined ? checkOut : enquiry.checkOut
    );
    if (winSent && !win.ok) return res.status(400).json({ message: win.message });

    // ── MB-CRM-2 S1 validation. Functions are checked against the window as it
    // will be AFTER this update (win.checkIn/checkOut when valid, else current),
    // and existing functions are re-checked when the window itself moves.
    const effCheckIn = win.ok ? win.checkIn : enquiry.checkIn;
    const effCheckOut = win.ok ? win.checkOut : enquiry.checkOut;
    // Set when a window move strands holds AND the caller acknowledged them —
    // echoed back so the UI can offer release/re-placement after the save.
    let staleHoldsAcknowledged = null;
    // The booking that shares this lead's window, and what re-deriving its
    // calendar did. Both are written only after the lead saves, so the two
    // copies of the window can never be left disagreeing.
    let bookingForWindow = null;
    let windowCalendarResult = null;

    // BUILD A — the event type is CHANGEABLE. A lead typed in as a wedding that
    // turns out to be a corporate offsite must never need deleting and
    // re-entering; that is how history, notes and follow-ups get lost. The
    // effective type drives validation of contacts and functions in this same
    // request, so a caller can switch the type and send the new vocabulary at
    // once rather than having to save twice.
    if (eventType !== undefined && !EVENT_TYPES.includes(eventType)) {
      return res.status(400).json({ message: `eventType must be one of ${EVENT_TYPES.join(", ")}` });
    }
    const effEventType = cleanEventType(eventType !== undefined ? eventType : enquiry.eventType);

    let contactsV = null;
    if (contacts !== undefined) {
      contactsV = sanitizeContacts(contacts, effEventType);
      if (!contactsV.ok) return res.status(400).json({ message: contactsV.message });
    }
    let functionsV = null;
    if (functions !== undefined) {
      functionsV = sanitizeFunctions(functions, venue.spaces, effCheckIn, effCheckOut, effEventType);
      if (!functionsV.ok) return res.status(400).json({ message: functionsV.message });
    }
    if (functions === undefined && winSent && effCheckIn && effCheckOut && (enquiry.functions || []).length) {
      // Re-checked against the lead's CURRENT type, not the effective one: this
      // path is about the window moving, and re-validating stored functions
      // against a freshly-changed vocabulary would reject a type switch purely
      // because the old functions exist.
      const recheck = sanitizeFunctions(enquiry.functions, venue.spaces, effCheckIn, effCheckOut, enquiry.eventType);
      if (!recheck.ok) {
        // BUILD2 S2(a): say WHICH functions fall outside the new window. The
        // old message named none of them, so a caller could only re-guess. The
        // UI resolves these before it ever sends the change; this stays as the
        // backstop for anything that does not.
        return res.status(400).json({
          message: "the new check-in/check-out window would orphan an existing function date",
          conflictingFunctions: outsideWindow(enquiry.functions, effCheckIn, effCheckOut),
        });
      }
    }
    let requirementsV = null;
    if (requirements !== undefined) {
      requirementsV = sanitizeRequirements(requirements);
      if (!requirementsV.ok) return res.status(400).json({ message: requirementsV.message });
    }

    // ── BUILD2 S1: finalise / revert ────────────────────────────────────────
    // Finalising = datesFinalised:true + a window. Reverting = false + a
    // period. The model refuses to hold both states; the controller refuses
    // the contradictory REQUEST, so the caller learns which half was wrong.
    const finalisedSent = datesFinalised !== undefined;
    const goingUnfinalised = datesFinalised === false;
    const apU = approximatePeriod(approximatePeriodRaw);
    if (!apU.ok) return res.status(400).json({ message: apU.message });
    if (goingUnfinalised) {
      const period = apU.value || (enquiry.approximatePeriod && enquiry.approximatePeriod.month
        ? { month: enquiry.approximatePeriod.month, year: enquiry.approximatePeriod.year, day: enquiry.approximatePeriod.day }
        : null);
      if (!period) return res.status(400).json({ message: "approximatePeriod {month, year} is required when dates are not finalised" });
      // Only the INCOMING body can contradict itself. `win` falls back to the
      // lead's current window, so testing it here would refuse every revert of
      // a lead that has dates — which is precisely the case reverting exists
      // for. The existing window is cleared below, not rejected.
      if ((checkIn !== undefined && checkIn) || (checkOut !== undefined && checkOut)) {
        return res.status(400).json({ message: "an unfinalised lead cannot carry a check-in/check-out window" });
      }
      if ((enquiry.functions || []).length && functions === undefined) {
        // Un-deciding the dates would strand every function on a day the lead
        // no longer claims. Same shape as the window-move conflict: name them,
        // make the caller deal with them first.
        return res.status(409).json({
          message: "remove or move this lead's functions before un-finalising its dates",
          conflictingFunctions: outsideWindow(enquiry.functions, enquiry.checkIn, enquiry.checkOut).length
            ? outsideWindow(enquiry.functions, enquiry.checkIn, enquiry.checkOut)
            : (enquiry.functions || []).map((f, i) => ({ index: i, _id: f._id, name: f.name, customLabel: f.customLabel || "", date: f.date, day: venueDateKey(f.date) })),
        });
      }
    } else if (finalisedSent && datesFinalised === true && enquiry.datesFinalised === false) {
      // Finalising REQUIRES real dates — otherwise the lead would land in the
      // finalised state carrying neither a window nor a period, which is the
      // dateless hole this whole slice exists to close.
      if (!win.checkIn) {
        return res.status(400).json({ message: "a check-in is required to finalise this lead's dates" });
      }
    }

    // ── BUILD2 S2: the consequences of moving an existing window ────────────
    // Only when the window actually MOVES on a lead that already had one —
    // filling in dates for the first time strands nothing.
    const windowMoving =
      winSent &&
      (enquiry.checkIn || enquiry.checkOut) &&
      (String(enquiry.checkIn || "") !== String(win.checkIn || "") ||
        String(enquiry.checkOut || "") !== String(win.checkOut || ""));

    if (windowMoving || goingUnfinalised) {
      // (c) A confirmed booking owns real calendar inventory.
      //
      // This USED to refuse outright — "change the dates through the booking,
      // not the lead" — which was a dead end, because no such path existed. A
      // lead's dates and its booking's dates are the same thing, so the edit is
      // now applied to both, or to neither. See utils/venueEventWindow.
      bookingForWindow = await VenueBooking.findOne({ enquiry: enquiry._id });
      if (bookingForWindow && goingUnfinalised) {
        // Un-finalising would leave a booking with no dates at all, holding
        // calendar inventory for an event nobody can name a day for. That is
        // still a refusal — but now for a reason, not for lack of a path.
        return res.status(409).json({
          message: "This lead has a booking — a booked event cannot go back to having no dates. Cancel the booking first.",
          bookingId: bookingForWindow._id,
          bookingStatus: bookingForWindow.status,
        });
      }

      // (b) Holds are approved claims on specific calendar days. A window move
      // leaves any hold on the OLD days blocking inventory for an event that is
      // no longer on them. Invariant #12's rule applies: never release
      // silently. So the first attempt is refused WITH the holds listed, and
      // only an explicit acknowledgeStaleHolds lets the move through — still
      // without touching the hold, which the owner then releases or re-places.
      const liveHolds = await VenueHold.find({
        venue: venue._id,
        linkedEnquiry: enquiry._id,
        status: { $in: ["requested", "approved"] },
      })
        .select("_id status dates expiresAt space")
        .lean();
      const newDays = new Set();
      if (win.checkIn && win.checkOut) {
        for (let d = new Date(win.checkIn); d <= win.checkOut; d = addVenueDays(d, 1)) newDays.add(venueDateKey(d));
      }
      const stranded = liveHolds.filter((h) => (h.dates || []).some((d) => !newDays.has(venueDateKey(d))));
      if (stranded.length && acknowledgeStaleHolds !== true) {
        return res.status(409).json({
          message: "This lead holds dates that the new window does not cover — release or re-place the hold",
          staleHolds: stranded.map((h) => ({ _id: h._id, status: h.status, dates: h.dates, expiresAt: h.expiresAt, space: h.space })),
          // The caller re-sends with acknowledgeStaleHolds:true once the owner
          // has decided. We still never release it for them.
          acknowledgeWith: "acknowledgeStaleHolds",
        });
      }
      if (stranded.length) staleHoldsAcknowledged = stranded;

      // (d) Re-derive the booking's calendar for the new window. Done here,
      // AFTER the function and hold checks, so a change that was going to be
      // refused never touches inventory — and BEFORE either window is written,
      // so a calendar conflict means nothing at all moved.
      //
      // rederiveCalendar claims every new date before releasing a single old
      // one, so a refusal leaves the booking holding exactly what it held.
      if (bookingForWindow) {
        const calendar = await rederiveCalendar({
          venueId: venue._id,
          booking: bookingForWindow,
          checkIn: win.checkIn,
          checkOut: win.checkOut,
        });
        if (!calendar.ok) {
          return res.status(409).json({
            message: `These dates cannot be moved — ${conflictSentence(calendar.conflicts)}. Nothing was changed.`,
            code: "calendar_conflict",
            conflicts: calendar.conflicts,
            bookingId: bookingForWindow._id,
          });
        }
        windowCalendarResult = calendar;
      }
    }

    // ── S0d fine-grained capability gates (coarse "leads" already required by
    // the route). Each mutating field checks its own capability; owners pass all.
    const stageChanging = stage !== undefined && stage !== enquiry.stage;
    const markingLost = stage === "lost" || (lostReason !== undefined && lostReason !== "");
    if (stageChanging && !(await hasCapability(req.venueOwner, "leads_change_stage", req.venueMember))) {
      return res.status(403).json({ message: "You don't have permission to change lead stage" });
    }
    if (markingLost && !(await hasCapability(req.venueOwner, "leads_mark_lost", req.venueMember))) {
      return res.status(403).json({ message: "You don't have permission to mark leads lost" });
    }
    if (evV.value !== undefined && !(await hasCapability(req.venueOwner, "money_negotiate", req.venueMember))) {
      return res.status(403).json({ message: "You don't have permission to change deal value" });
    }

    // ── S0a assignedTo is now a ref: reassignment needs leads_reassign, the
    // target must be an active member of this venue (422), and it's audited.
    let assignResolved; // { id, unassign } when a change is requested
    if (assignedTo !== undefined) {
      if (!(await hasCapability(req.venueOwner, "leads_reassign", req.venueMember))) {
        return res.status(403).json({ message: "You don't have permission to reassign leads" });
      }
      const wantsUnassign = assignedTo == null || String(assignedTo).trim() === "";
      if (wantsUnassign) {
        assignResolved = { id: null, unassign: true };
      } else {
        const v = await validateAssignable(venue._id, assignedTo);
        if (!v.ok) return res.status(422).json({ message: v.message });
        assignResolved = { id: v.id, unassign: false };
      }
    }

    let movedToBooked = false;
    let stageChanged = false;
    if (stageChanging) {
      enquiry.activities.push({
        type: "stage_changed",
        description: `Stage changed from ${enquiry.stage} to ${stage}`,
        timestamp: new Date(),
      });
      if (stage === "booked") movedToBooked = true;
      enquiry.stage = stage;
      stageChanged = true;
    }
    if (evV.value !== undefined) enquiry.estimatedValue = evV.value;
    if (lostReason !== undefined) enquiry.lostReason = lostReason;
    // followUpDate/followUpNote are no longer written directly: they are a
    // mirror of the next OPEN row in the follow-ups module. The legacy body
    // shape still works — it now edits/creates/closes that row (and the mirror
    // is recomputed from it) so the two can never diverge.
    // S3 profile-field edits (keep name/phone mirrors in sync with the couple
    // fields so dedup + WhatsApp keep working).
    // BUILD A: typing a name here is an OVERRIDE and it sticks — the
    // derivation never touches the row again until the field is cleared, which
    // is how "actually, just use the couple's names" is expressed.
    if (coupleName !== undefined) {
      setManualCoupleName(enquiry, coupleName);
      enquiry.name = enquiry.coupleName;
    }
    if (couplePhone !== undefined) { enquiry.couplePhone = cleanStr(couplePhone); enquiry.phone = cleanStr(couplePhone); }
    if (email !== undefined) enquiry.email = cleanStr(email);
    if (budget !== undefined) enquiry.budget = cleanStr(budget);
    if (message !== undefined) enquiry.message = cleanStr(message);
    if (guestCount !== undefined) enquiry.guestCount = gcU.value != null ? gcU.value : null;
    if (source !== undefined) enquiry.source = source;
    if (winSent) {
      if (checkIn !== undefined) enquiry.checkIn = win.checkIn;
      if (checkOut !== undefined) enquiry.checkOut = win.checkOut;
      // eventDate is re-derived from checkIn by the model pre-validate hook.
    }
    // BUILD2 S1 transitions, written after the window so the pre-validate hook
    // sees the final pair and can enforce mutual exclusivity on it.
    if (goingUnfinalised) {
      const prevWindow = { checkIn: enquiry.checkIn, checkOut: enquiry.checkOut };
      enquiry.datesFinalised = false;
      enquiry.approximatePeriod = apU.value || enquiry.approximatePeriod;
      enquiry.checkIn = null;
      enquiry.checkOut = null;
      enquiry.eventDate = null;
      enquiry.activities.push({
        type: "dates_unfinalised",
        description: prevWindow.checkIn
          ? `Dates un-finalised (was ${venueDateKey(prevWindow.checkIn)}${prevWindow.checkOut ? ` → ${venueDateKey(prevWindow.checkOut)}` : ""})`
          : "Dates marked not finalised",
        actor: actorIdOf(req),
        timestamp: new Date(),
      });
    } else if (finalisedSent && datesFinalised === true && enquiry.datesFinalised === false) {
      enquiry.datesFinalised = true;
      enquiry.approximatePeriod = { month: null, year: null, day: null };
      enquiry.activities.push({
        type: "dates_finalised",
        description: `Dates finalised — ${venueDateKey(win.checkIn)}${win.checkOut ? ` → ${venueDateKey(win.checkOut)}` : ""}`,
        actor: actorIdOf(req),
        timestamp: new Date(),
      });
    } else if (approximatePeriodRaw !== undefined && enquiry.datesFinalised === false && apU.value) {
      // Editing the period of a lead that is already unfinalised.
      enquiry.approximatePeriod = apU.value;
    }
    if (windowMoving && !goingUnfinalised) {
      enquiry.activities.push({
        type: "dates_changed",
        description: `Event window moved to ${venueDateKey(win.checkIn)}${win.checkOut ? ` → ${venueDateKey(win.checkOut)}` : ""}`,
        actor: actorIdOf(req),
        timestamp: new Date(),
      });
    }
    // BUILD A: the type change itself, recorded on the timeline because it
    // changes what the whole page means.
    if (eventType !== undefined && effEventType !== cleanEventType(enquiry.eventType)) {
      const from = cleanEventType(enquiry.eventType);
      enquiry.eventType = effEventType;
      enquiry.activities.push({
        type: "event_type_changed",
        description: `Event type changed from ${from} to ${effEventType}`,
        actor: actorIdOf(req),
        timestamp: new Date(),
      });
    }

    // The couple's community calendar. Recorded on the timeline: it changes
    // which dates the advice calls auspicious, so it is not a silent edit.
    if (traditionsU !== undefined) {
      const before = cleanTraditions(enquiry.traditions).join(",");
      if (before !== traditionsU.join(",")) {
        enquiry.traditions = traditionsU;
        enquiry.activities.push({
          type: "note",
          description: traditionsU.length
            ? `Tradition set to ${labelList(traditionsU)}`
            : "Tradition cleared",
          actor: actorIdOf(req),
          timestamp: new Date(),
        });
      }
    }

    // MB-CRM-2 S1 writes (wholesale replace — the workbench sends full arrays).
    if (contactsV) {
      enquiry.contacts = contactsV.value;
      // Keep the legacy PHONE mirrors following the primary contact so dedup
      // import, WhatsApp and the legacy dashboards stay coherent.
      const primary = contactsV.value.find((c) => c.isPrimary);
      if (primary && primary.phone) {
        enquiry.couplePhone = primary.phone;
        enquiry.phone = primary.phone;
      }
      // BUILD A: the NAME is no longer just "whatever the primary is called" —
      // it derives from bride + groom when those exist, and a manual override
      // beats both. utils/venueCoupleName owns the rule; `name` follows
      // coupleName exactly as it always did.
      applyCoupleName(enquiry);
      if (enquiry.coupleName) enquiry.name = enquiry.coupleName;
    }
    if (functionsV) enquiry.functions = functionsV.value;
    if (requirementsV) {
      const existing = enquiry.requirements
        ? enquiry.requirements.toObject
          ? enquiry.requirements.toObject()
          : enquiry.requirements
        : {};
      const { asks: asksPatch, asksFoodFallback, ...flat } = requirementsV.value;
      // `asks` merges PER QUESTION. A spread would mean answering "food" wipes
      // what they already said about alcohol — the whole checklist lost to
      // one dropdown.
      const asks = { ...(existing.asks || {}) };
      for (const [key, entry] of Object.entries(asksPatch || {})) {
        asks[key] = { ...(asks[key] || {}), ...entry };
      }
      // The retired question FILLS catering, it never overwrites it. A stale
      // tab answering "food" must not wipe a catering answer somebody gave
      // afterwards — and a note like "Outside caterer approved" is exactly the
      // kind of thing that would vanish.
      if (asksFoodFallback && asks.catering?.answer !== "yes" && asks.catering?.answer !== "no") {
        asks.catering = asksFoodFallback;
      }
      enquiry.requirements = { ...existing, ...flat, ...(asksPatch || asksFoodFallback ? { asks } : {}) };
    }
    if (assignResolved) {
      enquiry.assignedTo = assignResolved.id;
      enquiry.activities.push({
        type: assignResolved.unassign ? "unassigned" : "manual_assigned",
        description: assignResolved.unassign ? "Lead unassigned" : "Lead reassigned",
        via: "manual_reassign",
        actor: actorIdOf(req),
        timestamp: new Date(),
      });
    }
    if (typeof addNote === "string" && addNote.trim()) {
      enquiry.notes.push({ text: addNote.trim(), addedAt: new Date() });
      enquiry.activities.push({
        type: "note_added",
        description: "Note added",
        timestamp: new Date(),
      });
    }

    await enquiry.save();

    // ── the booking's copy of the window, in the same operation ────────────
    // The calendar has already been re-derived and the lead has saved, so this
    // is a plain field write on a document whose validation has nothing to say
    // about it. Writing it here rather than earlier means a lead that fails to
    // save cannot leave the booking on dates the lead never accepted.
    if (bookingForWindow && win.checkIn && win.checkOut) {
      bookingForWindow.checkIn = win.checkIn;
      bookingForWindow.checkOut = win.checkOut;
      await bookingForWindow.save();
      enquiry.activities.push({
        type: "dates_changed",
        description:
          `Event window moved to ${venueDateKey(win.checkIn)} → ${venueDateKey(win.checkOut)}` +
          (windowCalendarResult
            ? ` · calendar re-derived (+${windowCalendarResult.added} / −${windowCalendarResult.removed} date-spaces)`
            : ""),
        actor: actorIdOf(req),
        timestamp: new Date(),
      });
      await enquiry.save();
    }

    // Route the legacy follow-up fields through the module, then refresh the
    // in-memory mirror so the response body matches what was persisted.
    if (followUpDate !== undefined || followUpNote !== undefined) {
      await applyLegacyFollowUpWrite({
        lead: enquiry,
        venueId: venue._id,
        dueAt: followUpDate === undefined ? undefined : fuV.value,
        note: followUpNote === undefined ? undefined : cleanStr(followUpNote).slice(0, MAXLEN.text),
        actorId: actorIdOf(req),
      });
      const fresh = await VenueEnquiry.findById(enquiry._id).select("followUpDate followUpNote").lean();
      enquiry.followUpDate = fresh.followUpDate;
      enquiry.followUpNote = fresh.followUpNote;
    }

    // Phase 3.1: moving a lead to "booked" auto-creates a draft booking (idempotent,
    // one per enquiry). Failure here must not fail the stage update.
    let booking = null;
    if (movedToBooked) {
      try {
        booking = await createDraftBookingForEnquiry(venue._id, enquiry, req.venueOwner.venueOwnerId);
      } catch (bookingErr) {
        console.error("Auto-create booking failed for enquiry", String(enquiry._id), bookingErr.message);
      }
    }

    // Fire-and-forget: mirror a stage change back to the source Google Sheet for
    // sheet-synced leads. Never blocks the PATCH and never surfaces errors here;
    // no-ops gracefully when there is no integration / creds / row mapping.
    if (stageChanged) {
      setImmediate(() => {
        writeBackLeadToSheet(enquiry).catch((e) =>
          console.warn(`[writeBackLeadToSheet] enquiry ${enquiry._id}: ${e.message}`)
        );
      });
    }

    return res.status(200).json({
      enquiry,
      booking: booking ? { _id: booking._id } : undefined,
      // BUILD2 S2(b): the window moved and these holds still sit on the old
      // days. Nothing was released — the caller shows them as explicit
      // release/re-place actions, exactly as delete does with releasedNothing.
      staleHolds: staleHoldsAcknowledged
        ? staleHoldsAcknowledged.map((h) => ({ _id: h._id, status: h.status, dates: h.dates, expiresAt: h.expiresAt, space: h.space }))
        : undefined,
    });
  } catch (err) {
    if (err.name === "ValidationError") return res.status(400).json({ message: err.message });
    return res.status(500).json({ message: err.message });
  }
};

// Gated manual lead creation — venue owners adding walk-ins / referrals / etc.
// from their dashboard. Authenticated (venueOwnerAuth) and ownership-checked.
const createManualLead = async (req, res) => {
  try {
    const { slug } = req.params;
    const {
      coupleName,
      couplePhone,
      email,
      eventDate,
      checkIn,
      checkOut,
      guestCount,
      message,
      source,
      stage,
      estimatedValue,
      notes,
      followUpDate,
      followUpNote,
      assignedTo,
      budget,
      contacts,
      // BUILD2 S1
      datesFinalised,
      approximatePeriod: approximatePeriodRaw,
      // BUILD A: set at creation. Defaults to social — weddings are the business.
      eventType,
    } = req.body || {};

    if (eventType !== undefined && !EVENT_TYPES.includes(eventType)) {
      return res.status(400).json({ message: `eventType must be one of ${EVENT_TYPES.join(", ")}` });
    }
    const newEventType = cleanEventType(eventType);

    const nameC = cleanStr(coupleName);
    const phoneC = cleanStr(couplePhone);
    if (!nameC && !phoneC) {
      return res.status(400).json({ message: "Couple name or phone is required" });
    }
    // Hostile-input validation (length caps, strict dates, non-negative numbers).
    for (const [v, f, max] of [[coupleName, "coupleName", MAXLEN.name], [couplePhone, "couplePhone", MAXLEN.phone], [email, "email", MAXLEN.email], [message, "message", MAXLEN.text], [budget, "budget", MAXLEN.label]]) {
      const r = optStr(v, f, max);
      if (!r.ok) return res.status(400).json({ message: r.message });
    }
    const edV = optDate(eventDate, "eventDate"); if (!edV.ok) return res.status(400).json({ message: edV.message });
    const fuV = optDate(followUpDate, "followUpDate"); if (!fuV.ok) return res.status(400).json({ message: fuV.message });
    const gcV = optCount(guestCount, "guestCount"); if (!gcV.ok) return res.status(400).json({ message: gcV.message });
    const evV = optNumber(estimatedValue, "estimatedValue"); if (!evV.ok) return res.status(400).json({ message: evV.message });
    const win = eventWindow(checkIn, checkOut); if (!win.ok) return res.status(400).json({ message: win.message });
    // BUILD2 S1: "dates not finalised". Refuse the contradiction at the door
    // rather than picking a winner for the caller — a body carrying both a
    // window and "not finalised" is a bug in the caller, not an ambiguity for
    // us to resolve quietly.
    const unfinalised = datesFinalised === false;
    const apV = approximatePeriod(approximatePeriodRaw);
    if (!apV.ok) return res.status(400).json({ message: apV.message });
    if (unfinalised) {
      if (!apV.value) return res.status(400).json({ message: "approximatePeriod {month, year} is required when dates are not finalised" });
      if (win.checkIn || win.checkOut || edV.value) {
        return res.status(400).json({ message: "an unfinalised lead cannot carry a check-in/check-out window or event date" });
      }
    } else if (apV.value) {
      return res.status(400).json({ message: "approximatePeriod is only for leads whose dates are not finalised" });
    }
    // S1a: optional explicit contacts; default = one primary contact seeded
    // from the couple name+phone (the add-lead modal contract).
    let contactsV = null;
    if (contacts !== undefined) {
      contactsV = sanitizeContacts(contacts, newEventType);
      if (!contactsV.ok) return res.status(400).json({ message: contactsV.message });
    }

    const venue = await Venue.findOne({ slug }).select("_id settings").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // ── Assignment contract: explicit wins → creator default → auto round-robin.
    // A member assigning to someone OTHER than themselves needs leads_reassign.
    // WALKTHROUGH FIX 4 — this read req.venueOwner.memberId, which is
    // `undefined` for an OWNER token. creatorMemberId therefore came out null,
    // resolveCreateAssignment skipped its create_self rule entirely, and every
    // lead an owner typed in landed UNASSIGNED unless the venue had
    // auto-assign switched on (off by default).
    //
    // This is the same undefined-memberId class the owner-as-member build
    // fixed at every "Me" resolution site — and this create path was
    // explicitly left out of that build as "a separate call about default
    // ownership". The founder has now hit it on prod, which settles the call:
    // the person who typed the lead in owns it, owner or member.
    const creatorMemberId = await resolveActorMemberId(req);
    const explicit = assignedTo != null && String(assignedTo).trim() !== "";
    if (
      explicit &&
      (!creatorMemberId || String(assignedTo) !== String(creatorMemberId)) &&
      !(await hasCapability(req.venueOwner, "leads_reassign", req.venueMember))
    ) {
      return res.status(403).json({ message: "You don't have permission to assign leads to others" });
    }
    const autoAssignOn = Boolean(venue.settings && venue.settings.autoAssignLeads);
    let assign = await resolveCreateAssignment({
      venueId: venue._id,
      requested: assignedTo,
      creatorMemberId,
      autoAssign: autoAssignOn,
    });
    if (assign.error) return res.status(assign.error.status).json({ message: assign.error.message });
    // EDGE 1: re-validate the chosen assignee immediately before create. If the
    // target went inactive in the validate→apply window, fall back to auto (or
    // unassigned) rather than parking the lead on a disabled member.
    if (assign.assignedTo) {
      const recheck = await validateAssignable(venue._id, assign.assignedTo);
      if (!recheck.ok) {
        const autoId = autoAssignOn ? await pickRoundRobinAssignee(venue._id) : null;
        assign = autoId
          ? { assignedTo: autoId, via: "round_robin", auto: true }
          : { assignedTo: null, via: null, auto: false };
      }
    }

    let notesArray = [];
    if (Array.isArray(notes)) {
      notesArray = notes
        .map((n) => (typeof n === "string" ? { text: cleanStr(n) } : n))
        .filter((n) => n && n.text)
        .map((n) => ({ text: String(n.text).slice(0, MAXLEN.text) }));
    } else if (typeof notes === "string" && notes.trim()) {
      notesArray = [{ text: notes.trim().slice(0, MAXLEN.text) }];
    }

    const activities = [{ type: "created", description: "Lead added manually", timestamp: new Date() }];
    if (assign.assignedTo) {
      activities.push({
        type: assign.auto ? "auto_assigned" : "manual_assigned",
        description: assign.auto ? "Auto-assigned (round-robin)" : "Assigned on create",
        via: assign.via,
        actor: actorIdOf(req),
        timestamp: new Date(),
      });
    }

    // Default contact seeding: whoever the form named, as the primary contact.
    // BUILD A gives them the optional email from the form and the type's
    // neutral relation, so a brand-new lead already has a usable People tab
    // rather than an empty one the owner has to populate by hand.
    const seedRelation = newEventType === "corporate" ? "main_contact" : "other";
    const contactRows = contactsV
      ? contactsV.value
      : nameC || phoneC
        ? [{
            name: nameC,
            phone: phoneC,
            email: cleanStr(email).toLowerCase(),
            relation: seedRelation,
            role: seedRelation,
            isPrimary: true,
            isDecisionMaker: false,
          }]
        : [];

    const enquiry = await VenueEnquiry.create({
      venueId: venue._id,
      eventType: newEventType,
      name: nameC,
      phone: phoneC,
      // The typed name is what the owner meant, so it is the name — and it is
      // marked manual so a later bride/groom contact does not quietly rewrite
      // "Infosys Offsite" into two people's names.
      coupleName: nameC,
      coupleNameManual: Boolean(nameC),
      couplePhone: phoneC,
      email: cleanStr(email),
      // BUILD2 S1: an unfinalised lead carries the period and NO window. The
      // model enforces the same thing; sending nulls here means we never even
      // hand it a contradictory pair to reject.
      datesFinalised: unfinalised ? false : true,
      approximatePeriod: unfinalised ? apV.value : undefined,
      eventDate: unfinalised ? null : edV.value,
      checkIn: unfinalised ? null : win.checkIn,
      checkOut: unfinalised ? null : win.checkOut,
      guestCount: gcV.value != null ? gcV.value : null,
      message: cleanStr(message),
      budget: cleanStr(budget),
      source: source || "other",
      stage: stage || "new",
      estimatedValue: evV.value != null ? evV.value : 0,
      notes: notesArray,
      // followUpDate/followUpNote are the module's mirror — seeded just below
      // by applyLegacyFollowUpWrite so the row and the mirror are born together.
      assignedTo: assign.assignedTo,
      contacts: contactRows,
      activities,
      status: "new",
    });

    // A follow-up supplied at create time becomes a real follow-up row (and,
    // through it, the lead's next-touch mirror).
    if (fuV.value || cleanStr(followUpNote)) {
      await applyLegacyFollowUpWrite({
        lead: enquiry,
        venueId: venue._id,
        dueAt: fuV.value || undefined,
        note: cleanStr(followUpNote).slice(0, MAXLEN.text),
        actorId: actorIdOf(req),
      });
      const fresh = await VenueEnquiry.findById(enquiry._id).select("followUpDate followUpNote").lean();
      enquiry.followUpDate = fresh.followUpDate;
      enquiry.followUpNote = fresh.followUpNote;
    }

    // S1a matchedLead: dedup NEVER blocks or reassigns (EDGE 2 — a matching
    // create keeps its own record and owner); it only surfaces the banner so
    // the caller can link the histories. Scoped to what this requester sees.
    let matchedLead;
    try {
      const match = await findDedupMatch(req.venueOwner, req.venueMember, venue._id, enquiry);
      matchedLead = matchedLeadPayload(match);
    } catch (dedupErr) {
      console.warn(`[createManualLead] dedup lookup failed: ${dedupErr.message}`);
    }

    return res.status(201).json({ success: true, enquiryId: enquiry._id, enquiry, matchedLead });
  } catch (err) {
    if (err.name === "ValidationError") return res.status(400).json({ message: err.message });
    return res.status(500).json({ message: err.message });
  }
};

// DELETE /venues/:slug/enquiries/:enquiryId — soft-delete (leads_delete gated at
// the route). Scoped resolve so a member can only delete a lead they can see;
// the row is flagged (never hard-removed) and excluded from every CRM query.
const deleteEnquiry = async (req, res) => {
  try {
    const { slug, enquiryId } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const enquiry = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, enquiryId);
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });

    // Invariant #12 — "deleting a lead releases nothing silently". A deleted
    // lead disappears from every view, but the things it was holding do not
    // disappear with it: a live hold keeps real calendar inventory blocked, and
    // linked tasks/follow-ups become orphaned work nobody owns. We deliberately
    // do NOT auto-release the hold (that would silently free a contested date
    // someone may still want) — we surface it so the caller must decide.
    const [liveHolds, openTasks, openFollowUps, booking] = await Promise.all([
      VenueHold.find({ venue: venue._id, linkedEnquiry: enquiry._id, status: { $in: ["requested", "approved"] } })
        .select("_id status dates expiresAt")
        .lean(),
      VenueTask.countDocuments({ linkedEnquiry: enquiry._id, status: "open" }),
      VenueFollowUp.countDocuments({ lead: enquiry._id, status: "open" }),
      VenueBooking.findOne({ enquiry: enquiry._id }).select("_id").lean(),
    ]);

    // A lead that already became a booking must not be deletable — the booking,
    // its payments and its blocked calendar rows would be orphaned from the
    // history that explains them.
    if (booking) {
      return res.status(409).json({
        message: "This lead has a confirmed booking — cancel the booking first",
        bookingId: booking._id,
      });
    }

    enquiry.deleted = true;
    enquiry.deletedAt = new Date();
    enquiry.deletedBy = actorIdOf(req);
    enquiry.activities.push({ type: "deleted", description: "Lead deleted", actor: actorIdOf(req), timestamp: new Date() });
    await enquiry.save();

    return res.status(200).json({
      success: true,
      // The caller shows these as explicit next actions rather than letting a
      // date stay blocked for a lead nobody can see any more.
      releasedNothing: {
        holds: liveHolds.map((h) => ({ _id: h._id, status: h.status, dates: h.dates, expiresAt: h.expiresAt })),
        openTasks,
        openFollowUps,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * BUILD2 S2 — GET /venues/:slug/enquiries/:enquiryId/window-impact?checkIn=&checkOut=
 *
 * A dry run of a window move. Read-only, changes nothing, and answers the
 * three questions the PATCH would otherwise answer only by refusing:
 *   functions — which ones the new window would strand
 *   holds     — which live holds sit on days the new window no longer covers
 *   booking   — whether a booking makes this a refusal outright
 *
 * The UI calls this while the picker is open, so the owner resolves conflicts
 * BEFORE pressing save rather than meeting a 400 afterwards. The PATCH keeps
 * every one of these checks — this endpoint is a courtesy, never the gate.
 */
const getWindowImpact = async (req, res) => {
  try {
    const { slug, enquiryId } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const enquiry = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, enquiryId);
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });

    const { checkIn, checkOut } = req.query || {};
    const win = eventWindow(checkIn, checkOut);
    if (!win.ok) return res.status(400).json({ message: win.message });

    const [booking, liveHolds] = await Promise.all([
      VenueBooking.findOne({ enquiry: enquiry._id }).select("_id status").lean(),
      VenueHold.find({ venue: venue._id, linkedEnquiry: enquiry._id, status: { $in: ["requested", "approved"] } })
        .select("_id status dates expiresAt space")
        .lean(),
    ]);

    const newDays = new Set();
    if (win.checkIn && win.checkOut) {
      for (let d = new Date(win.checkIn); d <= win.checkOut; d = addVenueDays(d, 1)) newDays.add(venueDateKey(d));
    }
    const staleHolds = liveHolds.filter((h) => (h.dates || []).some((d) => !newDays.has(venueDateKey(d))));
    const conflictingFunctions = outsideWindow(enquiry.functions, win.checkIn, win.checkOut);

    // ── what this window would do to the booking's calendar ────────────────
    // A booking no longer BLOCKS a window change — the lead's dates and the
    // booking's dates are the same thing, so the change flows to both. What
    // the caller needs to know instead is which date-spaces would be claimed,
    // which released, and whether anything already holds a day being claimed.
    let calendar;
    if (booking && win.checkIn && win.checkOut) {
      const spaces = await bookingSpaceIds(booking._id);
      const desired = desiredPairs(win.checkIn, win.checkOut, spaces);
      const current = await VenueSpaceDate.find({ bookingRef: booking._id }).select("space date").lean();
      const currentKeys = new Set(current.map((r) => pairKey(r.space, r.date)));
      const willAdd = [...desired.entries()].filter(([k]) => !currentKeys.has(k)).map(([, v]) => v);
      const willRemove = current.filter((r) => !desired.has(pairKey(r.space, r.date)));
      // Read-only: describeConflicts only looks, it never writes.
      const conflicts = willAdd.length ? await describeConflicts(venue._id, willAdd, booking._id) : [];
      calendar = {
        willAdd: willAdd.map((p) => ({ space: p.space, day: venueDateKey(p.date) })),
        willRemove: willRemove.map((r) => ({ space: r.space, day: venueDateKey(r.date) })),
        keeps: current.length - willRemove.length,
        conflicts,
      };
    }

    return res.status(200).json({
      // blocked = the PATCH would refuse no matter what the caller sends.
      // A booking is no longer one of those reasons; an unresolvable calendar
      // conflict is, because someone else genuinely holds the date.
      blocked: Boolean(calendar && calendar.conflicts.length),
      booking: booking ? { _id: booking._id, status: booking.status } : undefined,
      conflictingFunctions,
      staleHolds: staleHolds.map((h) => ({ _id: h._id, status: h.status, dates: h.dates, expiresAt: h.expiresAt, space: h.space })),
      calendar,
      // What the caller must do to make the PATCH succeed.
      requires: {
        resolveFunctions: conflictingFunctions.length > 0,
        acknowledgeStaleHolds: staleHolds.length > 0,
        resolveCalendarConflicts: Boolean(calendar && calendar.conflicts.length),
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Shared bulk-create core (reused by CSV/Excel import AND Google Sheets sync).
// Given a venueId and an array of mapped rows, dedups by couplePhone (digits-only)
// against existing venue leads and within the batch, coerces dates/numbers safely,
// defaults stage/source, and creates VenueEnquiry docs. Returns { created, skipped,
// errors:[{row, reason}] }. Bad rows are caught per-row and never abort the run.
async function importLeadRows(venueId, rows, { activityDescription = "Lead imported" } = {}) {
  // Imported / sheet-synced leads hit the same invisibility trap as inbound
  // web enquiries: unassigned means invisible to every member without
  // leads_view_all. Precedence matches the assignment contract — an explicit
  // per-row assignedTo wins, else round-robin when the venue opted in, else
  // unassigned. Round-robin is recomputed per row so a 200-row import spreads
  // across the team instead of landing entirely on one person.
  const importVenue = await Venue.findById(venueId).select("settings").lean();
  const autoAssignOn = Boolean(importVenue && importVenue.settings && importVenue.settings.autoAssignLeads);
  // S1a: dedup keys on ANY contact phone, not just the couplePhone mirror.
  // Full-digit keys (legacy behaviour) plus every contact's digits. EDGE 2
  // holds: a duplicate row is SKIPPED outright, so its assignedTo can never
  // reassign the existing owned lead.
  const existing = await VenueEnquiry.find({ venueId, deleted: { $ne: true } }).select("couplePhone contacts.phone").lean();
  const seenPhones = new Set();
  for (const e of existing) {
    const k = digitsOnly(e.couplePhone);
    if (k) seenPhones.add(k);
    for (const c of e.contacts || []) {
      const ck = digitsOnly(c.phone);
      if (ck) seenPhones.add(ck);
    }
  }

  let created = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    try {
      const coupleName = toStr(row.coupleName);
      const couplePhone = toStr(row.couplePhone);
      if (!coupleName || !couplePhone) {
        errors.push({ row: i, reason: "Missing required coupleName or couplePhone" });
        continue;
      }

      const key = digitsOnly(couplePhone);
      if (key && seenPhones.has(key)) {
        skipped += 1; // duplicate of an existing lead or an earlier row in this batch
        continue;
      }

      const sourceRaw = toStr(row.source).toLowerCase();
      const stageRaw = toStr(row.stage).toLowerCase();
      const source = sourceRaw && SOURCE_ENUM.includes(sourceRaw) ? sourceRaw : "other";
      const stage = stageRaw && STAGE_ENUM.includes(stageRaw) ? stageRaw : "new";

      const notesStr = toStr(row.notes);
      let rowAssignee = toMemberIdOrNull(toStr(row.assignedTo));
      if (rowAssignee) {
        // Keep the existing best-effort behaviour: a bad id leaves the row
        // unassigned rather than 422-ing a whole import.
        const v = await validateAssignable(venueId, rowAssignee);
        rowAssignee = v.ok ? v.id : null;
      }
      if (!rowAssignee && autoAssignOn) {
        rowAssignee = await pickRoundRobinAssignee(venueId);
      }
      await VenueEnquiry.create({
        venueId,
        name: coupleName,
        phone: couplePhone,
        coupleName,
        couplePhone,
        email: toStr(row.email),
        eventDate: toDateOrNull(row.eventDate),
        guestCount: toNumberOrNull(row.guestCount),
        source,
        stage,
        estimatedValue: toNumberOrNull(row.expectedValue) || 0, // expectedValue → estimatedValue
        notes: notesStr ? [{ text: notesStr }] : [],
        followUpDate: toDateOrNull(row.followUpDate),
        // Bulk best-effort: a valid member id (explicit or round-robin), else
        // unassigned. (The migration reconciles legacy name/id values; import
        // doesn't 422 rows.)
        assignedTo: rowAssignee || null,
        activities: [
          { type: "created", description: activityDescription, timestamp: new Date() },
          ...(rowAssignee && !toMemberIdOrNull(toStr(row.assignedTo))
            ? [{ type: "auto_assigned", description: "Auto-assigned (round-robin)", via: "round_robin", timestamp: new Date() }]
            : []),
        ],
        status: "new",
      });

      if (key) seenPhones.add(key);
      created += 1;
    } catch (rowErr) {
      errors.push({ row: i, reason: rowErr.message });
    }
  }

  return { created, skipped, errors };
}

// Bulk CSV/Excel lead import — venue owners only, ownership-checked.
// Body: { rows: [mappedRow], fileName } (also tolerates a bare array of rows).
const importLeads = async (req, res) => {
  try {
    const { slug } = req.params;
    const body = req.body || {};
    const rows = Array.isArray(body) ? body : Array.isArray(body.rows) ? body.rows : [];
    const fileName = Array.isArray(body) ? "" : toStr(body.fileName);

    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { created, skipped, errors } = await importLeadRows(venue._id, rows);

    await VenueLeadImport.create({
      venue: venue._id,
      importedBy: req.venueOwner.venueOwnerId,
      fileName,
      total: rows.length,
      created,
      skipped,
    });

    return res.status(200).json({ created, skipped, errors });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Import history for a venue (most recent first).
const getImports = async (req, res) => {
  try {
    const { slug } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const imports = await VenueLeadImport.find({ venue: venue._id })
      .sort({ createdAt: -1 })
      .lean();
    return res.status(200).json({ imports, total: imports.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { createEnquiry, createManualLead, getVenueEnquiries, getEnquiryById, deleteEnquiry, checkEnquiryExists, updateEnquiry, getWindowImpact, importLeads, getImports, importLeadRows,
  // Exported so the Confirm Booking wizard writes its client through the SAME
  // validation the People tab uses. A second sanitizer would be a second set of
  // rules about what a contact is.
};
