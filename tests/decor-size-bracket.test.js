/**
 * SIZE BRACKET — the temperature-1.0 absorber.
 *
 * The vision pipeline has no determinism control (temperature/top_p/top_k are
 * all deprecated on sonnet-5), so one draw is a bet — measured worst case +74%
 * on the same image. Instead of trying to beat that, we offer the two ladder
 * rungs the read falls between and let a human pick. THIS suite is what makes
 * that deterministic: the ladder, the bracketing, and the occasion floor are
 * all pure code, post-model, and fully testable.
 *
 * PURE — no DB, no network, no Anthropic.
 *
 *   node tests/decor-size-bracket.test.js
 */
const sizeLadder = require("../services/decorSizeLadder");
const { buildDemoPrice } = require("../services/decorDemoPrice");
const { shapeClientResponse } = require("../controllers/decor");
const { SIZE_LOOKUP, TIER_LADDER } = require("../services/decorPricing");

let pass = 0,
  fail = 0;
const ok = (c, label) => {
  if (c) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
};
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

const labels = (rungs) => (rungs || []).map((r) => r.size).join(" + ");
const bracket = (rawWidthFt, extra = {}) => sizeLadder.bracketFor({ rawWidthFt, ...extra });
const opts = (rawWidthFt, extra = {}) => labels((bracket(rawWidthFt, extra) || {}).options);

// A "big function" occasion so the floor is out of the way for pure-geometry tests.
const HALDI = { occasion: "haldi" };
const SMALL_OK = { occasion: "mehendi" };

// ── 1. the ladder itself ────────────────────────────────────────────────────
console.log("1. the ladder is the single source of truth");
eq(
  sizeLadder.RUNGS.map((r) => r.size).join(" "),
  "8x8 12x8 16x12 20x16 24x16 32x16 40x20",
  "exactly the seven valid pairs, in length order",
);
ok(!sizeLadder.isValidPair(28, 16), "28x16 is NOT on the ladder (dropped — no data)");
ok(!sizeLadder.isValidPair(36, 20), "36x20 is NOT on the ladder (dropped — no data)");
ok(!sizeLadder.isValidPair(16, 16), "16x16 is NOT on the ladder");
ok(!sizeLadder.isValidPair(30, 16), "30x16 is NOT on the ladder");
ok(!sizeLadder.isValidPair(12, 12), "12x12 is NOT on the ladder");
ok(!sizeLadder.isValidPair(24, 20), "an arbitrary combination is NOT valid");
ok(sizeLadder.isValidPair(32, 16), "32x16 IS on the ladder");
ok(
  sizeLadder.RUNGS.every((r) => Object.isFrozen(r)),
  "rungs are frozen — no consumer can mutate the ladder",
);

// width is a FUNCTION of length — one width per length, no duplicates
const byLength = new Map();
for (const r of sizeLadder.RUNGS) byLength.set(r.length, r.width);
eq(byLength.size, sizeLadder.RUNGS.length, "each length appears exactly once");

// ── 2. "next rung up" = adjacent by LENGTH ──────────────────────────────────
console.log("2. next rung up — adjacent by length");
const NEXT = [
  ["8x8", "12x8"],
  ["12x8", "16x12"],
  ["16x12", "20x16"],
  ["20x16", "24x16"],
  ["24x16", "32x16"], // 28x16 dropped → 24's next up is 32
  ["32x16", "40x20"],
];
for (const [from, want] of NEXT) {
  const r = sizeLadder.RUNGS.find((x) => x.size === from);
  eq(sizeLadder.nextRungUp(r).size, want, `${from} → ${want}`);
}
ok(sizeLadder.nextRungUp(sizeLadder.RUNGS[sizeLadder.RUNGS.length - 1]) === null, "40x20 has no next rung up");

