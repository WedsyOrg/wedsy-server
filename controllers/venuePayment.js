/**
 * controllers/venuePayment.js — Phase 3 (3.4) payments summary.
 * GET /venues/:slug/payments/summary (venueOwnerAuth + ownership).
 */
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");

async function resolveOwnedVenue(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select("_id").lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) { res.status(403).json({ message: "Forbidden" }); return null; }
  return venue;
}

const summary = async (req, res) => {
  try {
    const venue = await resolveOwnedVenue(req, res);
    if (!venue) return;

    const bookings = await VenueBooking.find({ venue: venue._id, status: { $ne: "cancelled" } }).lean();
    const invoices = await VenueInvoice.find({ venue: venue._id }).lean();

    // Received per booking = sum of all payments across that booking's invoices.
    const receivedByBooking = {};
    for (const inv of invoices) {
      const key = String(inv.booking);
      const paid = (inv.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
      receivedByBooking[key] = (receivedByBooking[key] || 0) + paid;
    }

    const now = new Date();
    const perBooking = [];
    const overdue = [];
    let confirmedValue = 0;
    let received = 0;

    for (const b of bookings) {
      const totalValue = Number(b.totalValue) || 0;
      const recv = receivedByBooking[String(b._id)] || 0;
      const balance = totalValue - recv;
      confirmedValue += totalValue;
      received += recv;
      perBooking.push({ bookingId: b._id, coupleName: b.coupleName, totalValue, received: recv, balance });

      for (const item of b.paymentSchedule || []) {
        if (item.dueDate && new Date(item.dueDate) < now && balance > 0) {
          overdue.push({
            bookingId: b._id,
            coupleName: b.coupleName,
            label: item.label,
            dueDate: item.dueDate,
            amount: Number(item.amount) || 0,
          });
        }
      }
    }

    return res.status(200).json({
      perBooking,
      totals: { confirmedValue, received, pending: confirmedValue - received },
      overdue,
    });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { summary };
