// The venue's T&Cs as an uploaded PDF.
// Run: node tests/venue-terms-document.test.js
//
// WHY THIS EXISTS: an audit of the send path found it could never work for any
// venue on record — it resolves a contract-type template, else seeds clauses
// from policyDoc / legacy policies, else refuses. There are zero contract
// templates in the database, `policyDoc` has no write path in the API, and the
// doc-template routes are never called by the portal. Every owner clicking
// "Send terms & conditions" got a 400 pointing at two places they could not
// reach. This suite pins the replacement, and pins that the old path still
// works for anyone relying on it.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueOwner = require("../models/VenueOwner");
const VenueQuoteRound = require("../models/VenueQuoteRound");

const td = require("../controllers/venueTermsDocument");
const terms = require("../controllers/venueTerms");

const TAG = `tnc-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

const URL_A = "https://bucket.s3.ap-south-1.amazonaws.com/venues/x/terms/1-abc.pdf";
const URL_B = "https://bucket.s3.ap-south-1.amazonaws.com/venues/x/terms/2-def.pdf";

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const venue = await Venue.create({ name: `${TAG}-v`, slug: `${TAG}-v` });
    created.venues.push(venue._id);
    const ownerDoc = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(ownerDoc._id);

    const req = (extra = {}) => ({
      params: { slug: venue.slug, ...(extra.params || {}) },
      query: extra.query || {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: ownerDoc._id },
      venueMember: null,
    });
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} couple`, couplePhone: `9${Date.now()}`.slice(0, 10),
      stage: "negotiating",
      contacts: [{ name: "Priya", email: "priya@example.com", relation: "bride", isPrimary: true }],
    });
    const leadReq = (body = {}) => req({ params: { enquiryId: String(lead._id) }, body });

    // ── THE AUDIT FINDING, pinned ──
    console.log("\n[A. what a venue got BEFORE any of this — the audit finding]");
    const before = await call(terms.sendTerms, leadReq({ email: "priya@example.com" }));
    ok(before.code === 400, "a venue with no uploaded document and no policies CANNOT send — 400, not an empty PDF");
    ok(before.body.code === "no_terms_document", "…with a machine-readable reason the portal can act on");
    ok(/Settings/.test(before.body.message), "…and the message names SETTINGS, a place the owner can actually reach");

    // ── upload ──
    console.log("\n[B. upload]");
    const empty = await call(td.getTermsDocument, req());
    ok(empty.code === 200 && empty.body.document.uploaded === false, "a venue starts with no document, said plainly");

    const bad = await call(td.putTermsDocument, req({ body: { url: URL_A, filename: "terms.docx", contentType: "application/msword" } }));
    ok(bad.code === 400 && /PDF/.test(bad.body.message), "a .docx is refused — the couple has to be able to open it");

    const badMime = await call(td.putTermsDocument, req({ body: { url: URL_A, filename: "terms.pdf", contentType: "image/png" } }));
    ok(badMime.code === 400, "a PDF extension with a non-PDF type is refused too — the name is not the proof");

    const notHttps = await call(td.putTermsDocument, req({ body: { url: "http://evil.example/x.pdf", filename: "x.pdf" } }));
    ok(notHttps.code === 400, "a non-https link is refused — terms must not point somewhere that can change later");

    const noUrl = await call(td.putTermsDocument, req({ body: { filename: "terms.pdf" } }));
    ok(noUrl.code === 400 && /upload the file first/.test(noUrl.body.message), "no url → told to upload first");

    const tooBig = await call(td.putTermsDocument, req({
      body: { url: URL_A, filename: "terms.pdf", contentType: "application/pdf", sizeBytes: 12 * 1024 * 1024 },
    }));
    ok(tooBig.code === 400 && /10 MB/.test(tooBig.body.message), "over the cap is refused, and the message says the actual size and the limit");

    const good = await call(td.putTermsDocument, req({
      body: { url: URL_A, filename: "Palace T&C 2026.pdf", contentType: "application/pdf", sizeBytes: 240000, uploadedByName: "Maya" },
    }));
    ok(good.code === 200 && good.body.document.uploaded === true, "a real PDF is accepted → 200");
    ok(good.body.document.filename === "Palace T&C 2026.pdf", "…the owner's own filename is kept, so they recognise it");
    ok(good.body.document.uploadedByName === "Maya" && Boolean(good.body.document.uploadedAt),
      "…with who uploaded it and when");

    // ── replace ──
    console.log("\n[C. replace — one document per venue, never a pile]");
    await call(td.putTermsDocument, req({
      body: { url: URL_B, filename: "Palace T&C 2027.pdf", contentType: "application/pdf", sizeBytes: 260000 },
    }));
    const after = await call(td.getTermsDocument, req());
    ok(after.body.document.url === URL_B, "uploading again REPLACES — a second row would raise 'which one goes out?'");
    ok(after.body.document.filename === "Palace T&C 2027.pdf", "…and the new name is what Settings shows");

    // ── the send now works, and sends THE DOCUMENT ──
    console.log("\n[D. the send — and what lands on the negotiation thread]");
    const sent = await call(terms.sendTerms, leadReq({ email: "priya@example.com" }));
    ok(sent.code === 200, "with a document uploaded, the send succeeds");
    ok(sent.body.kind === "document", "…and it sends the UPLOADED PDF, not our generated approximation");
    ok(sent.body.document.filename === "Palace T&C 2027.pdf", "…the current one");
    ok(sent.body.delivered === false && /template/.test(sent.body.deliveryError || ""),
      "…still reporting delivery HONESTLY — recorded, not emailed, until the Mailjet template exists");

    const round = await VenueQuoteRound.findById(sent.body.roundId).lean();
    ok(Boolean(round.termsSentAt) && round.termsSentTo === "priya@example.com",
      "THE RECORD: the send is on the quote round — the thread is what proves they were informed");
    ok(round.termsDocument.url === URL_B, "…with the exact document that went, frozen as a pointer");
    const timeline = (await VenueEnquiry.findById(lead._id).lean()).activities;
    ok(timeline.some((a) => a.type === "terms_sent" && /Palace T&C 2027\.pdf/.test(a.description || "")),
      "…and the lead's timeline names the file, so 'which terms?' is answerable from the lead");

    // removing it must not break the record of what was already sent
    await call(td.deleteTermsDocument, req());
    const stillThere = await VenueQuoteRound.findById(sent.body.roundId).lean();
    ok(stillThere.termsDocument.url === URL_B,
      "REMOVING the document does NOT rewrite what was already sent — the dispute link keeps resolving");
    ok((await call(td.getTermsDocument, req())).body.document.uploaded === false, "…but it stops going out again");

    const afterRemove = await call(terms.sendTerms, leadReq({ email: "priya@example.com" }));
    ok(afterRemove.code === 400 && afterRemove.body.code === "no_terms_document",
      "…and the send returns to the honest empty state rather than sending the deleted file");

    // ── the generated path is NOT deleted ──
    console.log("\n[E. the generated path still works for anyone relying on it]");
    await Venue.updateOne({ _id: venue._id }, {
      $set: { policyDoc: { policies: ["No fireworks after 10pm."], terms: ["Payment in three instalments."], refund: [] } },
    });
    const generated = await call(terms.sendTerms, leadReq({ email: "priya@example.com" }));
    ok(generated.code === 200 && generated.body.kind === "generated",
      "a venue with policies but no upload still sends GENERATED clauses — working machinery was not deleted");
    ok(generated.body.clauseCount === 2, "…with its clauses intact");

    // and upload takes precedence when both exist
    await call(td.putTermsDocument, req({
      body: { url: URL_A, filename: "signed-terms.pdf", contentType: "application/pdf", sizeBytes: 100000 },
    }));
    const both = await call(terms.sendTerms, leadReq({ email: "priya@example.com" }));
    ok(both.body.kind === "document",
      "THE PRECEDENCE: with BOTH, the uploaded PDF wins — an owner who uploaded their real terms did not ask for our approximation");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const v of created.venues) {
      await VenueQuoteRound.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
