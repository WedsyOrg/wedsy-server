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

// ── THE REGRESSION A SWAP INTRODUCES (added 2026-08-18) ─────────────────────
// A small recommendation must NOT pull the pair back under the floor. The swap
// runs BEFORE the floor precisely so that the floor gets the last word: the
// floor is a founder rule about what a function physically is, while
// recommendedSize derives from a width read measured 13-45% LOW on every
// founder-verified build. Nothing caught this before the rule existed.
const smallRec = bracket(9, { occasion: "reception", recommendedSize: "12x8", category: "Stage" });
ok(
  smallRec.options.every((r) => r.length >= 20),
  `9ft reception + rec 12x8 → still all ≥20ft (${labels(smallRec.options)})`,
);
eq(labels(smallRec.options), "20x16 + 24x16", "…and it is the same floored pair as with no recommendation");
ok(smallRec.floorApplied === true, "…with floorApplied set, so the override is visible");
for (const occ of ["reception", "engagement", "sangeet", "nikah", "varmala", "muhurtham", null]) {
  for (const rec of ["8x8", "12x8", "16x12"]) {
    const b = bracket(9, { occasion: occ, recommendedSize: rec, category: "Stage" });
    ok(
      b.options.every((r) => r.length >= 20),
      `${occ === null ? "unknown" : occ} + rec ${rec}: floor holds (${labels(b.options)})`,
    );
  }
}
// The mirror case: a recommendation ABOVE the floor is honoured, not discarded.
const bigRec = bracket(9, { occasion: "reception", recommendedSize: "40x20", category: "Stage" });
ok(bigRec.options.some((r) => r.size === "40x20"), `a recommendation above the floor survives (${labels(bigRec.options)})`);
ok(bigRec.options.every((r) => r.length >= 20), "…and the pair is still entirely at/above the floor");

// small-end (mehendi) is defended the same way
const mehendiRec = bracket(9, { occasion: "mehendi", recommendedSize: "40x20", category: "Stage" });
ok(
  mehendiRec.options.every((r) => r.length <= sizeLadder.SMALL_END_CEILING_FT),
  `mehendi + rec 40x20 → still small-end only (${labels(mehendiRec.options)})`,
);

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
// EXTENDED 2026-08-18 for the recommended-size swap. The swap is the only thing
// that can put a rung into the pair which `nearestTwo` never chose, so it has to
// be inside the sweep — this is the assertion that catches an OFF-LADDER
// recommendation (16x16 / 30x16 / 12x12, all real SIZE_VOCAB values) leaking
// through as an offered option, and the one that catches a swap producing one
// rung or three.
const RECS = [
  undefined, null, "",
  // every valid rung
  ...sizeLadder.RUNGS.map((r) => r.size),
  // the SIZE_VOCAB values that are NOT rungs — these must never be offered
  "16x16", "30x16", "12x12", "20x20", "15x15",
  // junk the model could conceivably emit
  "0x0", "999x999", "abc", "16 x 12", "16X12",
];
const OFF_LADDER_RECS = ["16x16", "30x16", "12x12", "20x20", "15x15"];
let produced = 0,
  offLadder = 0,
  wrongCount = 0,
  dupes = 0,
  unsorted = 0,
  offLadderRecOffered = 0;
for (let w = 1; w <= 80; w += 0.5) {
  for (const occ of OCCS) {
    for (const conf of [0, 0.5, 0.75, 1]) {
      for (const rec of RECS) {
        const b = sizeLadder.bracketFor({
          rawWidthFt: w, occasion: occ, sizeConfidence: conf, backdropWidthFt: w,
          recommendedSize: rec, category: "Stage",
        });
        if (!b) continue;
        if (b.options.length !== 2) wrongCount++;
        if (b.options.length === 2) {
          if (b.options[0].size === b.options[1].size) dupes++;
          if (b.options[0].length > b.options[1].length) unsorted++;
        }
        for (const r of b.options) {
          produced++;
          if (!sizeLadder.isValidPair(r.length, r.width)) offLadder++;
          if (OFF_LADDER_RECS.includes(r.size)) offLadderRecOffered++;
        }
      }
    }
  }
}
eq(offLadder, 0, `every offered pair is on the ladder (${produced} generated)`);
eq(wrongCount, 0, "every bracket offers exactly two rungs");
eq(dupes, 0, "a swap never produces the same rung twice");
eq(unsorted, 0, "the pair is always sorted ascending by length, swapped or not");
eq(offLadderRecOffered, 0, "an OFF-LADDER recommendation is never offered as an option");

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

