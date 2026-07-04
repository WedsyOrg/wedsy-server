const VenueEnquiry = require("../models/VenueEnquiry");
const Venue = require("../models/Venue");
const VenueLeadImport = require("../models/VenueLeadImport");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");
const { createOrGetConversation } = require("./venueConversation");
const { createDraftBookingForEnquiry } = require("./venueBooking");
const { writeBackLeadToSheet } = require("../utils/venueSheetWriteBack");

// Phase 3 lost-reason allowlist (mirrors models/VenueEnquiry.js; "" = none/legacy).
const LOST_REASON_ENUM = ["", "too_expensive", "date_unavailable", "chose_competitor", "no_response", "other"];
const { reqStr, optStr, optDate, optNumber, optCount, cleanStr, MAXLEN } = require("../utils/venueInput");

// Valid enum values (kept in sync with models/VenueEnquiry.js) for import coercion.
const SOURCE_ENUM = ["wedsy", "instagram", "referral", "walk_in", "justdial", "wedmegood", "google", "other"];
const STAGE_ENUM = ["new", "contacted", "site_visit_scheduled", "site_visit_done", "proposal_sent", "negotiating", "booked", "lost"];

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
    const enquiries = await VenueEnquiry.find({ venueId: venue._id })
      .sort({ createdAt: -1 })
      .lean();
    return res.status(200).json({ enquiries, total: enquiries.length });
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
    // Anchor the regex to the last 10 digits; the stored value may carry a
    // country code or formatting, so match the canonical suffix.
    const candidates = await VenueEnquiry.find({ venueId: venue._id })
      .select("coupleName name couplePhone stage createdAt")
      .sort({ createdAt: -1 })
      .lean();
    const match = candidates.find((e) => last10(e.couplePhone) === key);
    if (!match) return res.status(200).json({ exists: false });
    return res.status(200).json({
      exists: true,
      lead: {
        _id: match._id,
        name: match.coupleName || match.name || "Lead",
        stage: match.stage,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const updateEnquiry = async (req, res) => {
  try {
    const { slug, enquiryId } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const enquiry = await VenueEnquiry.findOne({ _id: enquiryId, venueId: venue._id });
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });

    const { stage, estimatedValue, lostReason, followUpDate, addNote, assignedTo } = req.body || {};

    if (lostReason !== undefined && !LOST_REASON_ENUM.includes(lostReason)) {
      return res.status(400).json({ message: `lostReason must be one of ${LOST_REASON_ENUM.filter(Boolean).join(", ")}` });
    }
    if (stage !== undefined && !STAGE_ENUM.includes(stage)) {
      return res.status(400).json({ message: `stage must be one of ${STAGE_ENUM.join(", ")}` });
    }
    const evV = optNumber(estimatedValue, "estimatedValue"); if (!evV.ok) return res.status(400).json({ message: evV.message });
    const fuV = optDate(followUpDate, "followUpDate"); if (!fuV.ok) return res.status(400).json({ message: fuV.message });

    let movedToBooked = false;
    let stageChanged = false;
    if (stage !== undefined && stage !== enquiry.stage) {
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
    // assignedTo: a String holding a VenueTeamMember._id (so OS can read/resolve it);
    // not an ObjectId ref yet. Empty = unassigned. (Harness caught it was dropped.)
    if (assignedTo !== undefined) {
      enquiry.assignedTo = assignedTo ? String(assignedTo) : "";
      enquiry.activities.push({
        type: "assigned",
        description: assignedTo ? "Lead assigned" : "Lead unassigned",
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
      guestCount,
      message,
      source,
      stage,
      estimatedValue,
      notes,
      followUpDate,
      assignedTo,
    } = req.body || {};

    const nameC = cleanStr(coupleName);
    const phoneC = cleanStr(couplePhone);
    if (!nameC && !phoneC) {
      return res.status(400).json({ message: "Couple name or phone is required" });
    }
    // Hostile-input validation (length caps, strict dates, non-negative numbers).
    for (const [v, f, max] of [[coupleName, "coupleName", MAXLEN.name], [couplePhone, "couplePhone", MAXLEN.phone], [email, "email", MAXLEN.email], [message, "message", MAXLEN.text]]) {
      const r = optStr(v, f, max);
      if (!r.ok) return res.status(400).json({ message: r.message });
    }
    const edV = optDate(eventDate, "eventDate"); if (!edV.ok) return res.status(400).json({ message: edV.message });
    const fuV = optDate(followUpDate, "followUpDate"); if (!fuV.ok) return res.status(400).json({ message: fuV.message });
    const gcV = optCount(guestCount, "guestCount"); if (!gcV.ok) return res.status(400).json({ message: gcV.message });
    const evV = optNumber(estimatedValue, "estimatedValue"); if (!evV.ok) return res.status(400).json({ message: evV.message });

    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
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

    const enquiry = await VenueEnquiry.create({
      venueId: venue._id,
      name: nameC,
      phone: phoneC,
      coupleName: nameC,
      couplePhone: phoneC,
      email: cleanStr(email),
      eventDate: edV.value,
      guestCount: gcV.value != null ? gcV.value : null,
      message: cleanStr(message),
      source: source || "other",
      stage: stage || "new",
      estimatedValue: evV.value != null ? evV.value : 0,
      notes: notesArray,
      followUpDate: fuV.value,
      assignedTo: cleanStr(assignedTo),
      activities: [{ type: "created", description: "Lead added manually", timestamp: new Date() }],
      status: "new",
    });

    return res.status(201).json({ success: true, enquiryId: enquiry._id, enquiry });
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
  const existing = await VenueEnquiry.find({ venueId }).select("couplePhone").lean();
  const seenPhones = new Set(existing.map((e) => digitsOnly(e.couplePhone)).filter(Boolean));

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
        assignedTo: toStr(row.assignedTo),
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

module.exports = { createEnquiry, createManualLead, getVenueEnquiries, checkEnquiryExists, updateEnquiry, importLeads, getImports, importLeadRows };
