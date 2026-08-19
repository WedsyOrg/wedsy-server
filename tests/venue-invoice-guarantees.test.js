// Booking engine S5 — the two guarantees an invoice must carry.
// Run: node tests/venue-invoice-guarantees.test.js
//
//   1. the invoice NUMBER is unique under real concurrency, and gapless
//   2. an invoice is IMMUTABLE once generated — but only in the way it can be,
//      since payment application legitimately mutates it
//
// The numbering is NOT reimplemented here: controllers/venueInvoice.allocateInvoice
// already owns it, via an atomic VenueCounter $inc seeded from max(seq). This
// suite verifies that guarantee holds rather than adding a second mechanism.
//
// await VenueInvoice.init() is load-bearing. Mongoose builds indexes in the
// background, so a short run races ahead of the unique index and a duplicate
// insert SUCCEEDS — which is how a uniqueness test passes falsely. #130 shipped
// with exactly that hole until init() was added.
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueBooking = require("../models/VenueBooking");
const VenueInvoice = require("../models/VenueInvoice");
const VenueCounter = require("../models/VenueCounter");

const { allocateInvoice, isMilestoneCollision } = require("../controllers/venueInvoice");

const TAG = `inv-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    // Without this the unique index may not exist yet and every duplicate insert
    // below would succeed, reporting a guarantee that isn't there.
    await VenueInvoice.init();
    const idx = await VenueInvoice.collection.indexes();
    const uniq = idx.find((i) => i.unique && i.key && i.key.venue === 1 && i.key.invoiceNumber === 1);
    ok(Boolean(uniq), "the unique {venue, invoiceNumber} index EXISTS before any assertion is trusted");

    const venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      invoicePrefix: "CE-", gstin: "29ABCDE1234F1Z5",
    });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);
    const lead = await VenueEnquiry.create({
      venueId: venue._id, coupleName: `${TAG} Couple`, coupleNameManual: true,
      couplePhone: "9800001111", stage: "booked",
    });
    const booking = await VenueBooking.create({
      venue: venue._id, enquiry: lead._id, coupleName: `${TAG} Couple`, totalValue: 1200000,
      days: [{ date: new Date("2026-11-26T00:00:00Z"), eventType: "wedding", guestCount: 300 }],
    });

    // Each allocation gets its own forMilestoneId. That is not test decoration:
    // {enquiry, forMilestoneId} is now unique, so twelve invoices against ONE
    // lead are only legitimate when they cover twelve different instalments —
    // which is exactly the shape real usage has. Reusing a single milestone here
    // would be testing the duplicate guard, not the numbering, and section 4
    // does that deliberately.
    const baseFields = () => ({
      booking: booking._id,
      enquiry: lead._id,
      forMilestoneId: new mongoose.Types.ObjectId(),
      lineItems: [{ label: "Venue hire", qty: 1, unitPrice: 1200000 }],
      gstPercent: 18,
      gstMode: "exclusive",
      totals: { subtotal: 1200000, taxable: 1200000, gst: 216000, grandTotal: 1416000 },
    });

    // ══ 1 · UNIQUENESS UNDER CONCURRENCY ════════════════════════════════════
    console.log("\n[1. invoice numbers under concurrent generation]");
    const N = 12;
    const results = await Promise.all(Array.from({ length: N }, () => allocateInvoice(venue, baseFields())));
    const numbers = results.map((r) => r.invoiceNumber);
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    ok(new Set(numbers).size === N, `${N} simultaneous allocations produced ${new Set(numbers).size} DISTINCT numbers`);
    ok(new Set(seqs).size === N, "…and distinct sequence values");
    ok(seqs[0] === 1 && seqs[N - 1] === N, `…running 1..${N} with no gaps (got ${seqs[0]}..${seqs[N - 1]})`);
    ok(numbers.every((n) => /^CE-\d{4}$/.test(n)), "…all using the venue's invoicePrefix from Settings, zero-padded");
    ok(numbers.includes("CE-0001") && numbers.includes(`CE-${String(N).padStart(4, "0")}`), "…first and last as expected");

    // A second burst must continue the sequence rather than restart it.
    const more = await Promise.all(Array.from({ length: 5 }, () => allocateInvoice(venue, baseFields())));
    const allSeqs = [...seqs, ...more.map((m) => m.seq)].sort((a, b) => a - b);
    ok(new Set(allSeqs).size === N + 5, "a later burst continues the sequence rather than colliding");
    ok(allSeqs[allSeqs.length - 1] === N + 5, `…reaching ${N + 5} with no gaps`);

    // The counter is seeded from max(seq), so a pre-existing/seeded invoice cannot
    // be collided with — the case the lazy-init in allocateInvoice exists for.
    await VenueCounter.deleteOne({ key: `${venue._id}:invoice` });
    const afterCounterLoss = await allocateInvoice(venue, baseFields());
    ok(afterCounterLoss.seq === N + 6, `losing the counter row re-seeds from max(seq) rather than restarting at 1 (got ${afterCounterLoss.seq})`);
    const dupes = await VenueInvoice.aggregate([
      { $match: { venue: venue._id } },
      { $group: { _id: "$invoiceNumber", n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    ok(dupes.length === 0, "no duplicate invoice number exists in the collection");

    // And the index itself refuses a hand-forced duplicate.
    let refusedDupe = false;
    try {
      await VenueInvoice.create({ ...baseFields(), venue: venue._id, invoiceNumber: "CE-0001", seq: 9999 });
    } catch (e) { refusedDupe = e.code === 11000; }
    ok(refusedDupe, "a hand-forced duplicate number is refused by the database, not just by the allocator");

    // ══ 2 · IMMUTABILITY ════════════════════════════════════════════════════
    console.log("\n[2. an invoice is immutable once generated]");
    const inv = results[0];
    for (const [path, value] of [
      ["invoiceNumber", "CE-9999"],
      ["seq", 4242],
      ["gstPercent", 5],
      ["gstMode", "none"],
      ["discount", 100],
    ]) {
      const doc = await VenueInvoice.findById(inv._id);
      doc.set(path, value);
      let msg = "";
      try { await doc.save(); } catch (e) { msg = e.message; }
      ok(/immutable once generated/.test(msg), `changing ${path} is refused`);
    }
    // Nested and array paths too — the frozen list has to survive isModified's
    // path semantics, not just top-level scalars.
    const t = await VenueInvoice.findById(inv._id);
    t.totals.grandTotal = 1;
    let tm = ""; try { await t.save(); } catch (e) { tm = e.message; }
    ok(/immutable once generated/.test(tm), "changing totals.grandTotal is refused");
    const li = await VenueInvoice.findById(inv._id);
    li.lineItems.push({ label: "Sneaky addition", qty: 1, unitPrice: 50000 });
    let lm = ""; try { await li.save(); } catch (e) { lm = e.message; }
    ok(/immutable once generated/.test(lm), "adding a line item is refused");

    const onDisk = await VenueInvoice.findById(inv._id).lean();
    ok(onDisk.invoiceNumber === inv.invoiceNumber, "…and the row on disk is unchanged after every attempt");
    ok(onDisk.totals.grandTotal === 1416000, "…including its totals");
    ok(onDisk.lineItems.length === 1, "…and its line items");

    console.log("\n[2b. but payment application still works — four existing flows depend on it]");
    const payable = await VenueInvoice.findById(inv._id);
    payable.payments.push({ amount: 400000, mode: "upi", note: "token", status: "approved", ownerEntry: true });
    payable.status = "partially_paid";
    let payErr = "";
    try { await payable.save(); } catch (e) { payErr = e.message; }
    ok(!payErr, `recording a payment against an invoice still saves${payErr ? ` (got: ${payErr})` : ""}`);
    const paid = await VenueInvoice.findById(inv._id).lean();
    ok(paid.payments.length === 1 && paid.payments[0].amount === 400000, "…and the payment landed");
    ok(paid.status === "partially_paid", "…and status moved");

    // ══ 3 · GST IS OPTIONAL PER INVOICE ═════════════════════════════════════
    console.log("\n[3. GST is a per-invoice choice, using the GSTIN from Settings]");
    const noGst = await allocateInvoice(venue, {
      ...baseFields(),
      gstMode: "none",
      gstPercent: 0,
      totals: { subtotal: 1200000, taxable: 1200000, gst: 0, grandTotal: 1200000 },
    });
    ok(noGst.gstMode === "none", 'an invoice can be raised with gstMode "none"');
    ok(noGst.totals.gst === 0 && noGst.totals.grandTotal === 1200000, "…and carries no tax in its totals");
    ok(results[0].gstMode === "exclusive" && results[0].totals.gst === 216000, "…while another invoice on the same booking does carry GST");
    ok(noGst.seq !== results[0].seq, "…and both consumed their own number");
    const withVenue = await Venue.findById(venue._id).select("gstin").lean();
    ok(withVenue.gstin === "29ABCDE1234F1Z5", "the GSTIN itself stays in Settings — never copied onto the invoice row");

    // ══ 4 · ONE INVOICE PER MILESTONE, UNDER CONCURRENCY ════════════════════
    // The review case: two members press Raise on the SAME instalment at the
    // same moment. The controller's findOne check misses on both, because
    // neither write has landed when either read runs. Before the unique index
    // this produced two immutable tax invoices covering one instalment, and
    // neither can be deleted.
    console.log("\n[4. one invoice per milestone, under real concurrency]");
    const milestoneIdx = await VenueInvoice.collection.indexes();
    const msUniq = milestoneIdx.find(
      (i) => i.unique && i.key && i.key.enquiry === 1 && i.key.forMilestoneId === 1
    );
    ok(Boolean(msUniq), "the unique {enquiry, forMilestoneId} index EXISTS before any assertion is trusted");
    ok(
      Boolean(msUniq && msUniq.partialFilterExpression && msUniq.partialFilterExpression.enquiry),
      "…and is PARTIAL on enquiry, so the older createFromBooking path is untouched"
    );

    const sharedMilestone = new mongoose.Types.ObjectId();
    const contenders = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        allocateInvoice(venue, { ...baseFields(), forMilestoneId: sharedMilestone })
      )
    );
    const won = contenders.filter((r) => r.status === "fulfilled");
    const lost = contenders.filter((r) => r.status === "rejected");
    ok(won.length === 1, `6 simultaneous invoices for ONE instalment produced exactly 1 winner (got ${won.length})`);
    ok(lost.length === 5, `…and ${lost.length} losers, none of which created a row`);
    ok(
      lost.every((r) => isMilestoneCollision(r.reason)),
      "…every loser failed on the milestone index, not on the number index"
    );
    const covering = await VenueInvoice.countDocuments({ enquiry: lead._id, forMilestoneId: sharedMilestone });
    ok(covering === 1, `invoices now covering that ONE milestone: ${covering}`);

    // ── what a refused allocation costs the sequence ────────────────────────
    // A refused attempt has already drawn a number by the time the index turns
    // it away. allocateInvoice hands that number back when it is still the top
    // of the counter, which is always true for the ordinary sequential refusal
    // and true for some orderings of a concurrent one. The invariant that must
    // hold absolutely is the one below it: no number is ever issued twice.
    const countRows = async () => (await VenueInvoice.countDocuments({ venue: venue._id }));
    const counterNow = async () =>
      (await VenueCounter.findOne({ key: `${venue._id}:invoice` }).lean()).seq;

    const rowsAfterStorm = await countRows();
    const counterAfterStorm = await counterNow();
    const burnt = counterAfterStorm - rowsAfterStorm;
    ok(
      burnt <= 5,
      `the 5 losers burnt ${burnt} number(s), not 15 — a refused attempt no longer retries three times`
    );
    console.log(`     · counter ${counterAfterStorm}, invoices ${rowsAfterStorm} → ${burnt} number(s) unissued`);

    // The ordinary sequential refusal — the double-click — must cost NOTHING,
    // because its number is still the top of the counter when it is handed back.
    const beforeSeq = await counterNow();
    let sequentialErr = null;
    try {
      await allocateInvoice(venue, { ...baseFields(), forMilestoneId: sharedMilestone });
    } catch (e) { sequentialErr = e; }
    ok(isMilestoneCollision(sequentialErr), "a later attempt on the same instalment is refused by the index too");
    ok(
      (await counterNow()) === beforeSeq,
      "…and that refusal cost the sequence NOTHING — the number was handed back"
    );

    // And a booking-level invoice (forMilestoneId null) is one-per-lead as well.
    const bookingLevel = await allocateInvoice(venue, { ...baseFields(), forMilestoneId: null });
    ok(Boolean(bookingLevel.invoiceNumber), "a booking-level invoice (no milestone) is allowed");
    const beforeSecond = await counterNow();
    let secondBookingLevel = null;
    try {
      await allocateInvoice(venue, { ...baseFields(), forMilestoneId: null });
    } catch (e) { secondBookingLevel = e; }
    ok(isMilestoneCollision(secondBookingLevel), "…but only one of them per lead");
    ok((await counterNow()) === beforeSecond, "…and that refusal cost the sequence nothing either");

    // THE invariant. Handing a number back is only ever safe if it cannot be
    // issued twice; this is the assertion that would catch it if it were.
    const everySeq = (await VenueInvoice.find({ venue: venue._id }).select("seq invoiceNumber").lean());
    ok(
      new Set(everySeq.map((r) => r.seq)).size === everySeq.length,
      `no sequence value was issued twice across ${everySeq.length} invoices, handbacks included`
    );
    ok(
      new Set(everySeq.map((r) => r.invoiceNumber)).size === everySeq.length,
      "…and no invoice number was issued twice"
    );

    // The older venue-level path has no `enquiry`, so the partial filter must
    // let several of its invoices coexist on one booking.
    const legacyA = await allocateInvoice(venue, {
      booking: booking._id, kind: "advance",
      lineItems: [{ label: "Venue hire", qty: 1, unitPrice: 100 }],
      gstPercent: 18, gstMode: "exclusive",
      totals: { subtotal: 100, taxable: 100, gst: 18, grandTotal: 118 },
    });
    const legacyB = await allocateInvoice(venue, {
      booking: booking._id, kind: "addon",
      lineItems: [{ label: "Extra chairs", qty: 1, unitPrice: 200 }],
      gstPercent: 18, gstMode: "exclusive",
      totals: { subtotal: 200, taxable: 200, gst: 36, grandTotal: 236 },
    });
    ok(
      Boolean(legacyA.invoiceNumber && legacyB.invoiceNumber && legacyA.seq !== legacyB.seq),
      "the older createFromBooking path can still raise SEVERAL invoices per booking — the partial filter excludes it"
    );

    // ══ 5 · IMMUTABILITY HOLDS THROUGH QUERY WRITES TOO ═════════════════════
    // pre("save") is DOCUMENT middleware and never runs for updateOne or
    // findOneAndUpdate. Review proved the hole by setting invoiceNumber to
    // "HACKED-0001" through a single updateOne. Section 2 above only exercises
    // the .save() door; this exercises every other one.
    console.log("\n[5. the same immutability through query writes, not just .save()]");
    const target = results[1];
    const beforeQ = await VenueInvoice.findById(target._id).lean();

    const queryAttempts = [
      ["updateOne $set scalar", () => VenueInvoice.updateOne({ _id: target._id }, { $set: { invoiceNumber: "HACKED-0001" } })],
      ["updateOne $set nested", () => VenueInvoice.updateOne({ _id: target._id }, { $set: { "totals.grandTotal": 1 } })],
      ["updateOne $inc", () => VenueInvoice.updateOne({ _id: target._id }, { $inc: { seq: 500 } })],
      ["updateOne $unset", () => VenueInvoice.updateOne({ _id: target._id }, { $unset: { gstPercent: 1 } })],
      ["updateOne $push into lineItems", () => VenueInvoice.updateOne({ _id: target._id }, { $push: { lineItems: { label: "X", qty: 1, unitPrice: 1 } } })],
      ["updateOne positional path", () => VenueInvoice.updateOne({ _id: target._id }, { $set: { "lineItems.0.unitPrice": 5 } })],
      ["updateOne $rename onto a frozen name", () => VenueInvoice.updateOne({ _id: target._id }, { $rename: { status: "kind" } })],
      ["updateMany", () => VenueInvoice.updateMany({ venue: venue._id }, { $set: { gstMode: "none" } })],
      ["findOneAndUpdate", () => VenueInvoice.findOneAndUpdate({ _id: target._id }, { $set: { discount: 99 } })],
      ["findByIdAndUpdate", () => VenueInvoice.findByIdAndUpdate(target._id, { $set: { booking: new mongoose.Types.ObjectId() } })],
      ["replaceOne", () => VenueInvoice.replaceOne({ _id: target._id }, { ...beforeQ, totals: { ...beforeQ.totals, grandTotal: 7 } })],
      ["bulkWrite", () => VenueInvoice.bulkWrite([{ updateOne: { filter: { _id: target._id }, update: { $set: { seq: 31337 } } } }])],
    ];
    for (const [name, run] of queryAttempts) {
      let msg = "";
      try { await run(); } catch (e) { msg = e.message; }
      ok(/immutable once generated/.test(msg), `${name} is refused`);
    }

    const untouched = await VenueInvoice.findById(target._id).lean();
    ok(untouched.invoiceNumber === beforeQ.invoiceNumber, "…and the row on disk still has its original number");
    ok(untouched.seq === beforeQ.seq, "…its original seq");
    ok(untouched.totals.grandTotal === beforeQ.totals.grandTotal, "…its original grand total");
    ok(untouched.gstPercent === beforeQ.gstPercent, "…its original GST percentage");
    ok(untouched.lineItems.length === beforeQ.lineItems.length, "…and its original line items");
    ok(
      (await VenueInvoice.countDocuments({ venue: venue._id, gstMode: "none" })) === 1,
      "…and the refused updateMany did not touch any OTHER invoice either"
    );

    // The mutable half must keep working through the same door — the write
    // below is exactly what controllers/venueLeadInvoice performs after
    // rendering a PDF, and the payment flows depend on query writes staying
    // available. A guard that closed those would be a worse bug than the hole.
    console.log("\n[5b. …while the mutable fields still move through query writes]");
    const docId = new mongoose.Types.ObjectId();
    let linkErr = "";
    try {
      await VenueInvoice.updateOne({ _id: target._id }, { $set: { leadDocument: docId } });
    } catch (e) { linkErr = e.message; }
    ok(!linkErr, `linking leadDocument via updateOne still works — the write this branch itself uses${linkErr ? ` (got: ${linkErr})` : ""}`);
    ok(
      String((await VenueInvoice.findById(target._id).lean()).leadDocument) === String(docId),
      "…and the link landed"
    );
    let statusErr = "";
    try {
      await VenueInvoice.updateOne(
        { _id: target._id },
        { $set: { status: "paid" }, $push: { payments: { amount: 1, mode: "cash", status: "approved" } } }
      );
    } catch (e) { statusErr = e.message; }
    ok(!statusErr, `recording a payment via updateOne still works${statusErr ? ` (got: ${statusErr})` : ""}`);
    const afterPay = await VenueInvoice.findById(target._id).lean();
    ok(afterPay.status === "paid" && afterPay.payments.length === 1, "…and both the status and the payment landed");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const v of created.venues) {
      await VenueInvoice.deleteMany({ venue: v });
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
