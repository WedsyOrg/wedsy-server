// Booking engine S3 — the booking confirmation document.
// Run: node tests/venue-booking-confirmation.test.js
//
// Text is read by decoding content streams (inflated, hex/literal operands
// reassembled); grepping raw PDF bytes is vacuous. Every absence check is
// preceded by one proving the decoder can see a known string.
require("dotenv").config();
const http = require("http");
const zlib = require("zlib");
const mongoose = require("mongoose");
const PDFKit = require("pdfkit");
const { PDFDocument } = require("pdf-lib");

// Stub S3 before the controller is required, so the suite cannot write into the
// production bucket (a dev .env carries real credentials).
const s3 = require("../utils/s3Upload");
const uploaded = [];
s3.uploadBufferToS3 = async ({ buffer, key, contentType }) => {
  uploaded.push({ key, bytes: buffer.length, contentType, buffer });
  return `https://stub.local/${key}`;
};

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const bc = require("../controllers/venueBookingConfirmation");

const TAG = `bconf-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

function decode(bytes) {
  let b = bytes;
  if (b.length > 2 && b[0] === 0x78) { try { b = zlib.inflateSync(b); } catch { /* leave */ } }
  const s = b.toString("latin1");
  let out = ""; const re = /<([0-9A-Fa-f\s]+)>|\(((?:[^()\\]|\\.)*)\)/g; let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1] !== undefined) { const h = m[1].replace(/\s+/g, ""); if (h.length % 2 === 0) out += Buffer.from(h, "hex").toString("latin1"); }
    else out += m[2];
  }
  return out;
}
async function pageTexts(buf) {
  const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
  const out = [];
  for (let i = 0; i < pdf.getPageCount(); i++) {
    const raw = pdf.getPage(i).node.Contents(); let by = Buffer.alloc(0);
    if (raw) { const ps = typeof raw.asArray === "function" ? raw.asArray() : [raw];
      for (const r of ps) { const st = pdf.context.lookup(r); const c = st && (st.getContents ? st.getContents() : st.contents); if (c) by = Buffer.concat([by, Buffer.from(c)]); } }
    out.push(decode(by));
  }
  return out;
}
const makeTermsPdf = (pages) => new Promise((resolve) => {
  const d = new PDFKit({ size: "A4", margin: 50, compress: false });
  const chunks = []; d.on("data", (c) => chunks.push(c)); d.on("end", () => resolve(Buffer.concat(chunks)));
  for (let i = 0; i < pages; i++) { if (i) d.addPage(); d.fontSize(14).text(`VENUE TERMS PAGE ${i + 1}`, 50, 50); }
  d.end();
});

(async () => {
  let server = null;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // Serve a real multi-page T&C PDF for the attach path.
    const termsPdf = await makeTermsPdf(4);
    server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", termsPdf.length);
      res.end(termsPdf);
    });
    await new Promise((r) => server.listen(0, r));
    const termsUrl = `http://127.0.0.1:${server.address().port}/terms.pdf`;

    const policy = [
      { type: "heading", level: 1, spans: [{ text: "Cancellation policy" }] },
      { type: "paragraph", spans: [{ text: "If you cancel, the following applies: " }, { text: "no exceptions.", bold: true }] },
      { type: "orderedList", items: [
        { spans: [{ text: "More than 90 days before: full refund less the token." }] },
        { spans: [{ text: "30 to 90 days: 50% refund." }] },
      ] },
    ];
    const venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      address: "12 Palace Road", contact: { primaryPhone: "9800000000", email: "hello@example.com" },
      gstin: "29ABCDE1234F1Z5", pan: "ABCDE1234F",
      cancellationPolicy: { blocks: policy, updatedAt: new Date() },
      termsDocument: { url: termsUrl, filename: "Crown-TCs.pdf", contentType: "application/pdf", sizeBytes: termsPdf.length, uploadedAt: new Date() },
    });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true, couplePhone: "9800001111", stage: "booked",
      contacts: [{ name: "Priya Rao", phone: "9800001111", email: "priya@example.com", relation: "bride", isPrimary: true }],
    });
    await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun", couplePhone: "9800001111", totalValue: 1200000,
      specialRequirements: "Vegetarian kitchen only.",
      days: [
        { date: new Date("2026-11-26T00:00:00Z"), eventType: "wedding", guestCount: 300, spaces: ["Grand Lawn"] },
        { date: new Date("2026-11-27T00:00:00Z"), eventType: "reception", guestCount: 250, spaces: ["Banquet Hall"] },
      ],
      paymentSchedule: [
        { label: "Advance", amount: 400000, percent: 33.34, dueDate: new Date("2026-08-20T00:00:00Z"), paidAmount: 400000 },
        { label: "Second instalment", amount: 400000, percent: 33.33, dueDate: new Date("2026-10-27T00:00:00Z"), paidAmount: 100000 },
        { label: "Balance", amount: 400000, percent: 33.33, dueDate: new Date("2026-11-19T00:00:00Z"), paidAmount: 0 },
      ],
    });

    const req = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id }, venueMember: null,
    });

    // ══ OPTIONS ═════════════════════════════════════════════════════════════
    console.log("\n[the dialog only offers what exists]");
    const opts = await call(bc.getConfirmationOptions, req());
    ok(opts.code === 200 && opts.body.hasBooking === true, "options read → 200 with a booking");
    ok(opts.body.hasCancellationPolicy === true, "…knows a policy is written");
    ok(opts.body.hasTermsDocument === true && opts.body.termsFilename === "Crown-TCs.pdf", "…and that a T&C PDF exists, by name");
    ok(opts.body.scheduleRows === 3 && opts.body.bookingValue === 1200000, "…plus the schedule size and booking value");

    // ══ THE PLAIN DOCUMENT ══════════════════════════════════════════════════
    console.log("\n[generated FROM the booking — nothing re-entered]");
    const plain = await call(bc.generateBookingConfirmation, req({ body: { note: "v1 at confirmation" } }));
    ok(plain.code === 201, `generating → 201 (got ${plain.code}${plain.code !== 201 ? " " + JSON.stringify(plain.body) : ""})`);
    const t1 = (await pageTexts(uploaded[0].buffer)).join("");
    ok(t1.includes(`${TAG} Palace`), "the decoder sees the venue name (guards every absence check below)");
    ok(t1.includes("Booking Confirmation"), "titled as a confirmation");
    ok(t1.includes("29ABCDE1234F1Z5"), "carries the GSTIN from Settings (S1a branding)");
    ok(t1.includes("Priya & Arjun"), "names the couple");
    ok(t1.includes("priya@example.com"), "…and the contacts from the lead");
    ok(t1.includes("Thursday, 26 November 2026"), "event dates with weekdays, composed not localised");
    ok(t1.includes("Friday, 27 November 2026"), "…including the second day");
    ok(t1.includes("Grand Lawn") && t1.includes("Banquet Hall"), "…and the spaces");
    ok(t1.includes("Vegetarian kitchen only"), "…and the special requirements");
    ok(t1.includes("Advance") && t1.includes("Second instalment") && t1.includes("Balance"), "the payment schedule as a table");
    ok(t1.includes("33.34%") && t1.includes("33.33%"), "…with percentages");
    ok(t1.includes("Rs. 4,00,000"), "…and amounts");
    ok(t1.includes("Rs. 7,00,000"), "balance due comes from the S4 derivation (12L − 5L received)");
    ok(!t1.includes("₹"), "no rupee glyph — Helvetica cannot draw it");
    // The word "signature" DOES appear — in the sentence saying none is required.
    // What must not appear is a signature BLOCK: a place to sign, or a record of
    // someone having signed. That is the line between a confirmation and an
    // agreement, and it is what this asserts.
    ok(!/Signature:|Signed by|Accepted by|sign here|_{6,}/i.test(t1),
      "NOT signed — no signature block, no acceptance line");
    ok(/no signature is required/i.test(t1), "…and it says outright that none is needed");
    ok(/confirmation, not an agreement/i.test(t1), "…and says so explicitly");
    ok(!t1.includes("days late") && !t1.includes("Paid"), "the couple's copy states what ARRIVED, not internal status labels");
    for (const bad of ["undefined", "null", "NaN", "Invalid Date"]) ok(!t1.includes(bad), `…and never renders "${bad}"`);

    console.log("\n[it lands in the Documents tab, reusing #130]");
    const docs = await VenueLeadDocument.find({ enquiry: lead._id, kind: "booking_confirmation" }).lean();
    ok(docs.length === 1 && docs[0].version === 1, "one document row at version 1");
    ok(docs[0].note === "v1 at confirmation", "…with the note as given");
    ok(/booking-confirmation-Priya-Arjun-v1\.pdf/.test(docs[0].filename), `…and a versioned filename (${docs[0].filename})`);

    // ══ THE CANCELLATION POLICY ═════════════════════════════════════════════
    console.log("\n[the cancellation policy, when asked for]");
    const withPolicy = await call(bc.generateBookingConfirmation, req({ body: { includeCancellationPolicy: true } }));
    ok(withPolicy.code === 201 && withPolicy.body.includedCancellationPolicy === true, "including it → 201");
    const p2 = await pageTexts(uploaded[1].buffer);
    ok(p2.length >= 2, `it gets its own page (${p2.length} pages)`);
    ok(p2.join("").includes("More than 90 days before"), "…and the policy text is there");
    ok(p2.join("").includes("no exceptions"), "…including the bolded run");
    ok(!t1.includes("More than 90 days before"), "…while the plain version does NOT carry it");

    // ══ THE ATTACHED T&C ════════════════════════════════════════════════════
    console.log("\n[the venue's T&C PDF attached — carried, not re-rendered]");
    const withTerms = await call(bc.generateBookingConfirmation, req({ body: { attachTerms: true } }));
    ok(withTerms.code === 201, "attaching → 201");
    ok(withTerms.body.attachedTerms && withTerms.body.attachedTerms.pages === 4, "…reporting the 4 carried pages");
    const p3 = await pageTexts(uploaded[2].buffer);
    ok(p3.length === 5, `confirmation + 4 T&C pages = 5 (got ${p3.length})`);
    ok(p3[0].includes("Booking Confirmation"), "…confirmation first");
    for (let i = 1; i <= 4; i++) ok(p3[i].includes(`VENUE TERMS PAGE ${i}`), `…T&C page ${i} present and in order`);
    const row = await VenueLeadDocument.findOne({ enquiry: lead._id, kind: "booking_confirmation" }).sort({ version: -1 }).lean();
    ok(row.sourceVerified === true, "…and the source was verified page-by-page before storing");

    console.log("\n[versions are independent]");
    const all = await VenueLeadDocument.find({ enquiry: lead._id, kind: "booking_confirmation" }).sort({ version: 1 }).lean();
    ok(all.length === 3 && all.map((d) => d.version).join(",") === "1,2,3", "three versions, 1..3");
    ok(all[0].note === "v1 at confirmation", "v1's note unchanged after v2 and v3");
    ok(new Set(all.map((d) => d.url)).size === 3, "…and each has its own stored file");

    // ══ REFUSALS + DENY SWEEP ═══════════════════════════════════════════════
    console.log("\n[refusals]");
    const bare = await Venue.create({ name: `${TAG} Bare`, slug: `${TAG}-bare`, city: "B", state: "K" });
    created.venues.push(bare._id);
    const bareLead = await VenueEnquiry.create({ venueId: bare._id, coupleName: "A & B", coupleNameManual: true, couplePhone: "9800009999", stage: "booked" });
    await VenueBooking.create({ venue: bare._id, enquiry: bareLead._id, coupleName: "A & B", totalValue: 100000 });
    const bareReq = (body) => ({ params: { slug: bare.slug, enquiryId: String(bareLead._id) }, query: {}, body,
      venueOwner: { type: "venue_owner", venueId: bare._id, venueOwnerId: owner._id }, venueMember: null });
    const noPol = await call(bc.generateBookingConfirmation, bareReq({ includeCancellationPolicy: true }));
    ok(noPol.code === 400 && noPol.body.code === "no_cancellation_policy", "asking for a policy that is not written is refused, naming Settings");
    const noTerms = await call(bc.generateBookingConfirmation, bareReq({ attachTerms: true }));
    ok(noTerms.code === 400 && noTerms.body.code === "no_terms_document", "attaching a T&C that does not exist is refused");
    const plainBare = await call(bc.generateBookingConfirmation, bareReq({}));
    ok(plainBare.code === 201, "…but a plain confirmation still generates for that venue");

    const noBookingLead = await VenueEnquiry.create({ venueId: venue._id, coupleName: "No Booking", coupleNameManual: true, couplePhone: "9800008888", stage: "negotiating" });
    const nb = await call(bc.generateBookingConfirmation, req({ params: { enquiryId: String(noBookingLead._id) }, body: {} }));
    ok(nb.code === 400 && nb.body.code === "no_booking", "a lead with no booking cannot be confirmed");

    console.log("\n[deny sweep]");
    const beforeCount = await VenueLeadDocument.countDocuments({});
    for (const [fn, name] of [[bc.getConfirmationOptions, "GET options"], [bc.generateBookingConfirmation, "POST confirmation"]]) {
      const r = await call(fn, req({ params: { enquiryId: String(new mongoose.Types.ObjectId()) }, body: {} }));
      ok(r.code === 404, `${name} for a lead outside scope → 404`);
    }
    ok((await VenueLeadDocument.countDocuments({})) === beforeCount, "…and no document was created by a denied call");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    if (server) server.close();
    for (const v of created.venues) {
      await VenueLeadDocument.deleteMany({ venue: v });
      await VenueBooking.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
