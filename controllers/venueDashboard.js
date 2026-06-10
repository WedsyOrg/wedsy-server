const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");

// Stages that no longer need follow-up.
const TERMINAL_STAGES = ["booked", "lost"];

// GET /venues/dashboard/overview
// Venue-owner authenticated (venueOwnerAuth) — venueId/venueOwnerId come from the token.
// Returns the dashboard-home widget payload: onboarding progress, verification
// status (read-only, derived) and follow-up counts.
const getDashboardOverview = async (req, res) => {
  try {
    const { venueId, venueOwnerId } = req.venueOwner;

    const venue = await Venue.findById(venueId)
      .select("status photos coverPhoto featurePhoto pricing contact blockedDates")
      .lean();
    if (!venue) return res.status(404).json({ message: "Venue not found" });

    const owner = await VenueOwner.findById(venueOwnerId)
      .select("verificationStatus")
      .lean();

    // ── Onboarding steps (derived live from existing Venue/Owner fields) ──
    const photos = venue.photos || {};
    const photosDone = Boolean(
      (photos.venue && photos.venue.length) ||
        (photos.decor && photos.decor.length) ||
        (photos.rooms && photos.rooms.length) ||
        (photos.spaces && photos.spaces.length) ||
        venue.coverPhoto ||
        venue.featurePhoto
    );

    const pricing = venue.pricing || {};
    const perPlate = pricing.perPlate || {};
    const pricingDone = Boolean(
      (pricing.tiers && pricing.tiers.length) ||
        perPlate.veg > 0 ||
        perPlate.nonVeg > 0
    );

    const contactDone = Boolean(venue.contact && venue.contact.whatsappPhone);

    const phoneVerified = Boolean(
      owner && ["phone_verified", "verified"].includes(owner.verificationStatus)
    );

    const availabilityDone = Boolean(venue.blockedDates && venue.blockedDates.length);

    const steps = {
      photos: photosDone,
      pricing: pricingDone,
      contact: contactDone,
      phoneVerified,
      availability: availabilityDone,
    };
    const total = 5;
    const completed = Object.values(steps).filter(Boolean).length;
    const percent = Math.round((completed / total) * 100);

    // ── Verification (read-only, derived; Wedsy OS/admin is the single writer) ──
    const isVerified = venue.status === "verified";

    // ── Follow-ups: non-terminal leads with a follow-up date due today or overdue ──
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const baseFilter = { venueId, stage: { $nin: TERMINAL_STAGES } };

    const [overdue, dueToday] = await Promise.all([
      VenueEnquiry.countDocuments({ ...baseFilter, followUpDate: { $lt: startOfToday } }),
      VenueEnquiry.countDocuments({
        ...baseFilter,
        followUpDate: { $gte: startOfToday, $lte: endOfToday },
      }),
    ]);

    return res.status(200).json({
      onboarding: { steps, completed, total, percent },
      isVerified,
      followUps: { dueToday, overdue },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getDashboardOverview };
