/**
 * controllers/venueBooking.js — Phase 3 (3.1) bookings.
 * CRUD under /venues/:slug/bookings (venueOwnerAuth + ownership).
 * Also exports createDraftBookingForEnquiry() for the booked-stage auto-create
 * hook and the quote→booking flow (idempotent: one booking per enquiry).
 */
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const { seedRunsheetForBooking } = require("../utils/venueRunsheet");

async function resolveOwnedVenue(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select("_id").lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

/**
 * Idempotently create a draft booking for an enquiry. Returns the booking doc.
 * Safe to call repeatedly (one booking per enquiry, enforced by unique index).
 */
async function createDraftBookingForEnquiry(venueId, enquiry, ownerId) {
  const existing = await VenueBooking.findOne({ enquiry: enquiry._id });
  if (existing) return existing;
  try {
    const booking = await VenueBooking.create({
      venue: venueId,
      enquiry: enquiry._id,
      coupleName: enquiry.coupleName || enquiry.name || "",
      couplePhone: enquiry.couplePhone || enquiry.phone || "",
      days: enquiry.eventDate ? [{ date: enquiry.eventDate, guestCount: enquiry.guestCount || 0 }] : [],
      totalValue: enquiry.estimatedValue || 0,
      status: "confirmed",
      createdBy: ownerId,
    });
    await seedRunsheetForBooking(booking); // default event-day skeleton per day
    return booking;
  } catch (e) {
    // Concurrent create lost the race on the unique index — return the winner.
    if (e.code === 11000) return VenueBooking.findOne({ enquiry: enquiry._id });
    throw e;
  }
}

const listBookings = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const bookings = await VenueBooking.find({ venue: venue._id }).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ bookings, total: bookings.length });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

const getBooking = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: venue._id }).lean();
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    return res.status(200).json({ booking });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

const createBooking = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const { enquiry, coupleName, couplePhone, days, totalValue, paymentSchedule, specialRequirements, status } = req.body || {};
    const booking = await VenueBooking.create({
      venue: venue._id,
      enquiry: enquiry || undefined,
      coupleName: coupleName || "",
      couplePhone: couplePhone || "",
      days: Array.isArray(days) ? days : [],
      totalValue: Number(totalValue) || 0,
      paymentSchedule: Array.isArray(paymentSchedule) ? paymentSchedule : [],
      specialRequirements: specialRequirements || "",
      status: status || "confirmed",
      createdBy: req.venueOwner.venueOwnerId,
    });
    await seedRunsheetForBooking(booking); // default event-day skeleton per day
    return res.status(201).json({ booking });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "A booking already exists for this enquiry" });
    return res.status(500).json({ message: err.message });
  }
};

const UPDATABLE = ["coupleName", "couplePhone", "days", "totalValue", "paymentSchedule", "specialRequirements", "status"];
const updateBooking = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;
    const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: venue._id });
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    for (const k of UPDATABLE) {
      if (req.body[k] !== undefined) booking[k] = req.body[k];
    }
    await booking.save();
    // Newly added days get the default runsheet skeleton (no-op for existing).
    if (req.body.days !== undefined) await seedRunsheetForBooking(booking);
    return res.status(200).json({ booking });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = {
  createDraftBookingForEnquiry,
  listBookings,
  getBooking,
  createBooking,
  updateBooking,
};
