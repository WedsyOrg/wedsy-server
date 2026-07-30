// Phase A — décor pricing engine tests. Run: node tests/decor-pricing.test.js
// PURE unit tests (no DB). Comparables are built as raw Decor-shaped docs and
// pushed through normalizeComparable → suggestPrice, so the tier normaliser and
// the engine are both exercised. Coverage per the spec:
//   • flat-price category            → Partitions
//   • natural-only category          → Mala & More
//   • full-3-tier sized category     → Stage (+ size lookup, ladder, style,
//                                        outlier exclusion, extension uplift)
//   • size-ignored category          → Photobooth
const { suggestPrice, normalizeComparable } = require("../services/decorPricing");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

// Raw Decor-shaped doc. `tiers` keys are deliberately messy real-world
// productTypes names; `size` is [length, width] in feet (optional).
const doc = (id, name, tiers, size) => ({
  name,
  productInfo: {
    id,
    measurements: size ? { length: size[0], width: size[1] } : {},
  },
  productTypes: Object.entries(tiers).map(([n, sellingPrice]) => ({ name: n, sellingPrice })),
});
const comps = (docs) => docs.map(normalizeComparable);

// ── 1. Partitions — flat-price category ──────────────────────────────────────
{
  console.log("Partitions (flat only):");
  const data = comps([
    doc("pa-a", "A", { Price: 15000 }),
    doc("pa-b", "B", { Prices: 20000 }),   // dirty name → flat
    doc("pa-c", "C", { Pricees: 20000 }),  // typo'd name → flat
    doc("pa-d", "D", { Price: 25000 }),
  ]);
  const r = suggestPrice({ category: "Partitions" }, data);
  eq(JSON.stringify(r.applicableTiers), JSON.stringify(["flat"]), "only the flat tier is priced");
  eq(r.suggested.flat, 20000, "flat = median of comparables");
  eq(r.suggested.artificial, undefined, "no artificial tier on a flat category");
  eq(r.observedBand.median, 20000, "observedBand.median on the flat tier");
  eq(r.observedBand.n, 4, "observedBand.n counts the flat comps");
  eq(r.upliftApplied, 1, "no uplift for a non-extension caller");
  eq(r.comparables.length, 3, "always returns 3 comparables");
}

// ── 2. Mala & More — natural-only category ───────────────────────────────────
{
  console.log("Mala & More (natural only):");
  const data = comps([
    doc("na-a", "A", { Natura: 8000 }),          // typo → natural
    doc("na-b", "B", { "Natural Flowers": 8000 }),
    doc("na-c", "C", { Natural: 8000 }),
    doc("na-d", "D", { "Natural ": 10000 }),     // trailing space → natural
    doc("na-e", "E", { "Natural flowers": 15000 }),
  ]);
  // Pass a size on purpose — a natural-only category must ignore it.
  const r = suggestPrice({ category: "Mala & More", size: { length: 20, width: 20 } }, data);
  eq(JSON.stringify(r.applicableTiers), JSON.stringify(["natural"]), "only the natural tier is priced");
  eq(r.suggested.natural, 8000, "natural = median of comparables");
  eq(r.suggested.artificial, undefined, "no artificial tier");
  eq(r.suggested.mixed, undefined, "no mixed tier");
  eq(r.sizeBasis, undefined, "size is ignored (no size adjustment for Mala & More)");
  eq(r.observedBand.max, 15000, "observedBand.max = ceiling");
}

// ── 3. Stage — full-3-tier sized category ────────────────────────────────────
{
  console.log("Stage (full 3-tier, size-driven):");
  const data = comps([
    doc("st001", "S1", { "Natural Flowers": 40000 }, [16, 12]), // 192 sqft
    doc("st002", "S2", { "Natural Flowers": 50000 }, [16, 16]), // 256
    doc("st003", "S3", { "Natural Flowers": 60000 }, [20, 16]), // 320
    doc("st004", "S4", { "Natural Flowers": 80000 }, [24, 16]), // 384
    doc("st131", "Harmonic Concert", { "Natural Flowers": 700000 }, [60, 30]), // premium outlier
  ]);

  // (a) observedBand excludes the outlier from the median but reports it as max.
  const r = suggestPrice({ category: "Stage", size: { length: 16, width: 12 } }, data);
  eq(JSON.stringify(r.applicableTiers), JSON.stringify(["artificial", "mixed", "natural"]), "all three tiers apply");
  eq(r.observedBand.median, 55000, "median excludes premium outlier st131");
  eq(r.observedBand.max, 700000, "max reports the outlier as ceiling");
  eq(r.observedBand.n, 5, "n counts every natural comp (incl. outlier)");

  // (b) 192 sqft → size lookup natural 46,000; ladder preserves it exactly.
  eq(r.sizeBasis && r.sizeBasis.bucket, 192, "nearest size bucket = 192 sqft");
  eq(r.suggested.natural, 46000, "natural = size-lookup median (46,000)");
  eq(r.suggested.artificial, 31944, "artificial = natural / 1.44 (ladder anchor)");
  eq(r.suggested.mixed, 38972, "mixed = artificial × 1.22");
  ok(r.comparables.every((c) => c.id !== "st131"), "outlier is kept out of the comparables list");

  // (c) extension source → ×1.20 uplift on every tier.
  const up = suggestPrice({ category: "Stage", size: { length: 16, width: 12 }, source: "extension" }, data);
  eq(up.upliftApplied, 1.2, "extension caller gets the uplift factor");
  eq(up.suggested.natural, 55200, "natural uplifted (46,000 × 1.20)");

  // (d) style premium — Stage only, applied when confidently identified.
  const trad = suggestPrice({ category: "Stage", size: { length: 16, width: 12 }, style: "Traditional" }, data);
  eq(trad.suggested.natural, 32344, "Traditional discounts to its observed median (× 45k/64k)");
  const mod = suggestPrice({ category: "Stage", size: { length: 16, width: 12 }, style: "Modern" }, data);
  eq(mod.suggested.natural, 46000, "Modern is the baseline (unchanged)");
}