// ── 3. bracketing a raw read ────────────────────────────────────────────────
console.log("3. raw width → two nearest rungs");
eq(opts(30, HALDI_OFF()), "24x16 + 32x16", "raw 30ft → 24x16 + 32x16 (28x16 is gone)");
eq(opts(18, HALDI_OFF()), "16x12 + 20x16", "raw 18ft → 16x12 + 20x16");
eq(opts(24, HALDI_OFF()), "24x16 + 32x16", "EXACT 24ft → 24x16 + next rung up (32x16)");
eq(opts(20, HALDI_OFF()), "20x16 + 24x16", "EXACT 20ft → 20x16 + 24x16");
eq(opts(40, HALDI_OFF()), "32x16 + 40x20", "EXACT 40ft (top rung) → 32x16 + 40x20");
eq(opts(60, HALDI_OFF()), "32x16 + 40x20", "above the ladder → the two largest");
eq(opts(9, HALDI), "8x8 + 12x8", "raw 9ft → 8x8 + 12x8");
eq(opts(4, HALDI), "8x8 + 12x8", "below the ladder → the two smallest");
ok(bracket(0) === null, "zero width → no bracket");
ok(bracket(null) === null, "null width → no bracket");
ok(bracket("abc") === null, "non-numeric width → no bracket");

// ── 4. THE OCCASION FLOOR ───────────────────────────────────────────────────
console.log("4. occasion floor — no rungs below 20ft");
for (const occ of ["reception", "engagement", "sangeet", "nikah", "varmala", "muhurtham"]) {
  const o = bracket(9, { occasion: occ }).options;
  ok(
    o.every((r) => r.length >= 20),
    `${occ}: a 9ft read is lifted to the floor (${labels(o)})`,
  );
}
const unknown = bracket(9, { occasion: null }).options;
ok(unknown.every((r) => r.length >= 20), `UNKNOWN occasion is floored too (${labels(unknown)})`);
eq(labels(unknown), "20x16 + 24x16", "floored bracket is the two smallest at/above 20ft");
ok(bracket(9, { occasion: null }).floorApplied === true, "floorApplied flag is set");

// a read already above the floor is untouched
eq(opts(30, { occasion: "reception" }), "24x16 + 32x16", "reception at 30ft is unchanged");
ok(bracket(30, { occasion: "reception" }).floorApplied === false, "no floor flag when nothing moved");

// a bracket straddling the floor keeps only the valid side, then extends up
const straddle = bracket(18, { occasion: "reception" }).options;
ok(straddle.every((r) => r.length >= 20), `straddling bracket is lifted (${labels(straddle)})`);
eq(labels(straddle), "20x16 + 24x16", "16x12 is dropped, 24x16 added to keep two options");

// ── 5. home-function exception ──────────────────────────────────────────────
console.log("5. home-function exception (high confidence AND clearly small)");
const home = bracket(10, { occasion: "reception", sizeConfidence: 0.8, backdropWidthFt: 10 });
eq(labels(home.options), "8x8 + 12x8", "confident + small reception CAN go below 20ft");
ok(home.homeFunctionException === true, "exception flag is set");
ok(home.floorApplied === false, "floor was not applied when the exception fired");

ok(
  bracket(10, { occasion: "reception", sizeConfidence: 0.5, backdropWidthFt: 10 }).options.every(
    (r) => r.length >= 20,
  ),
  "LOW confidence + small → floor still applies",
);
ok(
  bracket(30, { occasion: "reception", sizeConfidence: 0.9, backdropWidthFt: 30 }).options.every(
    (r) => r.length >= 20,
  ),
  "high confidence + LARGE → exception does not fire",
);
ok(
  bracket(10, { occasion: "reception", sizeConfidence: 0.9, backdropWidthFt: null }).options.every(
    (r) => r.length >= 20,
  ),
  "no width signal → exception cannot fire",
);
eq(sizeLadder.HOME_FUNCTION_MIN_CONFIDENCE, 0.7, "threshold: confidence ≥ 0.7");
eq(sizeLadder.HOME_FUNCTION_MAX_WIDTH_FT, 12, "threshold: width ≤ 12ft");

