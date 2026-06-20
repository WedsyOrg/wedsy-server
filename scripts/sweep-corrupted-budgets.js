/**
 * ============================================================================
 * READ-ONLY SWEEP — find leads whose qualificationData.budgetAmount was
 * corrupted by the OLD Kiara budget normalizer (the range bug: "10-15k" →
 * digit-strip "1015" → ×1000 → ₹10.15L).
 *
 * THIS SCRIPT MAKES ZERO WRITES. It only reads (.lean()) and prints.
 * There is NO .save / .create / .insert* / .update* / .replace* / .delete* /
 * .remove / .bulkWrite / .findOneAndUpdate / .findOneAndDelete anywhere in this
 * file. Investigation only — remediation (if any) is a separate, deliberate step.
 *
 * Connection reuses the app's canonical bootstrap: mongoose.connect on
 * process.env.DATABASE_URL (same env var server.js uses). No URI is hardcoded —
 * on EC2 this env resolves to PROD, which is the point of running it there.
 *
 * Run the prod scan (on EC2):   node scripts/sweep-corrupted-budgets.js
 * Verify bucketing, NO DB:      node scripts/sweep-corrupted-budgets.js --self-check
 * ============================================================================
 */
require("dotenv").config();
const mongoose = require("mongoose");

// CANONICAL normalizer — imported, never copied. If this drifts, the sweep drifts
// with it (correct: "what the fixed code would now store" is the source of truth).
const { normalizeBudget } = require("../services/KiaraCrmSyncService");

// ── Pure bucketing logic (no DB, no I/O) ─────────────────────────────────────
// Given a lean Enquiry doc (only name + qualificationData needed), decide its
// bucket. Recompute from the raw note when we have one; otherwise we can't verify.
const classify = (doc) => {
  const qd = doc.qualificationData || {};
  const storedAmount = qd.budgetAmount;
  const raw = qd.budgetNote;
  const hasRaw = typeof raw === "string" && raw.trim() !== "";

  if (hasRaw) {
    const recomputed = normalizeBudget(raw);
    // Strict mismatch (including stored-number vs recomputed-null) → corrupted.
    if (recomputed.amount !== storedAmount) {
      return {
        bucket: "CORRUPTED",
        _id: doc._id,
        name: doc.name,
        raw,
        storedAmount,
        correctAmount: recomputed.amount,
      };
    }
    return { bucket: "OK", _id: doc._id };
  }

  // No raw note — the value cannot be recomputed, only flagged for manual review.
  return {
    bucket: "UNVERIFIABLE",
    _id: doc._id,
    name: doc.name,
    storedAmount,
    reviewFlag: reviewFlag(storedAmount),
  };
};

// Advisory only (does NOT change the bucket): heuristics for an UNVERIFIABLE value
// that smells like the range corruption, which inflated budgets by ~100x.
const reviewFlag = (amount) => {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  // The range bug concatenated the two bounds' digits before applying the unit,
  // so a single-value budget of ₹20L+ is implausible and likely range-inflated.
  if (amount >= 2_000_000) return "high-magnitude (>= ₹20L) — likely range-inflated";
  // k-range signature: an exact ×1000 multiple that is NOT a clean lakh figure,
  // e.g. 1,015,000 = 1015×1000 (from "10-15k"); a legit ₹k value rarely tops ₹1L+.
  if (amount >= 1_000_000 && Number.isInteger(amount / 1000) && !Number.isInteger(amount / 100000)) {
    return "k-range signature (non-round x1000)";
  }
  return null;
};

