/**
 * panelQuote comes from WHAT THE PANEL DISPLAYS (2026-08-21).
 *
 * It used to read the floral-run ladder row, which the panel stopped showing
 * when it moved to size options — so one pin had two prices (Ivory Cascade
 * quoted ₹51,000 on floral run against ₹93,333 in the tier table).
 *
 * sizeOptions exist for Stage and Mandap only; the other eleven categories show
 * a single band/floral-run row and are quoted from that. Haldi keeps its
 * floral-run quote because floral run IS its engine.
 *
 * PURE apart from the comparables query.
 *
 *   node tests/decor-panel-quote-source.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const { buildDemoPrice, resolveOccasion } = require("../services/decorDemoPrice");
const { normalizeComparable } = require("../services/decorPricing");
const { postProcess } = require("../services/decorVision");
const { panelQuoteFor } = require("../services/decorReadCache");
const Decor = require("../models/Decor");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
const mid500 = (r) => Math.round((r.low + r.high) / 2 / 500) * 500;

const analysisFor = (category, recommended, measured = true) =>
  postProcess({
    isDecorProduct: true, category, categoryConfidence: 0.9, style: "Modern",
    size: { length: 24, width: 16, confidence: 0.8 },
    complexity: { tier: "standard", confidence: 0.7, reasoning: "r" },
    observations: [], recommendedSize: recommended,
    stageMeasurements: measured
      ? { spanWidthFt: 24, floralRunFt: 19, confidence: 0.6, repeatingElements: { count: 4, estimatedWidthEachFt: 6 }, widthToHeightRatio: 3, structureGeometry: "blocky", reasoning: "x" }
      : null,
    occasion: { value: null, confidence: 0 },
  }, "demo");

const compsFor = async (category) =>
  (await Decor.find({ category, productVisibility: true, productAvailability: true },
    "name productInfo.id productInfo.measurements productTypes image thumbnail").lean()).map(normalizeComparable);

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    // ── 1. STAGE — the case that was wrong ──────────────────────────────────
    console.log("1. Stage quotes the displayed rung, not the floral-run row");
    // No caption, so the occasion floor stays out of the way and the RECOMMENDED
    // rung survives into the displayed pair.
    const a1 = analysisFor("Stage", { length: 24, width: 16 });
    const c1 = await compsFor("Stage");
    const out1 = buildDemoPrice(a1, c1, { occasion: null });
    const q1 = await panelQuoteFor(a1, { pinText: "" });

    eq(out1.sizeOptions.length, 2, "the panel displays two rungs");
    eq(out1.floralRunPriced, true, "…and the floral-run row still exists internally");
    const rec1 = out1.sizeOptions.find((o) => o.size === a1.recommendedSize);
    ok(!!rec1, "the RECOMMENDED rung is among them");
    eq(q1.size, a1.recommendedSize, "the quote is on the RECOMMENDED rung");
    eq(q1.basis, "size-ladder", "…and records its basis");
    eq(q1.low, rec1.prices.artificial.low, "low matches the displayed rung");
    eq(q1.high, rec1.prices.artificial.high, "high matches the displayed rung");
    eq(q1.midpoint, mid500(rec1.prices.artificial), "midpoint IS the displayed rung's midpoint");
    eq(q1.tier, "artificial", "still quoted on applicableTiers[0] — nothing else shifted");
    ok(q1.headroomApplied > 1, "the ×1.15 headroom is still in");

    // the drift itself
    const floral = out1.ladder[0].prices.artificial;
    ok(JSON.stringify(floral) !== JSON.stringify(rec1.prices.artificial),
      `the floral-run row is a genuinely different figure (${floral.low}-${floral.high} vs ${rec1.prices.artificial.low}-${rec1.prices.artificial.high})`);
    ok(q1.midpoint !== mid500(floral), "…and the quote no longer follows it");

    // every tier of that rung is available for the modal's table
    eq(q1.tierPrices.artificial.midpoint, q1.midpoint, "tierPrices.artificial agrees with the headline");
    for (const t of out1.applicableTiers) {
      eq(q1.tierPrices[t].midpoint, mid500(rec1.prices[t]), `tierPrices.${t} matches the displayed rung`);
    }

    // ── 2. MANDAP — the other sized category ────────────────────────────────
    console.log("\n2. Mandap behaves the same way");
    const a2 = analysisFor("Mandap", { length: 24, width: 16 }, false);
    const out2 = buildDemoPrice(a2, await compsFor("Mandap"), { occasion: null });
    const q2 = await panelQuoteFor(a2, { pinText: "" });
    eq(q2.basis, "size-ladder", "quoted from the size ladder");
    ok(out2.sizeOptions.some((o) => o.size === q2.size), "…on a displayed rung");
    const rec2 = out2.sizeOptions.find((o) => o.size === q2.size);
    eq(q2.midpoint, mid500(rec2.prices.artificial), "…at its midpoint");

    // ── 3. HALDI — keeps the floral-run quote ───────────────────────────────
    console.log("\n3. Haldi keeps its floral-run quote — floral run IS its engine");
    const a3 = analysisFor("Stage", { length: 24, width: 16 });
    const occ = resolveOccasion("haldi ceremony", a3.occasion);
    const out3 = buildDemoPrice(a3, await compsFor("Stage"), { occasion: occ });
    const q3 = await panelQuoteFor(a3, { pinText: "haldi ceremony" });
    eq(out3.category, "Haldi", "the caption relabels the Stage to Haldi");
    eq(out3.sizeOptions.length, 0, "…which has NO size model, so nothing is displayed as rungs");
    ok(!!q3, "a quote is still produced — this must never return null");
    eq(q3.basis, "floral-run", "…recorded as floral-run");
    eq(q3.size, null, "…with no rung size");
    eq(q3.tier, "mixed", "…on Haldi's first applicable tier (it has no artificial)");
    eq(q3.midpoint, mid500(out3.ladder[0].prices.mixed), "…and it matches the row the panel shows");

    // ── 4. THE OTHER TEN CATEGORIES ─────────────────────────────────────────
    console.log("\n4. every category with no size model still quotes, from its band row");
    const others = ["Photobooth", "Entrance", "Pathway", "Nameboard", "Mala & More", "Phoolon Ki Chadar", "Partitions", "Furniture", "Sound & Light", "Entries & Effects"];
    let quoted = 0, sized = 0;
    for (const cat of others) {
      const a = analysisFor(cat, null, false);
      const out = buildDemoPrice(a, await compsFor(cat), { occasion: null });
      if (out.rejected) continue;
      if (out.sizeOptions.length) sized += 1;
      const q = await panelQuoteFor(a, { pinText: "" });
      if (!q) { ok(false, `${cat}: produced NO quote`); continue; }
      quoted += 1;
      const row = out.ladder[0].prices[q.tier];
      if (!row) { ok(false, `${cat}: quoted tier ${q.tier} has no band row`); continue; }
      ok(q.basis === "category-band" && q.midpoint === mid500(row), `${cat}: quoted from its band row (${q.midpoint})`);
    }
    eq(sized, 0, "none of them has size options — only Stage and Mandap do");
    eq(quoted, others.length, "…and every one still produced a quote");

    // ── 5. FALLBACK WHEN THE RECOMMENDATION IS NOT DISPLAYED ────────────────
    console.log("\n5. the recommendation can be evicted by the occasion floor");
    // "reception" floors the bracket at 20ft, so a 16x12 recommendation is
    // dropped AFTER the swap — swap-first / floor-last, exactly as ruled.
    const a5 = analysisFor("Stage", { length: 16, width: 12 });
    const out5 = buildDemoPrice(a5, await compsFor("Stage"), { occasion: resolveOccasion("reception stage", a5.occasion) });
    const q5 = await panelQuoteFor(a5, { pinText: "reception stage" });
    eq(a5.recommendedSize, "16x12", "the read recommends 16x12");
    ok(!out5.sizeOptions.some((o) => o.size === "16x12"), "…which the floor evicts from the display");
    ok(out5.sizeOptions.some((o) => o.size === q5.size), "the quote still lands on a DISPLAYED rung");
    const rec5 = out5.sizeOptions.find((o) => o.size === q5.size);
    eq(q5.midpoint, mid500(rec5.prices.artificial), "…at that rung's midpoint, never at an undisplayed price");

    // ── 6. NON-DECOR ────────────────────────────────────────────────────────
    console.log("\n6. a rejected read still yields no quote");
    const q6 = await panelQuoteFor(postProcess({ isDecorProduct: false }, "demo"), { pinText: "" });
    eq(q6, null, "a non-décor image produces no panel quote");
  } catch (e) {
    fail++; console.error("  ✗ threw:", e);
  } finally {
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