// ── 6. haldi / mehendi bias to the small end ────────────────────────────────
console.log("6. haldi / mehendi bias to the 8-12ft end");
for (const occ of ["haldi", "mehendi"]) {
  eq(opts(9, { occasion: occ }), "8x8 + 12x8", `${occ} at 9ft stays small`);
  const big = bracket(30, { occasion: occ });
  eq(labels(big.options), "8x8 + 12x8", `${occ} at 30ft is pulled to the small end`);
  ok(big.smallEndApplied === true, `${occ}: smallEndApplied flag set`);
  ok(
    big.options.every((r) => r.length <= sizeLadder.SMALL_END_CEILING_FT),
    `${occ}: never offers above ${sizeLadder.SMALL_END_CEILING_FT}ft`,
  );
}

// ── 7. NOTHING off-ladder can ever be produced ──────────────────────────────
console.log("7. no arbitrary combination can be produced");
const OCCS = [null, "haldi", "mehendi", "reception", "engagement", "sangeet", "nikah", "varmala", "muhurtham", "bogus"];
let produced = 0,
  offLadder = 0,
  wrongCount = 0;
for (let w = 1; w <= 80; w += 0.5) {
  for (const occ of OCCS) {
    for (const conf of [0, 0.5, 0.75, 1]) {
      const b = sizeLadder.bracketFor({ rawWidthFt: w, occasion: occ, sizeConfidence: conf, backdropWidthFt: w });
      if (!b) continue;
      if (b.options.length !== 2) wrongCount++;
      for (const r of b.options) {
        produced++;
        if (!sizeLadder.isValidPair(r.length, r.width)) offLadder++;
      }
    }
  }
}
eq(offLadder, 0, `every offered pair is on the ladder (${produced} generated)`);
eq(wrongCount, 0, "every bracket offers exactly two rungs");

// ── 8. 32x16 is priced ──────────────────────────────────────────────────────
console.log("8. 32x16 price data");
eq(SIZE_LOOKUP.Stage[512], 100800, "SIZE_LOOKUP.Stage has area 512");
eq(
  Math.round(SIZE_LOOKUP.Stage[512] / TIER_LADDER.Stage.natural),
  70000,
  "…which is exactly ₹70,000 artificial through the Stage tier ladder",
);
ok(
  sizeLadder.RUNGS.filter((r) => r.length >= 20).every((r) => SIZE_LOOKUP.Stage[r.area] != null),
  "every large Stage rung has a SIZE_LOOKUP entry",
);

// ── 9. end-to-end through buildDemoPrice + the wire boundary ────────────────
console.log("9. end-to-end: buildDemoPrice → shapeClientResponse");
const comps = [
  { id: "st001", name: "Ref A", length: 24, width: 16, area: 384, sizeLabel: "24x16", image: "i", prices: { artificial: 60000, mixed: 73000, natural: 86000 } },
  { id: "st002", name: "Ref B", length: 24, width: 16, area: 384, sizeLabel: "24x16", image: "i", prices: { artificial: 62000, mixed: 75000, natural: 90000 } },
  { id: "st003", name: "Ref C", length: 24, width: 16, area: 384, sizeLabel: "24x16", image: "i", prices: { artificial: 58000, mixed: 71000, natural: 84000 } },
];
const analysisAt = (len, conf = 0.6, sm = null) => ({
  isDecorProduct: true,
  category: "Stage",
  categoryConfidence: 0.9,
  observations: [],
  size: { length: len, width: 16, confidence: conf },
  complexity: { tier: "standard", confidence: 0.7 },
  stageMeasurements: sm,
});