// ── No-DB self-check: run a few synthetic docs through the SAME classify() so we
// can see the bucketing is correct before pointing this at prod. Returns true on
// pass. Does NOT touch any database.
const selfCheck = () => {
  console.log("── self-check (no DB) ──────────────────────────────────────────");
  const oid = (n) => `selfcheck-${n}`;
  const cases = [
    // [label, doc, expectedBucket, expectedCorrectAmount?]
    ["range corruption (note recomputes lower)", { _id: oid(1), name: "A", qualificationData: { budgetAmount: 1015000, budgetNote: "10-15k" } }, "CORRUPTED", 10000],
    ["clean single value (matches)",             { _id: oid(2), name: "B", qualificationData: { budgetAmount: 15000, budgetNote: "15k" } }, "OK"],
    ["note recomputes to null but stored set",   { _id: oid(3), name: "C", qualificationData: { budgetAmount: 50000, budgetNote: "no idea" } }, "CORRUPTED", null],
    ["no note, inflated value",                  { _id: oid(4), name: "D", qualificationData: { budgetAmount: 1015000 } }, "UNVERIFIABLE"],
    ["no note, plausible value",                 { _id: oid(5), name: "E", qualificationData: { budgetAmount: 15000 } }, "UNVERIFIABLE"],
  ];

  let pass = 0, fail = 0;
  const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };

  for (const [label, doc, expBucket, expCorrect] of cases) {
    const r = classify(doc);
    ok(r.bucket === expBucket, `${label} → ${expBucket} (got ${r.bucket})`);
    if (expBucket === "CORRUPTED") {
      ok(r.correctAmount === expCorrect, `   correctAmount = ${expCorrect === null ? "null" : expCorrect} (got ${r.correctAmount})`);
    }
  }
  // The two UNVERIFIABLE flags: inflated flagged, plausible not.
  ok(classify(cases[3][1]).reviewFlag !== null, "inflated UNVERIFIABLE carries a review flag");
  ok(classify(cases[4][1]).reviewFlag === null, "plausible UNVERIFIABLE carries NO review flag");

  console.log(`── self-check: ${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  return fail === 0;
};

// ── Main: connect (PROD on EC2), scan READ-ONLY, print, disconnect. ──────────
const main = async () => {
  await mongoose.connect(process.env.DATABASE_URL, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
  });
  // Required after connect (model registers on the shared mongoose instance).
  const Enquiry = require("../models/Enquiry");

  // Only docs that actually have a budgetAmount set. .lean() → plain objects, so
  // nothing here is a Mongoose document and nothing can accidentally .save().
  const docs = await Enquiry.find(
    { "qualificationData.budgetAmount": { $ne: null } },
    { name: 1, qualificationData: 1 }
  ).lean();

  const corrupted = [];
  const unverifiable = [];
  for (const doc of docs) {
    const r = classify(doc);
    if (r.bucket === "CORRUPTED") corrupted.push(r);
    else if (r.bucket === "UNVERIFIABLE") unverifiable.push(r);
  }

  console.log("\n================ BUDGET CORRUPTION SWEEP (READ-ONLY) ================");
  console.log(`Scanned (budgetAmount set): ${docs.length}`);

  console.log(`\n--- CORRUPTED: ${corrupted.length} (raw note disagrees with stored amount) ---`);
  for (const c of corrupted) {
    const correct = c.correctAmount === null ? "null (clear/manual)" : c.correctAmount;
    console.log(`  ${c._id}  ${JSON.stringify(c.name)}  raw=${JSON.stringify(c.raw)}  stored=${c.storedAmount} -> correct=${correct}`);
  }

  console.log(`\n--- UNVERIFIABLE: ${unverifiable.length} (no budgetNote — cannot recompute) ---`);
  for (const u of unverifiable) {
    const flag = u.reviewFlag ? `  [REVIEW: ${u.reviewFlag}]` : "";
    console.log(`  ${u._id}  ${JSON.stringify(u.name)}  stored=${u.storedAmount}${flag}`);
  }
  const flagged = unverifiable.filter((u) => u.reviewFlag).length;
  console.log(`\nUNVERIFIABLE flagged for manual review (suspicious magnitude): ${flagged}`);
  console.log("====================================================================");

  await mongoose.disconnect();
};

// Guard: never auto-run on require() (so a test importing classify/selfCheck has
// NO side effects and the main DB path stays dormant). Only runs when invoked
// directly as `node scripts/sweep-corrupted-budgets.js`.
if (require.main === module) {
  const selfOk = selfCheck();
  if (process.argv.includes("--self-check")) {
    // No-DB mode: verify bucketing and exit BEFORE any connection is attempted.
    process.exit(selfOk ? 0 : 1);
  }
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("sweep failed:", e);
      process.exit(1);
    });
}

module.exports = { classify, reviewFlag, selfCheck };