// ── 11. THE RECOMMENDED-SIZE RULE ───────────────────────────────────────────
console.log("11. recommendedSize is always among the two offered rungs");

// Geometry only — the home-function shape neutralises the floor so the swap is
// observable on its own.
const rec = (rawWidthFt, recommendedSize, extra = {}) =>
  labels(bracket(rawWidthFt, { ...HALDI_OFF(), recommendedSize, category: "Stage", ...extra }).options);

// The case the panel-side version could not do: the recommendation is OUTSIDE
// the bracket, so there was nothing to swap to and it silently no-opped.
eq(rec(24, "40x20"), "32x16 + 40x20", "rec OUTSIDE the bracket is swapped in (24x16 dropped, further by length)");
eq(rec(24, "8x8"), "8x8 + 24x16", "…in the other direction too (32x16 dropped)");
eq(rec(9, "40x20"), "12x8 + 40x20", "a far-away recommendation still lands in the pair");

// Already present → untouched, and NOT duplicated.
eq(rec(24, "24x16"), "24x16 + 32x16", "rec already offered → pair unchanged");
eq(rec(24, "32x16"), "24x16 + 32x16", "…either member");
ok(bracket(24, { ...HALDI_OFF(), recommendedSize: "24x16", category: "Stage" }).recommendedApplied === false,
  "recommendedApplied is false when nothing moved");
ok(bracket(24, { ...HALDI_OFF(), recommendedSize: "40x20", category: "Stage" }).recommendedApplied === true,
  "recommendedApplied is true when a swap happened");

// Absent / off-ladder → skip. NOT snapped: snapping would badge RECOMMENDED
// onto a size the model never recommended. 16x16 and 30x16 are real SIZE_VOCAB
// values with 24 and 21 live products, so this path is common, not exotic.
eq(rec(24, null), "24x16 + 32x16", "no recommendation → untouched");
eq(rec(24, undefined), "24x16 + 32x16", "undefined → untouched");
for (const off of ["16x16", "30x16", "12x12", "20x20", "15x15"]) {
  eq(rec(24, off), "24x16 + 32x16", `OFF-LADDER rec ${off} is skipped, never snapped`);
}
for (const junk of ["", "abc", "0x0", "999x999", "16 x 12", "16X12", 42, {}, []]) {
  eq(rec(24, junk), "24x16 + 32x16", `junk rec ${JSON.stringify(junk)} is ignored`);
}

// SCOPED TO STAGE — Mandap's vocab is 4/5 off-ladder and the rungs are Stage shapes.
eq(
  labels(bracket(24, { ...HALDI_OFF(), recommendedSize: "40x20", category: "Mandap" }).options),
  "24x16 + 32x16",
  "Mandap does NOT swap — the rule is scoped to Stage",
);
eq(
  labels(bracket(24, { ...HALDI_OFF(), recommendedSize: "40x20" }).options),
  "24x16 + 32x16",
  "…nor does a caller that passes no category at all",
);