// ── 4. Photobooth — size MUST be ignored (r = −0.16) ─────────────────────────
{
  console.log("Photobooth (size ignored):");
  const data = comps([
    doc("ph01", "P1", { "Artificial Flowers": 10000 }, [8, 8]),
    doc("ph02", "P2", { "Artificial Flowers": 12000 }, [10, 8]),
    doc("ph03", "P3", { "Artificial Flowers": 14000 }, [12, 10]),
  ]);
  // A size is supplied but must not influence the result.
  const r = suggestPrice({ category: "Photobooth", size: { length: 8, width: 8 } }, data);
  eq(r.sizeBasis, undefined, "no size adjustment for Photobooth");
  eq(r.suggested.artificial, 12000, "artificial = category median, NOT a size lookup");
  eq(r.suggested.mixed, 13320, "mixed = artificial × 1.11 (ladder, size-free)");
  eq(r.suggested.natural, 14640, "natural = artificial × 1.22 (ladder, size-free)");
}

// ── unknown category guard ───────────────────────────────────────────────────
{
  console.log("Guard:");
  let threw = false;
  try { suggestPrice({ category: "Nope" }, []); } catch (e) { threw = e.code === "UNKNOWN_CATEGORY"; }
  ok(threw, "unknown category throws UNKNOWN_CATEGORY");
}

// ── added SIZE_LOOKUP entries (were gaps) ────────────────────────────────────
{
  console.log("Added size-lookup entries:");
  const s = suggestPrice({ category: "Stage", size: { length: 12, width: 12 } }, []);
  eq(s.sizeBasis.confidence, "exact", "Stage 12x12 now has an exact entry");
  eq(s.suggested.natural, 48000, "Stage 12x12 natural = 48000 (added)");
  const m15 = suggestPrice({ category: "Mandap", size: { length: 15, width: 15 } }, []);
  eq(m15.sizeBasis.confidence, "exact", "Mandap 15x15 now exact (was snapping to 256)");
  eq(m15.suggested.natural, 150000, "Mandap 15x15 natural = 150000 (was 82000)");
  const m20 = suggestPrice({ category: "Mandap", size: { length: 20, width: 16 } }, []);
  eq(m20.suggested.natural, 132500, "Mandap 20x16 natural = 132500 (was 82000)");
}

// ── snap guard: near vs far ──────────────────────────────────────────────────
{
  console.log("Snap guard:");
  // 14x14 = 196 → nearest 192 (2% away) → "near", trusted point, no band.
  const near = suggestPrice({ category: "Stage", size: { length: 14, width: 14 } }, []);
  eq(near.sizeBasis.confidence, "near", "196 sqft snaps <15% → near");
  eq(near.suggestedBand, undefined, "near snap keeps a confident point (no widened band)");
  eq(near.suggested.natural, 46000, "196 → 192 bucket natural 46000");

  // 50x30 = 1500 → nearest 800 (88% away) → "low": warn + widened band.
  const far = suggestPrice({ category: "Stage", size: { length: 50, width: 30 } }, []);
  eq(far.sizeBasis.confidence, "low", "1500 sqft snaps >15% → low confidence");
  ok(typeof far.sizeBasis.warning === "string" && far.sizeBasis.warning.length > 0, "far snap carries a warning");
  ok(far.suggestedBand && far.suggestedBand.natural, "far snap widens into a per-tier band");
  eq(far.suggestedBand.natural.low, Math.round(far.suggested.natural * 0.8), "band low = point × 0.8");
  eq(far.suggestedBand.natural.high, Math.round(far.suggested.natural * 1.2), "band high = point × 1.2");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
