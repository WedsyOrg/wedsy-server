// Money model S3 — approval. Pending money is VISIBLE but UNCOUNTED; rejected
// money stays visible as rejected.
//
// The two properties that matter and are easy to get wrong:
//   · pending must not leak into received/balance ANYWHERE — the lead, the
//     payments summary and the alerts all read the same derivation, and a
//     pending rupee counted on one of them is a booking that disagrees with
//     itself.
//   · approving must re-check the arithmetic AT APPROVAL TIME. Pending entries
//     do not reduce `outstanding`, so two of them can legitimately queue up
//     against the same remainder; approving both would overpay the instalment.
//
// Run: node tests/venue-payment-approval.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");

const lp = require("../controllers/venueLeadPayment");
const vp = require("../controllers/venuePayment");
const { summarizeSchedule, overdueSentence, receivedOn, pendingOn } = require("../utils/venuePaymentStatus");

const TAG = `appr-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [], members: [], leads: [], bookings: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const daysAhead = (n) => new Date(Date.now() + n * 86400000);

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const venue = await Venue.create({ name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);
    const member = await VenueTeamMember.create({
      venueId: venue._id, name: "Staff", phone: `${TAG}m`, email: `${TAG}@x.com`, role: "manager", isActive: true,
    });
    created.members.push(member._id);

    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true, couplePhone: "9800001111", stage: "booked",
    });
    created.leads.push(lead._id);
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun", totalValue: 200000,
      days: [{ date: daysAhead(60), eventType: "wedding", guestCount: 300 }],
      paymentSchedule: [
        { label: "Instalment 1", amount: 100000, dueDate: daysAgo(10) },
        { label: "Instalment 2", amount: 100000, dueDate: daysAhead(20) },
      ],
    });
    created.bookings.push(booking._id);

    const asOwner = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
      venueMember: null,
    });
    const asMember = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_member", venueId: venue._id, memberId: member._id, role: "manager" },
      venueMember: { _id: member._id, role: "manager" },
    });

    // ══ WHO RECORDS DECIDES WHETHER IT COUNTS ═══════════════════════════════
    console.log("\n[a member's payment lands PENDING; an owner's is approved on the spot]");
    const memberRec = await call(lp.recordPayment, asMember({ body: { amount: 50000, mode: "upi", reference: "UPI-M1" } }));
    ok(memberRec.code === 200, `member can record (got ${memberRec.code} ${memberRec.body && memberRec.body.message ? memberRec.body.message : ""})`);
    let fresh = await VenueBooking.findById(booking._id);
    let s = summarizeSchedule(fresh);
    ok(s.rows[0].entries.length === 1 && s.rows[0].entries[0].status === "pending", "the member's entry is pending");
    ok(s.totals.received === 0, "received is STILL ZERO — pending money is not in the books");
    ok(s.totals.balance === 200000, "…and the balance is untouched");
    ok(s.totals.pending === 50000, "…but it is surfaced as pending");
    ok(s.rows[0].pendingAmount === 50000, "…on the row it was recorded against");
    ok(s.rows[0].outstanding === 100000, "the instalment is still fully outstanding");

    console.log("\n[the owner chasing that instalment is TOLD money was offered]");
    const od = s.overdue[0];
    ok(!!od, "the instalment is overdue");
    ok(/50,000 awaiting approval/.test(overdueSentence(od)), `the sentence names it — "${overdueSentence(od)}"`);

    console.log("\n[the timeline says it is only claimed]");
    let freshLead = await VenueEnquiry.findById(lead._id);
    let act = (freshLead.activities || []).filter((a) => a.type === "payment_recorded").pop();
    ok(!!act && /awaiting approval/i.test(act.description), `"${act ? act.description : "(none)"}"`);

    // ══ NOBODY BUT AN OWNER APPROVES ════════════════════════════════════════
    console.log("\n[approval is owner-only]");
    const pendingId = String(s.rows[0].entries[0].paymentId || s.rows[0].entries[0]._id);
    const memberApprove = await call(lp.approveLeadPayment, asMember({ params: { paymentId: pendingId } }));
    ok(memberApprove.code === 403, `a member approving → 403 (got ${memberApprove.code})`);
    fresh = await VenueBooking.findById(booking._id);
    ok(summarizeSchedule(fresh).totals.received === 0, "…and the denied call approved nothing");

    console.log("\n[an owner approves, and only then does it count]");
    const appr = await call(lp.approveLeadPayment, asOwner({ params: { paymentId: pendingId } }));
    ok(appr.code === 200, `owner approve → 200 (got ${appr.code} ${appr.body && appr.body.message ? appr.body.message : ""})`);
    fresh = await VenueBooking.findById(booking._id);
    s = summarizeSchedule(fresh);
    ok(s.totals.received === 50000, "received is now 50,000");
    ok(s.totals.pending === 0, "…and nothing is pending");
    ok(s.rows[0].entries[0].approvedByName === "Owner" || !!s.rows[0].entries[0].approvedAt, "the approval is stamped");
    const dbl = await call(lp.approveLeadPayment, asOwner({ params: { paymentId: pendingId } }));
    ok(dbl.code === 400 && dbl.body.code === "not_pending", "approving twice is refused, not double-counted");

    // ══ THE APPROVAL-TIME RE-CHECK ══════════════════════════════════════════
    console.log("\n[two members can queue against the same remainder — approving both is refused]");
    const q1 = await call(lp.recordPayment, asMember({ body: { amount: 50000, mode: "cash" } }));
    const q2 = await call(lp.recordPayment, asMember({ body: { amount: 50000, mode: "cash" } }));
    ok(q1.code === 200 && q2.code === 200, "both members' claims are accepted into the queue");
    fresh = await VenueBooking.findById(booking._id);
    s = summarizeSchedule(fresh);
    ok(s.totals.pending === 100000, "both sit as pending");
    ok(s.totals.received === 50000, "…and neither has moved the balance");
    const queued = s.rows[0].entries.filter((e) => e.status === "pending");
    ok(queued.length === 2, "both landed on instalment 1");
    const a1 = await call(lp.approveLeadPayment, asOwner({ params: { paymentId: String(queued[0].paymentId) } }));
    ok(a1.code === 200, "the first approves");
    const a2 = await call(lp.approveLeadPayment, asOwner({ params: { paymentId: String(queued[1].paymentId) } }));
    ok(a2.code === 409 && a2.body.code === "approval_overpays_milestone", `the second is refused with 409 (got ${a2.code})`);
    ok(/another payment was approved after this one was recorded/.test(a2.body.message), "…explaining WHY, not just refusing");
    fresh = await VenueBooking.findById(booking._id);
    ok(summarizeSchedule(fresh).totals.received === 100000, "received is 1,00,000 — not 1,50,000");

    // ══ REJECTION ═══════════════════════════════════════════════════════════
    console.log("\n[rejecting keeps the record, and requires a reason]");
    const stillPending = summarizeSchedule(fresh).rows[0].entries.find((e) => e.status === "pending");
    const noReason = await call(lp.rejectLeadPayment, asOwner({ params: { paymentId: String(stillPending.paymentId) }, body: {} }));
    ok(noReason.code === 400 && noReason.body.code === "reason_required", "a rejection with no reason is refused");
    const rej = await call(lp.rejectLeadPayment, asOwner({
      params: { paymentId: String(stillPending.paymentId) },
      body: { reason: "Duplicate of the cash payment already recorded" },
    }));
    ok(rej.code === 200, `reject → 200 (got ${rej.code})`);
    fresh = await VenueBooking.findById(booking._id);
    s = summarizeSchedule(fresh);
    const rejected = s.rows[0].entries.find((e) => e.status === "rejected");
    ok(!!rejected, "the rejected entry is STILL THERE — not deleted");
    ok(rejected.rejectionReason === "Duplicate of the cash payment already recorded", "…carrying the reason");
    ok(!!rejected.approvedByName || !!rejected.approvedAt, "…and who rejected it, when");
    ok(s.totals.received === 100000, "rejecting a pending entry changes nothing about received");
    ok(s.totals.pending === 0, "…and clears it from the pending total");

    console.log("\n[an APPROVED payment can be reversed — the only way to undo a typo]");
    const approvedEntry = summarizeSchedule(fresh).rows[0].entries.find((e) => e.status === "approved");
    const rev = await call(lp.rejectLeadPayment, asOwner({
      params: { paymentId: String(approvedEntry.paymentId || approvedEntry._id) },
      body: { reason: "Recorded against the wrong booking" },
    }));
    ok(rev.code === 200, `reversing an approved payment → 200 (got ${rev.code})`);
    fresh = await VenueBooking.findById(booking._id);
    s = summarizeSchedule(fresh);
    ok(s.totals.received === 50000, "received drops by the reversed amount");
    ok(s.rows[0].entries.filter((e) => e.status === "rejected").length === 2, "…and the reversal stays visible on the row");
    freshLead = await VenueEnquiry.findById(lead._id);
    act = (freshLead.activities || []).filter((a) => a.type === "payment_rejected").pop();
    ok(/reversed/i.test(act.description), `the timeline calls it a reversal, not a rejection — "${act.description}"`);

    // ══ EVERY SURFACE AGREES ════════════════════════════════════════════════
    console.log("\n[pending never leaks into any surface's received]");
    await call(lp.recordPayment, asMember({ body: { amount: 25000, mode: "upi" } }));
    fresh = await VenueBooking.findById(booking._id);
    const truth = summarizeSchedule(fresh);
    const leadView = await call(lp.getLeadPayments, asOwner());
    ok(leadView.body.totals.received === truth.totals.received, `lead received (${leadView.body.totals.received})`);
    ok(leadView.body.totals.pending === 25000, "lead surfaces pending separately");
    const summary = await call(vp.summary, {
      params: { slug: venue.slug }, query: {}, body: {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id }, venueMember: null,
    });
    const mine = (summary.body.perBooking || []).find((p) => String(p.bookingId) === String(booking._id));
    ok(!!mine && mine.received === truth.totals.received, `payments summary received matches (${mine ? mine.received : "n/a"})`);
    ok(!!mine && mine.balance === truth.totals.balance, "…and its balance");
    ok(!!mine && mine.pending === 25000, "…and it surfaces pending too");

    // ══ DENY SWEEP ══════════════════════════════════════════════════════════
    console.log("\n[deny sweep — approve/reject are lead-scoped, 404 not 403]");
    const otherVenue = await Venue.create({ name: `${TAG} Other`, slug: `${TAG}-o`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(otherVenue._id);
    const outsider = await VenueOwner.create({ venueId: otherVenue._id, name: "Outsider", phone: `${TAG}x`, isActive: true });
    created.owners.push(outsider._id);
    const outsiderReq = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: otherVenue._id, venueOwnerId: outsider._id }, venueMember: null,
    });
    const outPending = summarizeSchedule(fresh).rows[0].entries.find((e) => e.status === "pending");
    const dApprove = await call(lp.approveLeadPayment, outsiderReq({ params: { paymentId: String(outPending.paymentId) } }));
    ok(dApprove.code === 404, `approve outside scope → 404 (got ${dApprove.code})`);
    const dReject = await call(lp.rejectLeadPayment, outsiderReq({ params: { paymentId: String(outPending.paymentId) }, body: { reason: "x" } }));
    ok(dReject.code === 404, `reject outside scope → 404 (got ${dReject.code})`);
    const afterDeny = await VenueBooking.findById(booking._id);
    ok(summarizeSchedule(afterDeny).totals.received === truth.totals.received, "…and no denied call moved a rupee");
    ok(pendingOn(afterDeny.paymentSchedule[0]) === 25000, "…nor approved anything");
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      await VenueBooking.deleteMany({ _id: { $in: created.bookings } });
      await VenueEnquiry.deleteMany({ _id: { $in: created.leads } });
      await VenueTeamMember.deleteMany({ _id: { $in: created.members } });
      await VenueOwner.deleteMany({ _id: { $in: created.owners } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
