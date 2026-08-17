/**
 * controllers/venueLeadPayment.js — S4: record a payment as it arrives.
 *
 * The owner marks a milestone paid (amount, date, method, reference) and the
 * balance updates everywhere it is shown. "Everywhere" is achieved by having
 * nowhere compute it: the lead, Today and venuePayment.summary all read
 * utils/venuePaymentStatus, so they cannot disagree.
 *
 * PARTIAL PAYMENT IS ALLOWED — see the reasoning in utils/venuePaymentStatus.
 * In short: refusing it pushes owners into editing the milestone amount down,
 * which destroys the agreed schedule, which is the record that matters in a
 * dispute. A partial keeps the original amount and records what arrived.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const VenueTeamMember = require("../models/VenueTeamMember");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { cleanStr } = require("../utils/venueInput");
const { summarizeSchedule, describeMilestone } = require("../utils/venuePaymentStatus");

const MODES = ["bank_transfer", "cash", "cheque", "upi", "card"];
const MAX_REF = 120;

async function resolveOwnedLead(req, res) {
  const venue = await Venue.findOne({ slug: req.params.slug }).select("_id slug").lean();
  if (!venue) { res.status(404).json({ message: "Venue not found" }); return null; }
  if (String(venue._id) !== String(req.venueOwner.venueId)) {
    res.status(404).json({ message: "Venue not found" });
    return null;
  }
  if (!mongoose.isValidObjectId(req.params.enquiryId)) {
    res.status(404).json({ message: "Lead not found" });
    return null;
  }
  const lead = await resolveScopedEnquiry(req.venueOwner, req.venueMember, venue._id, req.params.enquiryId);
  if (!lead) { res.status(404).json({ message: "Lead not found" }); return null; }
  return { venue, lead };
}

const actorId = (req) => (req.venueOwner && (req.venueOwner.memberId || req.venueOwner.venueOwnerId)) || null;
async function actorName(req) {
  if (req.admin) return "Wedsy admin";
  const o = req.venueOwner || {};
  if (o.memberId) {
    const m = await VenueTeamMember.findById(o.memberId).select("name").lean();
    return (m && m.name) || "team member";
  }
  return o.name || "Owner";
}

// ── GET /venues/:slug/enquiries/:enquiryId/payments ─────────────────────────
// The schedule as it stands, with balance and overdue already derived so the UI
// renders rather than calculates.
const getLeadPayments = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const booking = await VenueBooking.findOne({ enquiry: owned.lead._id }).lean();
    if (!booking) {
      return res.status(200).json({ hasBooking: false, rows: [], totals: null, overdue: [], next: null });
    }
    const s = summarizeSchedule(booking);
    return res.status(200).json({
      hasBooking: true,
      bookingId: booking._id,
      rows: s.rows,
      totals: s.totals,
      overdue: s.overdue,
      overdueTotal: s.overdueTotal,
      next: s.next,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── POST /venues/:slug/enquiries/:enquiryId/payments ────────────────────────
// Body: { milestoneId, amount, paidAt?, mode?, reference? }
const recordPayment = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { lead } = owned;
    const body = req.body || {};

    const booking = await VenueBooking.findOne({ enquiry: lead._id });
    if (!booking) {
      return res.status(400).json({ message: "This lead has no confirmed booking yet.", code: "no_booking" });
    }
    if (!mongoose.isValidObjectId(body.milestoneId)) {
      return res.status(400).json({ message: "milestoneId is required" });
    }
    const row = booking.paymentSchedule.id(body.milestoneId);
    if (!row) return res.status(404).json({ message: "That instalment is not on this booking" });

    const amount = Math.round(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: "A payment amount is required" });
    }
    const already = Math.round(Number(row.paidAmount) || 0);
    const due = Math.round(Number(row.amount) || 0);
    // Refuse MORE than the instalment is worth. Overpaying a milestone is
    // almost always a typo, and silently accepting it would make the booking
    // balance smaller than the couple actually owes — the one error direction
    // nobody notices until it is too late.
    if (due > 0 && already + amount > due) {
      return res.status(400).json({
        message: `That is more than this instalment needs. Rs. ${(due - already).toLocaleString("en-IN")} is outstanding on it.`,
        code: "overpays_milestone",
        outstanding: due - already,
      });
    }

    const mode = MODES.includes(String(body.mode || "").trim()) ? String(body.mode).trim() : "";
    const reference = cleanStr(body.reference).slice(0, MAX_REF);
    let paidAt = new Date();
    if (body.paidAt) {
      const d = new Date(body.paidAt);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "paidAt is not a valid date" });
      paidAt = d;
    }

    row.paidAmount = already + amount;
    row.paidAt = paidAt;
    if (mode) row.paidMode = mode;
    if (reference) row.paidReference = reference;
    row.recordedBy = actorId(req);
    row.recordedByName = await actorName(req);
    await booking.save();

    const described = describeMilestone(row);
    const s = summarizeSchedule(booking);

    lead.activities.push({
      type: "payment_recorded",
      description:
        `Payment received: Rs. ${amount.toLocaleString("en-IN")} against ${row.label || "an instalment"}` +
        `${mode ? ` by ${mode.replace(/_/g, " ")}` : ""}${reference ? ` (${reference})` : ""}` +
        `${described.status === "paid" ? "" : ` — Rs. ${described.outstanding.toLocaleString("en-IN")} still outstanding on it`}`,
      actor: actorId(req),
      timestamp: new Date(),
    });
    await lead.save();

    return res.status(200).json({
      success: true,
      milestone: described,
      // The whole schedule comes back so the caller re-renders from one source
      // rather than patching a row and recomputing the balance itself.
      rows: s.rows,
      totals: s.totals,
      overdue: s.overdue,
      overdueTotal: s.overdueTotal,
      next: s.next,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getLeadPayments, recordPayment, MODES };
