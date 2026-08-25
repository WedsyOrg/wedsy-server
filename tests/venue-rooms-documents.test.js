// ROOMS 5 slice 3 — the rooms line in the documents a couple actually reads,
// and last-minute rooms through the additional billing that already works.
//
// ── THE POINT ───────────────────────────────────────────────────────────────
// "Rooms Rs. 70,000" with no breakdown is the line that generates a phone
// call. Every document states HOW it was arrived at — how many rooms, how many
// were included, the rate, the nights — and states it in the same words the
// wizard showed the owner, because both come from describeRoomsWorking.
//
// It goes through the THREE EXISTING GENERATORS. No fourth document, and no
// document computing a rooms figure of its own: every one of them reads the
// amount frozen on the booking.
//
// Run: node tests/venue-rooms-documents.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const lp = require("../controllers/venueLeadPayment");
const { summarizeSchedule } = require("../utils/venuePaymentStatus");
const { buildStatementPdf } = require("../utils/venueStatementPdf");
const { buildBookingConfirmationPdf } = require("../utils/venueBookingConfirmationPdf");
const { buildInvoicePdf } = require("../utils/venueInvoicePdf");
const { describeRoomsWorking, describeAdditionalRooms, quoteRooms, resolvePolicy } = require("../utils/venueRoomsPolicy");

