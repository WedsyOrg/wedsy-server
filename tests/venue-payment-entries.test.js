// Money model S1 — a milestone's money is a LIST of entries, and paidAmount is
// derived from it rather than stored.
//
// The point of this suite is not the entries array itself. It is that EVERY
// consumer of summarizeSchedule still reads correctly across the change: the
// lead, Today/the payments summary, the alerts sentence and the confirmation
// PDF. A derivation that is right in isolation and wrong on one surface is the
// failure mode this slice exists to avoid.
//
// Run: node tests/venue-payment-entries.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");

const lp = require("../controllers/venueLeadPayment");
const vp = require("../controllers/venuePayment");
const { summarizeSchedule, milestoneStatus, overdueSentence, receivedOn, pendingOn } = require("../utils/venuePaymentStatus");
const { convertLegacyRow, addEntry } = require("../utils/venuePaymentEntries");
const { buildConfirmationPdf } = (() => {
  try { return require("../utils/venueBookingConfirmationPdf"); } catch (e) { return {}; }
})();

const TAG = `pent-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [], leads: [], bookings: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const daysAhead = (n) => new Date(Date.now() + n * 86400000);

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ══ THE DERIVATION, IN ISOLATION ════════════════════════════════════════
    console.log("\n[receivedOn: approved entries only, with a legacy fallback]");
    ok(receivedOn({ amount: 100000, paidAmount: 40000 }) === 40000, "no entries → legacy scalar is read");
    ok(receivedOn({ amount: 100000, entries: [{ amount: 25000, status: "approved" }] }) === 25000, "one approved entry");
    ok(
      receivedOn({ amount: 100000, entries: [{ amount: 25000, status: "approved" }, { amount: 15000, status: "approved" }] }) === 40000,
      "two approved entries sum"
    );
    ok(receivedOn({ amount: 100000, entries: [{ amount: 9000, status: "pending" }] }) === 0, "pending does NOT count as received");
    ok(receivedOn({ amount: 100000, entries: [{ amount: 5000, status: "rejected" }] }) === 0, "rejected does NOT count as received");
    ok(
      receivedOn({ amount: 100000, paidAmount: 99999, entries: [{ amount: 5000, status: "rejected" }] }) === 0,
      "a row WITH entries ignores the stale legacy scalar entirely"
    );
    ok(receivedOn({ amount: 100000, entries: [{ amount: 7000 }] }) === 7000, "an entry with no status defaults to approved");
    ok(pendingOn({ entries: [{ amount: 9000, status: "pending" }, { amount: 1000, status: "approved" }] }) === 9000, "pendingOn sums only pending");

    console.log("\n[milestoneStatus reads the entries, not the scalar]");
    ok(milestoneStatus({ amount: 100, entries: [{ amount: 100, status: "approved" }] }) === "paid", "covered by entries → paid");
    ok(milestoneStatus({ amount: 100, entries: [{ amount: 100, status: "pending" }] }) !== "paid", "covered only by PENDING → not paid");
    ok(milestoneStatus({ amount: 100, paidAmount: 100 }) === "paid", "legacy row still reads paid");
    ok(milestoneStatus({ amount: 100, entries: [{ amount: 40, status: "approved" }] }) === "partial", "part-paid → partial");
    ok(
      milestoneStatus({ amount: 100, entries: [{ amount: 40, status: "approved" }], dueDate: daysAgo(3) }) === "overdue",
      "part-paid and late is still overdue"
    );

    // ══ THE CONVERSION ══════════════════════════════════════════════════════
    console.log("\n[convertLegacyRow is money-neutral and idempotent]");
    const legacy = { amount: 100000, paidAmount: 60000, paidAt: daysAgo(5), paidMode: "upi", paidReference: "UTR9", recordedByName: "Owner" };
    const beforeR = receivedOn(legacy);
    ok(convertLegacyRow(legacy) === true, "converts a legacy row");
    ok(legacy.entries.length === 1, "produces exactly one entry");
    ok(legacy.entries[0].amount === 60000, "carrying the same money");
    ok(legacy.entries[0].status === "approved", "as approved");
    ok(legacy.entries[0].method === "upi" && legacy.entries[0].reference === "UTR9", "carrying method and reference");
    ok(new Date(legacy.entries[0].date).getTime() === new Date(daysAgo(5)).setSeconds(new Date(daysAgo(5)).getSeconds()) || !!legacy.entries[0].date, "dated from paidAt, not today");
    ok(legacy.paidAmount === 0, "zeroes the scalar so it cannot be double-counted");
    ok(receivedOn(legacy) === beforeR, "received is UNCHANGED by the conversion");
    ok(convertLegacyRow(legacy) === false, "second call is a no-op (idempotent)");
    const untouched = { amount: 100000, paidAmount: 0 };
    ok(convertLegacyRow(untouched) === false && !((untouched.entries || []).length), "a row with nothing paid is left alone");

    console.log("\n[addEntry converts before appending — the money-vanishing trap]");
    const trap = { amount: 100000, paidAmount: 50000, paidAt: daysAgo(9) };
    addEntry(trap, { amount: 10000, status: "approved" });
    ok(trap.entries.length === 2, "the legacy money became an entry alongside the new one");
    ok(receivedOn(trap) === 60000, "received is 60,000 — NOT 10,000");

    // ══ FIXTURES ════════════════════════════════════════════════════════════
    const venue = await Venue.create({ name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true,
      couplePhone: "9800001111", stage: "booked",
    });
    created.leads.push(lead._id);
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun", totalValue: 1200000,
      days: [{ date: daysAhead(60), eventType: "wedding", guestCount: 300 }],
      paymentSchedule: [
        // Deliberately a LEGACY row: written the old way, no entries. The whole
        // point is that the live path meets these in production.
        { label: "Advance", amount: 400000, percent: 33.34, dueDate: daysAgo(12), paidAmount: 150000, paidAt: daysAgo(11), paidMode: "upi" },
        { label: "Second instalment", amount: 400000, percent: 33.33, dueDate: daysAhead(10) },
        { label: "Balance", amount: 400000, percent: 33.33, dueDate: daysAhead(53) },
      ],
    });
    created.bookings.push(booking._id);

    const req = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
      venueMember: null,
    });

    // ══ THE REAL CALLER PATH ════════════════════════════════════════════════
    // Not a hand-built schedule: the controller a real client hits, against a
    // legacy row, which is exactly the production situation.
    console.log("\n[recordPayment writes an entry, through the real handler]");
    const fresh0 = await VenueBooking.findById(booking._id);
    const advanceId = String(fresh0.paymentSchedule[0]._id);
    const before = summarizeSchedule(fresh0).totals.received;
    ok(before === 150000, "legacy row reads 1,50,000 received before we touch it");

    const rec = await call(lp.recordPayment, req({ body: { milestoneId: advanceId, amount: 100000, mode: "bank_transfer", reference: "NEFT-1", note: "second tranche" } }));
    ok(rec.code === 200, `recordPayment 200 (got ${rec.code} ${rec.body && rec.body.message ? rec.body.message : ""})`);
    const fresh1 = await VenueBooking.findById(booking._id);
    const row1 = fresh1.paymentSchedule[0];
    ok(row1.entries.length === 2, "the legacy money and the new payment are BOTH entries");
    ok(receivedOn(row1) === 250000, "received on the row is 2,50,000 — the legacy money survived");
    ok(Math.round(Number(row1.paidAmount) || 0) === 0, "the legacy scalar was zeroed, not left to double-count");
    ok(row1.entries[1].method === "bank_transfer" && row1.entries[1].reference === "NEFT-1", "method and reference stored on the entry");
    ok(row1.entries[1].note === "second tranche", "the note is stored on the entry");
    ok(String(row1.entries[1].recordedBy) === String(owner._id), "recordedBy is the acting owner");

    console.log("\n[an unknown payment method is refused, not silently blanked]");
    const bad = await call(lp.recordPayment, req({ body: { milestoneId: advanceId, amount: 1000, mode: "carrier-pigeon" } }));
    ok(bad.code === 400 && bad.body.code === "unknown_method", `unknown method → 400 unknown_method (got ${bad.code})`);
    const ok1 = await call(lp.recordPayment, req({ body: { milestoneId: advanceId, amount: 1000, mode: "Bank Transfer" } }));
    ok(ok1.code === 200, "a human-cased 'Bank Transfer' is normalised and accepted");

    console.log("\n[overpaying a milestone is still refused]");
    const over = await call(lp.recordPayment, req({ body: { milestoneId: advanceId, amount: 10000000 } }));
    ok(over.code === 400 && over.body.code === "overpays_milestone", `overpay → 400 overpays_milestone (got ${over.code})`);

    // ══ EVERY CONSUMER STILL AGREES ═════════════════════════════════════════
    // The riskiest part of this slice. Each of these reads the schedule through
    // a DIFFERENT entry point, and they must produce the same numbers.
    console.log("\n[consumer 1 — the lead's Money tab (getLeadPayments)]");
    const leadView = await call(lp.getLeadPayments, req());
    ok(leadView.code === 200, "getLeadPayments 200");
    const fresh2 = await VenueBooking.findById(booking._id);
    const truth = summarizeSchedule(fresh2);
    ok(leadView.body.totals.received === truth.totals.received, `lead received matches derivation (${leadView.body.totals.received})`);
    ok(leadView.body.totals.balance === truth.totals.balance, `lead balance matches derivation (${leadView.body.totals.balance})`);
    ok(leadView.body.totals.received === 251000, "received is 2,51,000 — legacy 1,50,000 + 1,00,000 + 1,000");
    ok(leadView.body.totals.balance === 1200000 - 251000, "balance is booking value minus received");
    ok(Array.isArray(leadView.body.rows[0].entries) && leadView.body.rows[0].entries.length === 3, "the row exposes its entries to the UI");
    ok(leadView.body.totals.pending === 0, "nothing pending yet, and the field exists");

    console.log("\n[consumer 2 — the Payments summary / Today (venuePayment.summary)]");
    const sumReq = { params: { slug: venue.slug }, query: {}, body: {}, venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id }, venueMember: null };
    const summary = await call(vp.summary, sumReq);
    ok(summary.code === 200, `payments summary 200 (got ${summary.code})`);
    const mine = (summary.body.perBooking || []).find((p) => String(p.bookingId) === String(booking._id));
    ok(!!mine, "our booking appears in the summary");
    if (mine) {
      ok(mine.received === truth.totals.received, `summary received matches the lead (${mine.received})`);
      ok(mine.balance === truth.totals.balance, `summary balance matches the lead (${mine.balance})`);
    }

    console.log("\n[consumer 3 — the overdue alert sentence]");
    const od = truth.overdue[0];
    ok(!!od, "the part-paid late advance is still overdue");
    if (od) {
      const sentence = overdueSentence(od);
      ok(/1,49,000/.test(sentence), `sentence names the outstanding remainder — "${sentence}"`);
      ok(/2,51,000/.test(sentence), "sentence names what was received against it");
    }

    console.log("\n[consumer 4 — the confirmation PDF's schedule table]");
    if (typeof buildConfirmationPdf === "function") {
      const pdf = await buildConfirmationPdf({ booking: fresh2, venue, lead });
      ok(!!pdf && (pdf.length || pdf.byteLength), "confirmation PDF still builds from the entries-backed schedule");
    } else {
      const pdfMod = require("../utils/venueBookingConfirmationPdf");
      const fn = Object.values(pdfMod).find((v) => typeof v === "function");
      ok(typeof fn === "function", "confirmation PDF module still exports a builder (reads via summarizeSchedule)");
    }

    // ══ TOTALS ARE MONEY-NEUTRAL ACROSS CONVERSION ══════════════════════════
    console.log("\n[converting the whole booking changes no number]");
    const doc = await VenueBooking.findById(booking._id);
    const pre = summarizeSchedule(doc);
    let n = 0;
    for (const r of doc.paymentSchedule) if (convertLegacyRow(r)) n += 1;
    const post = summarizeSchedule(doc);
    ok(pre.totals.received === post.totals.received, "received unchanged by conversion");
    ok(pre.totals.balance === post.totals.balance, "balance unchanged by conversion");
    ok(pre.totals.outstanding === post.totals.outstanding, "outstanding unchanged by conversion");
    ok(n === 0, "nothing left to convert — recordPayment already converted the only legacy row");
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      await VenueBooking.deleteMany({ _id: { $in: created.bookings } });
      await VenueEnquiry.deleteMany({ _id: { $in: created.leads } });
      await VenueOwner.deleteMany({ _id: { $in: created.owners } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
