// T&C cover page + stitching: personalise the venue's own PDF without touching it.
// Run: node tests/venue-terms-cover.test.js
//
// FOUR THINGS ARE PINNED HERE, matching the four risks in the design:
//   A. the cover survives a lead with almost nothing on it, and NEVER renders
//      "undefined", "null", "NaN" or an empty labelled row
//   B. stitching produces cover + every source page, in order
//   C. the source PDF is IDENTICAL in the output — asserted per page on decoded
//      content streams, with a negative control proving the check can fail
//   D. versions are immutable: v2 does not alter v1, and the model refuses a
//      second write to any row
//
// The source fixture is a genuine multi-page PDF built with pdfkit, not a stub,
// because the fidelity claim is meaningless against a one-page blank.
require("dotenv").config();
const mongoose = require("mongoose");
const PDFKit = require("pdfkit");
const { PDFDocument } = require("pdf-lib");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueOwner = require("../models/VenueOwner");
const VenueQuoteRound = require("../models/VenueQuoteRound");
const VenueLeadDocument = require("../models/VenueLeadDocument");

const cover = require("../utils/venueTermsCover");
const stitch = require("../utils/pdfStitch");
const leadDocs = require("../controllers/venueLeadDocument");

const TAG = `tcov-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [] };
const mockRes = () => ({
  code: 200, body: null, redirected: null,
  status(c) { this.code = c; return this; },
  json(b) { this.body = b; return this; },
  redirect(c, u) { this.code = c; this.redirected = u; return this; },
});
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

/**
 * The text a reader would actually SEE on a page.
 *
 * Grepping the raw PDF bytes does not work and, worse, passes vacuously: pdfkit
 * writes text as hex strings inside kerned TJ arrays —
 * `[<46582050> 40 <616c616365> 0] TJ` is "FX Palace" — and `compress: false`
 * does not change that in pdfkit 0.14 (the comment claiming otherwise in
 * services/BillingDocService is stale). A test that greps for "undefined" in the
 * raw buffer therefore passes whether or not the bug exists, because NOTHING is
 * greppable. The first draft of this suite did exactly that.
 *
 * So the content stream is decoded through pdf-lib and the hex/literal string
 * operands are reassembled. Only then does "never renders undefined" mean
 * anything.
 */
async function renderedText(pdfBuffer) {
  const doc = await PDFDocument.load(pdfBuffer);
  let all = "";
  for (let i = 0; i < doc.getPageCount(); i++) {
    const raw = doc.getPage(i).node.Contents();
    if (!raw) continue;
    const parts = typeof raw.asArray === "function" ? raw.asArray() : [raw];
    let bytes = Buffer.alloc(0);
    for (const ref of parts) {
      const s = doc.context.lookup(ref);
      if (!s) continue;
      const contents = typeof s.getContents === "function" ? s.getContents() : s.contents;
      if (contents) bytes = Buffer.concat([bytes, Buffer.from(contents)]);
    }
    const stream = bytes.toString("latin1");
    // Hex strings: <48656c6c6f>
    for (const m of stream.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
      const hex = m[1].replace(/\s+/g, "");
      if (hex.length % 2) continue;
      all += Buffer.from(hex, "hex").toString("latin1");
    }
    // Literal strings: (Hello)
    for (const m of stream.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) all += m[1];
  }
  return all;
}

/** A real multi-page PDF, with distinct drawn content per page. */
const makeSourcePdf = (pages = 6) =>
  new Promise((resolve) => {
    const d = new PDFKit({ size: "A4", margin: 50, compress: false });
    const chunks = [];
    d.on("data", (c) => chunks.push(c));
    d.on("end", () => resolve(Buffer.concat(chunks)));
    for (let i = 0; i < pages; i++) {
      if (i) d.addPage();
      d.fontSize(16).text(`VENUE CLAUSE PAGE ${i + 1}`, 50, 50);
      for (let j = 0; j < 10; j++) d.fontSize(10).text(`${j + 1}. Clause ${j + 1} on page ${i + 1}.`, { width: 495 });
    }
    d.end();
  });

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    // The version sequence is a DATABASE guarantee, so the unique index has to
    // exist before it can be asserted. Mongoose builds indexes in the
    // background after connecting, and short test runs otherwise race ahead of
    // it — which made the first draft report 3,3,3 and pass the duplicate
    // insert. init() waits for the build.
    await VenueLeadDocument.init();

    const venue = await Venue.create({
      name: `${TAG}-v`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      spaces: [{ name: "Hall", isBookable: true }],
    });
    created.venues.push(venue._id);
    const ownerDoc = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(ownerDoc._id);

    const sourcePdf = await makeSourcePdf(6);

    // ══ A · THE COVER, AND ABSENT FIELDS ══════════════════════════════════
    console.log("\n[A. the cover page survives a nearly empty lead]");

    // The extractor must be proven to SEE text, or every "does not contain"
    // assertion below is vacuous.
    const probe = await cover.buildTermsCoverBuffer({ venue: { name: "Sentinel Venue" }, lead: { coupleName: "Zoya & Kabir" } });
    const probeTxt = await renderedText(probe);
    ok(probeTxt.includes("Sentinel Venue"), "the text extractor really reads rendered text (guards every negative below)");
    ok(probeTxt.includes("Zoya & Kabir"), "…including the couple's name");

    const bare = await cover.buildTermsCoverBuffer({ venue: { name: "Bare Venue" }, lead: {} });
    const bareTxt = await renderedText(bare);
    ok(stitch.looksLikePdf(bare), "a lead with NO fields still produces a valid PDF");
    for (const bad of ["undefined", "null", "NaN", "Invalid Date"]) {
      ok(!bareTxt.includes(bad), `…and never renders "${bad}"`);
    }
    ok(!bareTxt.includes("Rs. 0"), "…and omits the quote entirely rather than printing Rs. 0");
    // The absent-row rule: no "PHONE"/"EMAIL" label with nothing after it.
    ok(!/PHONE/.test(bareTxt), "…draws no PHONE row at all when there is no phone");
    ok(!/EMAIL/.test(bareTxt), "…draws no EMAIL row at all when there is no email");

    // The literal-string trap: a bad client write can store the text "undefined".
    const poisoned = await cover.buildTermsCoverBuffer({
      venue: { name: "V" },
      lead: { coupleName: "undefined", couplePhone: "null", contacts: [{ email: "NaN" }] },
    });
    const pTxt = await renderedText(poisoned);
    ok(!pTxt.includes("undefined") && !pTxt.includes("null") && !pTxt.includes("NaN"),
      "fields literally CONTAINING \"undefined\"/\"null\"/\"NaN\" are treated as absent");

    ok(cover.clean(undefined) === "" && cover.clean(null) === "" && cover.clean("  ") === "",
      "clean() maps nothing-ish values to the empty string");
    ok(cover.clean(NaN) === "" && cover.money(NaN) === "" && cover.money(0) === "",
      "…and NaN / zero money render as nothing, not as text");
    ok(cover.longDate("not a date") === "" && cover.longDate(undefined) === "",
      "…and an unparseable date renders as nothing, never \"Invalid Date\"");

    // The sentence the brief asked for, and its degradations.
    const d1 = new Date("2026-11-26T00:00:00Z");
    ok(cover.issueSentence({ coupleName: "Priya & Arjun" }, [d1]) ===
      "These terms are issued for Priya & Arjun for their event on 26 November 2026.",
      "the issue sentence reads exactly as specified");
    ok(cover.issueSentence({ coupleName: "Priya & Arjun" }, []) === "These terms are issued for Priya & Arjun.",
      "…drops the date clause when there are no dates");
    ok(/^These terms are issued for the event on /.test(cover.issueSentence({}, [d1])),
      "…addresses the event generically when there is no couple name");
    ok(cover.issueSentence({}, []) === "",
      "…and is empty when both halves are missing, so nothing is drawn");
    ok(/and 28 November 2026\.$/.test(
      cover.issueSentence({ coupleName: "A & B" }, [d1, new Date("2026-11-28T00:00:00Z")])),
      "…and joins two dates with \"and\" rather than a comma run");

    ok(cover.longDate(d1) === "Thursday, 26 November 2026", "event dates carry their weekday");
    ok(cover.money(812500) === "Rs. 8,12,500",
      "money is Indian-grouped and avoids the rupee glyph Helvetica cannot draw");

    // Multi-day reads functions[] first, de-duplicated by day.
    const days = cover.eventDays({
      functions: [
        { date: new Date("2026-11-28T06:00:00Z") },
        { date: new Date("2026-11-26T06:00:00Z") },
        { date: new Date("2026-11-26T18:00:00Z") }, // same day, second function
      ],
      checkIn: new Date("2020-01-01T00:00:00Z"), // must be ignored when functions exist
    });
    ok(days.length === 2, "three functions across two days resolve to TWO event dates");
    ok(days[0].toISOString().slice(0, 10) === "2026-11-26", "…earliest first");

    const full = await cover.buildTermsCoverBuffer({
      venue: { name: "FX Palace" },
      lead: {
        coupleName: "Priya & Arjun", couplePhone: "9800001111",
        contacts: [{ email: "priya@example.com", isPrimary: true }],
        functions: [{ date: d1 }],
      },
      quotedAmount: 812500, sendNote: "v1 — first issue", documentName: "fx-terms.pdf",
    });
    const fullTxt = await renderedText(full);
    ok(fullTxt.includes("Priya") && fullTxt.includes("9800001111"), "a populated lead renders its details");
    ok(fullTxt.includes("first issue"), "…and the send note is ON the page, not only in the list");

    // ══ B · STITCHING ═════════════════════════════════════════════════════
    console.log("\n[B. cover + the venue's pages, in order]");
    const st = await stitch.stitchCoverOntoPdf(full, sourcePdf);
    ok(st.coverPages === 1, "the cover is one page");
    ok(st.sourcePages === 6, "all six source pages are counted");
    ok(st.totalPages === 7, "the output is 1 + 6 = 7 pages");
    const outDoc = await PDFDocument.load(st.buffer);
    ok(outDoc.getPageCount() === 7, "…and the file itself really has 7 pages");

    console.log("\n[B2. malformed sources fail cleanly instead of shipping]");
    for (const [buf, label] of [
      [Buffer.from("not a pdf"), "a non-PDF"],
      [Buffer.alloc(0), "an empty buffer"],
      [sourcePdf.subarray(0, 900), "a truncated PDF"],
    ]) {
      let code = "";
      try { await stitch.stitchCoverOntoPdf(full, buf); } catch (e) { code = e.code || "threw"; }
      ok(Boolean(code), `${label} is refused (${code})`);
    }

    // ══ C · THE SOURCE IS IDENTICAL ═══════════════════════════════════════
    console.log("\n[C. the venue's PDF is byte-identical in the output]");
    const v = await stitch.verifySourcePreserved(st.buffer, sourcePdf, { coverPages: 1 });
    ok(v.ok === true, "every source page's content stream survives the stitch unchanged");
    ok(v.checkedPages === 6, `…all six pages were actually compared (${v.checkedPages})`);
    ok(v.mismatches.length === 0, "…with no mismatches");

    // NEGATIVE CONTROL. Without this the check above could be vacuous.
    const tampered = await PDFDocument.load(sourcePdf);
    tampered.getPage(3).drawText("ALTERED", { x: 60, y: 700, size: 24 });
    const tamperedBytes = Buffer.from(await tampered.save());
    const stT = await stitch.stitchCoverOntoPdf(full, tamperedBytes);
    const vT = await stitch.verifySourcePreserved(stT.buffer, sourcePdf, { coverPages: 1 });
    ok(vT.ok === false, "NEGATIVE CONTROL: altering one source page makes the check FAIL");
    ok(vT.mismatches.includes(4), `…and it names the altered page (got [${vT.mismatches}])`);

    // A dropped page must fail too — page count, not just content.
    const short = await PDFDocument.create();
    const keep = await short.copyPages(await PDFDocument.load(sourcePdf), [0, 1, 2, 3, 4]);
    keep.forEach((p) => short.addPage(p));
    const vShort = await stitch.verifySourcePreserved(
      (await stitch.stitchCoverOntoPdf(full, Buffer.from(await short.save()))).buffer,
      sourcePdf, { coverPages: 1 }
    );
    ok(vShort.ok === false && /page count/.test(vShort.reason || ""),
      "NEGATIVE CONTROL: a dropped page fails on the page count");

    // ══ C2 · THE SIZE CAP ═════════════════════════════════════════════════
    console.log("\n[C2. the size cap that keeps the 1 GB box alive]");
    ok(stitch.MAX_SOURCE_BYTES === 12 * 1024 * 1024, "the cap is 12 MB");
    let capCode = "";
    try {
      await stitch.fetchSourcePdf("http://127.0.0.1:9/never", { maxBytes: 10 });
    } catch (e) { capCode = e.code; }
    ok(Boolean(capCode), `an unreachable source is refused rather than hanging (${capCode})`);
    for (const bad of ["", "not-a-url", "ftp://x/y.pdf"]) {
      let c = "";
      try { await stitch.fetchSourcePdf(bad); } catch (e) { c = e.code; }
      ok(c === "bad_source_url", `a non-http source URL is refused (${JSON.stringify(bad)})`);
    }

    // ══ D · IMMUTABILITY ══════════════════════════════════════════════════
    console.log("\n[D. versions are immutable]");
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} Couple`, coupleNameManual: true,
      couplePhone: "9800002222", stage: "negotiating", estimatedValue: 500000,
    });

    const v1 = await leadDocs.insertNextVersion(
      { venue: venue._id, enquiry: lead._id, kind: "terms", note: "v1 — first issue", url: "https://x/v1.pdf", sizeBytes: 111, sourceVerified: true },
      (n) => ({ filename: `terms-v${n}.pdf` })
    );
    ok(v1.version === 1, "the first generation is version 1");
    ok(v1.filename === "terms-v1.pdf", "…and the filename carries the version at INSERT time");

    const v2 = await leadDocs.insertNextVersion(
      { venue: venue._id, enquiry: lead._id, kind: "terms", note: "v2 — removed the outside-décor restriction", url: "https://x/v2.pdf", sizeBytes: 222, sourceVerified: true },
      (n) => ({ filename: `terms-v${n}.pdf` })
    );
    ok(v2.version === 2, "the next generation is version 2");

    const v1After = await VenueLeadDocument.findById(v1._id).lean();
    ok(v1After.note === "v1 — first issue", "THE POINT: making v2 did not change v1's note");
    ok(v1After.url === "https://x/v1.pdf", "…nor its stored file");
    ok(v1After.sizeBytes === 111, "…nor its size");
    ok(v1After.version === 1, "…nor its version number");

    // The model refuses a second write outright.
    let refused = "";
    try {
      const row = await VenueLeadDocument.findById(v1._id);
      row.note = "tampered";
      await row.save();
    } catch (e) { refused = e.message; }
    ok(/immutable/i.test(refused), `the model REFUSES any re-save of an existing row (${refused.slice(0, 46)}…)`);
    const stillV1 = await VenueLeadDocument.findById(v1._id).lean();
    ok(stillV1.note === "v1 — first issue", "…and the row on disk is unchanged after the attempt");

    // The unique index makes the sequence a database guarantee.
    let dupe = false;
    try {
      await VenueLeadDocument.create({ venue: venue._id, enquiry: lead._id, kind: "terms", version: 2, url: "https://x/dupe.pdf" });
    } catch (e) { dupe = e.code === 11000; }
    ok(dupe, "two rows cannot both claim version 2 — the unique index refuses it");

    // Concurrent generation still yields distinct, gapless versions.
    const racers = await Promise.all(
      [1, 2, 3].map(() =>
        leadDocs.insertNextVersion(
          { venue: venue._id, enquiry: lead._id, kind: "terms", url: "https://x/race.pdf", sourceVerified: true },
          (n) => ({ filename: `terms-v${n}.pdf` })
        )
      )
    );
    const nums = racers.map((r) => r.version).sort((a, b) => a - b);
    ok(new Set(nums).size === 3, `three simultaneous generations got three DISTINCT versions (${nums.join(",")})`);
    ok(nums.join(",") === "3,4,5", "…continuing the sequence with no gaps and no reuse");

    // ══ E · THE NO-TERMS-UPLOADED REFUSAL ═════════════════════════════════
    console.log("\n[E. never a cover with nothing behind it]");
    const req = (extra = {}) => ({
      params: { slug: venue.slug, enquiryId: String(lead._id), ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: ownerDoc._id },
      venueMember: null,
    });
    const noTerms = await call(leadDocs.generateTermsDocument, req({ body: { note: "x" } }));
    ok(noTerms.code === 400, "generating with no uploaded T&C → 400, not a lone cover page");
    ok(noTerms.body.code === "no_terms_document", "…with a code the UI can branch on");
    ok(/Settings/.test(noTerms.body.message), "…and a message naming where to fix it");

    const listed = await call(leadDocs.listLeadDocuments, req());
    ok(listed.code === 200, "the Documents tab lists without an uploaded T&C");
    ok(listed.body.canGenerate === false, "…and reports canGenerate=false so the UI explains itself");
    ok(listed.body.documents.length === 5, `…while still listing every generated version (${listed.body.documents.length})`);
    ok(listed.body.documents[0].version === 5, "…newest first");
    ok(listed.body.latestVersion === 5, "…and reports the latest version");

    // An invalid email is rejected even though email is optional.
    await Venue.updateOne({ _id: venue._id }, {
      $set: { termsDocument: { url: "https://example.com/t.pdf", filename: "t.pdf", contentType: "application/pdf", sizeBytes: 1000, uploadedAt: new Date() } },
    });
    const badEmail = await call(leadDocs.generateTermsDocument, req({ body: { email: "nope" } }));
    ok(badEmail.code === 400 && /not valid/.test(badEmail.body.message),
      "a PRESENT but malformed email is rejected rather than silently dropped");

    // Scope: a foreign lead id is 404, never 403.
    const foreign = await call(leadDocs.listLeadDocuments, req({ params: { enquiryId: String(new mongoose.Types.ObjectId()) } }));
    ok(foreign.code === 404, "a lead outside this venue is 404, never 403");
    const foreignDl = await call(leadDocs.downloadLeadDocument, req({ params: { documentId: String(new mongoose.Types.ObjectId()) } }));
    ok(foreignDl.code === 404, "…and a document id that is not this lead's is 404 too");

    // Download PROXIES the bytes rather than redirecting: scope runs on the
    // path the download actually takes, and the client's Authorization header
    // never crosses to another origin. https://x/ is unreachable here, so the
    // assertion is that it resolved scope and then tried upstream — a 404 would
    // mean scope rejected it, which is the failure worth catching.
    const dl = await call(leadDocs.downloadLeadDocument, req({ params: { documentId: String(v1._id) } }));
    ok(dl.code === 502, `download passes scope and streams from storage (unreachable upstream -> 502, got ${dl.code})`);

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const v of created.venues) {
      await VenueLeadDocument.deleteMany({ venue: v });
      await VenueQuoteRound.deleteMany({ venue: v });
      await VenueEnquiry.deleteMany({ venueId: v });
      await Venue.deleteOne({ _id: v });
    }
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
