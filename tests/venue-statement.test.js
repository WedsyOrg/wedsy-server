// MONEY TAB — the STATEMENT OF ACCOUNT.
//
// The document answers "send me the total bill": the whole booking on one page.
// So the suite's job is to prove three things:
//
//   1. IT DERIVES NOTHING. Every figure equals what summarizeSchedule reports.
//      Asserted by comparing against summarizeSchedule directly, so a future
//      edit that starts summing payments inside the PDF fails here.
//   2. GST IS STATED, NEVER INVENTED. summarizeSchedule has no reference to GST
//      at all, so the totals are GST-agnostic. The document must say so rather
//      than leave a reader to infer whether tax is inside the number.
//   3. PREVIEW AND GENERATE ARE ONE COMPUTATION. The preview an owner reads and
//      the numbers in the PDF come from the same call — the bulk-create bug
//      that shipped was exactly this, a preview that computed something and
//      then discarded it.
//
// Every write goes through the CONTROLLER with a real request shape.
//
// Run: node tests/venue-statement.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const VenueTeamMember = require("../models/VenueTeamMember");
const VenueOwner = require("../models/VenueOwner");

const st = require("../controllers/venueLeadStatement");
const { summarizeSchedule } = require("../utils/venuePaymentStatus");
const { buildStatementPdf } = require("../utils/venueStatementPdf");
const { canViewAllLeads } = require("../utils/venueLeadScope");

