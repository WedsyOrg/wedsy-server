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
const { isOwnerActor } = require("../utils/venueRbac");
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
    // ── WHO RECORDED IT DECIDES WHETHER IT COUNTS YET ────────────────────────
    // An owner's own entry is approved on the spot: there is nobody above them
    // to approve it, and making an owner approve their own payment would be
    // ceremony rather than control. A member's entry lands PENDING — visible on
    // the row, but not in the books until an owner says so.
    //
    // Gated on isOwnerActor, deliberately NOT on a new `payments_approve`
    // capability: a capability nobody holds is a migration and a permissions
    // row for no live benefit, and this matches how invoice approval already
    // works. Add one the first time a venue asks to delegate it.
    const ownerActor = await isOwnerActor(req.venueOwner, req.venueMember);
    const entryStatus = ownerActor ? "approved" : "pending";
    const touched = [];
    for (const line of plan.lines) {
      const target = booking.paymentSchedule.id(line.milestoneId);
      // ── NEVER WRITE A PAYMENT SHORT ─────────────────────────────────────────
      // The plan came from THIS booking's own schedule a few lines above, so a
      // missing row is not reachable today. It was written as `continue`, which
      // would have written part of a payment and reported success — the couple's
      // money silently landing as less than they sent, with nothing to notice.
      // In money code the unreachable branch still has to be the loud one.
      if (!target) {
        return res.status(500).json({
          message: "That payment could not be recorded in full. Nothing was saved — please try again.",
          code: "allocation_row_missing",
        });
      }
      addEntry(target, {
        paymentId,
        amount: line.amount,
        date: paidAt,
        method: mode,
        methodOther: modeOther,
        reference,
        note,
        proofUrl,
        status: entryStatus,
        recordedBy: actorId(req),
        recordedByName,
      });
      touched.push(target);
    }
    // Belt and braces: the plan and what was written must be the same length.
    // Nothing is persisted unless they are — booking.save() has not run yet, so
    // returning here leaves the document untouched.
    if (touched.length !== plan.lines.length) {
      return res.status(500).json({
        message: "That payment could not be recorded in full. Nothing was saved — please try again.",
        code: "allocation_incomplete",
      });
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
        `${entryStatus === "pending" ? "Payment recorded, awaiting approval" : "Payment received"}: ` +
        `${allocationSentence(plan, amount)}`.replace(/\.$/, "") +
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

/**
 * Find every entry belonging to one payment.
 *
 * ── KEYED ON THE PAYMENT, NOT THE FRAGMENT ─────────────────────────────────
 * A payment that spanned two instalments is TWO entries and ONE thing the
 * couple did. Approving half of it is not a state anybody wants to be able to
 * reach, so approve and reject act on the whole `paymentId` group.
 *
 * Entries converted from the pre-S1 scalar have no paymentId — they predate
 * the concept. Those are matched by their own entry id instead, so a
 * historical payment can still be corrected.
 */
function findPaymentEntries(booking, key) {
  const hits = [];
  for (const row of booking.paymentSchedule || []) {
    for (const e of row.entries || []) {
      if ((e.paymentId && String(e.paymentId) === String(key)) || String(e._id) === String(key)) {
        hits.push({ row, entry: e });
      }
    }
  }
  return hits;
}

/**
 * Approving must RE-CHECK the arithmetic, not trust what was true when the
 * entry was recorded.
 *
 * A pending entry does not reduce `outstanding`, so two members can each record
 * Rs. 50,000 against the same Rs. 50,000 remainder and both sit in the queue
 * legitimately. Approving the first is fine; approving the second would take
 * the instalment past its own amount. The check has to happen HERE, against the
 * state at approval time — which is the whole reason approval is a separate act.
 */
function wouldOverpay(row, entry) {
  const amount = Math.round(Number(row.amount) || 0);
  if (amount <= 0) return null;
  const approved = receivedOn(row);
  const add = Math.round(Number(entry.amount) || 0);
  if (approved + add <= amount) return null;
  return {
    message:
      `Approving this would put ${row.label || "that instalment"} at Rs. ${(approved + add).toLocaleString("en-IN")} ` +
      `against Rs. ${amount.toLocaleString("en-IN")}. Only Rs. ${Math.max(0, amount - approved).toLocaleString("en-IN")} is outstanding on it — ` +
      `another payment was approved after this one was recorded.`,
    code: "approval_overpays_milestone",
    outstanding: Math.max(0, amount - approved),
  };
}

// ── POST /venues/:slug/enquiries/:enquiryId/payments/:paymentId/approve ──────
const approveLeadPayment = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { lead } = owned;
    if (!(await isOwnerActor(req.venueOwner, req.venueMember))) {
      return res.status(403).json({ message: "Only an owner can approve a payment." });
    }
    const booking = await VenueBooking.findOne({ enquiry: lead._id });
    if (!booking) return res.status(400).json({ message: "This lead has no confirmed booking yet.", code: "no_booking" });

    const hits = findPaymentEntries(booking, req.params.paymentId);
    if (!hits.length) return res.status(404).json({ message: "That payment is not on this booking" });
    const pending = hits.filter((h) => h.entry.status === "pending");
    if (!pending.length) {
      return res.status(400).json({ message: "That payment is not awaiting approval.", code: "not_pending" });
    }
    // Every piece is checked BEFORE any piece is approved, so a payment across
    // two instalments cannot be left half-approved by a failure on the second.
    for (const h of pending) {
      const problem = wouldOverpay(h.row, h.entry);
      if (problem) return res.status(409).json(problem);
    }
    const name = await actorName(req);
    for (const h of pending) {
      h.entry.status = "approved";
      h.entry.approvedBy = actorId(req);
      h.entry.approvedByName = name;
      h.entry.approvedAt = new Date();
    }
    await booking.save();

    const total = pending.reduce((sum, h) => sum + Math.round(Number(h.entry.amount) || 0), 0);
    lead.activities.push({
      type: "payment_approved",
      description:
        `Payment approved: Rs. ${total.toLocaleString("en-IN")}` +
        `${pending[0].entry.recordedByName ? ` — recorded by ${pending[0].entry.recordedByName}` : ""}`,
      actor: actorId(req),
      timestamp: new Date(),
    });
    await lead.save();

    const s = summarizeSchedule(booking);
    return res.status(200).json({ success: true, rows: s.rows, totals: s.totals, overdue: s.overdue, overdueTotal: s.overdueTotal, next: s.next });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── POST /venues/:slug/enquiries/:enquiryId/payments/:paymentId/reject ───────
/**
 * A rejected payment STAYS on the row, marked rejected, with who rejected it
 * and why. It is never deleted: a deleted payment record is how a dispute
 * becomes unresolvable, and "there is no record of that transfer" is the worst
 * thing a venue can say to a couple holding a bank statement.
 *
 * An ALREADY-APPROVED entry can be rejected too. That is the only way to undo a
 * payment recorded in error — an owner's own entries auto-approve, so without
 * it a mistyped amount would be permanent. It reduces `received`, which is the
 * point, and leaves the reversal visible rather than making money quietly
 * disappear.
 */
const rejectLeadPayment = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { lead } = owned;
    if (!(await isOwnerActor(req.venueOwner, req.venueMember))) {
      return res.status(403).json({ message: "Only an owner can reject a payment." });
    }
    const booking = await VenueBooking.findOne({ enquiry: lead._id });
    if (!booking) return res.status(400).json({ message: "This lead has no confirmed booking yet.", code: "no_booking" });

    const reason = cleanStr((req.body || {}).reason).slice(0, 500);
    if (!reason) {
      // Required, because "rejected" with no reason is exactly as unhelpful in a
      // dispute as no record at all.
      return res.status(400).json({ message: "Say why this payment is being rejected.", code: "reason_required" });
    }

    const hits = findPaymentEntries(booking, req.params.paymentId);
    if (!hits.length) return res.status(404).json({ message: "That payment is not on this booking" });
    const live = hits.filter((h) => h.entry.status !== "rejected");
    if (!live.length) return res.status(400).json({ message: "That payment is already rejected.", code: "already_rejected" });

    const name = await actorName(req);
    const wasApproved = live.some((h) => h.entry.status === "approved");
    for (const h of live) {
      h.entry.status = "rejected";
      h.entry.rejectionReason = reason;
      h.entry.approvedBy = actorId(req);
      h.entry.approvedByName = name;
      h.entry.approvedAt = new Date();
    }
    await booking.save();

    const total = live.reduce((sum, h) => sum + Math.round(Number(h.entry.amount) || 0), 0);
    lead.activities.push({
      type: "payment_rejected",
      description:
        `Payment ${wasApproved ? "reversed" : "rejected"}: Rs. ${total.toLocaleString("en-IN")} — ${reason}`,
      actor: actorId(req),
      timestamp: new Date(),
    });
    await lead.save();

    const s = summarizeSchedule(booking);
    return res.status(200).json({ success: true, rows: s.rows, totals: s.totals, overdue: s.overdue, overdueTotal: s.overdueTotal, next: s.next });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── POST /venues/:slug/enquiries/:enquiryId/additional-billing ───────────────
/**
 * An extra the venue adds after the booking — a bar tab on the night, an extra
 * hour, a last-minute upgrade.
 *
 * ── IT IS A SCHEDULE ROW, NOT A SEPARATE LIST ───────────────────────────────
 * So it flows through the waterfall, carries payment entries, can be invoiced
 * and appears in the schedule with no second money path. A parallel list of
 * extras is how a booking ends up with two balances that disagree.
 *
 * ── AND IT DOES NOT TOUCH THE AGREED VALUE ──────────────────────────────────
 * totalValue stays what was negotiated. Rewriting it to absorb an extra would
 * destroy the record that settles a dispute — "we agreed Rs. 5,00,000" has to
 * remain answerable months later. The extras are added on top, and every
 * surface reports both numbers.
 *
 * Due TODAY, because an extra added after the event is money owed now rather
 * than on some future instalment date.
 */
const addAdditionalBilling = async (req, res) => {
  try {
    const owned = await resolveOwnedLead(req, res);
    if (!owned) return;
    const { lead } = owned;
    const body = req.body || {};

    const booking = await VenueBooking.findOne({ enquiry: lead._id });
    if (!booking) return res.status(400).json({ message: "This lead has no confirmed booking yet.", code: "no_booking" });

    const amount = Math.round(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: "An amount is required" });
    }
    const label = cleanStr(body.label).slice(0, 80);
    if (!label) {
      // Required: "Additional billing Rs. 40,000" is exactly as useless in a
      // dispute as no record. The couple will ask what it was for.
      return res.status(400).json({ message: "Say what this charge is for.", code: "label_required" });
    }
    const note = cleanStr(body.note).slice(0, 2000);

    booking.paymentSchedule.push({
      label,
      amount,
      percent: null,
      dueDate: new Date(),
      isAdditional: true,
      addedNote: note,
      addedByName: await actorName(req),
      recordedBy: actorId(req),
    });
    await booking.save();

    const s = summarizeSchedule(booking);
    lead.activities.push({
      type: "additional_billing_added",
      description:
        `Additional billing: ${label} — Rs. ${amount.toLocaleString("en-IN")}` +
        `${note ? ` (${note})` : ""}. Agreed Rs. ${s.totals.bookingValue.toLocaleString("en-IN")}` +
        ` + additional Rs. ${s.totals.additional.toLocaleString("en-IN")}.`,
      actor: actorId(req),
      timestamp: new Date(),
    });
    await lead.save();

    return res.status(201).json({ success: true, rows: s.rows, totals: s.totals, overdue: s.overdue, overdueTotal: s.overdueTotal, next: s.next });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── DELETE /venues/:slug/enquiries/:enquiryId/additional-billing/:rowId ──────
/**
 * Remove an extra that was added in error.
 *
 * ONLY while nothing has been paid against it. Once money has landed on a row,
 * removing it would delete a payment record — the thing S3 spent a whole slice
 * refusing to do. A charge that has been part-paid is corrected by rejecting
 * the payment and then removing it, in that order, so the trail survives.
 */
const removeAdditionalBilling = async (req, res) => {
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
    const anyMoney = (row.entries || []).some((e) => e.status !== "rejected") || Math.round(Number(row.paidAmount) || 0) > 0;
    if (anyMoney) {
      return res.status(409).json({
        message: "Money has been recorded against this charge. Reject the payment first, so the record survives.",
        code: "has_payments",
      });
    }
    const label = row.label;
    const amount = Math.round(Number(row.amount) || 0);
    row.deleteOne();
    await booking.save();

    const s = summarizeSchedule(booking);
    lead.activities.push({
      type: "additional_billing_removed",
      description: `Additional billing removed: ${label} — Rs. ${amount.toLocaleString("en-IN")}`,
      actor: actorId(req),
      timestamp: new Date(),
    });
    await lead.save();
    return res.status(200).json({ success: true, rows: s.rows, totals: s.totals, overdue: s.overdue, overdueTotal: s.overdueTotal, next: s.next });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getLeadPayments, recordPayment, previewPayment, approveLeadPayment, rejectLeadPayment, addAdditionalBilling, removeAdditionalBilling, MODES };
