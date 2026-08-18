// The wizard's percentage rule must match the server's, exactly.
// Run: node tests/venue-schedule-parity.test.js
//
// WHY A MIRROR EXISTS AT ALL: step 2 of the Confirm Booking wizard has to show
// the shortfall WHILE the owner types — 30/30/30 must read "10% unallocated" on
// the third keystroke, not after Save — and a round trip per keystroke cannot do
// that. So app/(portal)/crm/_lib/payment-schedule.ts carries the same integer
// arithmetic client-side.
//
// A mirror is only safe if something notices when it breaks. This transcribes the
// client's rules and asserts they agree with utils/venuePaymentSchedule across
// every case that matters, including the ones floating point gets wrong. Without
// this, the wizard could let an owner save a schedule the API then refuses —
// which is the worst possible place to find a disagreement.
const sched = require("../utils/venuePaymentSchedule");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

// ── transcribed from app/(portal)/crm/_lib/payment-schedule.ts ──────────────
const PCT_SCALE = 100;
const FULL = 100 * PCT_SCALE;
const clientToHundredths = (percent) => {
  const raw = typeof percent === "number" ? String(percent) : (percent || "").trim();
  if (!raw) return null;
  if (!/^\d*\.?\d*$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * PCT_SCALE);
};
const clientEqualSplit = (n) => {
  const base = Math.floor(FULL / n);
  let remainder = FULL - base * n;
  return Array.from({ length: n }, () => {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    return base + extra;
  });
};
const clientAmountsFor = (hundredths, totalValue) => {
  const value = Math.max(0, Math.round(totalValue || 0));
  const amounts = hundredths.map((h) => Math.floor((value * h) / FULL));
  // Mirrors the client: the residue only lands on the last row when the
  // percentages total exactly 100. Below 100 each row shows what its own
  // percentage is worth, so a row cannot contradict the number beside it while
  // the owner is still editing. The server only ever generates AT 100%, so the
  // two agree everywhere it matters.
  const total = hundredths.reduce((sum, h) => sum + h, 0);
  if (total !== FULL) return amounts;
  const residue = value - amounts.reduce((s, a) => s + a, 0);
  if (amounts.length) amounts[amounts.length - 1] += residue;
  return amounts;
};

(async () => {
  console.log("\n[toHundredths agrees on every value a field can hold]");
  const values = ["0", "1", "33", "33.3", "33.33", "33.335", "50", "66.67", "99.99", "100", 33.33, 50, 0.01];
  let mismatch = 0;
  for (const v of values) {
    const c = clientToHundredths(v);
    const s = sched.toHundredths(v, "x");
    if (c !== s) { mismatch++; console.error(`     ✗ ${JSON.stringify(v)}: client ${c} vs server ${s}`); }
  }
  ok(mismatch === 0, `all ${values.length} percentage values convert identically`);
  ok(clientToHundredths("33.33") === 3333, "33.33% is 3333 hundredths on both");
  ok(clientToHundredths("33.335") === 3334, "…and 33.335 rounds up on both");

  console.log("\n[equalSplit agrees, and both total exactly 100]");
  let splitMismatch = 0;
  for (let n = 1; n <= sched.MAX_ROWS; n++) {
    const c = clientEqualSplit(n);
    const s = sched.equalSplit(n);
    if (c.join(",") !== s.join(",")) { splitMismatch++; console.error(`     ✗ n=${n}: client [${c}] vs server [${s}]`); }
    const sum = c.reduce((a, b) => a + b, 0);
    if (sum !== FULL) { splitMismatch++; console.error(`     ✗ n=${n} sums to ${sum}, not ${FULL}`); }
  }
  ok(splitMismatch === 0, `splits for 1..${sched.MAX_ROWS} instalments agree and each totals exactly 100%`);
  ok(clientEqualSplit(3).join(",") === "3334,3333,3333", "3 equal is 33.34 / 33.33 / 33.33 on both");

  console.log("\n[amounts agree, and always sum to the booking value]");
  let amtMismatch = 0;
  const cases = [];
  for (const n of [1, 2, 3, 4, 7]) for (const v of [0, 1, 7, 100, 812500, 999999, 1000000, 12345678]) cases.push([n, v]);
  for (const [n, v] of cases) {
    const hs = sched.equalSplit(n);
    const c = clientAmountsFor(hs, v);
    const g = sched.generateSchedule({ rows: hs.map((h, i) => ({ label: `r${i}`, percent: sched.fromHundredths(h) })), totalValue: v });
    const s = g.rows.map((r) => r.amount);
    if (c.join(",") !== s.join(",")) { amtMismatch++; console.error(`     ✗ n=${n} v=${v}: client [${c}] vs server [${s}]`); }
    if (c.reduce((a, b) => a + b, 0) !== Math.max(0, v)) { amtMismatch++; console.error(`     ✗ n=${n} v=${v}: client amounts sum to ${c.reduce((a, b) => a + b, 0)}`); }
  }
  ok(amtMismatch === 0, `amounts agree across all ${cases.length} (instalments × value) combinations, and always sum to the value`);

  console.log("\n[the shortfall/excess the owner sees matches what the server would say]");
  // The wizard's wording is "unallocated" (what the owner can act on) where the
  // server says "short of 100%" (what the API refuses). Same sign, same number —
  // only the sentence differs, which is intended.
  for (const [set, wantDelta] of [
    [[30, 30, 30], -1000],
    [[50, 40], -1000],
    [[50, 60], 1000],
    [[33.33, 33.33, 33.33], -1],
    [[33.34, 33.33, 33.33], 0],
    [[100], 0],
  ]) {
    const server = sched.checkTotal(set.map((p) => ({ percentHundredths: sched.toHundredths(p, "x") })));
    const clientTotal = set.map(clientToHundredths).reduce((a, b) => a + b, 0);
    const clientDelta = clientTotal - FULL;
    ok(clientDelta === wantDelta && server.deltaHundredths === wantDelta,
      `[${set.join(", ")}] → both compute a delta of ${wantDelta} hundredths (${sched.fromHundredths(wantDelta)}%)`);
    ok(server.ok === (clientDelta === 0), `…and agree on whether it is valid (${server.ok})`);
  }

  console.log("\n[the case the brief called out]");
  ok(33.33 * 3 !== 100, "float would say 33.33 × 3 is not 100 (99.99)");
  const three = clientEqualSplit(3);
  ok(three.reduce((a, b) => a + b, 0) === FULL, "…but the integer split totals exactly 100 on the client");
  ok(sched.checkTotal(three.map((h) => ({ percentHundredths: h }))).ok, "…and the server accepts it");

  console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