const TAG = `rdoc-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const daysAhead = (n) => new Date(Date.now() + n * 86400000);

/**
 * The RENDERED text, read back out of the PDF's hex runs — the same extraction
 * venue-statement.test.js uses.
 *
 * The first version of this suite asserted on `buffer.toString("latin1")`
 * directly. Every positive assertion failed (PDFKit hex-encodes the runs) and
 * every NEGATIVE one passed — "the confirmation says nothing about rooms" was
 * green against bytes it could not read. A negative assertion over an
 * unreadable buffer is exactly the vacuous shape; the extraction below is what
 * makes both directions mean something.
 */
function pdfText(built) {
  const raw = (built.buffer || built).toString("latin1");
  const runs = [];
  for (const arr of raw.match(/\[(.*?)\]\s*TJ/gs) || []) {
    for (const hex of arr.match(/<([0-9a-fA-F]+)>/g) || []) runs.push(Buffer.from(hex.slice(1, -1), "hex"));
  }
  return Buffer.concat(runs);
}
const asText = (built) => pdfText(built).toString("latin1");

let venue, owner, lead, booking;

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    venue = await Venue.create({
      name: `${TAG} Resort`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      rooms: Array.from({ length: 25 }, (_, i) => ({ name: `R${i + 1}`, isActive: true })),
      roomTypes: [{ name: "Deluxe", defaultRate: 4500 }],
      roomsPolicy: { configured: true, includedWithVenue: "count", includedCount: 10, extraRoomRate: 3500 },
    });
    owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`.slice(0, 14), isActive: true });
    lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true,
      couplePhone: "9800007777", stage: "booked",
    });

    const q = quoteRooms({
      policy: resolvePolicy(venue), roomsNeeded: 20, nights: 2, totalRoomsAtVenue: 25, typeRate: 4500,
    });
    eq(q.amount, 70000, "the fixture's rooms line is Rs. 70,000");

    booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun",
      totalValue: 570000, roomsRequired: 20,
      days: [{ date: daysAhead(30), eventType: "wedding", guestCount: 200 }],
      paymentSchedule: [
        { label: "Advance", amount: 285000, dueDate: daysAhead(1) },
        { label: "Balance", amount: 285000, dueDate: daysAhead(20) },
      ],
      roomsCharge: {
        roomsNeeded: 20, nights: 2, included: 10, chargeable: 10,
        ratePerNight: 3500, rateSource: "policy", includedSource: "policy",
        amount: 70000, sentence: q.sentence, quotedAt: new Date(),
      },
    });

    const WORKING = describeRoomsWorking(booking.roomsCharge);
    eq(WORKING, "20 rooms · 10 included · 10 × Rs. 3,500 × 2 nights", "the working reads as the wizard showed it");
    ok(booking.roomsCharge.sentence.startsWith(WORKING),
      "…and the wizard's full sentence is that same working plus its total — ONE composer, not two wordings");

    // ── [A] every generator states it, with the working ───────────────────
    console.log("\n[A. all three existing generators — no fourth document]");
    const summary = summarizeSchedule(booking);

    const conf = await buildBookingConfirmationPdf({ venue, booking, lead });
    const confText = asText(conf);
    // THE CONTROL for every assertion below: if the extraction returns nothing,
    // the negatives in section C would pass for the wrong reason.
    ok(confText.length > 200, `read ${confText.length} characters back out of the confirmation`);
    ok(confText.includes("Rooms"), "confirmation: names the rooms line");
    ok(confText.includes("Venue"), "confirmation: names the venue's own share beside it");
    ok(confText.includes("10 included"), "confirmation: states how many were included");
    ok(confText.includes("3,500"), "confirmation: states the rate");
    ok(confText.includes("2 nights"), "confirmation: states the nights");

    const stmt = await buildStatementPdf({ venue, booking, summary, invoices: [], lead });
    const stmtText = asText(stmt);
    ok(stmtText.includes("Rooms"), "statement: names the rooms line");
    ok(stmtText.includes("10 included") && stmtText.includes("3,500") && stmtText.includes("2 nights"),
      "statement: states the whole working");
    ok(stmtText.includes("5,70,000"), "statement: and the agreed value the two components add to");

    const inv = await buildInvoicePdf({
      venue, booking,
      invoice: { number: "INV-1", lineItems: [{ description: "Advance", amount: 285000 }], gstPercent: 0 },
    });
    const invText = asText(inv);
    ok(invText.includes("Includes rooms"), "invoice: says the booking value includes rooms");
    ok(invText.includes("70,000"), "invoice: with the amount");
    ok(invText.includes("10 included"), "invoice: and the working");

    // ── [B] the encoding, byte by byte ────────────────────────────────────
    // The working uses MIDDLE DOT and MULTIPLICATION SIGN. Both are WinAnsi, so
    // both are safe in standard-14 Helvetica — but that is exactly what was
    // assumed about MINUS SIGN, which rendered as a stray quote on a money
    // document. Asserted rather than assumed.
    console.log("\n[B. the working's punctuation survives WinAnsi]");
    for (const [name, text] of [["confirmation", confText], ["statement", stmtText], ["invoice", invText]]) {
      ok(text.includes("\xb7"), `${name}: MIDDLE DOT (0xB7) is present as one byte`);
      ok(text.includes("\xd7"), `${name}: MULTIPLICATION SIGN (0xD7) is present as one byte`);
      ok(!/−|‘|’|“|”/.test(text), `${name}: no non-WinAnsi punctuation leaked in`);
    }

    // ── [C] a booking with NO rooms line reads exactly as it always did ────
    console.log("\n[C. a booking with no rooms line is untouched]");
    const plainLead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Anika & Rohit", coupleNameManual: true, couplePhone: "9800008888", stage: "booked",
    });
    const plain = await VenueBooking.create({
      venue: venue._id, enquiry: plainLead._id, coupleName: "Anika & Rohit", totalValue: 400000,
      days: [{ date: daysAhead(40), eventType: "wedding", guestCount: 100 }],
      paymentSchedule: [{ label: "Full", amount: 400000, dueDate: daysAhead(5) }],
    });
    const plainConf = asText(await buildBookingConfirmationPdf({ venue, booking: plain, lead: plainLead }));
    const plainStmt = asText(await buildStatementPdf({ venue, booking: plain, summary: summarizeSchedule(plain), invoices: [], lead: plainLead }));
    ok(!plainConf.includes("included ·"), "confirmation: no rooms working");
    ok(!plainConf.includes("Rooms" + "Rs."), "confirmation: no rooms money line");
    ok(!plainStmt.includes("Rooms —"), "statement: no rooms row");
    ok(plainConf.includes("Booking value"), "confirmation: still reads exactly as it always has");

    // ── [D] last-minute rooms, through the billing that already works ─────
    console.log("\n[D. last-minute rooms are ordinary additional billing that SAYS it is rooms]");
    const req = (body) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id) }, query: {}, body,
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id }, venueMember: null,
    });
    const before = summarizeSchedule(await VenueBooking.findById(booking._id));
    const added = await call(lp.addAdditionalBilling, req({ label: "Extra rooms on the night", amount: 17500, roomsCount: 5, roomsNights: 1 }));
    eq(added.code, 201, "the charge is added through the EXISTING endpoint");

    const after = await VenueBooking.findById(booking._id).lean();
    const extra = after.paymentSchedule.find((r) => r.isAdditional);
    eq(extra.roomsCount, 5, "the room COUNT is stored as a number");
    eq(extra.roomsNights, 1, "…and so are the nights");
    eq(extra.label, "Extra rooms on the night", "🔴 the owner's own label is untouched — nothing was appended to what they typed");
    eq(describeAdditionalRooms(extra), "5 rooms × 1 night", "…and the detail is COMPOSED from the counts, never parsed back out of the label");

    const s2 = summarizeSchedule(after);
    eq(s2.totals.bookingValue, before.totals.bookingValue, "🔴 the agreed value did not move — this is additional billing, not a repricing");
    eq(s2.totals.additional, 17500, "…it is on top");
    eq(s2.totals.total, 587500, "…and the couple owes agreed + additional");

    const stmt2 = asText(await buildStatementPdf({ venue, booking: after, summary: s2, invoices: [], lead }));
    ok(stmt2.includes("5 rooms"), "🔴 the statement says what the charge WAS, six weeks later");
    ok(stmt2.includes("Extra rooms on the night"), "…beside the owner's own words");

    console.log("\n[E. bad rooms counts are refused, not rounded away]");
    for (const body of [
      { label: "x", amount: 100, roomsCount: "five" },
      { label: "x", amount: 100, roomsNights: -2 },
    ]) {
      const bad = await call(lp.addAdditionalBilling, req(body));
      eq(bad.code, 400, `${JSON.stringify(body)} → 400`);
    }
    // …and a charge with no rooms fields at all is still perfectly ordinary.
    const plainCharge = await call(lp.addAdditionalBilling, req({ label: "Extra bar", amount: 5000 }));
    eq(plainCharge.code, 201, "a charge that is not about rooms still works exactly as before");
    const afterPlain = await VenueBooking.findById(booking._id).lean();
    const bar = afterPlain.paymentSchedule.find((r) => r.label === "Extra bar");
    eq(bar.roomsCount, undefined, "…and stores no rooms fields");
    eq(describeAdditionalRooms(bar), "", "…and says nothing about rooms");
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      const leads = await VenueEnquiry.find({ venueId: venue && venue._id }).select("_id").lean();
      await VenueBooking.deleteMany({ venue: venue && venue._id });
      await VenueEnquiry.deleteMany({ _id: { $in: leads.map((l) => l._id) } });
      await VenueOwner.deleteMany({ _id: owner && owner._id });
      await Venue.deleteMany({ _id: venue && venue._id });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