const plain = buildDemoPrice(analysisAt(24), comps, { occasion: { value: "reception" } });
eq(plain.sizeOptions.length, 2, "two size options returned");
eq(plain.sizeOptions.map((o) => o.size).join(" + "), "24x16 + 32x16", "exact 24 → 24x16 + 32x16");
ok(
  plain.sizeOptions.every((o) => o.prices.artificial && o.prices.mixed && o.prices.natural),
  "each option carries its OWN full artificial/mixed/natural ladder",
);
ok(
  plain.sizeOptions[1].prices.natural.low > plain.sizeOptions[0].prices.natural.low,
  "the larger rung is priced higher",
);
eq(plain.validSizes.length, 7, "validSizes carries all seven pairs");

// MEASURED STAGE — bracket sits ALONGSIDE floral run, never replaces it
const measured = buildDemoPrice(
  analysisAt(24, 0.6, {
    backdropWidthFt: 30,
    spanWidthFt: 30,
    repeatingElements: { count: 5, type: "panels", estimatedWidthEachFt: 6 },
    floralRunFt: 15,
    widthToHeightRatio: 3,
    rawHeightEstimateFt: 10,
    structureGeometry: "blocky",
    sceneType: "wide_venue_shot",
    confidence: 0.6,
  }),
  comps,
  { occasion: { value: "reception" } },
);
eq(measured.pricingModel, "floral-run", "measured Stage still prices by floral run (headline intact)");
eq(measured.ladder.length, 1, "…and still returns the single floral-run row");
ok(measured.ladder[0].size === null, "…whose size stays null, exactly as before");
eq(measured.sizeOptions.map((o) => o.size).join(" + "), "24x16 + 32x16", "…AND the bracket rides alongside, off backdropWidthFt=30");

// haldi bypasses sizes entirely
const haldi = buildDemoPrice(analysisAt(24), comps, { occasion: { value: "haldi" } });
eq(haldi.category, "Haldi", "haldi re-labels the category");
eq(haldi.sizeOptions.length, 0, "Haldi has no size model → no options (documented, moot for now)");

// ── 10. the response contract is ADDITIVE ───────────────────────────────────
console.log("10. additive — the existing contract is untouched");
const before = shapeClientResponse("demo-price", {
  ...buildDemoPrice(analysisAt(24), comps, { occasion: { value: "reception" } }),
});
for (const k of ["rejected", "category", "categoryConfidence", "observations", "applicableTiers", "ladder", "structureHeavy", "confirmWidth", "lowConfidence"]) {
  ok(k in before, `existing key preserved: ${k}`);
}
ok("sizeOptions" in before, "sizeOptions reaches the wire");
ok("validSizes" in before, "validSizes reaches the wire");
ok(
  before.sizeOptions.every((o) => sizeLadder.isValidPair(o.length, o.width)),
  "every wire-level option is a valid pair",
);
ok(
  before.validSizes.every((s) => sizeLadder.isValidPair(s.length, s.width)),
  "every wire-level validSize is a valid pair",
);
ok(
  before.validSizes.every((s) => !("prices" in s)),
  "validSizes carries no prices — the picker chooses a size, the ladder carries money",
);

// a category with no size model adds NOTHING to the payload
const nameboard = shapeClientResponse("demo-price", {
  ...buildDemoPrice(
    { isDecorProduct: true, category: "Nameboard", categoryConfidence: 0.9, observations: [], size: { length: 3, width: 2, confidence: 0.6 }, complexity: { tier: "standard", confidence: 0.7 } },
    [],
    {},
  ),
});
ok(!("sizeOptions" in nameboard), "no sizeOptions key for a category without a size model");
ok("ladder" in nameboard, "…but the existing ladder key is still there");

function HALDI_OFF() {
  // mehendi keeps the small-end rule out of the way ONLY below 12ft; for the
  // geometry tests above 12ft we need an occasion with neither rule — there is
  // none, so use the home-function exception to neutralise the floor.
  return { occasion: "reception", sizeConfidence: 1, backdropWidthFt: 1 };
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
