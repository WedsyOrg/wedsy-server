// ── THE SIZE LADDER — single source of truth for valid décor size pairs ──────
//
// Width is a FUNCTION of length. No combination outside this table is ever
// valid or selectable, anywhere. Every other size list in the codebase
// (decorVision.SIZE_VOCAB, decorDemoPrice.SIZE_BUCKETS, decorPricing.SIZE_LOOKUP)
// predates this and does NOT agree with it — see the reconciliation note at the
// bottom of this file. This module does not attempt to fix them.
//
// WHY A BRACKET AT ALL: the vision pipeline runs at temperature 1.0 (every
// sampling control is deprecated on sonnet-5 — verified empirically), so the
// same photograph can produce different sizes and prices between two clicks;
// the measured worst case was +74%. We are not trying to beat that variance.
// We absorb it: offer the two rungs the read falls between, each with its own
// full price ladder, and let the human pick. That is deterministic and testable
// even though the model underneath is not.
//
// EVERYTHING HERE IS POST-MODEL, IN CODE. No prompt text is involved.

// ── PURE DATA. Adding a rung is a data edit — no code below changes. ─────────
// Sorted by length at load, so a row inserted anywhere still behaves.
//
// DROPPED 2026-08 (no catalogue products, no price data — do not invent them):
//   28x16  — 0 products
//   36x20  — 0 products
// Re-add either as a row here plus its SIZE_LOOKUP area entry, and the bracket,
// the "next rung up" chain, and the picker all pick it up automatically.
const RUNGS = [
  { length: 8, width: 8 },
  { length: 12, width: 8 },
  { length: 16, width: 12 },
  { length: 20, width: 16 },
  { length: 24, width: 16 },
  { length: 32, width: 16 },
  { length: 40, width: 20 },
]
  .slice()
  .sort((a, b) => a.length - b.length)
  .map((r) => Object.freeze({ ...r, size: `${r.length}x${r.width}`, area: r.length * r.width }));

Object.freeze(RUNGS);

// ── Occasion policy ─────────────────────────────────────────────────────────
// A reception/engagement/sangeet-class function is not held on an 8ft backdrop.
// When the occasion is one of these — OR unknown, which is the common case —
// never offer a rung below the floor. Unknown is deliberately included: the
// downside of quoting too small on a big function is worse than the reverse.
const FLOOR_FT = Number(process.env.DECOR_SIZE_FLOOR_FT) || 20;
const FLOORED_OCCASIONS = new Set([
  "reception",
  "engagement",
  "sangeet",
  "nikah",
  "varmala",
  "muhurtham",
]);

// Haldi and mehendi are small daytime functions — bias to the 8-12ft end.
// (Haldi additionally re-labels the category and prices by floral run, so it
// bypasses sizes entirely today; this half only bites once sizes exist there.)
const SMALL_END_OCCASIONS = new Set(["haldi", "mehendi"]);
const SMALL_END_CEILING_FT = Number(process.env.DECOR_SIZE_SMALL_END_CEILING_FT) || 12;

// ── HOME-FUNCTION EXCEPTION ─────────────────────────────────────────────────
// The floor is overridden only when the model is BOTH confident AND reads the
// build as clearly small — i.e. a reception genuinely held at home. Both
// conditions must hold; either alone is not enough.
// STARTING VALUES, expected to be tuned from real use (env-overridable):
//   confidence ≥ 0.70  — sonnet-5 reports 55-85% on real detections, so 0.70
//                        keeps the exception rare rather than routine.
//   width      ≤ 12 ft — the top of the home-backdrop range and an existing
//                        rung, so the exception can never invent a size.
const HOME_FUNCTION_MIN_CONFIDENCE = Number(process.env.DECOR_HOME_FUNCTION_MIN_CONF) || 0.7;
const HOME_FUNCTION_MAX_WIDTH_FT = Number(process.env.DECOR_HOME_FUNCTION_MAX_WIDTH_FT) || 12;

// ── Lookups (all derived from RUNGS — nothing hardcoded) ────────────────────
const isValidPair = (length, width) =>
  RUNGS.some((r) => r.length === Number(length) && r.width === Number(width));

const rungByLength = (length) => RUNGS.find((r) => r.length === Number(length)) || null;

const indexOfRung = (rung) => RUNGS.findIndex((r) => r.length === rung.length);

// Adjacent on the ladder, by LENGTH. With 28x16 dropped, 24x16's next rung up
// is 32x16. The top rung has none.
const nextRungUp = (rung) => {
  const i = indexOfRung(rung);
  return i >= 0 && i < RUNGS.length - 1 ? RUNGS[i + 1] : null;
};
const prevRungDown = (rung) => {
  const i = indexOfRung(rung);
  return i > 0 ? RUNGS[i - 1] : null;
};

