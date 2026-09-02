/**
 * controllers/venueBookingMoney.js — the POST-BOOKING money surface.
 *
 * MONEYPOST slices 3 and 4. Two acts an owner performs on a booking whose
 * schedule is already built, both DELIBERATE and CONFIRMED, both previewed
 * with the before/after because the couple was told those numbers:
 *
 *   · LINE EDIT (absorb): the agreed lines stay editable after confirm. The
 *     difference lands on the UNPAID instalments; paid ones are untouchable.
 *     A reduction below what has been collected is a REFUND, which this model
 *     cannot record (entries are min 1, no negatives; the only reversal is
 *     rejecting a payment) — refused out loud, naming both figures.
 *
 *   · FOLD (slice 4): an additional charge folds into the last unpaid
 *     instalment BY REFERENCE, never by moving amounts — the row stays the
 *     stored carrier of the money, the instalment's displayed absorption is a
 *     derivation in utils/venuePaymentStatus, and the schedule invariant
 *     holds by construction.
 *
 * Both writes land on ONE document (the booking), one save — atomic, nothing
 * to hand-undo. The estimatedValue write-back to the lead follows the
 * booking save, same exposure and same pattern as confirm's own write-back.
 *
 * The invariant Σ non-additional rows === charged + refundable is re-asserted
 * here through utils/venueMoney.scheduleMismatch — the SAME function the
 * PATCH guard runs, so this path provably executes the guard rather than
 * trusting its own construction.
 */
const mongoose = require("mongoose");
const Venue = require("../models/Venue");
const VenueBooking = require("../models/VenueBooking");
const VenueTeamMember = require("../models/VenueTeamMember");
const { resolveScopedEnquiry } = require("../utils/venueLeadScope");
const { computeLineTotals, scheduleMismatch, formatINR: inr } = require("../utils/venueMoney");
const { receivedOn, milestoneStatus, summarizeSchedule } = require("../utils/venuePaymentStatus");
const { normalizeQuoteLines } = require("./venueQuote");

const actorId = (req) => (req.venueOwner && (req.venueOwner.memberId || req.venueOwner.venueOwnerId)) || null;
async function actorName(req) {
  const o = req.venueOwner || {};
  if (o.memberId) {
    const m = await VenueTeamMember.findById(o.memberId).select("name").lean();
    return (m && m.name) || "team member";
  }
  return "owner";
}

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

/**
 * ── THE ABSORB PLAN, AS A PURE FUNCTION ─────────────────────────────────────
 * Given the current non-additional rows and the new payable, decide every
 * row's new amount. Exported so the suite can prove the arithmetic without a
 * database.
 *
 * Rules (founder rulings, moneypost slice 3):
 *   · a CLEARED row (milestoneStatus "paid", computed NOW, never cached) is
 *     frozen at its stored amount;
 *   · an OPEN row can move, but never below what has been received on it —
 *     the paid portion is untouchable;
 *   · the open rows absorb the difference BETWEEN THEM, in proportion to
 *     their current outstanding shares (equal split when all outstanding is
 *     zero-width), with rounding settled on the last open row so the total
 *     lands EXACTLY on the new payable;
 *   · new payable below what has been collected → refusal: that is a refund.
 *
 * @returns {{ok:true, rows:[{index,from,to,frozen,floor}]} |
 *           {ok:false, code:string, collected?:number, newPayable?:number}}
 */
