// Build B — the deny sweep the other suites did NOT cover.
//
// Every money suite in this build denies with a CROSS-VENUE OWNER. That
// exercises the ownership check in resolveOwnedLead:
//
//     if (String(venue._id) !== String(req.venueOwner.venueId)) → 404
//
// which is a DIFFERENT BRANCH from the one that actually scopes leads:
//
//     utils/venueLeadScope.scopedLeadFilter:
//       if (!canViewAllLeads(...)) filter.assignedTo = venueOwner.memberId
//
// That second branch is the reason a Sales member cannot read a colleague's
// lead, and nothing in this build was testing it. A same-venue member is the
// realistic attacker — they hold a valid token for this venue, they pass every
// ownership check, and the only thing between them and another member's money
// is the assignedTo narrowing.
//
// Every new money surface is swept by DIRECT ID: read, preview, record,
// approve, reject, add a charge, remove a charge, and raise an invoice.
// 404 never 403, and nothing moved.
//
// Run: node tests/venue-money-member-scope.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");

const lp = require("../controllers/venueLeadPayment");
const li = require("../controllers/venueLeadInvoice");
const { summarizeSchedule } = require("../utils/venuePaymentStatus");
const { canViewAllLeads } = require("../utils/venueLeadScope");

const TAG = `mscope-${Date.now()}`;
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
    await VenueInvoice.init();

    const venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      gstin: "29ABCDE1234F1Z5", billing: { gstin: "29ABCDE1234F1Z5", legalName: `${TAG} Pvt Ltd` },
    });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);

    const mkMember = async (s) => {
      const m = await VenueTeamMember.create({
        venueId: venue._id, ownerId: owner._id, name: `${TAG}-${s}`,
        phone: `${TAG}${s}`, email: `${TAG}${s}@x.com`, role: "sales", isActive: true,
      });
      created.members.push(m._id);
      return m;
    };
    const salesA = await mkMember("A"); // the lead is assigned to A
    const salesB = await mkMember("B"); // …and B is the scoped attacker

    // The premise: "sales" must NOT hold leads_view_all, or assignedTo never
    // narrows and this suite would pass while testing nothing.
    const bCanViewAll = await canViewAllLeads(
      { type: "venue_owner", venueId: venue._id, memberId: salesB._id, role: "sales" },
      salesB
    );
    ok(bCanViewAll === false, "PREMISE: a sales member does NOT have leads_view_all, so assignedTo narrowing applies");

    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true,
      couplePhone: "9800001111", stage: "booked", assignedTo: salesA._id,
    });
    created.leads.push(lead._id);
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun", totalValue: 300000,
      days: [{ date: daysAhead(30), eventType: "wedding", guestCount: 200 }],
      gstMode: "whole", gstPercent: 18,
      paymentSchedule: [
        { label: "Instalment 1", amount: 100000, dueDate: daysAgo(10), entries: [{ amount: 100000, status: "approved", method: "upi" }] },
        { label: "Instalment 2", amount: 100000, dueDate: daysAhead(10) },
        { label: "Extra bar", amount: 100000, dueDate: daysAgo(1), isAdditional: true, addedNote: "night bar" },
      ],
    });
    created.bookings.push(booking._id);

    const fresh = await VenueBooking.findById(booking._id);
    const paidRow = fresh.paymentSchedule[0];
    const dueRow = fresh.paymentSchedule[1];
    const extraRow = fresh.paymentSchedule[2];
    const existingPaymentId = String(paidRow.entries[0].paymentId || paidRow.entries[0]._id);

    // A pending entry to attack the approve/reject surfaces with.
    const pendingPaymentId = new mongoose.Types.ObjectId();
    dueRow.entries.push({ paymentId: pendingPaymentId, amount: 25000, status: "pending", recordedByName: "Someone" });
    await fresh.save();

    const before = summarizeSchedule(await VenueBooking.findById(booking._id));
    const invoicesBefore = await VenueInvoice.countDocuments({ enquiry: lead._id });

    // The attacker: a REAL member of THIS venue, with a valid token, who simply
    // is not assigned this lead. Every ownership check they meet, they pass.
    const asB = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, memberId: salesB._id, role: "sales" },
      venueMember: salesB,
    });
    // The control: the SAME request shape as the member the lead IS assigned to.
    const asA = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, memberId: salesA._id, role: "sales" },
      venueMember: salesA,
    });

    console.log("\n[the control — the assigned member CAN reach it, so a 404 below means scope, not breakage]");
    const aRead = await call(lp.getLeadPayments, asA());
    ok(aRead.code === 200, `the assigned member reads the schedule (got ${aRead.code})`);
    ok(aRead.body && aRead.body.totals && aRead.body.totals.received === 100000, "…and sees the real numbers");

    console.log("\n[every money surface, by DIRECT id, as a same-venue member who is not assigned]");
    const sweeps = [
      ["GET payments", lp.getLeadPayments, asB()],
      ["POST payments/preview", lp.previewPayment, asB({ body: { amount: 50000 } })],
      ["POST payments (record)", lp.recordPayment, asB({ body: { amount: 50000, mode: "cash" } })],
      ["POST payments/:id/approve", lp.approveLeadPayment, asB({ params: { paymentId: String(pendingPaymentId) } })],
      ["POST payments/:id/reject", lp.rejectLeadPayment, asB({ params: { paymentId: String(pendingPaymentId) }, body: { reason: "not mine" } })],
      ["POST additional-billing", lp.addAdditionalBilling, asB({ body: { label: "Sneaky charge", amount: 5000 } })],
      ["DELETE additional-billing/:rowId", lp.removeAdditionalBilling, asB({ params: { rowId: String(extraRow._id) } })],
      ["POST invoices (by payment)", li.createLeadInvoice, asB({ body: { paymentId: existingPaymentId } })],
      ["POST invoices (by milestone)", li.createLeadInvoice, asB({ body: { milestoneId: String(dueRow._id) } })],
      ["GET invoices", li.listLeadInvoices, asB()],
    ];
    for (const [name, fn, req] of sweeps) {
      const r = await call(fn, req);
      ok(r.code === 404, `${name} → 404 (got ${r.code})`);
      ok(r.code !== 403, `${name} → never 403, which would confirm the lead exists`);
    }

    console.log("\n[and NOTHING moved]");
    const after = summarizeSchedule(await VenueBooking.findById(booking._id));
    ok(after.totals.received === before.totals.received, `received unchanged (${after.totals.received})`);
    ok(after.totals.balance === before.totals.balance, `balance unchanged (${after.totals.balance})`);
    ok(after.totals.pending === before.totals.pending, `pending unchanged (${after.totals.pending}) — nothing was approved or rejected`);
    ok(after.totals.additional === before.totals.additional, "additional unchanged — no charge was added");
    ok(after.rows.length === before.rows.length, "no row added or removed");
    const stillPending = after.rows.flatMap((r) => r.entries || []).filter((e) => e.status === "pending");
    ok(stillPending.length === 1, "the pending entry is still pending — neither approved nor rejected");
    ok(await VenueInvoice.countDocuments({ enquiry: lead._id }) === invoicesBefore, "no invoice was raised, and no number consumed");

    console.log("\n[the same member CAN act once the lead is theirs — the guard is scope, not a blanket denial]");
    await VenueEnquiry.updateOne({ _id: lead._id }, { $set: { assignedTo: salesB._id } });
    const nowAllowed = await call(lp.getLeadPayments, asB());
    ok(nowAllowed.code === 200, `reassigned to B, the same request now succeeds (got ${nowAllowed.code})`);
    ok(nowAllowed.body.totals.received === before.totals.received, "…and reads the same numbers the owner sees");
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      await VenueInvoice.deleteMany({ enquiry: { $in: created.leads } });
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
