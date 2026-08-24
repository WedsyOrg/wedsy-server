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
const { summarizeSchedule, describeMilestone, receivedOn } = require("../utils/venuePaymentStatus");
const { addEntry } = require("../utils/venuePaymentEntries");
const { allocate, allocationSentence } = require("../utils/venuePaymentWaterfall");
const { normaliseMode, PAYMENT_MODES } = require("../utils/venuePaymentMode");

// The ONE vocabulary, re-exported rather than restated. This list used to be
// spelled out here and was already missing "other", so a method the schema
// accepts was rejected by the controller that writes it.
const MODES = PAYMENT_MODES;
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

/**
 * The owner's own allocation, if they gave one.
 *
 * THREE shapes reach this, and all three must keep working:
 *   · { allocations: [{ milestoneId, amount }] } — the S2 split
 *   · { milestoneId }                            — "all of it, to this one"
 *   · nothing                                    — the waterfall
 *
 * The bare `milestoneId` form is what every caller sent before S2, including
 * the confirm wizard and the existing payments UI. Translating it here rather
 * than branching downstream means those callers keep their exact behaviour —
 * one instalment, refused if it overpays that instalment — without a second
 * code path that could drift from the planner.
 *
 * `null` means "no override", which is the waterfall.
 */
function readOverride(body) {
  if (Array.isArray(body.allocations) && body.allocations.length) {
    return body.allocations
      .map((a) => ({ milestoneId: a && a.milestoneId, amount: Math.round(Number(a && a.amount) || 0) }))
      .filter((a) => a.milestoneId && a.amount > 0);
  }
  if (body.milestoneId) {
    return [{ milestoneId: body.milestoneId, amount: Math.round(Number(body.amount) || 0) }];
  }
  return null;
}

// ── POST /venues/:slug/enquiries/:enquiryId/payments/preview ────────────────
/**
 * WHERE WOULD THIS MONEY GO — answered before anything is saved.
 *
 * Nobody should discover where their money went after the fact. The owner
 * types an amount, sees "Rs. 1,00,000 → Rs. 50,000 completes Instalment 1,
 * Rs. 50,000 to Instalment 2", and only then agrees to it.
 *
 * It is a POST rather than a GET because the body can carry an override, and
 * it writes NOTHING — it plans with the same function the write uses, so the
 * preview cannot become a decoration that disagrees with what happens.
 *
 * A refusal is a 200 with the reason, not a 4xx: at preview time "that is more
 * than the booking has outstanding" is INFORMATION the owner is asking for,
 * not a failed request. The write still refuses it with a 400.
 */
const previewPayment = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { lead } = owned;
    const body = req.body || {};

    const booking = await VenueBooking.findOne({ enquiry: lead._id });
    if (!booking) {
      return res.status(400).json({ message: "This lead has no confirmed booking yet.", code: "no_booking" });
    }
    const amount = Math.round(Number(body.amount));
    const s = summarizeSchedule(booking);
    const plan = allocate(s.rows, amount, readOverride(body));

    return res.status(200).json({
      ok: !plan.error,
      amount: Number.isFinite(amount) ? amount : 0,
      lines: plan.lines,
      sentence: plan.error ? "" : allocationSentence(plan, amount),
      totalOutstanding: plan.totalOutstanding,
      // What the balance WOULD become, so the preview answers the second
      // question an owner has after "where does it go".
      balanceAfter: plan.error ? s.totals.balance : Math.max(0, s.totals.balance - plan.allocated),
      problem: plan.error || null,
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
    const amount = Math.round(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: "A payment amount is required" });
    }

    // ── WHERE THE MONEY GOES ─────────────────────────────────────────────────
    // The SAME planner the preview endpoint runs, so what the owner agreed to
    // on screen is what happens here. Nothing below re-derives an allocation.
    const plan = allocate(summarizeSchedule(booking).rows, amount, readOverride(body));
    if (plan.error) {
      return res.status(plan.error.code === "unknown_milestone" ? 404 : 400).json(plan.error);
    }

    // normaliseMode RETURNS NULL for a method we do not know, and that is a
    // refusal rather than a default: the old `includes() ? : ""` quietly threw
    // away whatever the owner actually chose, which is the exact bug
    // utils/venuePaymentMode was written to end.
    const mode = normaliseMode(body.mode);
    if (mode === null) {
      return res.status(400).json({ message: "That payment method is not one we recognise.", code: "unknown_method" });
    }
    const modeOther = mode === "other" ? cleanStr(body.modeOther || body.methodOther).slice(0, MAX_REF) : "";
    const reference = cleanStr(body.reference).slice(0, MAX_REF);
    const note = cleanStr(body.note).slice(0, 2000);
    const proofUrl = cleanStr(body.proofUrl).slice(0, 2000);
    let paidAt = new Date();
    if (body.paidAt) {
      const d = new Date(body.paidAt);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "paidAt is not a valid date" });
      paidAt = d;
    }

    // ONE payment, possibly SEVERAL entries. They share a paymentId so the
    // thing the couple actually did stays one thing — for display, for the
    // invoice that keys off it, and for anyone later asking "what was this
    // ₹1,00,000?". addEntry converts a still-legacy row before appending.
    const paymentId = new mongoose.Types.ObjectId();
    const recordedByName = await actorName(req);
    const touched = [];
    for (const line of plan.lines) {
      const target = booking.paymentSchedule.id(line.milestoneId);
      if (!target) continue;
      addEntry(target, {
        paymentId,
        amount: line.amount,
        date: paidAt,
        method: mode,
        methodOther: modeOther,
        reference,
        note,
        proofUrl,
        status: "approved",
        recordedBy: actorId(req),
        recordedByName,
      });
      touched.push(target);
    }
    await booking.save();

    const described = describeMilestone(touched[0]);
    const s = summarizeSchedule(booking);

    lead.activities.push({
      type: "payment_recorded",
      // The allocation sentence IS the description. A payment that spanned two
      // instalments used to be logged against whichever one the caller named,
      // which made the timeline disagree with the schedule it was describing.
      description:
        `Payment received: ${allocationSentence(plan, amount)}`.replace(/\.$/, "") +
        `${mode ? ` — by ${mode.replace(/_/g, " ")}` : ""}${reference ? ` (${reference})` : ""}`,
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

module.exports = { getLeadPayments, recordPayment, previewPayment, MODES };