function planAbsorb(rows, newPayable, now = new Date()) {
  const plan = [];
  let frozenSum = 0;
  const open = [];
  rows.forEach((row, index) => {
    if (row.isAdditional) return; // extras ride above the agreed schedule
    const amount = Math.round(Number(row.amount)) || 0;
    const paid = Math.round(receivedOn(row)) || 0;
    if (milestoneStatus(row, now) === "paid") {
      plan.push({ index, from: amount, to: amount, frozen: true, floor: amount });
      frozenSum += amount;
    } else {
      // The paid portion is untouchable: the row can shrink only to what has
      // already been received on it.
      open.push({ index, from: amount, floor: Math.max(0, paid) });
    }
  });

  const target = newPayable - frozenSum;
  const floorSum = open.reduce((s, r) => s + r.floor, 0);
  const collected = frozenSum + floorSum; // everything received against the agreed schedule
  if (target < floorSum) {
    return { ok: false, code: "refund_required", collected, newPayable };
  }
  if (!open.length) {
    // Every instalment cleared. An increase has nothing to absorb it; a
    // decrease below frozenSum was caught above; equal means a no-op.
    if (target === 0) return { ok: true, rows: plan };
    return { ok: false, code: "all_instalments_cleared", collected, newPayable };
  }

  // Distribute (target − floors) over the open rows, proportional to their
  // current outstanding; equal when nothing is outstanding anywhere.
  const spread = target - floorSum;
  const weights = open.map((r) => Math.max(0, r.from - r.floor));
  const weightSum = weights.reduce((s, w) => s + w, 0);
  let assigned = 0;
  open.forEach((r, i) => {
    const share = i === open.length - 1
      ? spread - assigned // the last row settles the rounding — exact by construction
      : Math.round(spread * (weightSum > 0 ? weights[i] / weightSum : 1 / open.length));
    assigned += i === open.length - 1 ? 0 : share;
    plan.push({ index: r.index, from: r.from, to: r.floor + share, frozen: false, floor: r.floor });
  });
  plan.sort((a, b) => a.index - b.index);
  return { ok: true, rows: plan };
}

