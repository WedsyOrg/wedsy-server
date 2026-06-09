const VenueEnquiry = require("../models/VenueEnquiry");
const Venue = require("../models/Venue");
const VenueLeadImport = require("../models/VenueLeadImport");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");
const { createOrGetConversation } = require("./venueConversation");

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

    const effectiveName = coupleName || name;
    const effectivePhone = couplePhone || phone;

    if (!effectiveName || !effectivePhone) {
      return res.status(400).json({ message: "Name and phone are required" });
    }

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
      coupleName: coupleName || effectiveName,
      couplePhone: couplePhone || effectivePhone,
      email: email || "",
      eventDate: eventDate || null,
      guestCount: guestCount || null,
      budget: budget || "",
      vibe: vibe || [],
      message: message || "",
      source: source || "wedsy",
      stage: "new", // forced server-side; client cannot set stage on the public endpoint
      estimatedValue: estimatedValue || 0,
      notes: notesArray,
      followUpDate: followUpDate || null,
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

    if (stage !== undefined && stage !== enquiry.stage) {
      enquiry.activities.push({
        type: "stage_changed",
        description: `Stage changed from ${enquiry.stage} to ${stage}`,
        timestamp: new Date(),
      });
      enquiry.stage = stage;
    }
    if (estimatedValue !== undefined) enquiry.estimatedValue = estimatedValue;
    if (lostReason !== undefined) enquiry.lostReason = lostReason;
    if (followUpDate !== undefined) enquiry.followUpDate = followUpDate || null;
    // assignedTo stays a String holding a VenueTeamMember._id (so OS can read/resolve
    // it); not converted to an ObjectId ref yet. Empty = unassigned.
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
    return res.status(200).json({ enquiry });
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

    if (!coupleName && !couplePhone) {
      return res.status(400).json({ message: "Couple name or phone is required" });
    }

    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
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
      name: coupleName || "",
      phone: couplePhone || "",
      coupleName: coupleName || "",
      couplePhone: couplePhone || "",
      email: email || "",
      eventDate: eventDate || null,
      guestCount: guestCount || null,
      message: message || "",
      source: source || "other",
      stage: stage || "new",
      estimatedValue: estimatedValue || 0,
      notes: notesArray,
      followUpDate: followUpDate || null,
      assignedTo: assignedTo || "",
      activities: [{ type: "created", description: "Lead added manually", timestamp: new Date() }],
      status: "new",
    });

    return res.status(201).json({ success: true, enquiryId: enquiry._id, enquiry });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Bulk CSV/Excel lead import — venue owners only, ownership-checked.
// Body: { rows: [mappedRow], fileName } (also tolerates a bare array of rows).
// Per row: require coupleName + couplePhone; dedup by couplePhone within the venue
// (and within the batch); coerce dates/numbers safely; default stage/source.
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

    // Existing phones for this venue → dedup set (digits-only). Batch dups added as we go.
    const existing = await VenueEnquiry.find({ venueId: venue._id }).select("couplePhone").lean();
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
          skipped += 1; // duplicate of an existing lead or an earlier row in this file
          continue;
        }

        const sourceRaw = toStr(row.source).toLowerCase();
        const stageRaw = toStr(row.stage).toLowerCase();
        const source = sourceRaw && SOURCE_ENUM.includes(sourceRaw) ? sourceRaw : "other";
        const stage = stageRaw && STAGE_ENUM.includes(stageRaw) ? stageRaw : "new";

        const notesStr = toStr(row.notes);
        await VenueEnquiry.create({
          venueId: venue._id,
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
          activities: [{ type: "created", description: "Lead imported", timestamp: new Date() }],
          status: "new",
        });

        if (key) seenPhones.add(key);
        created += 1;
      } catch (rowErr) {
        errors.push({ row: i, reason: rowErr.message });
      }
    }

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

module.exports = { createEnquiry, createManualLead, getVenueEnquiries, updateEnquiry, importLeads, getImports };
