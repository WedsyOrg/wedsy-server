const mongoose = require("mongoose");
const VenueEnquiry = require("../models/VenueEnquiry");
const Venue = require("../models/Venue");
const VenueLeadImport = require("../models/VenueLeadImport");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");
const VenueHold = require("../models/VenueHold");
const VenueConversation = require("../models/VenueConversation");
const VenueBooking = require("../models/VenueBooking");
const { createOrGetConversation } = require("./venueConversation");
const { createDraftBookingForEnquiry } = require("./venueBooking");
const { writeBackLeadToSheet } = require("../utils/venueSheetWriteBack");
const { hasCapability } = require("../utils/venueRbac");
const { resolveCreateAssignment, validateAssignable, pickRoundRobinAssignee } = require("../utils/venueLeadAssign");
const { canViewAllLeads, scopedLeadFilter, resolveScopedEnquiry } = require("../utils/venueLeadScope");

// Phase 3 lost-reason allowlist (mirrors models/VenueEnquiry.js; "" = none/legacy).
const LOST_REASON_ENUM = ["", "too_expensive", "date_unavailable", "chose_competitor", "no_response", "other"];
const { reqStr, optStr, optDate, optNumber, optCount, cleanStr, MAXLEN, eventWindow } = require("../utils/venueInput");

// The acting principal's id for audit stamps: a member id when a team member is
// logged in, otherwise the owner anchor id.
const actorIdOf = (req) => req.venueOwner.memberId || req.venueOwner.venueOwnerId || null;
const toMemberIdOrNull = (v) => (mongoose.isValidObjectId(v) ? v : null);

// Valid enum values (kept in sync with models/VenueEnquiry.js) for import coercion.
const SOURCE_ENUM = ["wedsy", "instagram", "referral", "walk_in", "justdial", "wedmegood", "google", "other"];
const STAGE_ENUM = ["new", "contacted", "site_visit_scheduled", "site_visit_done", "proposal_sent", "negotiating", "booked", "lost"];
// MB-CRM-2 S1 enums (kept in sync with models/VenueEnquiry.js).
const CONTACT_ROLE_ENUM = ["groom", "bride", "brides_father", "mother", "planner", "other"];
const FUNCTION_NAME_ENUM = ["mehendi", "haldi", "sangeet", "wedding", "reception", "custom"];
const REQ_FOOD_ENUM = ["", "veg", "nonveg", "both"];
const REQ_CATERING_ENUM = ["", "inhouse", "outside", "both"];
const MAX_CONTACTS = 20;
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

// S1a contacts[]: name-or-phone required per row, role coerced to the enum,
// EXACTLY one isPrimary in the result — first explicitly-marked wins, else the
// first contact. Empty array is allowed (legacy rows).
function sanitizeContacts(list) {
  if (!Array.isArray(list)) return { ok: false, message: "contacts must be an array" };
  if (list.length > MAX_CONTACTS) return { ok: false, message: `contacts is too long (max ${MAX_CONTACTS})` };
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i] || {};
    const name = cleanStr(c.name).slice(0, MAXLEN.name);
    const phone = cleanStr(c.phone).slice(0, MAXLEN.phone);
    if (!name && !phone) return { ok: false, message: `contacts[${i}] needs a name or phone` };
    const role = CONTACT_ROLE_ENUM.includes(c.role) ? c.role : "other";
    out.push({ name, phone, role, isPrimary: Boolean(c.isPrimary) });
  }
  if (out.length > 0) {
    const primaryIdx = out.findIndex((c) => c.isPrimary);
    out.forEach((c, i) => { c.isPrimary = i === (primaryIdx === -1 ? 0 : primaryIdx); });
  }
  return { ok: true, value: out };
}

