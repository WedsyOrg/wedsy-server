// What the Documents tab needs from the server in order to stop being bland.
// Run: node tests/venue-documents-tab.test.js
//
// Three things the list endpoint could not answer, each of which forced the UI
// into a wrong or missing behaviour:
//
//   1. "Latest" was a single max() ACROSS kinds, but versions are per-kind — so
//      the only invoice on a lead never got the badge while an older terms v2
//      did. Each row now carries isLatest, and versionsOfKind so the tab can
//      hide a version number nobody needs to see.
//   2. contentType was stored but never presented, so the tab could not tell a
//      photographed licence from a generated PDF except by sniffing filenames.
//   3. the download route hardcoded Content-Disposition: attachment, so there
//      was no way to look at a document without saving it first.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueLeadDocument = require("../models/VenueLeadDocument");

const ld = require("../controllers/venueLeadDocument");

const TAG = `dtab-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [] };
const mockRes = () => ({
  code: 200, body: null, headers: {},
  status(c) { this.code = c; return this; },
  json(b) { this.body = b; return this; },
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  destroy() {},
  on() { return this; },
  once() { return this; },
  emit() { return true; },
  write() { return true; },
  end() { return this; },
});
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await VenueLeadDocument.init();

    const venue = await Venue.create({ name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: "Priya & Arjun", coupleNameManual: true,
      couplePhone: "9800001111", stage: "booked",
    });

    const mk = (kind, version, extra = {}) =>
      VenueLeadDocument.create({
        venue: venue._id, enquiry: lead._id, kind, version,
        url: `https://stub.local/${kind}-${version}.pdf`,
        filename: `${kind}-v${version}.pdf`,
        sizeBytes: 1000 + version,
        generatedByName: "Owner",
        ...extra,
      });

    // Two terms, ONE invoice. Under the old global max(), latestVersion was 2,
    // so the invoice (v1, and the only one) was not "Latest" but terms v2 was.
    await mk("terms", 1, { note: "nothing. resharing previous one ?" });
    await mk("terms", 2, { note: "v2 — after they moved the reception date" });
    await mk("invoice", 1, {});
    await mk("client_document", 1, {
      contentType: "image/jpeg",
      filename: "licence.jpg",
      proofType: "driving_licence",
      contactName: "Arjun",
      uploadedByName: "Owner",
    });

    const req = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: extra.query || {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
      venueMember: null,
    });

    console.log("\n[1. 'Latest' is per kind, because versions are per kind]");
    const list = await call(ld.listLeadDocuments, req());
    ok(list.code === 200, `the list reads → 200 (got ${list.code})`);
    const byKV = (k, v) => list.body.documents.find((d) => d.kind === k && d.version === v);
    ok(byKV("terms", 2).isLatest === true, "terms v2 is the latest terms");
    ok(byKV("terms", 1).isLatest === false, "…and terms v1 is not");
    ok(
      byKV("invoice", 1).isLatest === true,
      "the ONLY invoice is latest — under the old global max() it never was, because terms had reached v2"
    );
    ok(byKV("client_document", 1).isLatest === true, "…and so is the only client document");
    ok(byKV("terms", 1).versionsOfKind === 2, "terms reports 2 versions, so the tab knows to show the number");
    ok(
      byKV("invoice", 1).versionsOfKind === 1 && byKV("client_document", 1).versionsOfKind === 1,
      "…while single-version kinds report 1, so 'v1 · Latest' can be hidden as the noise it is"
    );

    console.log("\n[2. the tab can tell a picture from a PDF]");
    ok(byKV("client_document", 1).contentType === "image/jpeg", "an uploaded photo presents its real contentType");
    ok(byKV("invoice", 1).contentType === "application/pdf", "…and a generated invoice presents application/pdf");
    ok(
      list.body.documents.every((d) => typeof d.contentType === "string" && d.contentType),
      "…every row carries one, so the UI never has to sniff a filename"
    );

    console.log("\n[3. the kind is on the row, so the TITLE can stop being the note]");
    ok(
      byKV("terms", 1).kind === "terms" && byKV("terms", 1).note === "nothing. resharing previous one ?",
      "the kind and the note are separate fields — the note was never meant to be the title"
    );
    ok(
      list.body.documents.every((d) => d.origin === (["address_proof", "client_document"].includes(d.kind) ? "client" : "venue")),
      "origin still splits the two tabs, derived from the kind rather than a hand-kept list"
    );

    console.log("\n[4. the same route serves a download AND a preview]");
    // The headers are set only once the upstream object is in hand, so the
    // stream has to be stubbed — a 502 would set no headers at all and the
    // assertions below would pass vacuously against `undefined`.
    const { Readable } = require("stream");
    const axios = require("axios");
    const realGet = axios.get;
    const STUB = Buffer.from("%PDF-1.4 stub");
    axios.get = async () => ({ headers: { "content-length": String(STUB.length) }, data: Readable.from([STUB]) });

    const dl = await call(ld.downloadLeadDocument, req({ params: { documentId: String(byKV("invoice", 1)._id) } }));
    ok(
      /^attachment;/.test(dl.headers["content-disposition"] || ""),
      `the default is still attachment — every existing caller is unchanged (got "${dl.headers["content-disposition"]}")`
    );
    const pv = await call(
      ld.downloadLeadDocument,
      req({ params: { documentId: String(byKV("invoice", 1)._id) }, query: { disposition: "inline" } })
    );
    ok(
      /^inline;/.test(pv.headers["content-disposition"] || ""),
      `?disposition=inline previews in place instead (got "${pv.headers["content-disposition"]}")`
    );
    ok(
      (pv.headers["content-type"] || "") === "application/pdf",
      "…with the stored content type, so the browser knows how to render it"
    );

    // Content-Length must describe the response, not the row. A stored size
    // larger than the body leaves the browser waiting for bytes that never
    // come — the download hangs. This is the regression guard for that.
    ok(
      pv.headers["content-length"] === String(Buffer.from("%PDF-1.4 stub").length),
      `Content-Length comes from the upstream object, not the stored sizeBytes (got ${pv.headers["content-length"]}, row says ${1001})`
    );
    axios.get = async () => ({ headers: {}, data: Readable.from([Buffer.from("%PDF-1.4 stub")]) });
    const noLen = await call(ld.downloadLeadDocument, req({ params: { documentId: String(byKV("invoice", 1)._id) } }));
    ok(
      noLen.headers["content-length"] === undefined,
      "…and when upstream does not say, no header is sent rather than a wrong one"
    );
    axios.get = realGet;

    console.log("\n[5. preview is still scoped — it is the same guarded route]");
    const foreign = await call(
      ld.downloadLeadDocument,
      req({
        params: { enquiryId: String(new mongoose.Types.ObjectId()), documentId: String(byKV("invoice", 1)._id) },
        query: { disposition: "inline" },
      })
    );
    ok(foreign.code === 404, `previewing a document on a lead outside scope → 404, never 403 (got ${foreign.code})`);
    const listForeign = await call(ld.listLeadDocuments, req({ params: { enquiryId: String(new mongoose.Types.ObjectId()) } }));
    ok(listForeign.code === 404, "…and so does listing them");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const v of created.venues) {
      await VenueLeadDocument.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
