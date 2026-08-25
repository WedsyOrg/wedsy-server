// The Documents tab is the tab an owner opens to find the thing they just made.
//
// It sorted by `version`, which is neither a time nor comparable across rows:
// versions are scoped to {enquiry, kind}, so every kind restarts at v1. A global
// sort put whichever row had a v2 on top regardless of age and left every v1
// tied — and MongoDB guarantees no order among ties.
//
// This suite reproduces the exact list the founder saw, asserts it now comes
// back newest-first, and pins the three things that must NOT influence the
// order: kind, version number, and the Latest flag.
//
// Run: node tests/venue-document-order.test.js
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueLeadDocument = require("../models/VenueLeadDocument");
const docs = require("../controllers/venueLeadDocument");

const TAG = `docord-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], leads: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const minsAgo = (n) => new Date(Date.now() - n * 60000);

let venue, lead;
const asOwner = () => ({
  params: { slug: venue.slug, enquiryId: String(lead._id) },
  query: {}, body: {},
  venueOwner: { type: "venue_owner", venueId: venue._id, role: "owner" },
});

/**
 * Written with an explicit createdAt, because the whole question is ordering by
 * TIME and the rows have to be spread across days to ask it. insertNextVersion
 * would stamp them all "now" and the suite would pass on a list of one instant.
 */
async function put({ kind, version, createdAt, note }) {
  const d = await VenueLeadDocument.create({
    venue: venue._id, enquiry: lead._id, kind, version, note,
    url: "https://example.invalid/x.pdf", filename: `${kind}-v${version}.pdf`,
    contentType: "application/pdf", generatedByName: "Owner",
  });
  // createdAt is set by timestamps on insert; the model refuses a second save,
  // so the backdate goes through the collection directly.
  await VenueLeadDocument.collection.updateOne({ _id: d._id }, { $set: { createdAt } });
  return d;
}

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await VenueLeadDocument.init();
    venue = await Venue.create({ name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(venue._id);
    lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} Couple`, coupleNameManual: true,
      couplePhone: "9800001111", stage: "booked",
    });
    created.leads.push(lead._id);

    // ══ THE FOUNDER'S LIST, EXACTLY ═════════════════════════════════════════
    // Inserted in an order that is neither chronological nor alphabetical, so
    // "it happens to come back right" cannot pass.
    console.log("\n[the list a live lead actually held]");
    const FIVE_DAYS = 5 * 24 * 60;
    await put({ kind: "terms", version: 1, createdAt: minsAgo(FIVE_DAYS + 30), note: "T&C" });
    await put({ kind: "invoice", version: 1, createdAt: minsAgo(FIVE_DAYS + 10), note: "INV0001" });
    await put({ kind: "booking_confirmation", version: 1, createdAt: minsAgo(FIVE_DAYS), note: "confirmation" });
    await put({ kind: "invoice", version: 2, createdAt: minsAgo(120), note: "INV0002" });
    await put({ kind: "statement", version: 1, createdAt: minsAgo(3), note: "statement" });

    const res = await call(docs.listLeadDocuments, asOwner());
    ok(res.code === 200, `GET documents → 200 (got ${res.code})`);
    const order = res.body.documents.map((d) => d.note);
    console.log(`     order: ${order.join(" → ")}`);

    ok(order[0] === "statement", `the newest document is FIRST (got "${order[0]}")`);
    ok(order[1] === "INV0002", `…then the 2h-old invoice (got "${order[1]}")`);
    ok(
      JSON.stringify(order) === JSON.stringify(["statement", "INV0002", "confirmation", "INV0001", "T&C"]),
      "…and the whole list is strictly newest-first",
    );

    console.log("\n[the three things that must NOT influence the order]");
    const idx = (n) => order.indexOf(n);
    ok(idx("statement") < idx("INV0002"),
      "VERSION does not: a v1 statement outranks a v2 invoice because it is newer");
    ok(idx("INV0002") > idx("statement") && idx("INV0001") === 3,
      "KIND does not: the two invoices are not adjacent — they sit 2nd and 4th, by age");
    const latest = res.body.documents.filter((d) => d.isLatest).map((d) => d.note);
    ok(latest.length === 4, `${latest.length} documents carry isLatest (one per kind)`);
    ok(idx("confirmation") === 2 && idx("T&C") === 4,
      "the Latest flag does not: confirmation and T&C are both latest-of-kind and still sit by age");

    console.log("\n[the derived fields still answer correctly — they never depended on order]");
    const byNote = Object.fromEntries(res.body.documents.map((d) => [d.note, d]));
    ok(byNote.INV0002.isLatest === true && byNote.INV0001.isLatest === false, "isLatest is still per-kind");
    ok(byNote.INV0002.versionsOfKind === 2 && byNote.statement.versionsOfKind === 1, "versionsOfKind still correct");
    ok(res.body.latestVersion === 2, `latestVersion still ${res.body.latestVersion}`);

    console.log("\n[a tie in the same millisecond is still deterministic]");
    const sameInstant = minsAgo(1);
    await put({ kind: "address_proof", version: 1, createdAt: sameInstant, note: "tie-a" });
    await put({ kind: "client_document", version: 1, createdAt: sameInstant, note: "tie-b" });
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const r = await call(docs.listLeadDocuments, asOwner());
      runs.push(r.body.documents.map((d) => d.note).join(","));
    }
    ok(new Set(runs).size === 1, `four reads returned the same order (${new Set(runs).size} distinct)`);
    ok(runs[0].startsWith("tie-b,tie-a") || runs[0].startsWith("tie-a,tie-b"),
      "…with the tied pair at the top, ordered by _id rather than arbitrarily");

    console.log("\n[BOTH columns, because the tab splits this one list]");
    // documents-tab filters this array into venue and client lists and does not
    // re-sort, so the split has to be newest-first on both sides for free.
    const venueSide = res.body.documents.filter((d) => (d.origin ?? "venue") === "venue");
    const all = (await call(docs.listLeadDocuments, asOwner())).body.documents;
    const clientSide = all.filter((d) => d.origin === "client");
    const isDesc = (list) => list.every((d, i) => i === 0 || new Date(list[i - 1].createdAt) >= new Date(d.createdAt));
    ok(isDesc(venueSide), `venue documents are newest-first (${venueSide.length} rows)`);
    ok(isDesc(clientSide), `client documents are newest-first (${clientSide.length} rows)`);
    ok(clientSide.length === 2, "…and the client column really has the two client-kind rows");

    console.log("\n[versioning itself still works — the other version sort was left alone]");
    const next = await docs.insertNextVersion(
      { venue: venue._id, enquiry: lead._id, kind: "invoice", note: "INV0003", url: "x", contentType: "application/pdf" },
      (v) => ({ filename: `invoice-v${v}.pdf` }),
    );
    ok(next.version === 3, `the next invoice is v${next.version}, not v1 — max-version lookup is untouched`);
  } catch (err) {
    fail += 1;
    console.error("\nFATAL", err);
  } finally {
    try {
      await VenueLeadDocument.deleteMany({ enquiry: { $in: created.leads } });
      await VenueEnquiry.deleteMany({ _id: { $in: created.leads } });
      await Venue.deleteMany({ _id: { $in: created.venues } });
    } catch (e) { /* best effort */ }
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