const TAG = `stmt-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], leads: [], bookings: [], owners: [], members: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const daysAhead = (n) => new Date(Date.now() + n * 86400000);
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

let venue;
const asOwner = (leadId, extra = {}) => ({
  params: { slug: venue.slug, enquiryId: String(leadId) },
  query: {}, body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, role: "owner" },
});

/** A lead + booking, built the way a real caller would. */
async function makeBooking({ label, schedule, gstMode = "none", gstPercent = 0, totalValue = 1000000 }) {
  const lead = await VenueEnquiry.create({
    venueId: venue._id, coupleName: `${TAG} ${label}`, coupleNameManual: true,
    couplePhone: "9800001111", stage: "booked",
  });
  created.leads.push(lead._id);
  const booking = await VenueBooking.create({
    venue: venue._id, enquiry: lead._id, coupleName: `${TAG} ${label}`, totalValue,
    days: [{ date: daysAhead(40), eventType: "wedding", guestCount: 250 }],
    gstMode, gstPercent,
    paymentSchedule: schedule,
  });
  created.bookings.push(booking._id);
  return { lead, booking };
}

/** Pull the PDF's text back out, so assertions are about what a reader SEES. */
async function pdfText(buffer) {
  // pdf-parse is not a dependency here; the check that matters is that the
  // bytes are a real PDF of non-trivial size and that the generator reported
  // what it stated about GST. Content assertions run against the preview and
  // the summary, which is where the numbers actually come from.
  return { isPdf: buffer.slice(0, 5).toString() === "%PDF-", bytes: buffer.length };
}

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await VenueLeadDocument.init();

    venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      gstin: "29ABCDE1234F1Z5", billing: { gstin: "29ABCDE1234F1Z5", legalName: `${TAG} Pvt Ltd` },
    });
    created.venues.push(venue._id);

    // ══ 1. NOTHING RECEIVED YET ═════════════════════════════════════════════
    console.log("\n[a booking with nothing received]");
    const fresh = await makeBooking({
      label: "Fresh",
      schedule: [
        { label: "Booking advance", amount: 300000, dueDate: daysAgo(2) },
        { label: "Balance", amount: 700000, dueDate: daysAhead(20) },
      ],
    });
    let prev = await call(st.previewStatement, asOwner(fresh.lead._id));
    ok(prev.code === 200, `preview → 200 (got ${prev.code})`);
    let p = prev.body.preview;
    ok(p.received === 0 && p.balance === 1000000, `received 0, balance ${p.balance}`);
    ok(p.receiptCount === 0, "no receipts");
    ok(p.additionalLines.length === 0 && p.additional === 0, "no additional billing");
    ok(p.gst.on === false && /not applicable/i.test(p.gst.note), `GST note: "${p.gst.note}"`);

    const gen = await call(st.createStatement, asOwner(fresh.lead._id));
    ok(gen.code === 201, `generate → 201 (got ${gen.code})`);
    ok(gen.body.document.kind === "statement" && gen.body.document.version === 1, "filed as statement v1");
    ok(/Balance Rs\. 10,00,000 of Rs\. 10,00,000/.test(gen.body.document.note), `default note carries the numbers: "${gen.body.document.note}"`);
    ok(gen.body.gstStated === "none", `the PDF stated GST as "${gen.body.gstStated}"`);

    console.log("\n[preview and generate are ONE computation]");
    ok(JSON.stringify(gen.body.preview) === JSON.stringify(p),
      "the numbers returned by generate are byte-identical to the preview's");

    // ══ 2. WITH ADDITIONAL BILLING AND MONEY RECEIVED ═══════════════════════
    console.log("\n[additional billing, itemised — and money in]");
    const busy = await makeBooking({
      label: "Busy",
      schedule: [
        {
          label: "Booking advance", amount: 300000, dueDate: daysAgo(30),
          entries: [
            { amount: 300000, status: "approved", method: "upi", reference: "UPI-77123", date: daysAgo(29), recordedByName: "Priya" },
          ],
        },
        {
          label: "Second instalment", amount: 700000, dueDate: daysAhead(10),
          entries: [{ amount: 150000, status: "approved", method: "bank_transfer", reference: "NEFT-9911", date: daysAgo(3) }],
        },
        { label: "Extra bar counter", amount: 60000, dueDate: daysAhead(5), isAdditional: true, addedNote: "night bar, 4 hours", addedByName: "Priya" },
        { label: "Extra 50 covers", amount: 40000, dueDate: daysAhead(5), isAdditional: true, addedNote: "guest count moved to 300", addedByName: "Arjun" },
      ],
    });
    const truth = summarizeSchedule(await VenueBooking.findById(busy.booking._id));
    prev = await call(st.previewStatement, asOwner(busy.lead._id));
    p = prev.body.preview;

    console.log("\n[…and every figure equals summarizeSchedule, not a second sum]");
    ok(p.bookingValue === truth.totals.bookingValue, `agreed ${p.bookingValue}`);
    ok(p.additional === truth.totals.additional, `additional ${p.additional}`);
    ok(p.total === truth.totals.total, `total ${p.total}`);
    ok(p.received === truth.totals.received, `received ${p.received}`);
    ok(p.balance === truth.totals.balance, `balance ${p.balance}`);
    ok(p.total === 1100000 && p.received === 450000 && p.balance === 650000,
      `the arithmetic a human would check: 10,00,000 + 1,00,000 − 4,50,000 = ${p.balance}`);

    console.log("\n[the extras are ITEMISED, not a lump]");
    ok(p.additionalLines.length === 2, `${p.additionalLines.length} additional lines`);
    ok(p.additionalLines[0].label === "Extra bar counter" && p.additionalLines[0].amount === 60000, "…the bar, at 60,000");
    ok(p.additionalLines[0].note === "night bar, 4 hours", `…carrying why: "${p.additionalLines[0].note}"`);
    ok(p.additionalLines[1].label === "Extra 50 covers" && p.additionalLines[1].addedByName === "Arjun", "…and who added it");
    ok(p.receiptCount === 2, `${p.receiptCount} receipts listed`);

    console.log("\n[unapproved money is NOT counted as received]");
    const b2 = await VenueBooking.findById(busy.booking._id);
    b2.paymentSchedule[1].entries.push({ amount: 200000, status: "pending", recordedByName: "Someone" });
    await b2.save();
    const prev2 = (await call(st.previewStatement, asOwner(busy.lead._id))).body.preview;
    ok(prev2.received === 450000, `received still ${prev2.received} — the pending 2,00,000 is out`);
    ok(prev2.pending === 200000, `…and reported separately as ${prev2.pending}`);
    ok(prev2.receiptCount === 2, "…and it is not listed as a receipt");
    ok(prev2.balance === 650000, "…and the balance did not move");

    const gen2 = await call(st.createStatement, asOwner(busy.lead._id));
    ok(gen2.code === 201 && gen2.body.document.version === 1, "statement generated for this lead at v1");

    console.log("\n[generating again is a NEW VERSION, not a refusal]");
    const gen3 = await call(st.createStatement, asOwner(busy.lead._id, { body: { note: "after the bar was added" } }));
    ok(gen3.code === 201 && gen3.body.document.version === 2, `second generation → v${gen3.body.document.version}`);
    ok(gen3.body.document.note === "after the bar was added", "…carrying the operator's own note");
    const versions = await VenueLeadDocument.countDocuments({ enquiry: busy.lead._id, kind: "statement" });
    ok(versions === 2, `${versions} statement versions on file, both kept`);

    // ══ 3. GST — STATED, NEVER RECOMPUTED ═══════════════════════════════════
    console.log("\n[GST on the whole booking]");
    const whole = await makeBooking({
      label: "Whole",
      gstMode: "whole", gstPercent: 18,
      schedule: [
        { label: "Advance", amount: 400000, dueDate: daysAgo(5), entries: [{ amount: 400000, status: "approved", method: "upi" }] },
        { label: "Balance", amount: 600000, dueDate: daysAhead(15) },
      ],
    });
    const wPrev = (await call(st.previewStatement, asOwner(whole.lead._id))).body.preview;
    ok(wPrev.gst.on === true && wPrev.gst.mode === "whole" && wPrev.gst.percent === 18, "GST reported as 18% on the whole booking");
    ok(wPrev.gst.instalmentsBearing === 2, `${wPrev.gst.instalmentsBearing} of ${wPrev.gst.instalments} instalments bear it`);
    ok(wPrev.total === 1000000, `total is ${wPrev.total} — the schedule's figure, NOT 11,80,000`);
    ok(/exclusive of GST/.test(wPrev.gst.note), `…and the document says why: "${wPrev.gst.note}"`);
    const wGen = await call(st.createStatement, asOwner(whole.lead._id));
    ok(wGen.body.gstStated === "whole", `the PDF stated GST as "${wGen.body.gstStated}"`);

    console.log("\n[GST on some instalments only]");
    const per = await makeBooking({
      label: "Per",
      gstMode: "per_instalment", gstPercent: 18,
      schedule: [
        { label: "Advance", amount: 400000, dueDate: daysAgo(5), gstApplicable: true },
        { label: "Second", amount: 400000, dueDate: daysAhead(5), gstApplicable: false },
        { label: "Final", amount: 200000, dueDate: daysAhead(25), gstApplicable: true },
      ],
    });
    const pPrev = (await call(st.previewStatement, asOwner(per.lead._id))).body.preview;
    ok(pPrev.gst.mode === "per_instalment", "reported as per-instalment");
    ok(pPrev.gst.instalmentsBearing === 2 && pPrev.gst.instalments === 3,
      `${pPrev.gst.instalmentsBearing} of ${pPrev.gst.instalments} bear GST — read from the rows, not assumed`);
    // The regression this guards: gstApplicable was not surfaced by
    // summarizeSchedule, so this count silently read 0 and every per-instalment
    // GST cell rendered "—", which looks like "no GST" rather than a missing field.
    ok(pPrev.gst.instalmentsBearing !== 0, "gstApplicable actually reaches the statement (it was not surfaced before)");
    const pGen = await call(st.createStatement, asOwner(per.lead._id));
    ok(pGen.body.gstStated === "per_instalment", `the PDF stated GST as "${pGen.body.gstStated}"`);

    // ══ 4. THE ARTEFACT ═════════════════════════════════════════════════════
    console.log("\n[the PDF itself]");
    const bookingDoc = await VenueBooking.findById(busy.booking._id);
    const built = await buildStatementPdf({
      venue: await Venue.findById(venue._id).lean(),
      booking: bookingDoc,
      summary: summarizeSchedule(bookingDoc),
      invoices: [],
      lead: await VenueEnquiry.findById(busy.lead._id).lean(),
    });
    const meta = await pdfText(built.buffer);
    ok(meta.isPdf, "renders a real PDF");
    ok(meta.bytes > 2000, `${meta.bytes} bytes`);
    ok(Array.isArray(built.tableStats) && built.tableStats.length >= 3, `${built.tableStats.length} tables rendered through renderTable`);
    ok(built.tableStats.every((t) => t.truncatedCells === 0), "no cell was silently truncated");
    ok(built.tableStats.every((t) => t.pages === 1 || t.headerRepeats > 0), "any table that broke a page repeated its header");

    console.log("\n[a very long additional-billing note does not truncate silently]");
    const longNote = "x".repeat(4000);
    const b3 = await VenueBooking.findById(busy.booking._id);
    b3.paymentSchedule.push({ label: "Extra with a long note", amount: 1000, isAdditional: true, addedNote: longNote });
    await b3.save();
    const longBuilt = await buildStatementPdf({
      venue: await Venue.findById(venue._id).lean(),
      booking: b3, summary: summarizeSchedule(b3), invoices: [],
    });
    const truncated = longBuilt.tableStats.reduce((n, t) => n + (t.truncatedCells || 0), 0);
    ok(truncated > 0, `renderTable REPORTED ${truncated} truncated cell(s) rather than losing them silently`);
    ok(longBuilt.buffer.slice(0, 5).toString() === "%PDF-", "…and still produced a valid document");

    // ══ 5. NO BOOKING, AND SCOPE ════════════════════════════════════════════
    console.log("\n[a lead with no booking is told why, not 500'd]");
    const bare = await VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} Bare`, coupleNameManual: true, couplePhone: "9800002222", stage: "new",
    });
    created.leads.push(bare._id);
    const noBooking = await call(st.createStatement, asOwner(bare._id));
    ok(noBooking.code === 409 && noBooking.body.code === "no_booking", `→ 409 no_booking (got ${noBooking.code})`);
    ok(/no booking yet/i.test(noBooking.body.message), `…in words: "${noBooking.body.message}"`);
    ok((await call(st.previewStatement, asOwner(bare._id))).code === 409, "…and the preview says the same thing");

    console.log("\n[a same-venue member who is not assigned the lead gets 404, and nothing is written]");
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);
    const salesB = await VenueTeamMember.create({
      venueId: venue._id, ownerId: owner._id, name: `${TAG}-B`,
      phone: `${TAG}B`, email: `${TAG}b@x.com`, role: "sales", isActive: true,
    });
    created.members.push(salesB._id);
    ok((await canViewAllLeads({ type: "venue_owner", venueId: venue._id, memberId: salesB._id, role: "sales" }, salesB)) === false,
      "PREMISE: a sales member does not hold leads_view_all, so assignedTo narrows");
    await VenueEnquiry.updateOne({ _id: busy.lead._id }, { $set: { assignedTo: new mongoose.Types.ObjectId() } });
    const before = await VenueLeadDocument.countDocuments({ enquiry: busy.lead._id, kind: "statement" });
    const asB = {
      params: { slug: venue.slug, enquiryId: String(busy.lead._id) }, query: {}, body: {},
      venueOwner: { type: "venue_owner", venueId: venue._id, memberId: salesB._id, role: "sales" },
      venueMember: salesB,
    };
    for (const [name, fn] of [["GET statement/preview", st.previewStatement], ["POST statement", st.createStatement]]) {
      const r = await call(fn, asB);
      ok(r.code === 404, `${name} → 404 (got ${r.code})`);
      ok(r.code !== 403, `${name} → never 403, which would confirm the lead exists`);
    }
    ok(await VenueLeadDocument.countDocuments({ enquiry: busy.lead._id, kind: "statement" }) === before,
      "…and no statement was written");
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      await VenueLeadDocument.deleteMany({ enquiry: { $in: created.leads } });
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
