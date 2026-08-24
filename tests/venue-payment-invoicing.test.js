// Money model S6 — an invoice keys on the PAYMENT, not the milestone.
//
// A Rs. 1,00,000 payment that finishes one instalment and starts the next
// belongs to neither of them. Keying on the milestone forced it to be filed
// against whichever one somebody picked, which made the invoice disagree with
// the bank statement it exists to evidence.
//
// THE NO-DUPLICATE GUARANTEE IS THE DATABASE'S, not a read-then-write. The
// concurrency section below fires simultaneous raises and asserts that exactly
// one row exists afterwards — the controller's pre-check is only the friendly
// path, and it is deliberately bypassed in that test.
//
// Run: node tests/venue-payment-invoicing.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");

const lp = require("../controllers/venueLeadPayment");
const li = require("../controllers/venueLeadInvoice");

const TAG = `pinv-${Date.now()}`;
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
    // The guarantee is an INDEX. Without this the collection may have no index
    // built yet and the whole suite would pass while guaranteeing nothing.
    await VenueInvoice.init();

    const idx = await VenueInvoice.collection.indexes();
    const three = idx.find((i) => i.name === "enquiry_1_forMilestoneId_1_forPaymentId_1");
    ok(!!three, "the three-key unique index exists");
    ok(!!three && three.unique === true, "…and it is unique");
    ok(
      !!three && JSON.stringify(three.partialFilterExpression) === JSON.stringify({ enquiry: { $type: "objectId" } }),
      "…partial-filtered to lead invoices only, so booking-level paths are unaffected"
    );
    ok(!idx.find((i) => i.name === "enquiry_1_forMilestoneId_1"), "and the old two-key index is NOT created by the schema");

    const venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      gstin: "29ABCDE1234F1Z5", billing: { gstin: "29ABCDE1234F1Z5", legalName: `${TAG} Palace Pvt Ltd` },
    });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true, couplePhone: "9800001111", stage: "booked",
    });
    created.leads.push(lead._id);
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun", totalValue: 300000,
      days: [{ date: daysAhead(30), eventType: "wedding", guestCount: 200 }],
      gstMode: "per_instalment", gstPercent: 18,
      paymentSchedule: [
        { label: "Instalment 1", amount: 100000, dueDate: daysAgo(10), gstApplicable: true },
        { label: "Instalment 2", amount: 100000, dueDate: daysAhead(10), gstApplicable: false },
        { label: "Balance", amount: 100000, dueDate: daysAhead(20), gstApplicable: true },
      ],
    });
    created.bookings.push(booking._id);

    const req = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
      venueMember: null,
    });

    // ══ A PAYMENT SPANNING TWO INSTALMENTS ══════════════════════════════════
    console.log("\n[a payment that spans two instalments is ONE invoice]");
    const rec = await call(lp.recordPayment, req({ body: { amount: 150000, mode: "bank_transfer", reference: "NEFT-9" } }));
    ok(rec.code === 200, `recorded (got ${rec.code} ${rec.body && rec.body.message ? rec.body.message : ""})`);
    let fresh = await VenueBooking.findById(booking._id);
    const spanningId = String(fresh.paymentSchedule[0].entries[0].paymentId);
    const piecesOnRow2 = (fresh.paymentSchedule[1].entries || []).filter((e) => String(e.paymentId) === spanningId);
    ok(piecesOnRow2.length === 1, "it landed on two rows under one paymentId");

    const inv = await call(li.createLeadInvoice, req({ body: { paymentId: spanningId } }));
    ok(inv.code === 201 || inv.code === 200, `invoice raised (got ${inv.code} ${inv.body && inv.body.message ? inv.body.message : ""})`);
    const doc = await VenueInvoice.findOne({ enquiry: lead._id, forPaymentId: spanningId });
    ok(!!doc, "and it is keyed on the PAYMENT");
    if (doc) {
      ok(doc.forMilestoneId === null || doc.forMilestoneId === undefined, "…not on a milestone it only partly covers");
      ok(doc.lineItems.length === 2, "one line per instalment the money landed on");
      ok(doc.lineItems[0].unitPrice === 100000 && doc.lineItems[1].unitPrice === 50000,
        `each at what ACTUALLY landed there, not the instalment's face value (${doc.lineItems.map((l) => l.unitPrice).join(" + ")})`);
      ok(doc.totals.subtotal === 150000, "subtotal is the payment");
      // Instalment 1 bears GST, instalment 2 does not.
      ok(doc.totals.taxable === 100000, "only the GST-bearing instalment's share is taxable");
      ok(doc.totals.gst === 18000, "GST is 18% of THAT share — not of the whole payment");
      ok(doc.totals.grandTotal === 168000, "grand total 1,68,000");
      ok(doc.gstMode === "exclusive", "GST sits outside the agreed value, so it is exclusive");
    }

    console.log("\n[raising it twice is refused, and names the invoice that exists]");
    const again = await call(li.createLeadInvoice, req({ body: { paymentId: spanningId } }));
    ok(again.code === 409 && again.body.code === "invoice_exists", `409 invoice_exists (got ${again.code})`);
    ok(/already covers that payment/.test(String(again.body.message)), `"${again.body.message}"`);

    // ══ THE GUARANTEE IS THE INDEX ══════════════════════════════════════════
    console.log("\n[the no-duplicate guarantee survives concurrency — DATABASE, not read-then-write]");
    // The controller's pre-check is bypassed entirely: these are raw inserts of
    // the shape the controller would produce, fired together. If the guarantee
    // lived in the read-then-write, both would land.
    const racePaymentId = new mongoose.Types.ObjectId();
    const mkDoc = (n) => ({
      venue: venue._id, booking: booking._id, enquiry: lead._id,
      forMilestoneId: null, forPaymentId: racePaymentId,
      invoiceNumber: `${TAG}-RACE-${n}`, seq: 9000 + n,
      lineItems: [{ label: "race", category: "instalment", qty: 1, unitPrice: 1000 }],
      totals: { subtotal: 1000, discount: 0, taxable: 1000, gst: 0, grandTotal: 1000 },
      gstMode: "none", gstPercent: 0,
    });
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => VenueInvoice.create(mkDoc(n))));
    const won = results.filter((r) => r.status === "fulfilled").length;
    const lost = results.filter((r) => r.status === "rejected" && r.reason && r.reason.code === 11000).length;
    ok(won === 1, `exactly ONE of five simultaneous writes succeeded (got ${won})`);
    ok(lost === 4, `the other four lost on E11000 (got ${lost})`);
    const stored = await VenueInvoice.countDocuments({ enquiry: lead._id, forPaymentId: racePaymentId });
    ok(stored === 1, `and exactly one row exists for that payment (got ${stored})`);

    console.log("\n[the three rules coexist on one lead]");
    // booking-level + legacy milestone + payment — all three on the same lead.
    const bookingLevel = await VenueInvoice.create({
      venue: venue._id, booking: booking._id, enquiry: lead._id, forMilestoneId: null, forPaymentId: null,
      invoiceNumber: `${TAG}-BOOK`, seq: 9100,
      lineItems: [{ label: "booking", category: "venue", qty: 1, unitPrice: 300000 }],
      totals: { subtotal: 300000, discount: 0, taxable: 300000, gst: 0, grandTotal: 300000 },
      gstMode: "none", gstPercent: 0,
    });
    ok(!!bookingLevel, "a booking-level invoice coexists with the payment invoice");
    let dupBooking = null;
    try {
      await VenueInvoice.create({
        venue: venue._id, booking: booking._id, enquiry: lead._id, forMilestoneId: null, forPaymentId: null,
        invoiceNumber: `${TAG}-BOOK2`, seq: 9101,
        lineItems: [{ label: "booking", category: "venue", qty: 1, unitPrice: 300000 }],
        totals: { subtotal: 300000, discount: 0, taxable: 300000, gst: 0, grandTotal: 300000 },
        gstMode: "none", gstPercent: 0,
      });
    } catch (e) { dupBooking = e; }
    ok(dupBooking && dupBooking.code === 11000, "…but a SECOND booking-level invoice is still refused");
    const legacyMilestone = await VenueInvoice.create({
      venue: venue._id, booking: booking._id, enquiry: lead._id,
      forMilestoneId: fresh.paymentSchedule[2]._id, forPaymentId: null,
      invoiceNumber: `${TAG}-MS`, seq: 9102,
      lineItems: [{ label: "ms", category: "instalment", qty: 1, unitPrice: 100000 }],
      totals: { subtotal: 100000, discount: 0, taxable: 100000, gst: 0, grandTotal: 100000 },
      gstMode: "none", gstPercent: 0,
    });
    ok(!!legacyMilestone, "…and a legacy milestone-keyed invoice still works");

    // ══ GST DERIVED FROM THE INSTALMENT, NOT CHOSEN ═════════════════════════
    console.log("\n[a payment against a PLAIN instalment gets a plain invoice]");
    const plainRec = await call(lp.recordPayment, req({
      body: { amount: 50000, allocations: [{ milestoneId: String(fresh.paymentSchedule[1]._id), amount: 50000 }], mode: "cash" },
    }));
    ok(plainRec.code === 200, "recorded against the non-GST instalment");
    fresh = await VenueBooking.findById(booking._id);
    const plainEntry = (fresh.paymentSchedule[1].entries || []).filter((e) => e.method === "cash")[0];
    const plainInv = await call(li.createLeadInvoice, req({ body: { paymentId: String(plainEntry.paymentId) } }));
    ok(plainInv.code === 201 || plainInv.code === 200, `raised (got ${plainInv.code} ${plainInv.body && plainInv.body.message ? plainInv.body.message : ""})`);
    const plainDoc = await VenueInvoice.findOne({ enquiry: lead._id, forPaymentId: plainEntry.paymentId });
    ok(!!plainDoc && plainDoc.totals.gst === 0, "no GST on it");
    ok(!!plainDoc && plainDoc.gstMode === "none", "…and it is not a tax invoice");
    ok(!!plainDoc && plainDoc.totals.grandTotal === 50000, "grand total is the payment itself");

    console.log("\n[the owner cannot override what was agreed]");
    // body.gst is honoured on the legacy milestone path; on a payment invoice
    // the instalment decides, because a tax invoice must reflect the agreement.
    const forced = await call(li.createLeadInvoice, req({ body: { paymentId: String(plainEntry.paymentId), gst: true, gstPercent: 28 } }));
    ok(forced.code === 409, "raising it again is still refused regardless of the GST flags");

    console.log("\n[pending and rejected money is not invoiceable]");
    const b3 = await VenueBooking.findById(booking._id);
    const pendingRow = b3.paymentSchedule[2];
    const pendingPaymentId = new mongoose.Types.ObjectId();
    pendingRow.entries.push({ paymentId: pendingPaymentId, amount: 5000, status: "pending", recordedByName: "Staff" });
    await b3.save();
    const pendInv = await call(li.createLeadInvoice, req({ body: { paymentId: String(pendingPaymentId) } }));
    ok(pendInv.code === 409 && pendInv.body.code === "payment_pending", `pending → 409 payment_pending (got ${pendInv.code})`);
    ok(/approve it before invoicing/.test(String(pendInv.body.message)), "…saying what to do first");

    console.log("\n[an unknown payment is a 404, and scope is enforced]");
    const nope = await call(li.createLeadInvoice, req({ body: { paymentId: String(new mongoose.Types.ObjectId()) } }));
    ok(nope.code === 404, `unknown payment → 404 (got ${nope.code})`);
    const otherVenue = await Venue.create({ name: `${TAG} Other`, slug: `${TAG}-o`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(otherVenue._id);
    const outsider = await VenueOwner.create({ venueId: otherVenue._id, name: "Outsider", phone: `${TAG}x`, isActive: true });
    created.owners.push(outsider._id);
    const denied = await call(li.createLeadInvoice, {
      params: { slug: venue.slug, enquiryId: String(lead._id) }, query: {}, body: { paymentId: spanningId },
      venueOwner: { type: "venue_owner", venueId: otherVenue._id, venueOwnerId: outsider._id }, venueMember: null,
    });
    ok(denied.code === 404, `invoicing a lead outside scope → 404 not 403 (got ${denied.code})`);
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      await VenueInvoice.deleteMany({ enquiry: { $in: created.leads } });
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