// ── POST /venues/:slug/enquiries/:enquiryId/booking-line-edit ───────────────
// Body: { lineItems, gstPercent?, confirm? }. Without confirm:true this is a
// PREVIEW — the before/after the owner must see, per instalment. With it, the
// one atomic write described in the header.
const bookingLineEdit = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { lead } = owned;
    const body = req.body || {};

    const booking = await VenueBooking.findOne({ enquiry: lead._id });
    if (!booking) return res.status(400).json({ message: "This lead has no confirmed booking yet.", code: "no_booking" });
    if (booking.status === "cancelled") {
      return res.status(409).json({ message: "This booking is cancelled — there is nothing to edit.", code: "booking_cancelled" });
    }
    if (!(booking.lineItems || []).length) {
      return res.status(400).json({
        message: "This booking predates line quotes — its value is edited on the booking itself, as before.",
        code: "not_a_line_booking",
      });
    }

    if (!Array.isArray(body.lineItems) || body.lineItems.length === 0) {
      return res.status(400).json({ message: "lineItems are required — a booking cannot bill nothing.", code: "lines_required" });
    }
    const norm = normalizeQuoteLines(body.lineItems);
    if (!norm.ok) return res.status(400).json({ message: norm.message });
    let pct = booking.gstPercent || 0;
    if (body.gstPercent !== undefined) {
      const p = Number(body.gstPercent);
      if (!Number.isFinite(p) || p < 0 || p > 100) return res.status(400).json({ message: "gstPercent must be 0..100" });
      pct = p;
    }

    const oldLf = computeLineTotals(booking.lineItems, booking.gstPercent);
    const newLf = computeLineTotals(norm.lines, pct);
    const newPayable = newLf.charged + newLf.refundable;

    const plan = planAbsorb(booking.paymentSchedule || [], newPayable);
    if (!plan.ok && plan.code === "refund_required") {
      return res.status(409).json({
        message:
          `${inr(plan.collected)} has already been collected against the agreed schedule, but the new total collects only ${inr(newPayable)}. ` +
          `That is a refund, which cannot be recorded yet — keep the total at or above ${inr(plan.collected)}, or wait for the refund build.`,
        code: "refund_required",
        collected: plan.collected,
        newPayable,
      });
    }
    if (!plan.ok && plan.code === "all_instalments_cleared") {
      return res.status(409).json({
        message:
          `Every instalment is already cleared — nothing can absorb the increase. ` +
          `Add the difference as additional billing instead; it is collected separately.`,
        code: "all_instalments_cleared",
        collected: plan.collected,
        newPayable,
      });
    }

    const rowView = plan.rows.map((p) => {
      const row = booking.paymentSchedule[p.index];
      return { _id: row._id, label: row.label, from: p.from, to: p.to, frozen: p.frozen, paid: Math.round(receivedOn(row)) || 0 };
    });
    const preview = {
      agreed: { from: oldLf.charged, to: newLf.charged },
      payable: { from: oldLf.charged + oldLf.refundable, to: newPayable },
      refundable: { from: oldLf.refundable, to: newLf.refundable },
      rows: rowView,
    };
    if (body.confirm !== true) return res.status(200).json({ preview: true, ...preview });

    // ── THE WRITE — one document, one save ─────────────────────────────────
    booking.lineItems = norm.lines.map((li) => ({
      label: li.label, amount: li.amount, gstTreatment: li.gstTreatment,
      taxableAmount: li.taxableAmount || 0, refundable: Boolean(li.refundable),
      source: { chargeKey: (li.source && li.source.chargeKey) || "" },
    }));
    booking.gstPercent = pct;
    booking.totalValue = newLf.charged;
    for (const p of plan.rows) {
      if (!p.frozen && p.to !== p.from) booking.paymentSchedule[p.index].amount = p.to;
    }
    // THE GUARD, EXECUTED IN THIS PATH — the same function the PATCH guard
    // runs. If the construction above ever failed to land exactly, this
    // refuses before anything is saved rather than storing the drift.
    const mm = scheduleMismatch(booking.paymentSchedule, newLf);
    if (mm) {
      return res.status(500).json({
        message: `Internal: the absorbed schedule comes to ${inr(mm.scheduled)} against ${inr(mm.payable)} payable — nothing was saved.`,
        code: "schedule_value_mismatch",
      });
    }
    await booking.save();

    // The lead follows the booking, exactly as confirm's write-back does.
    if (booking.totalValue > 0) lead.estimatedValue = booking.totalValue;
    const changed = rowView.filter((r) => !r.frozen && r.to !== r.from).length;
    lead.activities.push({
      type: "booking_lines_edited",
      description:
        `Booking lines edited by ${await actorName(req)}: agreed ${inr(preview.agreed.from)} → ${inr(preview.agreed.to)}` +
        (changed ? `, absorbed into ${changed} unpaid instalment${changed === 1 ? "" : "s"}` : "") + ".",
      actor: actorId(req),
      timestamp: new Date(),
    });
    await lead.save();

    const s = summarizeSchedule(booking);
    return res.status(200).json({ preview: false, ...preview, rows: rowView, totals: s.totals, schedule: s.rows });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── POST /venues/:slug/enquiries/:enquiryId/additional-billing/:rowId/fold ──
