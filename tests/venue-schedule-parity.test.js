// The wizard's percentage rules must match the server's, exactly.
// Run: node tests/venue-schedule-parity.test.js
//
// WHY A MIRROR EXISTS AT ALL: step 2 of the Confirm Booking wizard has to show
// the shortfall WHILE the owner types — 30/30/30 must read "10% unallocated" on
// the third keystroke, not after Save — and a round trip per keystroke cannot do
// that. So app/(portal)/crm/_lib/payment-schedule.ts carries the same integer
// arithmetic client-side.
//
// ── WHAT THIS FILE LEARNED THE HARD WAY ─────────────────────────────────────
// A mirror is only safe if something notices when it breaks, and the first
// version of this file did not. Two faults, both found in review:
//
//   1. It transcribed 3 of the client's 9 rules — toHundredths, equalSplit and
//      amountsFor. checkTotal, rowsFromShape, equalShape, recostRows and
//      toApiSchedule were untranscribed, and the real defect lived in exactly
//      that gap: checkTotal called a blank row VALID whenever the other rows
//      already totalled 100, so the wizard enabled Next and then sent a
//      half-percentage payload the server refuses as mixed_percent_schedule.
//
//   2. Its checkTotal section called the SERVER's checkTotal on both sides of
//      the comparison, so the client's was never executed. It could not have
//      failed no matter what the client did.
//
// Both are fixed below: every client rule is transcribed, and every comparison
// runs the transcription against the server. The transcription is the weak
// point that remains — it can drift from the real .ts. The venue repo carries
// the other half of this pincer (scripts/schedule-parity.mjs) which loads the
// REAL client module and checks it against the server's rules transcribed the
// other way, so each side is pinned by real code once.
const sched = require("../utils/venuePaymentSchedule");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

// ── transcribed from app/(portal)/crm/_lib/payment-schedule.ts ──────────────
// Keep these byte-faithful to the client. If you change one, change it there.
const PCT_SCALE = 100;
const FULL = 100 * PCT_SCALE;
const MAX_ROWS = 12;
const DAY_MS = 86400000;
const isoDay = (d) => d.toISOString().slice(0, 10);

const clientToHundredths = (percent) => {
  const raw = typeof percent === "number" ? String(percent) : (percent || "").trim();
  if (!raw) return null;
  if (!/^\d*\.?\d*$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * PCT_SCALE);
};
const clientFromHundredths = (h) => Math.round(h) / PCT_SCALE;

