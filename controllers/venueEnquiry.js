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
      eventDate,
      guestCount,
      budget,
      vibe,
      message,
      source,
      stage,
      estimatedValue,
      notes,
      userId: bodyUserId,
    } = req.body;

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
      eventDate: eventDate || null,
      guestCount: guestCount || null,
      budget: budget || "",
      vibe: vibe || [],
      message: message || "",
      source: source || "wedsy",
      stage: stage || "new",
      estimatedValue: estimatedValue || 0,
      notes: notesArray,
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

module.exports = { createEnquiry, getVenueEnquiries, updateEnquiry };
