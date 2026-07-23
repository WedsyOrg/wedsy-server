const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");
const { optDate, cleanStr, MAXLEN } = require("../utils/venueInput");

const INTERACTION_TYPES = ["call", "whatsapp", "email", "site_visit", "meeting", "enquiry", "note"];

// S0e quick-log: the one-tap touches and where each auto-advances the pipeline.
// Only ever moves FORWARD (never past the current stage) and never off a
// terminal stage. "note" records without advancing.
const QUICK_LOG_TYPES = ["call", "whatsapp", "site_visit", "note"];
const STAGE_ORDER = ["new", "contacted", "site_visit_scheduled", "site_visit_done", "proposal_sent", "negotiating", "booked", "lost"];
const QUICK_LOG_ADVANCE = { call: "contacted", whatsapp: "contacted", site_visit: "site_visit_done" };

// Resolve the venue from the slug and confirm the authenticated owner owns it and that
// the enquiry belongs to that venue. Returns { venue, enquiry } or sends the response.
async function resolveOwnedEnquiry(req, res) {
  const { slug, enquiryId } = req.params;
  const venue = await Venue.findOne({ slug }).select("_id").lean();
  if (!venue) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  const enquiry = await VenueEnquiry.findOne({ _id: enquiryId, venueId: venue._id })
    .select("_id")
    .lean();
  if (!enquiry) {
    res.status(404).json({ message: "Enquiry not found" });
    return null;
  }
  return { venue, enquiry };
}

// POST /venues/:slug/enquiries/:enquiryId/interactions
const addInteraction = async (req, res) => {
  try {
    const owned = await resolveOwnedEnquiry(req, res);
    if (!owned) return;

    const { type, note } = req.body || {};
    if (!type || !INTERACTION_TYPES.includes(type)) {
      return res.status(400).json({ message: "Invalid or missing interaction type" });
    }

    const interaction = await VenueLeadInteraction.create({
      enquiry: owned.enquiry._id,
      venue: owned.venue._id,
      type,
      note: typeof note === "string" ? note.trim() : "",
      createdBy: req.venueOwner.venueOwnerId,
    });

    return res.status(201).json({ interaction });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /venues/:slug/enquiries/:enquiryId/interactions — timeline, newest first.
const getInteractions = async (req, res) => {
  try {
    const owned = await resolveOwnedEnquiry(req, res);
    if (!owned) return;

    const interactions = await VenueLeadInteraction.find({ enquiry: owned.enquiry._id })
      .sort({ createdAt: -1 })
      .populate("createdBy", "name")
      .lean();

    return res.status(200).json({ interactions, total: interactions.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /venues/:slug/enquiries/:enquiryId/quick-log
// Body: { type: call|whatsapp|site_visit|note, note?, followUpDate?, followUpNote?, advanceStage? }
// One tap: writes the interaction, auto-advances the stage (unless
// advanceStage === false or it would move backward / off a terminal stage), and
// captures the next follow-up. Returns the updated lead so the UI can prompt
// "when's the next touch?".
const quickLog = async (req, res) => {
  try {
    const { slug, enquiryId } = req.params;
    const venue = await Venue.findOne({ slug }).select("_id").lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });
    if (String(venue._id) !== String(req.venueOwner.venueId)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const enquiry = await VenueEnquiry.findOne({ _id: enquiryId, venueId: venue._id });
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });

    const { type, note, followUpDate, followUpNote, advanceStage } = req.body || {};
    if (!type || !QUICK_LOG_TYPES.includes(type)) {
      return res.status(400).json({ message: `type must be one of ${QUICK_LOG_TYPES.join(", ")}` });
    }
    const fu = optDate(followUpDate, "followUpDate");
    if (!fu.ok) return res.status(400).json({ message: fu.message });

    const noteText = typeof note === "string" ? note.trim().slice(0, MAXLEN.text) : "";
    const interaction = await VenueLeadInteraction.create({
      enquiry: enquiry._id,
      venue: venue._id,
      type,
      note: noteText,
      createdBy: req.venueOwner.venueOwnerId,
    });

    // Auto-advance (forward-only, non-terminal), unless the caller overrides.
    let advancedTo = null;
    const target = QUICK_LOG_ADVANCE[type];
    const cur = STAGE_ORDER.indexOf(enquiry.stage);
    const terminal = enquiry.stage === "booked" || enquiry.stage === "lost";
    if (advanceStage !== false && target && !terminal && STAGE_ORDER.indexOf(target) > cur) {
      enquiry.activities.push({
        type: "stage_changed",
        description: `Stage advanced to ${target} (${type} logged)`,
        timestamp: new Date(),
      });
      enquiry.stage = target;
      advancedTo = target;
    }

    // Capture the next follow-up in the same tap (a lead with no next step is
    // the most dangerous object in the system).
    if (followUpDate !== undefined) enquiry.followUpDate = fu.value;
    if (followUpNote !== undefined) enquiry.followUpNote = cleanStr(followUpNote).slice(0, MAXLEN.text);
    enquiry.activities.push({ type: "quick_log", description: `Logged ${type}`, timestamp: new Date() });

    await enquiry.save();
    return res.status(201).json({ interaction, enquiry: enquiry.toJSON(), advancedTo });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { addInteraction, getInteractions, quickLog };
