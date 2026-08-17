// Booking engine S1 — venue-level configuration.
// Run: node tests/venue-booking-settings.test.js
//
// Covers the three things most likely to be wrong:
//   · the 100% rule in INTEGER arithmetic, including 33.33 x 3
//   · the rich-text schema rejecting anything it cannot render to PDF
//   · the deny sweep: a foreign venue is 404, never 403, and a write without
//     the capability does not land
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");

const bs = require("../controllers/venueBookingSettings");
const sched = require("../utils/venuePaymentSchedule");
const rt = require("../utils/venueRichText");
const { resolveBranding } = require("../utils/venueBranding");

const TAG = `bes-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const created = { venues: [], owners: [] };
const mockRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const venue = await Venue.create({
      name: `${TAG} Palace`, slug: `${TAG}-v`, city: "Bangalore", state: "Karnataka",
      spaces: [{ name: "Lawn", isBookable: true }],
      logo: "", address: "12 Palace Road, Bangalore",
      contact: { primaryPhone: "9800000000", email: "hello@example.com" },
      gstin: "29ABCDE1234F1Z5", pan: "ABCDE1234F", invoicePrefix: "CE",
    });
    created.venues.push(venue._id);
    const owner = await VenueOwner.create({ venueId: venue._id, name: "Owner", phone: `${TAG}o`, isActive: true });
    created.owners.push(owner._id);

    const req = (extra = {}) => ({
      params: { slug: venue.slug, ...(extra.params || {}) },
      query: {}, body: extra.body || {},
      venueOwner: { type: "venue_owner", venueId: venue._id, venueOwnerId: owner._id },
      venueMember: null,
    });

    // ══ S1a · BRANDING IS RESOLVED, NOT DUPLICATED ══════════════════════════
    console.log("\n[S1a. branding comes from the fields that already exist]");
    const b = resolveBranding(venue);
    ok(b.name === `${TAG} Palace`, "name from Venue.name");
    ok(b.gstin === "29ABCDE1234F1Z5", "GSTIN from Venue.gstin (Settings → Billing & tax)");
    ok(b.pan === "ABCDE1234F", "PAN from Venue.pan");
    ok(b.invoicePrefix === "CE", "invoice prefix from Venue.invoicePrefix");
    ok(b.phone === "9800000000", "phone falls back through contact.primaryPhone");
    ok(b.hasGstin === true, "hasGstin true, so a GST invoice can be offered");
    ok(b.contactLine.includes("Palace Road") && b.contactLine.includes("hello@example.com"),
      "contactLine pre-joins address · phone · email");
    ok(b.taxLine === "GSTIN: 29ABCDE1234F1Z5    PAN: ABCDE1234F", "taxLine is composed once for every document");
    // Absent fields must drop out, not leave dangling separators.
    const bare = resolveBranding({ name: "Bare" });
    ok(bare.contactLine === "" && bare.taxLine === "", "a venue with nothing set yields empty lines, not stray bullets");
    ok(bare.hasGstin === false, "…and cannot be offered a GST invoice");
    ok(resolveBranding({ name: "X", gstin: "undefined" }).gstin === "", 'the literal string "undefined" is treated as absent');

    // ══ S1d · THE 100% RULE ═════════════════════════════════════════════════
    console.log("\n[S1d. percentages total exactly 100, in integer arithmetic]");
    ok(33.33 * 3 !== 100, "float would fail: 33.33 * 3 is 99.99 (the case the brief flags)");
    for (const n of [1, 2, 3, 4, 6, 7, 12]) {
      const rows = sched.equalInstalmentRows(n);
      const chk = sched.checkTotal(rows.map((r) => ({ percentHundredths: sched.toHundredths(r.percent, "x") })));
      ok(chk.ok, `${n} equal instalments total exactly 100% (${rows.map((r) => r.percent).join(" + ")})`);
    }
    const three = sched.equalInstalmentRows(3).map((r) => r.percent);
    ok(three[0] === 33.34 && three[1] === 33.33 && three[2] === 33.33,
      "3 equal is 33.34 / 33.33 / 33.33 — the remainder goes to the earliest row");
    const short = sched.checkTotal([50, 40].map((p) => ({ percentHundredths: sched.toHundredths(p, "x") })));
    ok(!short.ok && short.message === "10% short of 100%", `a shortfall reports live: "${short.message}"`);
    const over = sched.checkTotal([50, 60].map((p) => ({ percentHundredths: sched.toHundredths(p, "x") })));
    ok(!over.ok && over.message === "10% over 100%", `an excess reports live: "${over.message}"`);
    for (const s of sched.BUILTIN_SLABS) {
      const c = sched.checkTotal(s.rows.map((r) => ({ percentHundredths: sched.toHundredths(r.percent, "x") })));
      ok(c.ok, `built-in shape "${s.name}" totals 100%`);
    }

    console.log("\n[S1d. amounts always add up to the booking value]");
    for (const v of [1000000, 999999, 812500, 7, 1, 0]) {
      const g = sched.generateSchedule({ rows: sched.equalInstalmentRows(3), totalValue: v, eventDate: "2026-11-26T00:00:00Z" });
      ok(g.totals.amountsMatchBookingValue && g.totals.amount === v,
        `value ${v}: [${g.rows.map((r) => r.amount).join(" + ")}] = ${g.totals.amount}`);
    }
    let refused = "";
    try { sched.generateSchedule({ rows: [33.33, 33.33, 33.33].map((p, i) => ({ label: `r${i}`, percent: p })), totalValue: 100 }); }
    catch (e) { refused = e.message; }
    ok(/exactly 100%/.test(refused), `a 99.99% schedule is refused: "${refused}"`);

    console.log("\n[S1d. dates default sensibly against the event date]");
    const gen = sched.generateSchedule({
      rows: sched.BUILTIN_SLABS.find((s) => s.key === "three_way").rows,
      totalValue: 1200000,
      eventDate: "2026-11-26T00:00:00Z",
      now: new Date("2026-08-17T00:00:00Z"),
    });
    ok(gen.rows[0].dueDate.toISOString().slice(0, 10) === "2026-08-17", "an 'on booking' row is due today, not against the event");
    ok(gen.rows[1].dueDate.toISOString().slice(0, 10) === "2026-10-27", "a -30 row is 30 days before the event");
    ok(gen.rows[2].dueDate.toISOString().slice(0, 10) === "2026-11-19", "the balance is 7 days before the event");

    // ══ S1d · PERSISTENCE ═══════════════════════════════════════════════════
    console.log("\n[S1d. saving shapes]");
    const good = await call(bs.putPaymentSlabs, req({ body: { paymentSlabs: [
      { name: "House 50/50", isDefault: true, rows: [{ label: "Advance", percent: 50, offsetDays: null }, { label: "Balance", percent: 50, offsetDays: -7 }] },
    ] } }));
    ok(good.code === 200, "a valid shape saves → 200");
    ok(good.body.paymentSlabs[0].rows.length === 2, "…with its rows");
    const bad = await call(bs.putPaymentSlabs, req({ body: { paymentSlabs: [
      { name: "Broken", rows: [{ label: "a", percent: 60 }, { label: "b", percent: 30 }] },
    ] } }));
    ok(bad.code === 400 && /exactly 100%/.test(bad.body.message), `a shape that does not total 100 is refused: "${bad.body.message}"`);
    const after = await Venue.findById(venue._id).select("settings").lean();
    ok(after.settings.paymentSlabs.length === 1, "the refused shape did not overwrite the saved one");
    ok(after.settings.holdExpiryDays !== undefined, "…and saving slabs did not wipe other venue settings");

    // ══ S1c · RICH TEXT ═════════════════════════════════════════════════════
    console.log("\n[S1c. the cancellation policy schema]");
    const policy = [
      { type: "heading", level: 1, spans: [{ text: "Cancellation policy", bold: false }] },
      { type: "paragraph", spans: [{ text: "If you cancel, the following applies: ", bold: false }, { text: "no exceptions.", bold: true }] },
      { type: "orderedList", items: [
        { spans: [{ text: "More than 90 days before: full refund less the token.", bold: false }] },
        { spans: [{ text: "30–90 days: 50% refund.", bold: false }] },
      ] },
      { type: "bulletList", items: [{ spans: [{ text: "Force majeure is handled case by case.", bold: false }] }] },
    ];
    const saved = await call(bs.putCancellationPolicy, req({ body: { blocks: policy } }));
    ok(saved.code === 200, "a valid policy saves → 200");
    ok(saved.body.cancellationPolicy.blocks.length === 4, "…all four blocks stored");
    ok(saved.body.cancellationPolicy.plainText.includes("1. More than 90 days"), "…ordered list numbers in the plain-text mirror");
    ok(saved.body.cancellationPolicy.blocks[1].spans[1].bold === true, "…and the bold run survives as a run, not a whole block");

    for (const [blocks, why] of [
      [[{ type: "table", spans: [{ text: "x" }] }], "a table (unrenderable, and a fidelity risk)"],
      [[{ type: "image", spans: [{ text: "x" }] }], "an image"],
      [[{ type: "paragraph", spans: [{ text: "x".repeat(3000) }] }], "a single run over the per-run cap"],
      [["not an object"], "a non-object block"],
      [{ nope: 1 }, "blocks that are not an array"],
    ]) {
      const r = await call(bs.putCancellationPolicy, req({ body: { blocks } }));
      ok(r.code === 400, `refused: ${why}`);
    }
    // The length guard exists because pdfkit truncates an oversized cell silently.
    const huge = [{ type: "paragraph", spans: Array.from({ length: 20 }, () => ({ text: "y".repeat(1900) })) }];
    const tooLong = await call(bs.putCancellationPolicy, req({ body: { blocks: huge } }));
    ok(tooLong.code === 400 && /limit is/.test(tooLong.body.message), "a policy past the total-length cap is refused with the limit named");
    const stillThere = await Venue.findById(venue._id).select("cancellationPolicy").lean();
    ok(stillThere.cancellationPolicy.blocks.length === 4, "…and the previous policy is untouched by a rejected save");
    // Heading level is presentation: coerced, not fatal.
    const lvl = await call(bs.putCancellationPolicy, req({ body: { blocks: [{ type: "heading", level: 9, spans: [{ text: "H" }] }] } }));
    ok(lvl.code === 200 && lvl.body.cancellationPolicy.blocks[0].level === 2, "an out-of-range heading level coerces to 2 rather than failing the save");
    // Empty blocks are dropped rather than stored as blank lines on a document.
    const empties = await call(bs.putCancellationPolicy, req({ body: { blocks: [
      { type: "paragraph", spans: [{ text: "" }] }, { type: "bulletList", items: [{ spans: [] }] }, { type: "paragraph", spans: [{ text: "kept" }] },
    ] } }));
    ok(empties.code === 200 && empties.body.cancellationPolicy.blocks.length === 1, "empty paragraphs and bullets are dropped, not stored");

    console.log("\n[S1c. it renders to a PDF without throwing]");
    const { bufferDoc } = require("../utils/venuePdf");
    const { doc, done } = bufferDoc();
    rt.renderBlocksToPdf(doc, policy);
    doc.end();
    const buf = await done;
    ok(buf.length > 800 && buf.subarray(0, 5).toString() === "%PDF-", `the policy renders to a valid PDF (${buf.length} bytes)`);

    // ══ S1b · VENUE BRIEF ═══════════════════════════════════════════════════
    console.log("\n[S1b. the venue brief upload — pointer only]");
    const okBrief = await call(bs.putBrief, req({ body: {
      url: "https://example.com/brief.pdf", filename: "Crown-brief.pdf", contentType: "application/pdf", sizeBytes: 900000,
    } }));
    ok(okBrief.code === 200 && okBrief.body.brief.uploaded === true, "a PDF pointer saves → 200");
    for (const [body, why] of [
      [{ url: "http://x/brief.pdf", filename: "a.pdf", contentType: "application/pdf", sizeBytes: 1 }, "a non-https URL"],
      [{ url: "https://x/a.docx", filename: "a.docx", contentType: "application/pdf", sizeBytes: 1 }, "a non-PDF filename"],
      [{ url: "https://x/a.pdf", filename: "a.pdf", contentType: "text/html", sizeBytes: 1 }, "a non-PDF contentType"],
      [{ url: "https://x/a.pdf", filename: "a.pdf", contentType: "application/pdf", sizeBytes: 11 * 1024 * 1024 }, "a file over 10 MB"],
      [{ url: "https://x/a.pdf", filename: "a.pdf", contentType: "application/pdf", sizeBytes: 0 }, "a zero-byte file"],
    ]) {
      const r = await call(bs.putBrief, req({ body }));
      ok(r.code === 400, `refused: ${why}`);
    }
    const del = await call(bs.deleteBrief, req());
    ok(del.code === 200 && del.body.brief.uploaded === false, "deleting clears the pointer");

    // ══ THE COMBINED READ ═══════════════════════════════════════════════════
    console.log("\n[the one GET the Settings page and the wizard share]");
    const all = await call(bs.getBookingSettings, req());
    ok(all.code === 200, "GET booking-settings → 200");
    for (const k of ["branding", "brief", "terms", "cancellationPolicy", "paymentSlabs", "builtinSlabs", "limits"]) {
      ok(k in all.body, `…returns ${k}`);
    }
    ok(all.body.builtinSlabs.length === 3, "…including the three built-in shapes the wizard falls back to");

    // ══ DENY SWEEP ══════════════════════════════════════════════════════════
    console.log("\n[deny sweep: a foreign venue is 404, never 403, and writes do not land]");
    const other = await Venue.create({ name: `${TAG} Other`, slug: `${TAG}-other`, city: "Bangalore", state: "Karnataka" });
    created.venues.push(other._id);
    const foreign = (extra = {}) => ({ ...req(extra), params: { slug: other.slug, ...(extra.params || {}) } });
    for (const [fn, name] of [
      [bs.getBookingSettings, "GET booking-settings"],
      [bs.putBrief, "PUT brief"],
      [bs.deleteBrief, "DELETE brief"],
      [bs.putCancellationPolicy, "PUT cancellation-policy"],
      [bs.putPaymentSlabs, "PUT payment-slabs"],
    ]) {
      const r = await call(fn, foreign({ body: { blocks: [], paymentSlabs: [], url: "https://x/a.pdf", filename: "a.pdf", contentType: "application/pdf", sizeBytes: 5 } }));
      ok(r.code === 404, `${name} on a foreign venue → 404 (got ${r.code})`);
    }
    const untouched = await Venue.findById(other._id).select("briefDocument cancellationPolicy settings").lean();
    ok(!untouched.briefDocument || !untouched.briefDocument.url, "…and the foreign venue's brief was never written");
    ok(!untouched.cancellationPolicy || !(untouched.cancellationPolicy.blocks || []).length, "…nor its policy");
    ok(!untouched.settings || !(untouched.settings.paymentSlabs || []).length, "…nor its payment slabs");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const v of created.venues) await Venue.deleteOne({ _id: v });
    await VenueOwner.deleteMany({ _id: { $in: created.owners } });
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