// S1b functions[]: name from the enum (custom requires customLabel), strict
// date inside [checkIn, checkOut] when the window is set, space must be a
// bookable space of THIS venue (or absent), pax a positive count. Two
// functions on the same date are fine — different spaces is the normal case.
function sanitizeFunctions(list, venueSpaces, checkIn, checkOut) {
  if (!Array.isArray(list)) return { ok: false, message: "functions must be an array" };
  if (list.length > MAX_FUNCTIONS) return { ok: false, message: `functions is too long (max ${MAX_FUNCTIONS})` };
  const dayStart = (d) => new Date(d).setHours(0, 0, 0, 0);
  const lo = checkIn && checkOut ? dayStart(checkIn) : null;
  const hi = checkIn && checkOut ? dayStart(checkOut) : null;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i] || {};
    if (!FUNCTION_NAME_ENUM.includes(f.name)) {
      return { ok: false, message: `functions[${i}].name must be one of ${FUNCTION_NAME_ENUM.join(", ")}` };
    }
    const customLabel = cleanStr(f.customLabel).slice(0, MAXLEN.label);
    if (f.name === "custom" && !customLabel) {
      return { ok: false, message: `functions[${i}].customLabel is required for a custom function` };
    }
    const dV = optDate(f.date, `functions[${i}].date`);
    if (!dV.ok) return { ok: false, message: dV.message };
    if (!dV.value) return { ok: false, message: `functions[${i}].date is required` };
    if (lo !== null) {
      const day = dayStart(dV.value);
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
  return { ok: true, value: out };
}

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

    const venue = await Venue.findOne({ slug }).select("_id name phone status").lean();
    if (!venue) {
      return res.status(404).json({ message: "Venue not found" });
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
      coupleName: cleanStr(coupleName) || effectiveName,
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
      followUpDate: fuPub.value,
      activities: [{ type: "created", description: "Lead created", timestamp: new Date() }],
      status: "new",
    });

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
    const venue = await Venue.findOne({ slug }).select("_id spaces").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const enquiry = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, enquiryId, {
      populate: { path: "assignedTo", select: "name" },
    });
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });

    const json = enquiry.toJSON();

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

    // S1a: bidirectional dedup banner — the most recent other lead sharing any
    // contact phone, scoped to what THIS requester may see.
    const match = await findDedupMatch(req.venueOwner, req.venueMember, venue._id, json);
    json.matchedLead = matchedLeadPayload(match) || null;

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
    let contactsV = null;
    if (contacts !== undefined) {
      contactsV = sanitizeContacts(contacts);
      if (!contactsV.ok) return res.status(400).json({ message: contactsV.message });
    }
    let functionsV = null;
    if (functions !== undefined) {
      functionsV = sanitizeFunctions(functions, venue.spaces, effCheckIn, effCheckOut);
      if (!functionsV.ok) return res.status(400).json({ message: functionsV.message });
    }
    if (functions === undefined && winSent && effCheckIn && effCheckOut && (enquiry.functions || []).length) {
      const recheck = sanitizeFunctions(enquiry.functions, venue.spaces, effCheckIn, effCheckOut);
      if (!recheck.ok) {
        return res.status(400).json({ message: "the new check-in/check-out window would orphan an existing function date" });
      }
    }
    let requirementsV = null;
    if (requirements !== undefined) {
      requirementsV = sanitizeRequirements(requirements);
      if (!requirementsV.ok) return res.status(400).json({ message: requirementsV.message });
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
    if (followUpDate !== undefined) enquiry.followUpDate = fuV.value;
    if (followUpNote !== undefined) enquiry.followUpNote = cleanStr(followUpNote).slice(0, MAXLEN.text);
    // S3 profile-field edits (keep name/phone mirrors in sync with the couple
    // fields so dedup + WhatsApp keep working).
    if (coupleName !== undefined) { enquiry.coupleName = cleanStr(coupleName); enquiry.name = cleanStr(coupleName); }
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
    // MB-CRM-2 S1 writes (wholesale replace — the workbench sends full arrays).
    if (contactsV) {
      enquiry.contacts = contactsV.value;
      // Keep the legacy couple mirrors following the primary contact so dedup
      // import, WhatsApp and the legacy dashboards stay coherent.
      const primary = contactsV.value.find((c) => c.isPrimary);
      if (primary) {
        if (primary.name) { enquiry.coupleName = primary.name; enquiry.name = primary.name; }
        if (primary.phone) { enquiry.couplePhone = primary.phone; enquiry.phone = primary.phone; }
      }
    }
    if (functionsV) enquiry.functions = functionsV.value;
    if (requirementsV) {
      enquiry.requirements = { ...(enquiry.requirements ? enquiry.requirements.toObject ? enquiry.requirements.toObject() : enquiry.requirements : {}), ...requirementsV.value };
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

    return res.status(200).json({ enquiry, booking: booking ? { _id: booking._id } : undefined });
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
    } = req.body || {};

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
    // S1a: optional explicit contacts; default = one primary contact seeded
    // from the couple name+phone (the add-lead modal contract).
    let contactsV = null;
    if (contacts !== undefined) {
      contactsV = sanitizeContacts(contacts);
      if (!contactsV.ok) return res.status(400).json({ message: contactsV.message });
    }

    const venue = await Venue.findOne({ slug }).select("_id settings").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // ── Assignment contract: explicit wins → creator default → auto round-robin.
    // A member assigning to someone OTHER than themselves needs leads_reassign.
    const creatorMemberId = req.venueOwner.memberId || null;
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

    // Default contact seeding: the couple themselves, primary.
    const contactRows = contactsV
      ? contactsV.value
      : nameC || phoneC
        ? [{ name: nameC, phone: phoneC, role: "other", isPrimary: true }]
        : [];

    const enquiry = await VenueEnquiry.create({
      venueId: venue._id,
      name: nameC,
      phone: phoneC,
      coupleName: nameC,
      couplePhone: phoneC,
      email: cleanStr(email),
      eventDate: edV.value,
      checkIn: win.checkIn,
      checkOut: win.checkOut,
      guestCount: gcV.value != null ? gcV.value : null,
      message: cleanStr(message),
      budget: cleanStr(budget),
      source: source || "other",
      stage: stage || "new",
      estimatedValue: evV.value != null ? evV.value : 0,
      notes: notesArray,
      followUpDate: fuV.value,
      followUpNote: cleanStr(followUpNote).slice(0, MAXLEN.text),
      assignedTo: assign.assignedTo,
      contacts: contactRows,
      activities,
      status: "new",
    });

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
    enquiry.deleted = true;
    enquiry.deletedAt = new Date();
    enquiry.deletedBy = actorIdOf(req);
    enquiry.activities.push({ type: "deleted", description: "Lead deleted", actor: actorIdOf(req), timestamp: new Date() });
    await enquiry.save();
    return res.status(200).json({ success: true });
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
        // Bulk best-effort: keep a valid member id, else leave unassigned. (The
        // migration reconciles legacy name/id values; import doesn't 422 rows.)
        assignedTo: toMemberIdOrNull(toStr(row.assignedTo)),
        activities: [{ type: "created", description: activityDescription, timestamp: new Date() }],
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

module.exports = { createEnquiry, createManualLead, getVenueEnquiries, getEnquiryById, deleteEnquiry, checkEnquiryExists, updateEnquiry, importLeads, getImports, importLeadRows };
