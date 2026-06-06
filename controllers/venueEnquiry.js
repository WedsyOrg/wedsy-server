const VenueEnquiry = require("../models/VenueEnquiry");
const Venue = require("../models/Venue");
const { createOrGetConversation } = require("./venueConversation");

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

    const { stage, estimatedValue, lostReason, followUpDate, addNote } = req.body || {};

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

module.exports = { createEnquiry, createManualLead, getVenueEnquiries, updateEnquiry };