// THE TIE-BREAK CHAIN: length → area → position.
// ⚠️ ONLY THE FIRST LINK IS LIVE. nearestTwo always returns ADJACENT rungs, and
// for an adjacent pair a length tie needs the recommendation exactly midway —
// which puts it between them, so it is either one of the two or off-ladder.
// Proven by exhaustive sweep below. The area and position links are guards for
// future rungs; they are asserted at the unit level so a ladder edit that DOES
// reach them fails here rather than silently picking arbitrarily.
eq(rec(18, "20x16"), "16x12 + 20x16", "rec already in the bracket → unchanged (adjacency, not a tie)");
{
  let ties = 0;
  for (let w = 0.5; w <= 90; w += 0.25) {
    const b = sizeLadder.nearestTwo(w);
    if (!b || b.length !== 2) continue;
    for (const r of sizeLadder.RUNGS) {
      if (r.size === b[0].size || r.size === b[1].size) continue;
      if (Math.abs(r.length - b[0].length) === Math.abs(r.length - b[1].length)) ties++;
    }
  }
  eq(ties, 0, "no length tie is reachable through nearestTwo — brackets are always adjacent");
}
// Unit level: hand the metric a NON-adjacent pair, which is the only way to make
// the area link fire. rec 20x16 sits 4ft from both 16x12 and 24x16; areas are
// rec 320, 16x12=192 (Δ128), 24x16=384 (Δ64) → 16x12 is further, so it is dropped.
ok(
  sizeLadder.furtherFromRecommended(
    sizeLadder.rungBySize("20x16"),
    sizeLadder.rungBySize("16x12"),
    sizeLadder.rungBySize("24x16"),
  ).size === "16x12",
  "furtherFromRecommended picks 16x12 over 24x16 for rec 20x16 (AREA breaks the length tie)",
);
eq(
  labels(sizeLadder.swapInRecommended(
    [sizeLadder.rungBySize("16x12"), sizeLadder.rungBySize("24x16")],
    "20x16",
  )),
  "20x16 + 24x16",
  "…and the swap drops it, keeping the pair sorted",
);
// Length alone, no tie.
ok(
  sizeLadder.furtherFromRecommended(
    sizeLadder.rungBySize("40x20"),
    sizeLadder.rungBySize("24x16"),
    sizeLadder.rungBySize("32x16"),
  ).size === "24x16",
  "…and 24x16 over 32x16 for rec 40x20, on LENGTH alone",
);

// The position tie-break is a guard for future rungs, not a live branch —
// asserted so that adding a rung which DOES reach it fails here first.
{
  let doubleTies = 0;
  for (const r of sizeLadder.RUNGS)
    for (const a of sizeLadder.RUNGS)
      for (const b of sizeLadder.RUNGS) {
        if (a === b || r === a || r === b) continue;
        if (
          Math.abs(r.length - a.length) === Math.abs(r.length - b.length) &&
          Math.abs(r.area - a.area) === Math.abs(r.area - b.area)
        )
          doubleTies++;
      }
  eq(doubleTies, 0, "no (rec, a, b) triple ties on BOTH length and area — position stays unreachable");
}

// Every swapped-in rung is PRICED, not blank — the panel-side version could only
// re-label a rung the response had already priced.
{
  const swapped = buildDemoPrice(
    { ...analysisAt(24), recommendedSize: "40x20" },
    comps,
    { occasion: { value: "reception" } },
  );
  eq(swapped.sizeOptions.map((o) => o.size).join(" + "), "32x16 + 40x20", "end-to-end: 40x20 is swapped in");
  ok(
    swapped.sizeOptions.every((o) => o.prices.artificial && o.prices.mixed && o.prices.natural),
    "…and BOTH rungs carry a full artificial/mixed/natural ladder",
  );
  const rung40 = swapped.sizeOptions.find((o) => o.size === "40x20");
  ok(rung40.prices.natural.low > 0, "the swapped-in rung is priced, not blank");
  // It must price identically to the same size reached any other way.
  const viaLadder = buildDemoPrice(analysisAt(24), comps, { occasion: { value: "reception" } })
    .ladder.find((r) => r.size === "40x20");
  eq(
    JSON.stringify(rung40.prices.natural),
    JSON.stringify(viaLadder.prices.natural),
    "…at exactly the price the ladder row of that size carries",
  );
  const wire = shapeClientResponse("demo-price", { ...swapped });
  ok(wire.sizeOptions.every((o) => sizeLadder.isValidPair(o.length, o.width)), "…and it reaches the wire as a valid pair");
  eq(wire.sizeOptions.map((o) => o.size).join(" + "), "32x16 + 40x20", "…in ascending order");
}

function HALDI_OFF() {
  // mehendi keeps the small-end rule out of the way ONLY below 12ft; for the
  // geometry tests above 12ft we need an occasion with neither rule — there is
  // none, so use the home-function exception to neutralise the floor.
  return { occasion: "reception", sizeConfidence: 1, backdropWidthFt: 1 };
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
