// The client step: contact sync, the client GSTIN's path onto an invoice, and
// client-document scoping.
// Run: node tests/venue-client-step.test.js
//
// ── ON WHICH PATH THESE TESTS TAKE ──────────────────────────────────────────
// The last build shipped a guard that had never executed, because every test
// sent amounts-only payment schedules while every real caller sends
// percentages. So each case below goes through the SAME entry point the portal
// uses — confirmBookingFromLead with a `client` block, createLeadInvoice with a
// real booking, uploadClientDocument through the route's controller — rather
// than calling the helper underneath it. Where a helper is unit-tested, there
// is an end-to-end case beside it proving the helper is actually reached.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueOwner = require("../models/VenueOwner");
const VenueBooking = require("../models/VenueBooking");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const VenueInvoice = require("../models/VenueInvoice");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const VenueTeamMember = require("../models/VenueTeamMember");

const bookings = require("../controllers/venueBooking");
const invoices = require("../controllers/venueLeadInvoice");
const leadDocs = require("../controllers/venueLeadDocument");
const { buildInvoicePdf } = require("../utils/venueInvoicePdf");
const { normaliseGstin } = require("../utils/venueGstin");
const { originOfKind } = require("../models/VenueLeadDocument");

const TAG = `cs-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

let venue, owner;
let dayN = 1;
const nextDate = () => `2034-0${Math.ceil(dayN / 27)}-${String(((dayN++ - 1) % 27) + 1).padStart(2, "0")}`;

const ownerReq = (extra = {}) => ({
  params: { slug: venue.slug, ...(extra.params || {}) },
  query: extra.query || {},
  body: extra.body || {},
  venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
  venueMember: null,
});

/**
 * The text inside a generated PDF.
 *
 * pdfkit embeds a SUBSET font and writes the page content as hex string runs,
 * so a plain buffer.toString() finds the metadata and nothing that was
 * actually printed — the first version of this test asserted against raw
 * latin1 and reported "Tax Invoice" missing from a PDF that plainly says Tax
 * Invoice. Decoding the <hex> runs and joining them is what makes an assertion
 * about the DOCUMENT rather than about its container.
 */
function pdfText(buffer) {
  const raw = buffer.toString("latin1");
  return [...raw.matchAll(/<([0-9A-Fa-f]{2,})>/g)]
    .map((m) => Buffer.from(m[1], "hex").toString("latin1"))
    .join("")
    // Kerning splits a line into several runs, so the spaces between them are
    // positioning operators rather than characters. Comparing without spaces is
    // what makes "Tax Invoice" findable in a document that renders it as
    // "T" + "ax In" + "oice".
    .replace(/\s+/g, "");
}

const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

async function newLead(extra = {}) {
  return VenueEnquiry.create({
    venueId: venue._id, coupleName: `${TAG} couple`, couplePhone: `9${Date.now()}`.slice(0, 10),
    stage: "negotiating", estimatedValue: 100000, ...extra,
  });
}
const fn = (date) => [{ date, name: "Wedding", space: String(venue.spaces[0]._id) }];

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    venue = await Venue.create({
      name: `${TAG}-v`, slug: `${TAG}-v`, gstin: "27AAPFU0939F1ZV",
      spaces: [{ name: "Hall", isBookable: true }],
    });
    owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`.slice(0, 14), isActive: true });

    // ── [A] a NEW person typed into the wizard lands in People ──
    console.log("\n[A. a new client becomes a contact — one people model]");
    const l1 = await newLead();
    const r1 = await call(bookings.confirmBookingFromLead, ownerReq({
      params: { enquiryId: String(l1._id) },
      body: {
        functions: fn(nextDate()),
        client: { name: "Anita Rao", phone: "+91 98765 43210", email: "Anita@Example.com", relation: "bride" },
      },
    }));
    ok(r1.code === 200, `confirm succeeds (got ${r1.code}: ${r1.body && r1.body.message})`);
    const l1after = await VenueEnquiry.findById(l1._id).lean();
    ok(l1after.contacts.length === 1, "the client is now a contact on the lead — not a copy on the booking");
    ok(l1after.contacts[0].name === "Anita Rao", "…with the name that was typed");
    ok(l1after.contacts[0].email === "anita@example.com", "…normalised by the People tab's OWN sanitizer, not a second one");
    ok(l1after.contacts[0].isPrimary === true, "…and marked primary — the client is who you call about the booking");
    const bk1 = await VenueBooking.findOne({ enquiry: l1._id }).lean();
    ok(bk1.client === undefined, "THE POINT: no `client` subdocument on the booking to drift from People");
    ok(r1.body.clientSync && r1.body.clientSync.created === true, "the response says a contact was CREATED, so the UI can say so");

    // ── [B] an EXISTING contact is matched, not duplicated ──
    console.log("\n[B. an existing contact is updated, never duplicated]");
    const l2 = await newLead({
      contacts: [{ name: "Ravi Menon", phone: "9876500011", relation: "groom", isPrimary: true }],
    });
    const r2 = await call(bookings.confirmBookingFromLead, ownerReq({
      params: { enquiryId: String(l2._id) },
      // Same human, phone written the way a person actually types it.
      body: { functions: fn(nextDate()), client: { name: "Ravi Menon", phone: "+91 98765 00011", email: "ravi@example.com" } },
    }));
    ok(r2.code === 200, "confirm succeeds");
    const l2after = await VenueEnquiry.findById(l2._id).lean();
    ok(l2after.contacts.length === 1, "MATCHED ON PHONE DIGITS — '+91 98765 00011' and '9876500011' are one person, not two");
    ok(l2after.contacts[0].email === "ravi@example.com", "…and the email the wizard added is merged in");
    ok(r2.body.clientSync.matchedBy === "phone", "…reported as a phone match");

    // ── [C] blanks do not erase ──
    console.log("\n[C. a blank field in the wizard is not a delete instruction]");
    const l3 = await newLead({
      contacts: [{ name: "Meera Iyer", phone: "9876500022", email: "meera@example.com", relation: "bride", isPrimary: true }],
    });
    await call(bookings.confirmBookingFromLead, ownerReq({
      params: { enquiryId: String(l3._id) },
      body: { functions: fn(nextDate()), client: { name: "Meera Iyer", phone: "9876500022", email: "" } },
    }));
    const l3after = await VenueEnquiry.findById(l3._id).lean();
    ok(l3after.contacts[0].email === "meera@example.com",
      "the email People already had SURVIVES an empty box in the wizard");

    // ── [D] two Sharmas are two people ──
    console.log("\n[D. name is not a matching rung]");
    const l4 = await newLead({
      contacts: [{ name: "Sharma", phone: "9876500033", relation: "brides_father", isPrimary: true }],
    });
    await call(bookings.confirmBookingFromLead, ownerReq({
      params: { enquiryId: String(l4._id) },
      body: { functions: fn(nextDate()), client: { name: "Sharma", phone: "9876500044" } },
    }));
    const l4after = await VenueEnquiry.findById(l4._id).lean();
    ok(l4after.contacts.length === 2,
      "a second 'Sharma' with a different phone is a SECOND PERSON — silently merging them would corrupt People");
    ok(l4after.contacts.filter((c) => c.isPrimary).length === 1, "…and exactly one is primary, still");

    // ── [E] the GSTIN, end to end, onto a real invoice PDF ──
    console.log("\n[E. the client GSTIN reaches the invoice — the B2B path]");
    ok(normaliseGstin("27aapfu0939f1zv").value === "27AAPFU0939F1ZV", "a GSTIN is upper-cased and stripped on the way in");
    ok(normaliseGstin("27AAPFU0939F1Z").ok === false, "a 14-character GSTIN is refused");
    ok(normaliseGstin("").ok === true && normaliseGstin("").value === "", "GST details are OPTIONAL — empty is fine");

    const l5 = await newLead();
    const r5 = await call(bookings.confirmBookingFromLead, ownerReq({
      params: { enquiryId: String(l5._id) },
      body: {
        functions: fn(nextDate()), totalValue: 100000,
        client: { name: "Northwind Offsites Pvt Ltd", phone: "9876500055", gstin: "27aapfu0939f1zv", isDecisionMaker: true },
      },
    }));
    ok(r5.code === 200, "confirm with a client GSTIN succeeds");
    const l5after = await VenueEnquiry.findById(l5._id).lean();
    ok(l5after.contacts[0].gstin === "27AAPFU0939F1ZV", "the GSTIN is stored ON THE CONTACT — the party being billed");

    const inv = await call(invoices.createLeadInvoice, ownerReq({
      params: { enquiryId: String(l5._id) }, body: { gst: true, gstMode: "exclusive", gstPercent: 18 },
    }));
    ok(inv.code === 200 || inv.code === 201, `an invoice is raised (got ${inv.code}: ${inv.body && inv.body.message})`);
    const invDoc = await VenueInvoice.findOne({ enquiry: l5._id }).lean();
    ok(invDoc.billedTo.gstin === "27AAPFU0939F1ZV", "THE SNAPSHOT: the invoice froze the client's GSTIN at raise time");
    ok(invDoc.billedTo.name === "Northwind Offsites Pvt Ltd", "…with the billing party's name");

    // changing the contact afterwards must NOT rewrite an issued invoice
    await VenueEnquiry.updateOne({ _id: l5._id }, { $set: { "contacts.0.gstin": "29AAPFU0939F1ZV" } });
    const invAfter = await VenueInvoice.findOne({ enquiry: l5._id }).lean();
    ok(invAfter.billedTo.gstin === "27AAPFU0939F1ZV",
      "IMMUTABILITY: correcting the contact later does NOT change what the issued invoice says");

    const bk5 = await VenueBooking.findOne({ enquiry: l5._id }).lean();
    const pdf = (await buildInvoicePdf({ venue, booking: bk5, invoice: invAfter })).buffer;
    const text = pdfText(pdf);
    ok(pdf.length > 1000, "the invoice PDF builds");
    ok(/CLIENTGSTIN/i.test(text), "…and it prints a CLIENT GSTIN row");
    ok(/27AAPFU0939F1ZV/.test(text), "…carrying the client's number");
    ok(/TaxInvoice/i.test(text), "…titled Tax Invoice, since GST is charged");

    // no client GSTIN → no row, and nothing else changes
    const l6 = await newLead();
    await call(bookings.confirmBookingFromLead, ownerReq({
      params: { enquiryId: String(l6._id) },
      body: { functions: fn(nextDate()), totalValue: 50000, client: { name: "Priya", phone: "9876500066" } },
    }));
    await call(invoices.createLeadInvoice, ownerReq({
      params: { enquiryId: String(l6._id) }, body: { gst: true, gstMode: "exclusive", gstPercent: 18 },
    }));
    const inv6 = await VenueInvoice.findOne({ enquiry: l6._id }).lean();
    const pdf6 = (await buildInvoicePdf({ venue, booking: await VenueBooking.findOne({ enquiry: l6._id }).lean(), invoice: inv6 })).buffer;
    ok(!/CLIENTGSTIN/i.test(pdfText(pdf6)),
      "a client with NO GSTIN gets no row and no dangling label — B2C is unchanged");

    // ── [F] client documents ──
    console.log("\n[F. client docs: the same model, the other direction]");
    ok(originOfKind("address_proof") === "client" && originOfKind("invoice") === "venue",
      "origin is DERIVED from the kind, so a new kind cannot land on the wrong side of the tab");

    const l7 = await newLead();
    const up = await call(leadDocs.uploadClientDocument, ownerReq({
      params: { enquiryId: String(l7._id) },
      body: { url: "https://bucket.s3.amazonaws.com/x/proof-1.pdf", filename: "aadhaar.pdf",
              contentType: "application/pdf", sizeBytes: 220000, proofType: "aadhaar", contactName: "Anita Rao" },
    }));
    ok(up.code === 201, `an address proof records (got ${up.code}: ${up.body && up.body.message})`);
    ok(up.body.document.origin === "client", "…on the CLIENT side of the tab");
    ok(up.body.document.version === 1, "…as v1");

    const up2 = await call(leadDocs.uploadClientDocument, ownerReq({
      params: { enquiryId: String(l7._id) },
      body: { url: "https://bucket.s3.amazonaws.com/x/proof-2.pdf", filename: "aadhaar-clear.pdf",
              contentType: "application/pdf", sizeBytes: 240000, proofType: "aadhaar" },
    }));
    ok(up2.body.document.version === 2,
      "REPLACING a blurry proof adds v2 — 'what did we hold when we booked' stays answerable");
    const held = await VenueLeadDocument.find({ enquiry: l7._id }).lean();
    ok(held.length === 2, "…and v1 is still there, unmutated");

    const badType = await call(leadDocs.uploadClientDocument, ownerReq({
      params: { enquiryId: String(l7._id) },
      body: { url: "https://bucket.s3.amazonaws.com/x/p.pdf", filename: "p.pdf", proofType: "ration_card" },
    }));
    ok(badType.code === 400, "an unknown proof type is refused rather than stored as free text");
    const otherNoName = await call(leadDocs.uploadClientDocument, ownerReq({
      params: { enquiryId: String(l7._id) },
      body: { url: "https://bucket.s3.amazonaws.com/x/p.pdf", filename: "p.pdf", proofType: "other" },
    }));
    ok(otherNoName.code === 400, "'Other' with no name is refused — an unnamed proof is unfileable");
    const notHttps = await call(leadDocs.uploadClientDocument, ownerReq({
      params: { enquiryId: String(l7._id) },
      body: { url: "http://evil.example/p.pdf", filename: "p.pdf", proofType: "pan" },
    }));
    ok(notHttps.code === 400, "a non-https link is refused — an identity document must not point somewhere mutable");
    const tooBig = await call(leadDocs.uploadClientDocument, ownerReq({
      params: { enquiryId: String(l7._id) },
      body: { url: "https://bucket.s3.amazonaws.com/x/p.pdf", filename: "p.pdf", proofType: "pan", sizeBytes: 12 * 1024 * 1024 },
    }));
    ok(tooBig.code === 400 && /10 MB/.test(tooBig.body.message),
      "over the cap is refused BY THE SERVER, with both numbers");

    // ── [G] the deny sweep ──
    console.log("\n[G. deny sweep — an identity document is exactly as private as its lead]");
    const other = await Venue.create({ name: `${TAG}-o`, slug: `${TAG}-o`, spaces: [] });
    const otherOwner = await VenueOwner.create({ venueId: other._id, name: "Other", phone: `${TAG}x`.slice(0, 14), isActive: true });
    const foreign = {
      params: { slug: other.slug, enquiryId: String(l7._id) }, query: {}, body: {
        url: "https://bucket.s3.amazonaws.com/x/p.pdf", filename: "p.pdf", proofType: "pan",
      },
      venueOwner: { type: "venue_owner", venueId: other._id, venueOwnerId: otherOwner._id }, venueMember: null,
    };
    const denied = await call(leadDocs.uploadClientDocument, foreign);
    ok(denied.code === 404, "another venue cannot upload against this lead — 404, never 403");

    // a SALES member sees only their own leads; l7 is unassigned
    const salesMember = await VenueTeamMember.create({
      venueId: venue._id, name: "Sales", phone: `${TAG}s`.slice(0, 14), role: "sales", isActive: true,
    });
    const salesReq = {
      params: { slug: venue.slug, enquiryId: String(l7._id) }, query: {}, body: {
        url: "https://bucket.s3.amazonaws.com/x/p.pdf", filename: "p.pdf", proofType: "pan",
      },
      venueOwner: { type: "venue_member", venueId: venue._id, memberId: salesMember._id, role: "sales" },
      venueMember: { _id: salesMember._id, role: "sales", venueId: venue._id },
    };
    const salesRes = await call(leadDocs.uploadClientDocument, salesReq);
    ok(salesRes.code === 404,
      "a sales member cannot attach an identity document to a lead outside their scope — the SAME venueLeadScope boundary as every other lead read");

    await VenueTeamMember.deleteOne({ _id: salesMember._id });
    await VenueOwner.deleteOne({ _id: otherOwner._id });
    await Venue.deleteOne({ _id: other._id });

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    if (venue) {
      const leads = await VenueEnquiry.find({ venueId: venue._id }).select("_id").lean();
      const ids = leads.map((l) => l._id);
      await VenueLeadDocument.deleteMany({ enquiry: { $in: ids } });
      await VenueInvoice.deleteMany({ enquiry: { $in: ids } });
      await VenueBooking.deleteMany({ enquiry: { $in: ids } });
      await VenueSpaceDate.deleteMany({ venue: venue._id });
      await VenueEnquiry.deleteMany({ venueId: venue._id });
      await Venue.deleteOne({ _id: venue._id });
    }
    if (owner) await VenueOwner.deleteOne({ _id: owner._id });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