// The two rungs a raw width falls between.
//   • exact hit on a rung  → that rung + the next rung UP (top rung → prev + top)
//   • between two rungs    → the two it sits between
//   • below the smallest   → the two smallest
//   • above the largest    → the two largest
const nearestTwo = (rawWidthFt) => {
  const w = Number(rawWidthFt);
  if (!Number.isFinite(w) || w <= 0) return null;

  const exact = rungByLength(w);
  if (exact) {
    const up = nextRungUp(exact);
    return up ? [exact, up] : [prevRungDown(exact), exact].filter(Boolean);
  }
  if (w < RUNGS[0].length) return [RUNGS[0], RUNGS[1]];
  const last = RUNGS[RUNGS.length - 1];
  if (w > last.length) return [RUNGS[RUNGS.length - 2], last];

  const upperIdx = RUNGS.findIndex((r) => r.length > w);
  return [RUNGS[upperIdx - 1], RUNGS[upperIdx]];
};

// ── The policy layer ────────────────────────────────────────────────────────
const homeFunctionApplies = ({ sizeConfidence, backdropWidthFt }) => {
  const conf = Number(sizeConfidence);
  const w = Number(backdropWidthFt);
  return (
    Number.isFinite(conf) &&
    conf >= HOME_FUNCTION_MIN_CONFIDENCE &&
    Number.isFinite(w) &&
    w > 0 &&
    w <= HOME_FUNCTION_MAX_WIDTH_FT
  );
};

// Two rungs at or above the floor, anchored as close to `options` as possible.
const liftToFloor = (options) => {
  const atOrAbove = RUNGS.filter((r) => r.length >= FLOOR_FT);
  if (atOrAbove.length < 2) return atOrAbove.slice();
  const kept = options.filter((r) => r.length >= FLOOR_FT);
  if (kept.length >= 2) return kept;
  if (kept.length === 1) {
    const up = nextRungUp(kept[0]);
    return up ? [kept[0], up] : [prevRungDown(kept[0]), kept[0]].filter(Boolean);
  }
  return atOrAbove.slice(0, 2);
};

// Pull the bracket down to the small end for haldi/mehendi.
const pullToSmallEnd = (options) => {
  const small = RUNGS.filter((r) => r.length <= SMALL_END_CEILING_FT);
  if (small.length < 2) return options;
  return options.every((r) => r.length <= SMALL_END_CEILING_FT) ? options : small.slice(0, 2);
};

// bracketFor({ rawWidthFt, occasion, sizeConfidence, backdropWidthFt })
//   → { options: [rung, rung], floorApplied, smallEndApplied, homeFunctionException }
// `occasion` is the resolved occasion VALUE (string) or null/undefined when
// unknown — unknown is floored, same as reception.
const bracketFor = ({ rawWidthFt, occasion, sizeConfidence, backdropWidthFt } = {}) => {
  const base = nearestTwo(rawWidthFt);
  if (!base) return null;

  const occ = typeof occasion === "string" ? occasion : null;
  const out = {
    options: base,
    floorApplied: false,
    smallEndApplied: false,
    homeFunctionException: false,
  };

  if (SMALL_END_OCCASIONS.has(occ)) {
    const pulled = pullToSmallEnd(base);
    out.smallEndApplied = pulled !== base;
    out.options = pulled;
    return out;
  }

  // Floored occasions AND unknown.
  if (occ === null || FLOORED_OCCASIONS.has(occ)) {
    if (homeFunctionApplies({ sizeConfidence, backdropWidthFt })) {
      out.homeFunctionException = true;
      return out;
    }
    const lifted = liftToFloor(base);
    out.floorApplied = lifted.length !== base.length || lifted.some((r, i) => r !== base[i]);
    out.options = lifted;
  }
  return out;
};

// The picker payload: every valid pair, in ladder order.
const validSizes = () => RUNGS.map((r) => ({ size: r.size, length: r.length, width: r.width }));

module.exports = {
  RUNGS,
  validSizes,
  isValidPair,
  rungByLength,
  nextRungUp,
  prevRungDown,
  nearestTwo,
  bracketFor,
  homeFunctionApplies,
  FLOOR_FT,
  FLOORED_OCCASIONS,
  SMALL_END_OCCASIONS,
  SMALL_END_CEILING_FT,
  HOME_FUNCTION_MIN_CONFIDENCE,
  HOME_FUNCTION_MAX_WIDTH_FT,
};

// ── RECONCILIATION NOTE (flagged, deliberately NOT fixed here) ───────────────
// Four size lists exist and none agree with this ladder or with each other:
//   decorVision.SIZE_VOCAB.Stage   — has 12x12, 16x16, 30x16 (off-ladder)
//   decorDemoPrice.SIZE_BUCKETS    — has 16x16, 30x16; LACKS 12x12
//   decorPricing.SIZE_LOOKUP       — keyed by area; has 144/256/480 (off-ladder)
// Consequence: the vision model can snap to 12x12, which the demo panel has no
// bucket for. 16x16 (24 products) and 30x16 (21 products) are heavily populated
// in the live catalogue, so removing them is a catalogue decision, not a code
// one. See the report accompanying this build.
