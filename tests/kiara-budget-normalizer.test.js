/**
 * KIARA BUDGET NORMALIZER — range-aware parsing (CRM-scoped).
 *
 * Bug: KiaraCrmSyncService stored budget via raw.replace(/[^\d.]/g,"") which
 * stripped the hyphen from a range — "10-15k" became "1015" → ×1000 → ₹10.15L.
 * Fix: detect ranges (hyphen / en-dash / em-dash / "to"), parse BOTH bounds,
 * apply the unit to each, store the LOWER bound (conservative floor), and always
 * keep the raw phrasing in the note. Absurd/unparseable output → amount=null.
 *
 *   node tests/kiara-budget-normalizer.test.js
 *
 * Pure-function test — no DB. Exercises normalizeBudget directly.
 */
const { normalizeBudget } = require("../services/KiaraCrmSyncService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

// Asserts amount AND that the raw phrasing is preserved verbatim in note.
const expect = (raw, amount, label) => {
  const r = normalizeBudget(raw);
  ok(r.amount === amount, `${label}: ${JSON.stringify(raw)} → amount ${amount === null ? "null" : amount} (got ${r.amount})`);
  ok(r.note === String(raw), `${label}: raw preserved in note (${JSON.stringify(r.note)})`);
};

console.log("Required cases (from the spec):");
expect("10-15k", 10000, "range hyphen + k → lower bound");        // the bug
expect("15k", 15000, "single + k");
expect("10 to 15 lakh", 1000000, "range 'to' + lakh → lower bound");
expect("1-2cr", 10000000, "range + cr → lower bound");
expect("50000", 50000, "plain number, no unit");
expect("not sure", null, "garbage → null + raw note");

console.log("\nRegression guard — the exact corruption must be gone:");
{
  const r = normalizeBudget("10-15k");
  ok(r.amount === 10000 && r.amount !== 1015000, "'10-15k' is 10000, NOT the old 1,015,000");
}

console.log("\nSeparator variants (en-dash / em-dash / spaces):");
expect("10 – 15k", 10000, "en-dash range");
expect("10—15k", 10000, "em-dash range");
expect("10 - 15 k", 10000, "spaced hyphen range");

console.log("\nUnit table (case-insensitive, applied to the parsed number):");
expect("1.5 lakh", 150000, "decimal + lakh");
expect("2L", 200000, "short 'L' unit");
expect("2 lac", 200000, "'lac' spelling");
expect("3 CRORE", 30000000, "uppercase crore");
expect("50,000", 50000, "thousands separator preserved on single value");

console.log("\nAbsurd / unparseable output → null (raw note still kept):");
expect("999cr", null, "implausibly large (> ₹100cr) → null");
expect("", null, "empty string → null");
expect("budget?", null, "no number → null");

console.log("\nLower-bound is the smaller of the two bounds regardless of order:");
{
  const r = normalizeBudget("15-10k");
  ok(r.amount === 10000, "'15-10k' still stores the smaller bound (10000)");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
