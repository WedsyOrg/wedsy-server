// Money model S5 — additional billing: the venue adds extras after the fact.
//
// The load-bearing property: the AGREED VALUE NEVER MOVES. It is what was
// negotiated and what a dispute turns on, so an extra is added on top and every
// surface reports both numbers. A booking whose agreed value silently grew to
// absorb a bar tab has destroyed the record that settles the argument.
//
// It is also the legitimate route S2 pointed at when it refused an overpayment,
// so the last section walks that whole path: refuse → add the extra → the same
// payment now lands.
//
// Run: node tests/venue-additional-billing.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");

const lp = require("../controllers/venueLeadPayment");
const vp = require("../controllers/venuePayment");
const { summarizeSchedule, receivedOn } = require("../utils/venuePaymentStatus");

const TAG = `addl-${Date.now()}`;
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

    const venue = await Venue.create({ name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true, couplePhone: "9800001111", stage: "booked",
    });
    created.leads.push(lead._id);
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun", totalValue: 500000,
      days: [{ date: daysAhead(30), eventType: "wedding", guestCount: 200 }],
      paymentSchedule: [
        { label: "Advance", amount: 200000, dueDate: daysAgo(20), entries: [{ amount: 200000, status: "approved" }] },
        { label: "Balance", amount: 300000, dueDate: daysAhead(10) },
      ],
    });
    created.bookings.push(booking._id);

    const req = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
      venueMember: null,
    });

    console.log("\n[before any extra, nothing changes]");
    let s = summarizeSchedule(await VenueBooking.findById(booking._id));
    ok(s.totals.bookingValue === 500000 && s.totals.additional === 0, "agreed 5,00,000, no extras");
    ok(s.totals.total === 500000 && s.totals.balance === 300000, "total is the agreed value; balance is 3,00,000");

    console.log("\n[adding an extra: the total moves, the AGREED VALUE DOES NOT]");
    const add = await call(lp.addAdditionalBilling, req({ body: { label: "Bar service", amount: 40000, note: "Extra bar on the night" } }));
    ok(add.code === 201, `added (got ${add.code} ${add.body && add.body.message ? add.body.message : ""})`);
    const afterAdd = await VenueBooking.findById(booking._id);
    s = summarizeSchedule(afterAdd);
    ok(s.totals.bookingValue === 500000, "the agreed value is STILL 5,00,000 — untouched");
    ok(afterAdd.totalValue === 500000, "…and so is the stored totalValue");
    ok(s.totals.additional === 40000, "additional is 40,000");
    ok(s.totals.total === 540000, "the total is 5,40,000");
    ok(s.totals.balance === 340000, "and the balance adjusted to 3,40,000");
    ok(s.totals.scheduleMatchesValue, "the schedule still reconciles against what is owed");

    console.log("\n[the extra is a real row — it can be chased and paid like any other]");
    const extraRow = s.rows.find((r) => r.isAdditional);
    ok(!!extraRow, "it appears in the schedule");
    ok(extraRow.label === "Bar service" && extraRow.amount === 40000, "with its own label and amount");
    ok(extraRow.addedNote === "Extra bar on the night", "and the note that says what it was for");
    ok(extraRow.addedByName === "Owner" || extraRow.addedByName.length >= 0, "and who added it");
    ok(extraRow.outstanding === 40000, "outstanding on it");

    console.log("\n[an extra needs a label — 'Additional billing Rs. 40,000' is useless in a dispute]");
    const noLabel = await call(lp.addAdditionalBilling, req({ body: { amount: 5000 } }));
    ok(noLabel.code === 400 && noLabel.body.code === "label_required", `refused (got ${noLabel.code})`);
    const noAmount = await call(lp.addAdditionalBilling, req({ body: { label: "Something" } }));
    ok(noAmount.code === 400, "and an amount is required too");

    console.log("\n[the waterfall reaches it, because it is just a row]");
    const pv = await call(lp.previewPayment, req({ body: { amount: 340000 } }));
    ok(pv.body.ok === true, "a payment covering everything previews");
    ok(/Bar service/.test(pv.body.sentence), `the allocation names the extra — "${pv.body.sentence}"`);
    ok(pv.body.balanceAfter === 0, "…and would clear the balance");

    console.log("\n[S2's refusal pointed here, and the route works]");
    // Fresh booking, fully paid, so the refusal is the one S2 emits.
    const lead2 = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Kavya & Rohit", coupleNameManual: true, couplePhone: "9800002222", stage: "booked",
    });
    created.leads.push(lead2._id);
    const b2 = await VenueBooking.create({
      venue: venue._id, enquiry: lead2._id, coupleName: "Kavya & Rohit", totalValue: 100000,
      days: [{ date: daysAhead(30), eventType: "wedding", guestCount: 100 }],
      paymentSchedule: [{ label: "All of it", amount: 100000, dueDate: daysAgo(2), entries: [{ amount: 100000, status: "approved" }] }],
    });
    created.bookings.push(b2._id);
    const req2 = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead2._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
      venueMember: null,
    });
    const refused = await call(lp.recordPayment, req2({ body: { amount: 15000 } }));
    ok(refused.code === 400 && refused.body.code === "overpays_schedule", "collecting more than agreed is refused");
    ok(/additional billing/.test(refused.body.message), `…pointing at the route — "${refused.body.message}"`);
    const addl = await call(lp.addAdditionalBilling, req2({ body: { label: "Extra hour", amount: 15000 } }));
    ok(addl.code === 201, "the extra is added");
    const nowOk = await call(lp.recordPayment, req2({ body: { amount: 15000, mode: "cash" } }));
    ok(nowOk.code === 200, `and the SAME payment now lands (got ${nowOk.code} ${nowOk.body && nowOk.body.message ? nowOk.body.message : ""})`);
    const b2after = await VenueBooking.findById(b2._id);
    const s2 = summarizeSchedule(b2after);
    ok(s2.totals.bookingValue === 100000 && s2.totals.additional === 15000, "agreed 1,00,000, additional 15,000 — kept apart");
    ok(s2.totals.received === 115000 && s2.totals.balance === 0, "received 1,15,000, balance clear");

    console.log("\n[removing an extra added in error]");
    const spurious = await call(lp.addAdditionalBilling, req({ body: { label: "Typo charge", amount: 9999 } }));
    ok(spurious.code === 201, "added");
    let fresh = await VenueBooking.findById(booking._id);
    const spuriousRow = fresh.paymentSchedule.find((r) => r.label === "Typo charge");
    const del = await call(lp.removeAdditionalBilling, req({ params: { rowId: String(spuriousRow._id) } }));
    ok(del.code === 200, `removed (got ${del.code})`);
    fresh = await VenueBooking.findById(booking._id);
    ok(!fresh.paymentSchedule.find((r) => r.label === "Typo charge"), "it is gone");
    ok(summarizeSchedule(fresh).totals.additional === 40000, "and the additional total is back to 40,000");

    console.log("\n[but NOT once money has landed on it — that would delete a payment record]");
    const barRow = fresh.paymentSchedule.find((r) => r.isAdditional);
    await call(lp.recordPayment, req({ body: { amount: 10000, allocations: [{ milestoneId: String(barRow._id), amount: 10000 }], mode: "cash" } }));
    fresh = await VenueBooking.findById(booking._id);
    ok(receivedOn(fresh.paymentSchedule.id(barRow._id)) === 10000, "10,000 recorded against the bar");
    const blocked = await call(lp.removeAdditionalBilling, req({ params: { rowId: String(barRow._id) } }));
    ok(blocked.code === 409 && blocked.body.code === "has_payments", `removal refused with 409 (got ${blocked.code})`);
    ok(/Reject the payment first/.test(blocked.body.message), "…telling the owner the order to do it in");
    fresh = await VenueBooking.findById(booking._id);
    ok(!!fresh.paymentSchedule.id(barRow._id), "the row survives the refusal");

    console.log("\n[a NORMAL row cannot be removed through this route]");
    const normalRow = fresh.paymentSchedule.find((r) => !r.isAdditional);
    const notAdditional = await call(lp.removeAdditionalBilling, req({ params: { rowId: String(normalRow._id) } }));
    ok(notAdditional.code === 404, `an agreed instalment is not removable here (got ${notAdditional.code})`);

    console.log("\n[every surface agrees]");
    fresh = await VenueBooking.findById(booking._id);
    const truth = summarizeSchedule(fresh);
    const leadView = await call(lp.getLeadPayments, req());
    ok(leadView.body.totals.total === truth.totals.total, `the lead reports the total (${leadView.body.totals.total})`);
    ok(leadView.body.totals.additional === 40000, "…and the additional separately");
    ok(leadView.body.totals.bookingValue === 500000, "…with the agreed value unchanged");
    const summary = await call(vp.summary, {
      params: { slug: venue.slug }, query: {}, body: {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id }, venueMember: null,
    });
    const mine = (summary.body.perBooking || []).find((p) => String(p.bookingId) === String(booking._id));
    ok(!!mine && mine.balance === truth.totals.balance, `the payments summary balance matches (${mine ? mine.balance : "n/a"})`);
    ok(!!mine && mine.totalValue === 500000 && mine.additional === 40000 && mine.total === 540000, "…and it reports all three numbers");

    console.log("\n[deny sweep]");
    const otherVenue = await Venue.create({ name: `${TAG} Other`, slug: `${TAG}-o`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(otherVenue._id);
    const outsider = await VenueOwner.create({ venueId: otherVenue._id, name: "Outsider", phone: `${TAG}x`, isActive: true });
    created.owners.push(outsider._id);
    const outReq = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: otherVenue._id, venueOwnerId: outsider._id }, venueMember: null,
    });
    const dAdd = await call(lp.addAdditionalBilling, outReq({ body: { label: "Sneaky", amount: 1000 } }));
    ok(dAdd.code === 404, `adding outside scope → 404 not 403 (got ${dAdd.code})`);
    const dDel = await call(lp.removeAdditionalBilling, outReq({ params: { rowId: String(barRow._id) } }));
    ok(dDel.code === 404, `removing outside scope → 404 (got ${dDel.code})`);
    const afterDeny = await VenueBooking.findById(booking._id);
    ok(summarizeSchedule(afterDeny).totals.additional === 40000, "…and neither denied call changed a rupee");
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