// Body: { confirm? }. FOLDING IS BY REFERENCE (founder ruling, taken from the
// audit's recommendation): the additional row stays the stored carrier of the
// money; the last unpaid instalment gains a derived absorption in
// summarizeSchedule; stored amounts never move, so the schedule invariant
// holds by construction — and the guard is still executed below, not assumed.
//
// Eligibility is computed AT THE MOMENT OF THE ACT from live milestoneStatus,
// never cached: a charge that stood alone because the last instalment was
// cleared BECOMES foldable if a rejected payment later un-clears it — that is
// the unambiguous rule, no third state.
const foldAdditionalBilling = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { lead } = owned;
    const body = req.body || {};

    const booking = await VenueBooking.findOne({ enquiry: lead._id });
    if (!booking) return res.status(400).json({ message: "This lead has no confirmed booking yet.", code: "no_booking" });
    const row = booking.paymentSchedule.id(req.params.rowId);
    if (!row || !row.isAdditional) {
      return res.status(404).json({ message: "That additional charge is not on this booking" });
    }
    if (row.foldedInto) {
      return res.status(409).json({ message: "This charge is already folded into an instalment — unfold it first.", code: "already_folded" });
    }

    // The fold target is THE LAST instalment of the agreed schedule — the one
    // the couple has not finished paying, the number they were last told.
    const agreedRows = booking.paymentSchedule.filter((r) => !r.isAdditional);
    const target = agreedRows[agreedRows.length - 1];
    if (!target) {
      return res.status(409).json({ message: "This booking has no instalments — the charge is collected on its own.", code: "no_instalments" });
    }
    if (milestoneStatus(target) === "paid") {
      return res.status(409).json({
        message:
          `${target.label || "The last instalment"} is already cleared — nothing can absorb this charge. ` +
          `It stands alone and is collected separately. (If a payment on that instalment is later rejected, folding becomes available again.)`,
        code: "last_instalment_cleared",
      });
    }

    const targetPaid = Math.round(receivedOn(target)) || 0;
    const targetOutstanding = Math.max(0, (Math.round(Number(target.amount)) || 0) - targetPaid);
    const chargeAmount = Math.round(Number(row.amount)) || 0;
    const preview = {
      charge: { _id: row._id, label: row.label, amount: chargeAmount },
      target: {
        _id: target._id, label: target.label,
        amount: Math.round(Number(target.amount)) || 0,
        paid: targetPaid,
        outstanding: targetOutstanding,
        // The number the confirm dialog MUST state, part-paid included: what
        // the instalment will collect from here once the charge rides on it.
        newOutstanding: targetOutstanding + chargeAmount,
        displayAmount: (Math.round(Number(target.amount)) || 0) + chargeAmount,
      },
    };
    if (body.confirm !== true) return res.status(200).json({ preview: true, ...preview });

    row.foldedInto = target._id;
    // Collected together: the folded charge falls due when the instalment does.
    if (target.dueDate) row.dueDate = target.dueDate;
    // THE GUARD, EXECUTED — amounts did not move, and this proves it.
    const lf = computeLineTotals(booking.lineItems, booking.gstPercent);
    const mm = (booking.lineItems || []).length ? scheduleMismatch(booking.paymentSchedule, lf) : null;
    if (mm) {
      return res.status(500).json({
        message: `Internal: the fold moved money — ${inr(mm.scheduled)} against ${inr(mm.payable)} payable. Nothing was saved.`,
        code: "schedule_value_mismatch",
      });
    }
    await booking.save();

    lead.activities.push({
      type: "additional_billing_folded",
      description: `${row.label} — ${inr(chargeAmount)} folded into ${target.label || "the last instalment"} by ${await actorName(req)}.`,
      actor: actorId(req),
      timestamp: new Date(),
    });
    await lead.save();

    const s = summarizeSchedule(booking);
    return res.status(200).json({ preview: false, ...preview, rows: s.rows, totals: s.totals });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── POST /venues/:slug/enquiries/:enquiryId/additional-billing/:rowId/unfold ─
// The reversal of a deliberate act must exist, or a misfold is a dead-end.
// The dueDate stays where the fold aligned it — the charge is still owed now.
const unfoldAdditionalBilling = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { lead } = owned;
    const booking = await VenueBooking.findOne({ enquiry: lead._id });
    if (!booking) return res.status(400).json({ message: "This lead has no confirmed booking yet.", code: "no_booking" });
    const row = booking.paymentSchedule.id(req.params.rowId);
    if (!row || !row.isAdditional) {
      return res.status(404).json({ message: "That additional charge is not on this booking" });
    }
    if (!row.foldedInto) {
      return res.status(409).json({ message: "This charge is not folded into anything.", code: "not_folded" });
    }
    const label = row.label;
    row.foldedInto = undefined;
    await booking.save();
    lead.activities.push({
      type: "additional_billing_unfolded",
      description: `${label} unfolded — it is collected on its own again (by ${await actorName(req)}).`,
      actor: actorId(req),
      timestamp: new Date(),
    });
    await lead.save();
    const s = summarizeSchedule(booking);
    return res.status(200).json({ rows: s.rows, totals: s.totals });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { bookingLineEdit, planAbsorb, foldAdditionalBilling, unfoldAdditionalBilling };
