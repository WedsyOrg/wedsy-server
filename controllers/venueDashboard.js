const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");
const VenueRoomAllotment = require("../models/VenueRoomAllotment");
const VenueRunsheetItem = require("../models/VenueRunsheetItem");

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
    const baseFilter = { venueId, deleted: { $ne: true }, stage: { $nin: TERMINAL_STAGES } };

    const [overdue, dueToday] = await Promise.all([
      VenueEnquiry.countDocuments({ ...baseFilter, followUpDate: { $lt: startOfToday } }),
      VenueEnquiry.countDocuments({
        ...baseFilter,
        followUpDate: { $gte: startOfToday, $lte: endOfToday },
      }),
    ]);

    // ── Revenue (Phase 3.4): confirmed vs received vs pending ──
    const [bookings, invoices] = await Promise.all([
      VenueBooking.find({ venue: venueId, status: { $ne: "cancelled" } }).select("totalValue").lean(),
      VenueInvoice.find({ venue: venueId }).select("payments").lean(),
    ]);
    const confirmedValue = bookings.reduce((s, b) => s + (Number(b.totalValue) || 0), 0);
    const received = invoices.reduce(
      (s, inv) => s + (inv.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0),
      0
    );
    const revenue = { confirmedValue, received, pending: confirmedValue - received };

    // ── Today (Phase 5 PMS): expected check-ins/outs + runsheet items due ──
    // UTC day window to match the allotment/runsheet day quantisation.
    const utcDayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const utcDayEnd = new Date(utcDayStart.getTime() + 86400000);
    // "Quote accepted — confirm booking" (D8 review add): accepted quotes
    // whose enquiry has no booking yet. Public acceptance never auto-books,
    // so this card is the owner's unmissable next action.
    const VenueQuote = require("../models/VenueQuote");
    const acceptedQuotes = await VenueQuote.find({ venue: venueId, status: "accepted" })
      .sort({ updatedAt: -1 })
      .limit(50)
      .populate("enquiry", "coupleName couplePhone")
      .lean();
    const enquiryIds = acceptedQuotes.map((q) => q.enquiry && q.enquiry._id).filter(Boolean);
    const bookedEnquiries = new Set(
      (await VenueBooking.find({ venue: venueId, enquiry: { $in: enquiryIds } }).select("enquiry").lean())
        .map((b) => String(b.enquiry))
    );
    const quotesAwaitingBooking = acceptedQuotes
      .filter((q) => q.enquiry && !bookedEnquiries.has(String(q.enquiry._id)))
      .map((q) => ({
        quoteId: q._id,
        enquiryId: q.enquiry._id,
        coupleName: q.enquiry.coupleName || "",
        grandTotal: (q.totals && q.totals.grandTotal) || 0,
        acceptedAt: (q.acceptance && q.acceptance.at) || q.updatedAt,
        acceptedBy: (q.acceptance && q.acceptance.name) || "",
      }));

    const [checkInsToday, checkOutsToday, runsheetDueToday] = await Promise.all([
      VenueRoomAllotment.countDocuments({
        venue: venueId,
        status: "allotted",
        checkInAt: { $gte: utcDayStart, $lt: utcDayEnd },
      }),
      VenueRoomAllotment.countDocuments({
        venue: venueId,
        status: "checked_in",
        checkOutAt: { $gte: utcDayStart, $lt: utcDayEnd },
      }),
      VenueRunsheetItem.countDocuments({
        venue: venueId,
        day: utcDayStart,
        status: { $ne: "done" },
      }),
    ]);

    return res.status(200).json({
      onboarding: { steps, completed, total, percent },
      isVerified,
      followUps: { dueToday, overdue },
      revenue,
      today: { checkIns: checkInsToday, checkOuts: checkOutsToday, runsheetDue: runsheetDueToday },
      actionNeeded: { quotesAwaitingBooking, quotesAwaitingBookingCount: quotesAwaitingBooking.length },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getDashboardOverview };
