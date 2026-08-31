// MONEY LINES — the server side of the line-totals parity pincer.
// Run: node tests/venue-line-totals-parity.test.js   (no database needed)
//
// The venue app mirrors computeLineTotals so its editor can show charged /
// refundable / GST live (app/(portal)/crm/_lib/line-totals.ts), and pins the
// REAL client module against a transcription of these rules
// (scripts/line-totals-parity.mjs in wedsy-venue). This file closes the
// pincer from this end: a TRANSCRIPTION of the client's rules against the
// REAL server module. Change utils/venueMoney and this fails; change the
// client mirror and that one fails. Neither drifts silently — the
// schedule-parity arrangement, applied to the line math.
const { computeLineTotals } = require("../utils/venueMoney");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

// ── transcribed from the client's line-totals.ts ────────────────────────────
function clientLineTaxable(line) {
  const amount = Math.round(Number(line.amount) || 0);
  if (line.gstTreatment === "full") return amount;
  if (line.gstTreatment === "part") return Math.round(Number(line.taxableAmount) || 0);
  return 0;
}
function clientLineTotals(lines, gstPercent) {
  const pct = Number(gstPercent) || 0;
  let subtotal = 0, charged = 0, refundable = 0, taxable = 0, gst = 0;
  for (const li of lines) {
    const amount = Math.round(Number(li.amount) || 0);
    subtotal += amount;
    if (li.refundable) refundable += amount;
    else charged += amount;
    const t = clientLineTaxable(li);
    taxable += t;
    gst += Math.round((t * pct) / 100);
  }
  return { subtotal, charged, refundable, taxable, gst, grandTotal: subtotal + gst };
}

// ── the same case matrix as the client-side script ──────────────────────────
const CASES = [];
for (const gstPercent of [0, 5, 12, 18, 28]) {
  for (const a of [0, 1, 3, 999, 25000, 200000, 500000, 736451]) {
    for (const t of ["none", "full", "part"]) {
      for (const refundable of [false, true]) {
        CASES.push({ gstPercent, lines: [{ amount: a, gstTreatment: t, taxableAmount: t === "part" ? Math.floor(a / 3) : 0, refundable }] });
      }
    }
  }
}
CASES.push(
  { gstPercent: 18, lines: [{ amount: 500000, gstTreatment: "part", taxableAmount: 200000, refundable: false }] },
  {
    gstPercent: 18,
    lines: [
      { amount: 500000, gstTreatment: "full", refundable: false },
      { amount: 200000, gstTreatment: "part", taxableAmount: 50000, refundable: false },
      { amount: 25000, gstTreatment: "none", refundable: true },
    ],
  },
  { gstPercent: 18, lines: [{ amount: 3, gstTreatment: "full", refundable: false }, { amount: 3, gstTreatment: "full", refundable: false }] }
);

console.log(`[${CASES.length} cases: transcribed client vs REAL computeLineTotals]`);
let mismatches = 0;
for (const c of CASES) {
  const want = clientLineTotals(c.lines, c.gstPercent);
  const got = computeLineTotals(c.lines, c.gstPercent);
  for (const k of ["subtotal", "charged", "refundable", "taxable", "gst", "grandTotal"]) {
    if (got[k] !== want[k]) {
      mismatches++;
      console.error(`  ✗ ${JSON.stringify(c)} → ${k}: server ${got[k]} vs client-rule ${want[k]}`);
    }
  }
}
ok(mismatches === 0, `every figure matches across the matrix (${mismatches} mismatches)`);
ok(computeLineTotals([{ amount: 500000, gstTreatment: "part", taxableAmount: 200000 }], 18).gst === 36000,
  "SPEC pinned here too: 5,00,000 part 2,00,000 @18% → 36,000");

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
