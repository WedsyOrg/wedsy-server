// Booking engine S5c — raising an invoice from the lead.
// Run: node tests/venue-lead-invoice.test.js
//
// S3 upload is stubbed at the module boundary so the suite never writes objects
// into the production bucket (the .env in a dev checkout carries real creds).
require("dotenv").config();
const mongoose = require("mongoose");

// Stubbed BEFORE the controller is required, so it captures the patched export.
const s3 = require("../utils/s3Upload");
const uploaded = [];
s3.uploadBufferToS3 = async ({ buffer, key, contentType }) => {
  uploaded.push({ key, bytes: buffer.length, contentType });
  return `https://stub.local/${key}`;
};

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const VenueCounter = require("../models/VenueCounter");

const li = require("../controllers/venueLeadInvoice");

const TAG = `lin-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await VenueInvoice.init();

    const venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      invoicePrefix: "CE-", gstin: "29ABCDE1234F1Z5", pan: "ABCDE1234F",
      address: "12 Palace Road", contact: { primaryPhone: "9800000000", email: "h@x.com" },
    });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true,
      couplePhone: "9800001111", stage: "booked",
    });
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: "Priya & Arjun", couplePhone: "9800001111",
      totalValue: 1200000,
      days: [{ date: new Date("2026-11-26T00:00:00Z"), eventType: "wedding", guestCount: 300, spaces: ["Grand Lawn"] }],
      paymentSchedule: [
        { label: "Advance", amount: 400000, dueDate: new Date("2026-08-20T00:00:00Z") },
        { label: "Balance", amount: 800000, dueDate: new Date("2026-11-19T00:00:00Z") },
      ],
    });

    const req = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
      venueMember: null,
    });

    // ══ THE AT-BOOKING INVOICE ══════════════════════════════════════════════
    console.log("\n[the invoice raised at booking]");
    const first = await call(li.createLeadInvoice, req({ body: { gst: true, note: "at booking" } }));
    ok(first.code === 201, `raising it → 201 (got ${first.code}${first.code !== 201 ? " " + JSON.stringify(first.body) : ""})`);
    ok(/^CE-\d{4}$/.test(first.body.invoice.invoiceNumber), `numbered from the Settings prefix (${first.body.invoice.invoiceNumber})`);
    ok(first.body.invoice.gstMode === "exclusive", "GST on → exclusive mode");
    ok(first.body.invoice.totals.grandTotal === 1416000, "18% on 12,00,000 → 14,16,000 via computeTotals, not new arithmetic");
    ok(first.body.invoice.forMilestoneId === null, "…and it is the booking-level invoice, not tied to a milestone");
    ok(uploaded.length === 1 && uploaded[0].contentType === "application/pdf", "the PDF was stored");
    ok(uploaded[0].key.startsWith(`venues/${venue._id}/invoices/`), "…under the venue-scoped key layout");

    console.log("\n[it lands in the Documents tab, reusing #130]");
    const docs = await VenueLeadDocument.find({ enquiry: lead._id, kind: "invoice" }).lean();
    ok(docs.length === 1, "one VenueLeadDocument row of kind 'invoice'");
    ok(docs[0].version === 1, "…at version 1");
    ok(docs[0].filename.includes("CE-"), `…named after the invoice (${docs[0].filename})`);
    ok(String(docs[0]._id) === String(first.body.document._id), "…and returned to the caller");
    const linked = await VenueInvoice.findById(first.body.invoice._id).lean();
    ok(String(linked.leadDocument) === String(docs[0]._id), "the invoice links back to its document row");
    const fresh = await VenueEnquiry.findById(lead._id).select("activities").lean();
    ok(fresh.activities.some((a) => a.type === "invoice_raised" && /CE-/.test(a.description)), "…and the lead's timeline records it");

    // ══ NO ACCIDENTAL DUPLICATE ═════════════════════════════════════════════
    console.log("\n[the duplicate guard — an invoice is immutable and consumes a number]");
    const dupe = await call(li.createLeadInvoice, req({ body: { gst: true } }));
    ok(dupe.code === 409, "a second booking-level invoice → 409, not a second tax document");
    ok(dupe.body.code === "invoice_exists" && dupe.body.invoiceNumber === first.body.invoice.invoiceNumber,
      "…naming the invoice that already covers it");
    ok((await VenueInvoice.countDocuments({ enquiry: lead._id })) === 1, "…and no second row was created");
    ok(uploaded.length === 1, "…and nothing extra was uploaded");

    // ══ ONE PER RECORDED PAYMENT ════════════════════════════════════════════
    console.log("\n[one invoice per milestone]");
    const b = await VenueBooking.findById(booking._id);
    const m1 = b.paymentSchedule[0];
    const perPayment = await call(li.createLeadInvoice, req({ body: { gst: false, milestoneId: String(m1._id) } }));
    ok(perPayment.code === 201, "an invoice for a specific instalment → 201");
    ok(perPayment.body.invoice.gstMode === "none", "GST off → mode 'none'");
    ok(perPayment.body.invoice.totals.gst === 0 && perPayment.body.invoice.totals.grandTotal === 400000,
      "…priced from the milestone (4,00,000), with no tax");
    ok(String(perPayment.body.invoice.forMilestoneId) === String(m1._id), "…and tied to that milestone");
    ok(perPayment.body.invoice.invoiceNumber !== first.body.invoice.invoiceNumber, "…with its own number");
    const dupeMilestone = await call(li.createLeadInvoice, req({ body: { gst: false, milestoneId: String(m1._id) } }));
    ok(dupeMilestone.code === 409 && /covers that instalment/.test(dupeMilestone.body.message),
      "a second invoice for the SAME instalment is refused");
    const m2 = b.paymentSchedule[1];
    const other = await call(li.createLeadInvoice, req({ body: { gst: true, milestoneId: String(m2._id) } }));
    ok(other.code === 201, "…but the OTHER instalment can be invoiced");
    ok(other.body.invoice.totals.grandTotal === 944000, "…at its own value with GST (8,00,000 + 18%)");

    console.log("\n[document versions are independent and earlier ones unchanged]");
    const allDocs = await VenueLeadDocument.find({ enquiry: lead._id, kind: "invoice" }).sort({ version: 1 }).lean();
    ok(allDocs.length === 3 && allDocs.map((d) => d.version).join(",") === "1,2,3", "three invoice documents, versions 1,2,3");
    ok(allDocs[0].note === "at booking", "v1's note is unchanged after v2 and v3 were made");
    ok(new Set(allDocs.map((d) => d.url)).size === 3, "…and each has its own stored file");

    // ══ REFUSALS ════════════════════════════════════════════════════════════
    console.log("\n[refusals that protect the owner]");
    const noGstinVenue = await Venue.create({ name: `${TAG} NoGst`, slug: `${TAG}-nogst`, city: "B", state: "K", invoicePrefix: "NG-" });
    created.venues.push(noGstinVenue._id);
    const ngLead = await VenueEnquiry.create({ venueId: noGstinVenue._id, coupleName: "A & B", coupleNameManual: true, couplePhone: "9800002222", stage: "booked" });
    await VenueBooking.create({ venue: noGstinVenue._id, enquiry: ngLead._id, coupleName: "A & B", totalValue: 500000 });
    const ngReq = { params: { slug: noGstinVenue.slug, enquiryId: String(ngLead._id) }, query: {}, body: { gst: true },
      venueOwner: { type: "venue_owner", venueId: noGstinVenue._id, venueOwnerId: owner._id }, venueMember: null };
    const noGstin = await call(li.createLeadInvoice, ngReq);
    ok(noGstin.code === 400 && noGstin.body.code === "no_gstin", "asking for GST with no GSTIN is refused, naming where to fix it");
    ok(/Settings/.test(noGstin.body.message), "…and points at Settings → Billing & tax");
    ngReq.body = { gst: false };
    const ngOk = await call(li.createLeadInvoice, ngReq);
    ok(ngOk.code === 201, "…but a non-GST invoice is fine without a GSTIN");

    const noBookingLead = await VenueEnquiry.create({ venueId: venue._id, coupleName: "No Booking", coupleNameManual: true, couplePhone: "9800003333", stage: "negotiating" });
    const nb = await call(li.createLeadInvoice, req({ params: { enquiryId: String(noBookingLead._id) }, body: { gst: false } }));
    ok(nb.code === 400 && nb.body.code === "no_booking", "a lead with no confirmed booking cannot be invoiced");

    const zeroLead = await VenueEnquiry.create({ venueId: venue._id, coupleName: "Zero", coupleNameManual: true, couplePhone: "9800004444", stage: "booked" });
    await VenueBooking.create({ venue: venue._id, enquiry: zeroLead._id, coupleName: "Zero", totalValue: 0 });
    const zero = await call(li.createLeadInvoice, req({ params: { enquiryId: String(zeroLead._id) }, body: { gst: false } }));
    ok(zero.code === 400 && zero.body.code === "nothing_to_invoice", "a booking with no value cannot be invoiced");

    const badMs = await call(li.createLeadInvoice, req({ body: { gst: false, milestoneId: String(new mongoose.Types.ObjectId()) } }));
    ok(badMs.code === 404, "a milestone id that is not on this booking → 404");

    // ══ THE LIST ════════════════════════════════════════════════════════════
    console.log("\n[the list the UI reads]");
    const list = await call(li.listLeadInvoices, req());
    ok(list.code === 200 && list.body.invoices.length === 3, "lists this lead's three invoices");
    ok(list.body.invoices[0].seq > list.body.invoices[2].seq, "…newest first");
    ok(list.body.canChargeGst === true && list.body.gstin === "29ABCDE1234F1Z5", "…and reports whether GST can be offered at all");
    ok(list.body.bookingValue === 1200000 && list.body.hasBooking === true, "…plus the booking value for the UI");

    // ══ DENY SWEEP ══════════════════════════════════════════════════════════
    console.log("\n[deny sweep: 404 never 403, and no write lands]");
    const foreignLead = String(new mongoose.Types.ObjectId());
    const before = await VenueInvoice.countDocuments({});
    for (const [fn, name] of [[li.listLeadInvoices, "GET invoices"], [li.createLeadInvoice, "POST invoices"]]) {
      const r = await call(fn, req({ params: { enquiryId: foreignLead }, body: { gst: false } }));
      ok(r.code === 404, `${name} for a lead outside scope → 404 (got ${r.code})`);
    }
    const otherVenue = await call(li.listLeadInvoices, { ...req(), params: { slug: noGstinVenue.slug, enquiryId: String(lead._id) } });
    ok(otherVenue.code === 404, "a venue that is not the caller's → 404");
    ok((await VenueInvoice.countDocuments({})) === before, "…and no invoice was created by any denied call");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const v of created.venues) {
      await VenueInvoice.deleteMany({ venue: v });
      await VenueLeadDocument.deleteMany({ venue: v });
      await VenueBooking.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await VenueCounter.deleteOne({ key: `${v}:invoice` });
      await Venue.deleteOne({ _id: v });
    }
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
