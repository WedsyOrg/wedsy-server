/**
 * controllers/venuePayment.js — Phase 3 (3.4) payments summary.
 * GET /venues/:slug/payments/summary (venueOwnerAuth + ownership).
 */
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");
const { summarizeSchedule, overdueSentence } = require("../utils/venuePaymentStatus");

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

    // ── THE INVOICE LEDGER IS NOT THE MONEY ─────────────────────────────────
    // This used to compute `received` per booking by summing approved payments
    // across that booking's INVOICES. That is a second derivation of the same
    // fact, and it disagreed with the lead the moment a payment was recorded
    // against the schedule without an invoice being raised — which is the
    // normal case. The result was a Payments page reporting "Rs. 0 received"
    // beside an overdue line, IN THE SAME RESPONSE, that named Rs. 2,51,000 as
    // already received against the very same instalment.
    //
    // Received and balance now come from summarizeSchedule, like every other
    // surface. The invoice scan below survives only to build the owner's
    // approval queue, which is a property of the invoice ledger and not a
    // statement about how much money has arrived.
    let pendingApproval = 0;
    const pendingEntries = [];
    for (const inv of invoices) {
      for (const p of inv.payments || []) {
        const st = p.status || "approved";
        if (st === "pending_approval") {
          pendingApproval += Number(p.amount) || 0;
          pendingEntries.push({
            invoiceId: inv._id,
            invoiceNumber: inv.invoiceNumber,
            bookingId: inv.booking,
            paymentId: p._id,
            amount: Number(p.amount) || 0,
            mode: p.mode,
            date: p.date,
            recordedByName: p.recordedByName,
            collectedBy: p.collectedBy,
            proofUrl: p.proofUrl,
          });
        }
      }
      // (no receivedByBooking: the schedule is the source of received money)
    }

    const now = new Date();
    const perBooking = [];
    const overdue = [];
    let confirmedValue = 0;
    let received = 0;

    for (const b of bookings) {
      // ONE derivation, computed once and used for both the per-booking figures
      // and the overdue list below, so the two cannot disagree with each other.
      const s = summarizeSchedule(b, now);
      const totalValue = s.totals.bookingValue;
      const recv = s.totals.received;
      const balance = s.totals.balance;
      confirmedValue += totalValue;
      received += recv;
      perBooking.push({
        bookingId: b._id,
        coupleName: b.coupleName,
        totalValue,
        received: recv,
        balance,
        // Claimed but unapproved, shown beside the balance rather than inside
        // it — an owner chasing a late instalment has to know money was offered.
        pending: s.totals.pending,
      });

      // S4: overdue is derived per INSTALMENT, not from the booking's balance.
      //
      // It used to flag every past-due row whenever the booking owed anything at
      // all, which meant a booking with one late instalment and three future ones
      // reported all four, and an instalment that HAD been paid still showed as
      // overdue because the booking balance was non-zero. Neither told an owner
      // what to chase.
      //
      // summarizeSchedule reads paidAmount per row, so this now names the
      // instalment, its due date, what is still outstanding on it, and how many
      // days late it is — the same sentence the lead and Today show, from the
      // same derivation.
      for (const m of s.overdue) {
        overdue.push({
          bookingId: b._id,
          coupleName: b.coupleName,
          milestoneId: m._id,
          label: m.label,
          dueDate: m.dueDate,
          amount: m.amount,
          outstanding: m.outstanding,
          paidAmount: m.paidAmount,
          daysLate: m.daysLate,
          sentence: overdueSentence(m),
        });
      }
    }

    return res.status(200).json({
      perBooking,
      totals: { confirmedValue, received, pending: confirmedValue - received, pendingApproval },
      pendingEntries,
      overdue,
    });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { summary };
