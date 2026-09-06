// Money model S4 — mixed fixed/percentage rows, and GST outside the agreed value.
//
// THE RULE THIS SUITE EXISTS FOR: exercise the path REAL CALLERS take. A guard
// once shipped having never executed because every test sent amounts-only
// schedules while the wizard sends percentages. So the confirm cases below send
// exactly what app/(portal)/crm/_components/confirm-booking.tsx sends — a mixed
// schedule with computed amounts, percent on the percentage rows only, plus
// gstMode/gstPercent — rather than a shape convenient to assert on.
//
// Run: node tests/venue-mixed-slabs-gst.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const sched = require("../utils/venuePaymentSchedule");
const vb = require("../controllers/venueBooking");

const TAG = `mix-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [], leads: [], bookings: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const daysAhead = (n) => new Date(Date.now() + n * 86400000);
const iso = (d) => new Date(d).toISOString().slice(0, 10);

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // ══ THE RULES, PURE ═════════════════════════════════════════════════════
    console.log("\n[fixed comes off the top; percentages split what remains]");
    const g1 = sched.generateSchedule({
      rows: [{ label: "On booking", amount: 100000 }, { label: "Second", percent: 50 }, { label: "Balance", percent: 50 }],
      totalValue: 950000,
    });
    ok(g1.rows[0].amount === 100000, "the fixed row is exactly what was typed");
    ok(g1.rows[1].amount === 425000 && g1.rows[2].amount === 425000, "the percentages split the remaining 8,50,000 — not 9,50,000");
    ok(g1.totals.percentBase === 850000, "totals name the base the percentages applied to");
    ok(g1.totals.amountsMatchBalance, "and the whole schedule still adds up to the balance");
    ok(g1.rows[0].percent === null, "a fixed row reports no percentage");

    console.log("\n[all-fixed is legal, and must land exactly]");
    const g2 = sched.generateSchedule({ rows: [{ amount: 500000 }, { amount: 450000 }], totalValue: 950000 });
    ok(g2.totals.amount === 950000 && g2.totals.amountsMatchBalance, "two fixed rows totalling the balance generate");
    let threw = null;
    try { sched.generateSchedule({ rows: [{ amount: 500000 }, { amount: 400000 }], totalValue: 950000 }); } catch (e) { threw = e; }
    ok(threw && /50,000 short/.test(threw.message), `all-fixed short is refused, naming the shortfall — "${threw && threw.message}"`);
    threw = null;
    try { sched.generateSchedule({ rows: [{ amount: 1000000 }], totalValue: 950000 }); } catch (e) { threw = e; }
    ok(threw && /50,000 more than/.test(threw.message), `fixed over the balance is refused, naming the excess`);
    threw = null;
    try { sched.generateSchedule({ rows: [{ amount: 950000 }, { percent: 100 }], totalValue: 950000 }); } catch (e) { threw = e; }
    ok(threw && /nothing to split/.test(threw.message), "fixed covering everything with percentage rows left over is refused");

    console.log("\n[a percentage WINS when a row carries a derived amount too]");
    // The editor has always shown a derived amount beside a percentage row, so
    // every shape-generated row carries both. Reading that as a conflict blocked
    // the wizard the moment any built-in shape was picked — found by driving it,
    // not by a unit test, which is why this case is pinned here now.
    const derived = sched.generateSchedule({
      rows: [{ label: "Advance", percent: 50, amount: 500000 }, { label: "Balance", percent: 50, amount: 500000 }],
      totalValue: 1000000,
    });
    ok(derived.rows.length === 2, "a shape-generated pair still generates");
    ok(derived.rows.every((r) => !r.isFixed), "…both are PERCENTAGE rows, not fixed ones");
    ok(derived.totals.amount === 1000000 && derived.totals.percentBase === 1000000, "…and the percentages split the whole balance");

    console.log("\n[a zero-value booking with percentages still generates — it is just undecided]");
    const g0 = sched.generateSchedule({ rows: [{ percent: 50 }, { percent: 50 }], totalValue: 0 });
    ok(g0.rows.length === 2 && g0.totals.amount === 0, "percentages of nothing produce rows of nothing, as they always did");

    console.log("\n[editing a fixed amount re-costs every percentage row]");
    const before = sched.generateSchedule({ rows: [{ amount: 100000 }, { percent: 50 }, { percent: 50 }], totalValue: 950000 });
    const after = sched.generateSchedule({ rows: [{ amount: 300000 }, { percent: 50 }, { percent: 50 }], totalValue: 950000 });
    ok(before.rows[1].amount === 425000 && after.rows[1].amount === 325000, "raising the fixed row lowers what the percentages split");
    ok(after.totals.amountsMatchBalance, "and it still adds up");

    console.log("\n[the residue lands on the last PERCENTAGE row, never on a fixed one]");
    const odd = sched.generateSchedule({ rows: [{ amount: 1 }, { percent: 33.34 }, { percent: 33.33 }, { percent: 33.33 }], totalValue: 100000 });
    ok(odd.rows[0].amount === 1, "the fixed row still holds exactly 1 — it did not absorb a rounding rupee");
    ok(odd.totals.amount === 100000, "and the schedule totals the balance exactly");

    console.log("\n[GST sits OUTSIDE the agreed value]");
    const gw = sched.generateSchedule({ rows: [{ amount: 100000 }], totalValue: 100000, gstMode: "whole", gstPercent: 18 });
    ok(gw.totals.amount === 100000, "the agreed total is unchanged by GST");
    ok(gw.totals.gst === 18000 && gw.totals.collectable === 118000, "collectable is 1,18,000 — what the couple transfers");
    ok(
      sched.rowArithmeticSentence(gw.rows[0], { gstPercent: 18 }) === "Instalment 1 — Rs. 1,00,000 + 18% GST = Rs. 1,18,000",
      "the row states its own arithmetic exactly as specified"
    );
    const gp = sched.generateSchedule({
      rows: [{ label: "A", amount: 100000, gstApplicable: true }, { label: "B", percent: 100 }],
      totalValue: 200000, gstMode: "per_instalment", gstPercent: 18,
    });
    ok(gp.rows[0].gst === 18000 && gp.rows[1].gst === 0, "per-instalment mode taxes only the flagged row");
    const gpIgnored = sched.generateSchedule({
      rows: [{ label: "A", amount: 100000, gstApplicable: false }, { label: "B", percent: 100 }],
      totalValue: 200000, gstMode: "whole", gstPercent: 18,
    });
    ok(gpIgnored.rows[0].gst === 18000 && gpIgnored.rows[1].gst === 18000, "whole mode ignores the per-row flags entirely");
    ok(sched.normaliseGst({ gstMode: "whole", gstPercent: 0 }).effective === false, "a mode with a 0% rate is no GST at all");

    // ══ THROUGH THE REAL CONFIRM PATH ═══════════════════════════════════════
    const venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      spaces: [{ name: "Lawn", type: "outdoor", capacitySeated: 300 }],
    });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);

    const makeLead = async (n) => {
      const l = await VenueEnquiry.create({
        venueId: venue._id, coupleName: `Couple ${n}`, coupleNameManual: true, couplePhone: `98000011${n}`, stage: "negotiating",
      });
      created.leads.push(l._id);
      return l;
    };
    const confirmReq = (lead, body) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id) },
      query: {}, body,
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
      venueMember: null,
    });
    let dayCursor = 400;
    const nextDate = () => iso(daysAhead((dayCursor += 3)));

    console.log("\n[the wizard's real payload: a mixed schedule with GST]");
    const lead1 = await makeLead(1);
    const date1 = nextDate();
    const r1 = await call(vb.confirmBookingFromLead, confirmReq(lead1, {
      functions: [{ date: date1, name: "wedding", pax: 300 }],
      tokenAmount: 50000, tokenMode: "upi",
      totalValue: 1000000,
      // EXACTLY the shape toApiSchedule builds: amounts computed for every row,
      // percent only on the percentage rows, gstApplicable only where ticked.
      paymentSchedule: [
        { label: "On booking", amount: 100000 },
        { label: "Second", amount: 425000, percent: 50 },
        { label: "Balance", amount: 425000, percent: 50 },
      ],
      gstMode: "whole", gstPercent: 18,
    }));
    ok(r1.code === 200 || r1.code === 201, `a mixed schedule confirms (got ${r1.code} ${r1.body && r1.body.message ? r1.body.message : ""})`);
    const b1 = await VenueBooking.findOne({ enquiry: lead1._id });
    created.bookings.push(b1 && b1._id);
    ok(!!b1, "the booking exists");
    if (b1) {
      ok(b1.gstMode === "whole" && b1.gstPercent === 18, "the GST mode and rate are stored ON THE BOOKING");
      const rows = b1.paymentSchedule.filter((r) => !/^Token/.test(r.label));
      ok(rows.length === 3, "all three rows were written");
      ok(rows[0].amount === 100000 && (rows[0].percent === null || rows[0].percent === undefined), "the fixed row kept its amount and no percentage");
      ok(rows[1].amount === 425000 && rows[2].amount === 425000, "the percentage rows are costed against the balance after the token");
      const token = b1.paymentSchedule.find((r) => /^Token/.test(r.label));
      ok(!!token && (token.entries || []).length === 1, "the token is still one approved entry (S1)");
      ok(token.amount + rows.reduce((s, r) => s + r.amount, 0) === 1000000, "token + rows = the booking value");
    }

    // ── FOUND BY DRIVING (wizard audit): the confirm loop DROPPED the
    // per-row GST flag — the wizard sent gstApplicable, the model has the
    // field, the PATCH path preserves it, and a per_instalment booking
    // confirmed through the wizard stored every row false. The owner watched
    // "+ GST Rs. 3,600 = collectable Rs. 3,53,600" and the system committed a
    // schedule carrying none. The screen and the write must agree.
    console.log("\n[the per-row GST tick survives the confirm]");
    const leadG = await makeLead(9);
    const rG = await call(vb.confirmBookingFromLead, confirmReq(leadG, {
      functions: [{ date: nextDate(), name: "wedding", pax: 100 }],
      totalValue: 350000,
      paymentSchedule: [
        { label: "Advance", amount: 165000, percent: 50 },
        { label: "Balance", amount: 165000, percent: 50 },
        { label: "GST Slab", amount: 20000, gstApplicable: true },
      ],
      gstMode: "per_instalment", gstPercent: 18,
    }));
    ok(rG.code === 200 || rG.code === 201, `a per_instalment schedule confirms (got ${rG.code} ${rG.body && rG.body.message ? rG.body.message : ""})`);
    const bG = await VenueBooking.findOne({ enquiry: leadG._id });
    created.bookings.push(bG && bG._id);
    if (bG) {
      const rowsG = bG.paymentSchedule.filter((r) => !/^Token/.test(r.label));
      ok(rowsG.find((r) => r.label === "GST Slab")?.gstApplicable === true,
        "🔴 the ticked row is stored gstApplicable:true — what the owner saw is what was committed");
      ok(rowsG.filter((r) => r.label !== "GST Slab").every((r) => !r.gstApplicable),
        "…and the unticked rows stay false");
    }

    console.log("\n[a mixed schedule that does not add up is refused, with the arithmetic]");
    const lead2 = await makeLead(2);
    const r2 = await call(vb.confirmBookingFromLead, confirmReq(lead2, {
      functions: [{ date: nextDate(), name: "wedding", pax: 300 }],
      totalValue: 1000000,
      paymentSchedule: [
        { label: "On booking", amount: 100000 },
        { label: "Second", amount: 400000, percent: 40 },
        { label: "Balance", amount: 400000, percent: 40 },
      ],
    }));
    ok(r2.code === 400, `refused (got ${r2.code})`);
    ok(/20% |remaining/.test(String(r2.body && r2.body.message)), `the message names the shortfall — "${r2.body && r2.body.message}"`);
    ok(!(await VenueBooking.findOne({ enquiry: lead2._id })), "NOTHING was written on refusal");

    console.log("\n[fixed exceeding the balance is refused by the write, not just the UI]");
    const lead3 = await makeLead(3);
    const r3 = await call(vb.confirmBookingFromLead, confirmReq(lead3, {
      functions: [{ date: nextDate(), name: "wedding", pax: 300 }],
      totalValue: 500000,
      paymentSchedule: [{ label: "Too big", amount: 600000 }, { label: "Rest", amount: 100000, percent: 100 }],
    }));
    ok(r3.code === 400, `refused (got ${r3.code})`);
    ok(/more than/.test(String(r3.body && r3.body.message)), `naming the excess — "${r3.body && r3.body.message}"`);

    console.log("\n[GST is not silently inherited — a booking with no GST stated has none]");
    const lead4 = await makeLead(4);
    const r4 = await call(vb.confirmBookingFromLead, confirmReq(lead4, {
      functions: [{ date: nextDate(), name: "wedding", pax: 300 }],
      totalValue: 200000,
      paymentSchedule: [{ label: "All of it", amount: 200000 }],
    }));
    ok(r4.code === 200 || r4.code === 201, `confirms (got ${r4.code})`);
    const b4 = await VenueBooking.findOne({ enquiry: lead4._id });
    if (b4) created.bookings.push(b4._id);
    ok(b4 && b4.gstMode === "none" && b4.gstPercent === 0, "no GST stated → none stored");

    console.log("\n[an all-percentage schedule still behaves exactly as before]");
    const lead5 = await makeLead(5);
    const r5 = await call(vb.confirmBookingFromLead, confirmReq(lead5, {
      functions: [{ date: nextDate(), name: "wedding", pax: 300 }],
      tokenAmount: 25000, tokenMode: "cash", totalValue: 100000,
      paymentSchedule: [{ label: "A", amount: 37500, percent: 50 }, { label: "B", amount: 37500, percent: 50 }],
    }));
    ok(r5.code === 200 || r5.code === 201, `the pre-S4 shape confirms unchanged (got ${r5.code} ${r5.body && r5.body.message ? r5.body.message : ""})`);
    const b5 = await VenueBooking.findOne({ enquiry: lead5._id });
    if (b5) created.bookings.push(b5._id);
    ok(b5 && b5.paymentSchedule.reduce((s, r) => s + r.amount, 0) === 100000, "…and still totals the booking value");
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      await VenueBooking.deleteMany({ _id: { $in: created.bookings.filter(Boolean) } });
      await VenueEnquiry.deleteMany({ _id: { $in: created.leads } });
      await VenueOwner.deleteMany({ _id: { $in: created.owners } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