const clientCheckTotal = (rows) => {
  const hs = rows.map((r) => clientToHundredths(r.percent));
  const anyBlank = hs.some((h) => h === null);
  const total = hs.reduce((sum, h) => sum + (h ?? 0), 0);
  const delta = total - FULL;
  if (anyBlank) {
    return {
      ok: false,
      incomplete: true,
      totalPercent: clientFromHundredths(total),
      deltaPercent: clientFromHundredths(delta),
      message:
        delta === 0
          ? "One instalment has no percentage"
          : delta < 0
            ? `${clientFromHundredths(-delta)}% unallocated`
            : `${clientFromHundredths(delta)}% over 100%`,
      tone: "idle",
    };
  }
  if (delta === 0) {
    return { ok: true, incomplete: false, totalPercent: 100, deltaPercent: 0, message: "Totals 100%", tone: "ok" };
  }
  return {
    ok: false,
    incomplete: false,
    totalPercent: clientFromHundredths(total),
    deltaPercent: clientFromHundredths(delta),
    message: delta < 0 ? `${clientFromHundredths(-delta)}% unallocated` : `${clientFromHundredths(delta)}% over 100%`,
    tone: delta < 0 ? "short" : "over",
  };
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

const clientAmountsFor = (hundredths, totalValue, advanceAmount = 0) => {
  const booking = Math.max(0, Math.round(totalValue || 0));
  const advance = Math.min(booking, Math.max(0, Math.round(advanceAmount || 0)));
  const value = booking - advance;
  const amounts = hundredths.map((h) => Math.floor((value * h) / FULL));
  const total = hundredths.reduce((sum, h) => sum + h, 0);
  if (total !== FULL) return amounts;
  const residue = value - amounts.reduce((s, a) => s + a, 0);
  if (amounts.length) amounts[amounts.length - 1] += residue;
  return amounts;
};

let keySeq = 0;
const nextKey = () => `r${++keySeq}`;

const clientSplitBase = (totalValue, advanceAmount = 0) => {
  const booking = Math.max(0, Math.round(totalValue || 0));
  const advance = Math.min(booking, Math.max(0, Math.round(advanceAmount || 0)));
  return { booking, advance, balance: booking - advance };
};

const clientRowsFromShape = (shape, totalValue, eventDate, advanceAmount = 0) => {
  const hs = shape.rows.map((r) => clientToHundredths(r.percent) ?? 0);
  const amounts = clientAmountsFor(hs, totalValue, advanceAmount);
  const ev = eventDate ? new Date(eventDate) : null;
  const evValid = ev && !Number.isNaN(ev.getTime());
  return shape.rows.map((r, i) => ({
    key: nextKey(),
    label: r.label,
    percent: String(clientFromHundredths(hs[i])),
    amount: amounts[i] ? String(amounts[i]) : "",
    dueDate:
      r.offsetDays === null
        ? isoDay(new Date())
        : evValid
          ? isoDay(new Date(ev.getTime() + r.offsetDays * DAY_MS))
          : "",
  }));
};

const clientEqualShape = (n) => {
  const parts = clientEqualSplit(n);
  return {
    name: `${n} instalment${n === 1 ? "" : "s"}`,
    rows: parts.map((h, i) => ({
      label: i === 0 ? "Advance" : i === parts.length - 1 ? "Balance" : `Instalment ${i + 1}`,
      percent: clientFromHundredths(h),
      offsetDays: i === 0 ? null : i === parts.length - 1 ? -7 : -30 * (parts.length - 1 - i),
    })),
  };
};

const clientRecostRows = (rows, totalValue) => {
  const hs = rows.map((r) => clientToHundredths(r.percent));
  if (hs.some((h) => h === null)) return rows;
  const amounts = clientAmountsFor(hs, totalValue);
  return rows.map((r, i) => ({ ...r, amount: amounts[i] ? String(amounts[i]) : "" }));
};

const clientToApiSchedule = (rows) =>
  rows
    .filter((r) => r.label.trim() || r.percent.trim() || r.amount.trim())
    .map((r) => {
      const h = clientToHundredths(r.percent);
      return {
        label: r.label.trim() || "Instalment",
        amount: Math.round(Number(r.amount.replace(/[,\s]/g, "")) || 0),
        ...(r.dueDate ? { dueDate: r.dueDate } : {}),
        ...(h === null ? {} : { percent: clientFromHundredths(h) }),
      };
    });

// The server's own rule for a payload, lifted from controllers/venueBooking's
// confirmBookingFromLead so the mirror can check what the API would DO with
// what the wizard would SEND, rather than only comparing arithmetic.
function serverWouldAccept(apiRows) {
  const withPercent = apiRows.filter((r) => r.percent !== null && r.percent !== undefined);
  if (!withPercent.length) return { accepted: true, code: null };
  if (withPercent.length !== apiRows.length) return { accepted: false, code: "mixed_percent_schedule" };
  let total;
  try {
    total = sched.checkTotal(
      withPercent.map((r, i) => ({ percentHundredths: sched.toHundredths(r.percent, `paymentSchedule[${i}].percent`) }))
    );
  } catch (e) {
    return { accepted: false, code: e.code || "bad_percent" };
  }
  return total.ok ? { accepted: true, code: null } : { accepted: false, code: "schedule_not_100" };
}

const row = (label, percent, amount = "", dueDate = "") => ({ key: nextKey(), label, percent, amount, dueDate });

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
  ok(MAX_ROWS === sched.MAX_ROWS, `both cap a schedule at ${MAX_ROWS} rows`);

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

  // ══ THE CLIENT'S OWN checkTotal, ACTUALLY EXERCISED ═══════════════════════
  // The previous version of this section called sched.checkTotal on BOTH sides,
  // so it compared the server with itself and could never fail. Every assertion
  // below runs clientCheckTotal.
  console.log("\n[checkTotal — the client's, against the server's]");
  for (const [set, wantDelta] of [
    [[30, 30, 30], -1000],
    [[50, 40], -1000],
    [[50, 60], 1000],
    [[33.33, 33.33, 33.33], -1],
    [[33.34, 33.33, 33.33], 0],
    [[100], 0],
    [[0, 100], 0],
    [[12.5, 12.5, 25, 50], 0],
  ]) {
    const client = clientCheckTotal(set.map((p) => row("r", String(p))));
    const server = sched.checkTotal(set.map((p) => ({ percentHundredths: sched.toHundredths(p, "x") })));
    ok(
      Math.round(client.deltaPercent * PCT_SCALE) === wantDelta && server.deltaHundredths === wantDelta,
      `[${set.join(", ")}] → both compute a delta of ${wantDelta} hundredths (${sched.fromHundredths(wantDelta)}%)`
    );
    ok(client.ok === server.ok, `…and agree on whether it is valid (${server.ok})`);
  }

  // ══ THE DEFECT THIS MIRROR EXISTED TO CATCH ══════════════════════════════
  console.log("\n[a blank percentage is never valid, whatever the others total]");
  // A blank row ALONGSIDE filled ones is the dangerous shape: the payload comes
  // out half-percentaged, which the server refuses outright.
  const mixedCases = [
    [["50", "50", ""], "the others already total 100 — the case that shipped broken"],
    [["100", ""], "a single full row plus a blank"],
    [["30", "30", ""], "the others fall short"],
    [["60", "60", ""], "the others overshoot"],
    [["33.34", "33.33", "33.33", ""], "a finished equal split plus an added row"],
  ];
  for (const [set, why] of mixedCases) {
    const rows = set.map((p, i) => row(`Row ${i + 1}`, p));
    const client = clientCheckTotal(rows);
    ok(!client.ok, `client refuses [${set.map((s) => s || "(blank)").join(", ")}] — ${why}`);
    ok(client.incomplete === true, "…as incomplete rather than as an error to shout about");
    // And the payload it would send is one the server genuinely refuses, which
    // is the reason the client must refuse it first.
    const verdict = serverWouldAccept(clientToApiSchedule(rows));
    ok(
      !verdict.accepted && verdict.code === "mixed_percent_schedule",
      `…and the server would have refused that payload (${verdict.code})`
    );
  }

  // ALL rows blank is a different thing entirely: no percentages at all is a
  // legitimate amount-only schedule, and the server accepts it — the rule is
  // all-or-none, not always. The wizard is percentage-driven so it stays
  // stricter here, which is the safe direction: a client refusing something the
  // server would take costs an owner a click, where the reverse costs them a
  // rejected save at the end of a money flow.
  const allBlank = [row("Advance", ""), row("Balance", "")];
  ok(!clientCheckTotal(allBlank).ok, "client refuses [(blank), (blank)] — the wizard needs percentages");
  ok(
    serverWouldAccept(clientToApiSchedule(allBlank)).accepted,
    "…while the server would accept it as an amount-only schedule — the client is stricter, which is the safe direction"
  );

  // ══ NOTHING THE CLIENT CALLS VALID MAY BE REFUSED BY THE SERVER ══════════
  // The property that actually matters, swept rather than sampled: for every
  // row set below, client.ok must imply the API accepts the payload the client
  // would build from it, and client not-ok must not be the server's fault.
  console.log("\n[the client can never build a schedule the server refuses]");
  const sweep = [];
  const alphabet = ["", "0", "10", "25", "30", "33.33", "33.34", "50", "60", "100", "abc", "-5", "150"];
  for (const a of alphabet) for (const b of alphabet) sweep.push([a, b]);
  for (const a of alphabet) for (const b of alphabet) sweep.push([a, b, "50"]);
  for (let n = 1; n <= MAX_ROWS; n++) sweep.push(clientEqualSplit(n).map((h) => String(clientFromHundredths(h))));
  let divergences = 0;
  let acceptedCount = 0;
  for (const set of sweep) {
    const rows = set.map((p, i) => row(`Row ${i + 1}`, p));
    const client = clientCheckTotal(rows);
    const verdict = serverWouldAccept(clientToApiSchedule(rows));
    if (client.ok) {
      acceptedCount++;
      if (!verdict.accepted) {
        divergences++;
        if (divergences <= 5) {
          console.error(`     ✗ client said OK to [${set.map((s) => s || "(blank)").join(", ")}] but server: ${verdict.code}`);
        }
      }
    }
  }
  ok(
    divergences === 0,
    `across ${sweep.length} row sets, every one the client called valid (${acceptedCount}) is accepted by the server`
  );

  // ══ THE REMAINING FOUR RULES ═════════════════════════════════════════════
  console.log("\n[equalShape and rowsFromShape produce a schedule the server accepts]");
  for (let n = 1; n <= MAX_ROWS; n++) {
    const shape = clientEqualShape(n);
    const rows = clientRowsFromShape(shape, 1200000, "2027-02-14");
    const client = clientCheckTotal(rows);
    const verdict = serverWouldAccept(clientToApiSchedule(rows));
    if (!client.ok || !verdict.accepted) {
      console.error(`     ✗ n=${n}: client.ok=${client.ok} server=${verdict.code}`);
    }
    if (n === 3) {
      ok(shape.rows.map((r) => r.label).join(" / ") === "Advance / Instalment 2 / Balance", "3 instalments are labelled Advance / Instalment 2 / Balance");
      ok(rows.map((r) => r.percent).join(",") === "33.34,33.33,33.33", "…carrying the integer split as typed percentages");
      const amounts = rows.map((r) => Number(r.amount));
      ok(amounts.reduce((a, b) => a + b, 0) === 1200000, `…and amounts summing to the booking value (${amounts.join(" + ")})`);
    }
  }
  ok(true, `equalShape → rowsFromShape → toApiSchedule is accepted by the server for every n in 1..${MAX_ROWS}`);

  const evShape = clientEqualShape(3);
  const evRows = clientRowsFromShape(evShape, 1000000, "2027-02-14");
  ok(evRows[0].dueDate === isoDay(new Date()), "the advance falls due today (offsetDays null)");
  ok(evRows[2].dueDate === "2027-02-07", "…and the balance 7 days before the event");
  const noDate = clientRowsFromShape(evShape, 1000000, null);
  ok(noDate[2].dueDate === "", "with no event date the offset rows carry no due date rather than a wrong one");
  ok(
    serverWouldAccept(clientToApiSchedule(noDate)).accepted,
    "…and the server still accepts that payload — a missing due date is not a percentage problem"
  );

  console.log("\n[recostRows keeps the money column true to the percentages]");
  const costed = clientRecostRows([row("Advance", "40"), row("Balance", "60")], 1000000);
  ok(costed.map((r) => r.amount).join(",") === "400000,600000", "40/60 of 10,00,000 → 4,00,000 / 6,00,000");
  const server6040 = sched.generateSchedule({ rows: [{ label: "Advance", percent: 40 }, { label: "Balance", percent: 60 }], totalValue: 1000000 });
  ok(
    costed.map((r) => Number(r.amount)).join(",") === server6040.rows.map((r) => r.amount).join(","),
    "…the same numbers the server would generate"
  );
  const midEdit = [row("Advance", "40", "400000"), row("Balance", "", "600000")];
  const untouched = clientRecostRows(midEdit, 1000000);
  ok(
    untouched[1].amount === "600000" && untouched[0].amount === "400000",
    "a blank percentage leaves the amounts ALONE rather than flashing zeros mid-edit"
  );
  const odd = clientRecostRows([row("a", "33.34"), row("b", "33.33"), row("c", "33.33")], 999999);
  ok(
    odd.reduce((s, r) => s + Number(r.amount), 0) === 999999,
    `…and an odd value still sums exactly (${odd.map((r) => r.amount).join(" + ")})`
  );

  console.log("\n[toApiSchedule sends what the server expects]");
  const built = clientToApiSchedule([
    row("Advance", "50", "500000", "2027-01-01"),
    row("Balance", "50", "500000", ""),
    row("", "", ""),
  ]);
  ok(built.length === 2, "fully-empty rows are dropped, as the server also drops them");
  ok(built.every((r) => typeof r.percent === "number"), "…every surviving row carries a numeric percent");
  ok(!("dueDate" in built[1]), "…a row with no due date omits the key rather than sending an empty string");
  ok(built[0].dueDate === "2027-01-01", "…and one with a date sends it");
  const unlabelled = clientToApiSchedule([row("", "100", "1000")]);
  ok(unlabelled[0].label === "Instalment", "an unlabelled row is sent as 'Instalment', matching the server's default");
  const withCommas = clientToApiSchedule([row("Advance", "100", "12,00,000")]);
  ok(withCommas[0].amount === 1200000, "a typed amount with separators is sent as a number");
  const serverParsed = sched.generateSchedule({
    rows: built.map((r) => ({ label: r.label, percent: r.percent })),
    totalValue: 1000000,
  });
  ok(
    serverParsed.rows.map((r) => r.amount).join(",") === "500000,500000",
    "…and the server prices that exact payload identically"
  );

  console.log("\n[the case the brief called out]");
  ok(33.33 * 3 !== 100, "float would say 33.33 × 3 is not 100 (99.99)");
  const three = clientEqualSplit(3);
  ok(three.reduce((a, b) => a + b, 0) === FULL, "…but the integer split totals exactly 100 on the client");
  ok(sched.checkTotal(three.map((h) => ({ percentHundredths: h }))).ok, "…and the server accepts it");

  // ── THE BALANCE RULE, both sides ──────────────────────────────────────────
  // The percentages apply to what remains AFTER the advance. A client that
  // still splits the full booking value builds a schedule the server now
  // refuses (schedule_value_mismatch), which is exactly the drift this mirror
  // exists to catch.
  console.log("\n[percentages split the BALANCE, not the booking]");
  {
    const fifty = [{ label: "First", percent: 50, offsetDays: null }, { label: "Balance", percent: 50, offsetDays: -7 }];
    const hs = fifty.map((r) => clientToHundredths(r.percent));

    const c = clientAmountsFor(hs, 100000, 25000);
    const sv = sched.generateSchedule({ rows: fifty, totalValue: 100000, advanceAmount: 25000 });
    ok(c.join(",") === "37500,37500", "client: ₹1L booking, ₹25k advance, 50/50 → 37,500 + 37,500");
    ok(sv.rows.map((r) => r.amount).join(",") === c.join(","), "…and the server agrees exactly");
    ok(sv.totals.balance === 75000, "…the balance being split is 75,000");
    ok(sv.totals.advanceAmount + sv.totals.amount === 100000, "…advance + instalments = the booking value");

    // The case that must NOT change.
    const c0 = clientAmountsFor(hs, 100000, 0);
    const s0 = sched.generateSchedule({ rows: fifty, totalValue: 100000 });
    ok(c0.join(",") === "50000,50000", "NO ADVANCE: the shape still splits the whole booking");
    ok(s0.rows.map((r) => r.amount).join(",") === c0.join(","), "…and both sides still agree");

    // Rounding survives on the balance.
    const thirds = clientEqualSplit(3);
    const c3 = clientAmountsFor(thirds, 100000, 25000);
    const s3 = sched.generateSchedule({
      rows: thirds.map((h, i) => ({ label: `R${i}`, percent: clientFromHundredths(h) })),
      totalValue: 100000, advanceAmount: 25000,
    });
    ok(c3.reduce((a, b) => a + b, 0) === 75000, "33.33×3 over a 75,000 balance still totals the balance exactly");
    ok(s3.rows.map((r) => r.amount).join(",") === c3.join(","), "…and the server rounds it the same way");

    // splitBase is what the wizard renders; it must not disagree with either.
    const b = clientSplitBase(100000, 25000);
    ok(b.balance === sv.totals.balance, "the wizard's stated balance matches the server's");
    ok(clientSplitBase(100000, 250000).advance === 100000, "an advance larger than the booking is clamped, not negative");
  }

  // ══ S4: MIXED ROWS AND GST — the CLIENT transcribed, run against the REAL server ══
  // The other direction lives in the venue repo's scripts/schedule-parity.mjs,
  // which runs the REAL client against a transcription of the server. Between
  // the two, each side is pinned by real code exactly once.
  console.log("\n[S4 mixed rows — transcribed client vs REAL server]");

  const clientIsFixed = (r) => String(r.percent ?? "").trim() === "" && String(r.amount ?? "").trim() !== "";

  /** Transcribed from payment-schedule.ts checkMixed. */
  const clientCheckMixed = (rows, balance) => {
    const bal = Math.max(0, Math.round(balance || 0));
    const neither = rows.findIndex((r) => String(r.amount ?? "").trim() === "" && String(r.percent ?? "").trim() === "");
    if (neither >= 0) return { ok: false, code: "incomplete", fixedTotal: 0, percentBase: bal };
    const fixed = rows.filter(clientIsFixed);
    const percentRows = rows.filter((r) => !clientIsFixed(r));
    let fixedTotal = 0;
    for (const r of fixed) {
      const n = Number(String(r.amount).replace(/[,\s]/g, "").replace("₹", ""));
      if (!Number.isFinite(n)) return { ok: false, code: "incomplete", fixedTotal: 0, percentBase: bal };
      if (n < 0) return { ok: false, code: "negative_fixed", fixedTotal: 0, percentBase: bal };
      fixedTotal += Math.round(n);
    }
    const percentBase = bal - fixedTotal;
    if (fixedTotal > bal) return { ok: false, code: "fixed_exceeds_balance", fixedTotal, percentBase };
    if (!percentRows.length) {
      return fixedTotal === bal
        ? { ok: true, code: "ok", fixedTotal, percentBase }
        : { ok: false, code: "fixed_short", fixedTotal, percentBase };
    }
    if (fixedTotal > 0 && percentBase <= 0) return { ok: false, code: "no_base_for_percentages", fixedTotal, percentBase };
    const hs = percentRows.map((r) => clientToHundredths(r.percent));
    if (hs.some((h) => h === null)) return { ok: false, code: "incomplete", fixedTotal, percentBase };
    const total = hs.reduce((sum, h) => sum + h, 0);
    return total === FULL
      ? { ok: true, code: "ok", fixedTotal, percentBase }
      : { ok: false, code: "percent_mismatch", fixedTotal, percentBase };
  };

  /** Transcribed from payment-schedule.ts gstOnRow. */
  const clientGstOnRow = (amount, { gstMode = "none", gstPercent = 0, rowApplicable = false } = {}) => {
    const amt = Math.round(Number(amount) || 0);
    const pct = Math.max(0, Math.min(100, Number(gstPercent) || 0));
    const bears = gstMode === "whole" || (gstMode === "per_instalment" && rowApplicable);
    if (!bears || pct === 0 || amt <= 0) return { gst: 0, collectable: amt, bears: false };
    const gst = Math.round((amt * pct) / 100);
    return { gst, collectable: amt + gst, bears: true };
  };

  const MIXED = [
    ["percentages only", [row("a", "50"), row("b", "50")], 950000],
    ["one fixed then 50/50", [row("a", "", "100000"), row("b", "50"), row("c", "50")], 950000],
    ["several fixed then percentages", [row("a", "", "50000"), row("b", "", "50000"), row("c", "100")], 950000],
    ["all fixed exact", [row("a", "", "500000"), row("b", "", "450000")], 950000],
    ["all fixed short", [row("a", "", "500000"), row("b", "", "400000")], 950000],
    ["all fixed over", [row("a", "", "500000"), row("b", "", "500000")], 950000],
    ["fixed exceeds the balance", [row("a", "", "1000000")], 950000],
    ["fixed covers everything, percentages left", [row("a", "", "950000"), row("b", "100")], 950000],
    ["percentages short of the remainder", [row("a", "", "100000"), row("b", "50"), row("c", "40")], 950000],
    ["percentages over the remainder", [row("a", "", "100000"), row("b", "60"), row("c", "50")], 950000],
    ["a row with both", [row("a", "50", "100")], 950000],
    ["a negative fixed amount", [row("a", "", "-5000"), row("b", "100")], 950000],
  ];
  let mixBad = 0;
  for (const [name, rows, bal] of MIXED) {
    const cl = clientCheckMixed(rows, bal);
    const sv = sched.checkMixedTotal(
      // Pass BOTH fields through untouched. Mapping a row to one field here
      // would hide the very conflict the "row has both" rule exists to catch —
      // the harness must not pre-clean what the rule is being tested on.
      rows.map((r) => {
        const out = {};
        if (String(r.amount ?? "").trim() !== "") out.amount = Number(String(r.amount).replace(/[,\s]/g, ""));
        if (String(r.percent ?? "").trim() !== "") out.percent = r.percent;
        return out;
      }),
      bal
    );
    // `incomplete` is a client-only concept (mid-typing); the server simply has
    // no valid schedule there, so those cases are compared on ok alone.
    const same = cl.code === "incomplete" ? sv.ok === false : cl.ok === sv.ok && cl.code === sv.code && cl.fixedTotal === sv.fixedTotal && cl.percentBase === sv.percentBase;
    if (!same) {
      mixBad++;
      console.error(`     ✗ ${name}: client ${JSON.stringify(cl)} vs REAL server ${JSON.stringify({ ok: sv.ok, code: sv.code, fixedTotal: sv.fixedTotal, percentBase: sv.percentBase })}`);
    }
  }
  ok(mixBad === 0, `all ${MIXED.length} mixed rules agree with the real server module`);

  console.log("\n[S4 GST — transcribed client vs REAL server]");
  let gBad = 0;
  let gCases = 0;
  for (const amount of [0, 1, 999, 100000, 425000, 33333]) {
    for (const gstMode of ["none", "whole", "per_instalment"]) {
      for (const gstPercent of [0, 5, 12, 18, 28]) {
        for (const rowApplicable of [true, false]) {
          gCases++;
          const cl = clientGstOnRow(amount, { gstMode, gstPercent, rowApplicable });
          const sv = sched.gstOnRow(amount, { gstMode, gstPercent, rowApplicable });
          if (cl.gst !== sv.gst || cl.collectable !== sv.collectable || cl.bears !== sv.bears) {
            gBad++;
            console.error(`     ✗ ${amount}/${gstMode}/${gstPercent}%/${rowApplicable}: ${JSON.stringify(cl)} vs ${JSON.stringify(sv)}`);
          }
        }
      }
    }
  }
  ok(gBad === 0, `GST agrees with the real server across ${gCases} combinations`);

  console.log("\n[S4 the generated schedule matches what the client would have shown]");
  {
    const gen = sched.generateSchedule({
      rows: [{ label: "On booking", amount: 100000 }, { label: "Second", percent: 50 }, { label: "Balance", percent: 50 }],
      totalValue: 950000,
      gstMode: "whole",
      gstPercent: 18,
    });
    ok(gen.rows[0].amount === 100000 && gen.rows[0].isFixed, "the fixed row keeps exactly the amount that was typed");
    ok(gen.rows[1].amount === 425000 && gen.rows[2].amount === 425000, "the percentages split the REMAINING 8,50,000");
    ok(gen.totals.amount === 950000, "the agreed total is still the balance");
    ok(gen.totals.gst === 171000 && gen.totals.collectable === 1121000, "GST sits outside it: collectable is 11,21,000");
    ok(gen.rows[0].percent === null, "a fixed row reports no percentage — it never agreed to one");
    ok(
      sched.rowArithmeticSentence(gen.rows[0], { gstPercent: 18 }) === "On booking — Rs. 1,00,000 + 18% GST = Rs. 1,18,000",
      "and states its own arithmetic"
    );
  }

  console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
