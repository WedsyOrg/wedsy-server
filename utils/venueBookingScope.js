/**
 * utils/venueBookingScope.js — a booking-keyed read is still a LEAD read.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * Room allotments and the runsheet are keyed by booking id, and both
 * controllers resolved nothing but the VENUE: `resolveOwnedVenue` followed by
 * `{ venue: venue._id, booking: req.params.bookingId }`. Twelve handlers, none
 * of them touching venueLeadScope.
 *
 * That meant a member who cannot see a lead could still read and write its room
 * plan and its per-day runsheet — the guest names, the room numbers, the whole
 * event schedule — by knowing a booking id. Every other lead-attached surface
 * (payments, invoices, documents) goes through resolveScopedEnquiry; these two
 * never did.
 *
 * It mattered less while they lived on a separate /dashboard page that a
 * restricted member had little reason to visit. Moving Event Ops onto the lead
 * makes it a lead surface in the product as well as in the data, and the
 * invariant is that every lead read is scoped.
 *
 * ── WHY NOT LEAD-SCOPED ALIASES ─────────────────────────────────────────────
 * The alternative was a second set of routes under /enquiries/:id/... that the
 * new tab would call. That is two URLs for one resource — the duplication this
 * whole merge exists to remove — and, worse, it would leave the booking-keyed
 * originals exactly as unscoped as they are now. Fixing the routes that already
 * exist closes the hole for every caller, including the ones written before
 * this change.
 *
 * ── BOOKINGS WITH NO LEAD ───────────────────────────────────────────────────
 * A booking created directly (controllers/venueBooking.createBooking) can have
 * no `enquiry`. There is no lead to scope by, so those stay venue-scoped —
 * refusing them would break a path that works today, and there is no lead whose
 * visibility could be consulted.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const { resolveScopedEnquiry } = require("./venueLeadScope");

/**
 * Venue + booking, with the booking's lead checked against the caller's scope.
 *
 * Responds and returns null on every failure, so callers keep the shape they
 * already use: `const owned = await resolveScopedBooking(req, res); if (!owned) return;`
 *
 * A miss is 404, never 403 — the same rule as every other lead read. Telling a
 * member "forbidden" would confirm the booking exists.
 */
async function resolveScopedBooking(req, res, select = "_id") {
  const venue = await Venue.findOne({ slug: req.params.slug }).select(select).lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (!mongoose.isValidObjectId(req.params.bookingId)) {
    res.status(404).json({ message: "Booking not found" });
    return null;
  }
  const booking = await VenueBooking.findOne({ _id: req.params.bookingId, venue: venue._id })
    .select("_id enquiry status days checkIn checkOut coupleName roomsRequired")
    .lean();
  if (!booking) { res.status(404).json({ message: "Booking not found" }); return null; }

  if (booking.enquiry) {
    const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, booking.enquiry);
    if (!lead) { res.status(404).json({ message: "Booking not found" }); return null; }
    return { venue, booking, lead };
  }
  // Unlinked booking: nothing to scope by. Venue ownership is the whole check.
  return { venue, booking, lead: null };
}

/**
 * Is this booking inside the caller's lead scope?
 *
 * For the ITEM-keyed routes — /allotments/:allotmentId, /runsheet/:itemId —
 * which resolve their row by { _id, venue } and only then learn which booking
 * it belongs to. They are not a different KIND of surface from the
 * booking-keyed ones: the row carries `booking`, the booking carries `enquiry`,
 * so the same lead is one hop away and the same member could reach the same
 * guest names by holding an item id instead of a booking id. Leaving them out
 * would have been a documented hole rather than a real distinction.
 *
 * @returns true when the caller may see it (including when there is no linked
 *          lead to scope by — see the note at the top of this file).
 */
async function bookingInScope(req, venueId, bookingId) {
  if (!bookingId) return true; // item not attached to a booking: venue scope is all there is
  const booking = await VenueBooking.findOne({ _id: bookingId, venue: venueId }).select("enquiry").lean();
  if (!booking) return false;
  if (!booking.enquiry) return true; // unlinked booking, as above
  const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venueId, booking.enquiry);
  return Boolean(lead);
}

/**
 * Is this invoice inside the caller's lead scope?
 *
 * Invoices are keyed by their own id on /invoices/:invoiceId/payments…, and
 * those handlers resolved by venue alone. addPayment was a live hole: any
 * member with bookings_money could add a payment entry to an invoice on a lead
 * they cannot see, by knowing an id.
 *
 * approve/reject were NOT a live hole — their 403 is isOwnerActor, a ROLE gate,
 * and an owner sees every lead anyway. They are scoped here regardless, because
 * leaving one resolver family half-scoped is how the next person assumes the
 * whole family is safe.
 *
 * `booking` is required on every invoice, so the hop always exists; `enquiry`
 * is set only by the lead-raised path, and is preferred when present because it
 * is the direct answer.
 */
async function invoiceInScope(req, venueId, invoice) {
  if (!invoice) return false;
  if (invoice.enquiry) {
    const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venueId, invoice.enquiry);
    return Boolean(lead);
  }
  return bookingInScope(req, venueId, invoice.booking);
}

module.exports = { resolveScopedBooking, bookingInScope, invoiceInScope };
