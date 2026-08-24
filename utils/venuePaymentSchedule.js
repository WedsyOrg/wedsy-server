/**
 * utils/venuePaymentSchedule.js — payment slab shapes, schedule generation, and
 * the 100% rule.
 *
 * Shared deliberately: S1d validates the venue's saved slabs with the same
 * functions the S2 wizard uses to generate a schedule and the same ones the API
 * uses to accept one. A slab that saves must be a slab that generates, and one
 * implementation is the only way to guarantee that.
 *
 * ══ THE 100% RULE, AND WHY IT IS INTEGER ARITHMETIC ═════════════════════════
 * "Percentages must total exactly 100" cannot be checked in floating point.
 * Three equal instalments are the case that proves it:
 *
 *     33.33 + 33.33 + 33.33            = 99.99   ✗ not 100
 *     0.3333 + 0.3333 + 0.3334         = 1.0000  but in float, 0.1+0.2 !== 0.3
 *
 * So percentages are carried as HUNDREDTHS OF A PERCENT as integers — 33.33%
 * is 3333 — and the rule is `sum === 10000`, which is exact. Two decimal places
 * is also the most precision a percentage on a customer document can justify.
 *
 * Generation then distributes the remainder rather than repeating a rounded
 * value: three equal instalments come out 33.34 / 33.33 / 33.33, summing to
 * exactly 100. The extra hundredth goes to the FIRST row, because the earliest
 * payment is the one the venue would rather have a rupee more of.
 *
 * ══ PERCENTAGES SPLIT THE BALANCE, NOT THE BOOKING VALUE ════════════════════
 * The advance is negotiated per client — ₹25,000 on a ₹1,00,000 booking,
 * whatever gets agreed — and the shape splits WHAT REMAINS AFTER IT. So a
 * "50/50" on that booking is ₹37,500 and ₹37,500 over the ₹75,000 balance, not
 * ₹50,000 twice.
 *
 * THIS WAS A LIVE OVER-COLLECTION BUG, not a wording problem. The advance
 * already existed as `tokenAmount`, and controllers/venueBooking.js PREPENDS it
 * to the schedule as a paid row while the rows themselves were costed against
 * the full booking value. Measured before the fix:
 *
 *     ₹1,00,000 booking + ₹25,000 token + 50/50
 *       → token 25,000 (paid) + rows 50,000 + 50,000
 *       → ₹1,25,000 scheduled against a ₹1,00,000 booking
 *
 * The couple was billed 125% of the price and the outstanding read ₹1,00,000 on
 * a booking with ₹25,000 already in hand.
 *
 * WITH NO ADVANCE NOTHING CHANGES. advanceAmount defaults to 0, the balance is
 * the booking value, and every existing schedule generates byte-identically.
 *
 * ══ A ROW IS EITHER A FIXED AMOUNT OR A PERCENTAGE (S4) ════════════════════
 * Real venues do not price purely in percentages. "Rs. 1,00,000 on booking, then
 * 50/50 on the rest" is the normal shape, and forcing that into percentages
 * means recomputing them by hand every time the booking value moves.
 *
 * So a row carries EITHER `amount` (fixed) or `percent`, never both. The rule
 * that follows from it:
 *
 *     FIXED COMES OFF THE TOP. PERCENTAGES SPLIT WHAT REMAINS.
 *
 *     Rs. 9,50,000 balance, one Rs. 1,00,000 fixed row
 *       → the percentage rows split Rs. 8,50,000, not Rs. 9,50,000
 *
 * All-fixed is legal and must total the balance EXACTLY — with no percentage
 * row there is nothing to absorb a shortfall, so "close enough" would silently
 * bill the couple the wrong number.
 *
 * Fixed exceeding the balance is refused with the arithmetic in the message,
 * because "invalid schedule" tells an owner nothing about which number to
 * change. And fixed EQUALLING the balance while percentage rows exist is also
 * refused: those rows would each be worth nothing, which is never what anybody
 * meant to build.
 *
 * ══ GST SITS OUTSIDE THE AGREED VALUE ══════════════════════════════════════
 * Rs. 1,00,000 agreed with 18% GST means the couple transfers Rs. 1,18,000. The
 * agreed value does not change — it is what was negotiated — so the schedule
 * carries BOTH numbers: what was agreed, and what is collectable.
 *
 * Three modes, MUTUALLY EXCLUSIVE by construction rather than by discipline:
 *   · "none"            — no GST anywhere
 *   · "whole"           — every instalment bears GST
 *   · "per_instalment"  — only the rows flagged for it do
 *
 * They are an enum and not a set of flags precisely so that "whole plus a few
 * per-row ticks" cannot be expressed. Double-taxing should be impossible to
 * represent, not merely discouraged.
 *
 * ══ MONEY ROUNDS SEPARATELY, AND MUST TOTAL THE BOOKING ═════════════════════
 * A percentage split that sums to 100 still does not guarantee the amounts sum
 * to the booking value — 33.34% of 1,000,000 is 333,400 and the three rows come
 * to 1,000,000, but at other values rounding to whole rupees loses or gains one.
 * So amounts are computed per row and the residue is applied to the LAST row,
 * which is the balance payment and the one an owner expects to absorb the
 * rounding. The invariant that matters on a document is that the schedule adds
 * up to the price.
 */

const PCT_SCALE = 100; // hundredths of a percent
const FULL = 100 * PCT_SCALE; // 10000 == 100.00%
const MAX_ROWS = 12; // matches MAX_SCHEDULE_ROWS in controllers/venueBooking
const MAX_LABEL = 80;
const GST_MODES = ["none", "whole", "per_instalment"];
const MAX_GST_PERCENT = 100;

class ScheduleError extends Error {
  constructor(message) {
    super(message);
    this.code = "invalid_schedule";
  }
}

/** "33.33" | 33.33 | 33 → 3333 hundredths. Throws on anything unusable. */
function toHundredths(percent, where) {
  const n = Number(percent);
  if (!Number.isFinite(n)) throw new ScheduleError(`${where}: percentage is not a number`);
  if (n < 0) throw new ScheduleError(`${where}: percentage cannot be negative`);
  if (n > 100) throw new ScheduleError(`${where}: percentage cannot exceed 100`);
  // Rounded, not truncated: a client sending 33.335 means 33.34, and floating
  // point makes 33.33 * 100 land on 3332.9999999999995.
  return Math.round(n * PCT_SCALE);
}

const fromHundredths = (h) => Math.round(h) / PCT_SCALE;

/**
 * Split 100% into `n` parts that sum to exactly 100.
 * The remainder lands on the earliest rows, one hundredth each.
 */
function equalSplit(n) {
  if (!Number.isInteger(n) || n < 1) throw new ScheduleError("Number of instalments must be a positive integer");
  if (n > MAX_ROWS) throw new ScheduleError(`At most ${MAX_ROWS} instalments`);
  const base = Math.floor(FULL / n);
  let remainder = FULL - base * n;
  return Array.from({ length: n }, () => {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    return base + extra;
  });
}

/**
 * Check a set of rows totals exactly 100%.
 * @returns {{ ok: boolean, totalHundredths: number, totalPercent: number,
 *             deltaHundredths: number, deltaPercent: number, message: string }}
 */
function checkTotal(rows) {
  const total = (rows || []).reduce((s, r) => s + (Number.isFinite(r.percentHundredths) ? r.percentHundredths : 0), 0);
  const delta = total - FULL;
  return {
    ok: delta === 0,
    totalHundredths: total,
    totalPercent: fromHundredths(total),
    deltaHundredths: delta,
    deltaPercent: fromHundredths(delta),
    // Phrased for the live indicator the brief asks for, so the UI never has to
    // compose this and get the sign backwards.
    message:
      delta === 0
        ? "Totals 100%"
        : delta < 0
          ? `${fromHundredths(-delta)}% short of 100%`
          : `${fromHundredths(delta)}% over 100%`,
  };
}

/**
 * The built-in shapes, used when a venue has saved no slabs of its own.
 * offsetDays is relative to the EVENT date; null means "on booking".
 *
 * DEFAULTS CHOSEN, and why:
 *   · a token/first payment is always "on booking" — it is what confirms the date
 *   · the final payment lands 7 days BEFORE the event, so money is in before
 *     anyone is on site, which is the whole point of a schedule
 *   · a middle instalment sits 30 days before, the usual point at which a couple
 *     has committed and the venue is ordering against the booking
 */
const BUILTIN_SLABS = [
  {
    key: "full_before",
    name: "100% before the event",
    rows: [{ label: "Full payment", percent: 100, offsetDays: -7 }],
  },
  {
    key: "50_50",
    name: "50 / 50",
    rows: [
      { label: "Advance", percent: 50, offsetDays: null },
      { label: "Balance", percent: 50, offsetDays: -7 },
    ],
  },
  {
    key: "three_way",
    name: "3 instalments",
    rows: [
      { label: "Advance", percent: 34, offsetDays: null },
      { label: "Second instalment", percent: 33, offsetDays: -30 },
      { label: "Balance", percent: 33, offsetDays: -7 },
    ],
  },
];

/**
 * Normalise incoming slab definitions (S1d). Each slab must total exactly 100%.
 * @returns {Array} storable slabs
 */
function normalizeSlabs(raw) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ScheduleError("paymentSlabs must be an array");
  if (raw.length > 12) throw new ScheduleError("At most 12 saved shapes");
  const out = [];
  raw.forEach((slab, i) => {
    const where = `paymentSlabs[${i}]`;
    if (!slab || typeof slab !== "object") throw new ScheduleError(`${where} is not an object`);
    const name = String(slab.name || "").trim().slice(0, MAX_LABEL);
    if (!name) throw new ScheduleError(`${where}: a shape needs a name`);
    const rowsRaw = Array.isArray(slab.rows) ? slab.rows : [];
    if (!rowsRaw.length) throw new ScheduleError(`${where}: a shape needs at least one row`);
    if (rowsRaw.length > MAX_ROWS) throw new ScheduleError(`${where}: at most ${MAX_ROWS} rows`);

    const rows = rowsRaw.map((r, j) => {
      const w = `${where}.rows[${j}]`;
      const percentHundredths = toHundredths(r.percent, w);
      let offsetDays = null;
      if (r.offsetDays !== null && r.offsetDays !== undefined && r.offsetDays !== "") {
        const n = Number(r.offsetDays);
        if (!Number.isFinite(n)) throw new ScheduleError(`${w}: offsetDays is not a number`);
        if (n < -3650 || n > 3650) throw new ScheduleError(`${w}: offsetDays is out of range`);
        offsetDays = Math.trunc(n);
      }
      return {
        label: String(r.label || "").trim().slice(0, MAX_LABEL) || `Instalment ${j + 1}`,
        percentHundredths,
        offsetDays,
      };
    });

    const total = checkTotal(rows);
    if (!total.ok) {
      throw new ScheduleError(`${where} ("${name}") totals ${total.totalPercent}% — a shape must total exactly 100%`);
    }
    out.push({
      name,
      isDefault: Boolean(slab.isDefault),
      rows: rows.map((r) => ({ label: r.label, percent: fromHundredths(r.percentHundredths), offsetDays: r.offsetDays })),
    });
  });
  // At most one default; the first wins rather than failing the save.
  let seenDefault = false;
  for (const s of out) {
    if (s.isDefault && seenDefault) s.isDefault = false;
    if (s.isDefault) seenDefault = true;
  }
  return out;
}

const money = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

/**
 * Split a mixed set of rows into its fixed and percentage halves, and say
 * whether it is buildable against a given balance.
 *
 * Returns a RICH result rather than a boolean, because the live indicator in
 * the wizard shows the same numbers this validates on — the base the
 * percentages apply to, what is short or over, and a sentence. A UI that had to
 * re-derive any of that would be the second implementation this module exists
 * to prevent.
 *
 * @param {Array}  rows     [{ percent }] or [{ amount }] per row
 * @param {number} balance  what the schedule has to cover
 */
function checkMixedTotal(rows, balance) {
  const list = Array.isArray(rows) ? rows : [];
  const bal = Math.max(0, Math.round(Number(balance) || 0));

  const fixedRows = [];
  const percentRows = [];
  list.forEach((r, i) => {
    const hasAmount = r && r.amount !== null && r.amount !== undefined && r.amount !== "";
    const hasPercent = r && r.percent !== null && r.percent !== undefined && r.percent !== "";
    // ── A PERCENTAGE WINS WHEN BOTH ARE PRESENT ────────────────────────────
    // Not ambiguity — the editor has ALWAYS carried a derived amount beside a
    // percentage row, because that is what it displays. Treating that pair as a
    // conflict made picking any built-in shape ("50 / 50" populates both) read
    // as "Row 1 has both a fixed amount and a percentage" and blocked the
    // wizard outright. Found by driving it.
    //
    // FIXED therefore means exactly one thing: a percentage was NOT given.
    if (hasPercent) return percentRows.push({ index: i, percentHundredths: toHundredths(r.percent, `rows[${i}]`) });
    if (hasAmount) return fixedRows.push({ index: i, amount: Math.round(Number(r.amount) || 0) });
    return percentRows.push({ index: i, percentHundredths: toHundredths(0, `rows[${i}]`) });
  });

  const fixedTotal = fixedRows.reduce((sum, r) => sum + r.amount, 0);
  const negative = fixedRows.find((r) => r.amount < 0);
  if (negative) {
    // fixedTotal/percentBase are reported as if nothing were entered: with a
    // negative in the set neither is a number the UI should render, and the
    // client mirror says the same. Parity caught them disagreeing here.
    return { ok: false, code: "negative_fixed", message: `Row ${negative.index + 1} has a negative amount.`, fixedTotal: 0, percentBase: bal, percentRows, fixedRows };
  }

  const percentBase = bal - fixedTotal;
  const base = { fixedTotal, percentBase, percentRows, fixedRows, hasPercentRows: percentRows.length > 0 };

  // ── fixed alone cannot exceed what there is to collect ──
  if (fixedTotal > bal) {
    return {
      ...base,
      ok: false,
      code: "fixed_exceeds_balance",
      // The arithmetic, not just a refusal: an owner has to know WHICH number to
      // change and by how much.
      message: `The fixed amounts come to ${money(fixedTotal)}, which is ${money(fixedTotal - bal)} more than the ${money(bal)} to collect.`,
      over: fixedTotal - bal,
    };
  }

  // ── all-fixed: it must land exactly, since no percentage row can absorb it ──
  if (!percentRows.length) {
    const ok = fixedTotal === bal;
    return {
      ...base,
      ok,
      code: ok ? "ok" : "fixed_short",
      message: ok
        ? `Totals ${money(fixedTotal)}`
        : `The fixed amounts come to ${money(fixedTotal)} — ${money(bal - fixedTotal)} short of the ${money(bal)} to collect.`,
      short: bal - fixedTotal,
    };
  }

  // ── the FIXED rows have eaten everything the percentages were to split ──
  // Only when fixed rows exist. A zero balance with no fixed rows is simply a
  // booking whose value has not been set yet, and percentages of nothing have
  // always generated rows of nothing — refusing that would break every draft
  // schedule built before a price was agreed.
  if (fixedTotal > 0 && percentBase <= 0) {
    return {
      ...base,
      ok: false,
      code: "no_base_for_percentages",
      message: `The fixed amounts already cover the whole ${money(bal)}, so the percentage rows have nothing to split.`,
    };
  }

  // ── and the percentages must total 100% OF THE REMAINDER ──
  const pct = checkTotal(percentRows);
  return {
    ...base,
    ok: pct.ok,
    code: pct.ok ? "ok" : "percent_mismatch",
    totalHundredths: pct.totalHundredths,
    totalPercent: pct.totalPercent,
    deltaHundredths: pct.deltaHundredths,
    deltaPercent: pct.deltaPercent,
    message: pct.ok
      ? fixedTotal > 0
        ? `${money(fixedTotal)} fixed, then 100% of the remaining ${money(percentBase)}`
        : "Totals 100%"
      // Names the delta AND the rule. The delta alone ("0.01% short of 100%")
      // says what is wrong; the clause says what "right" is, which is what an
      // owner staring at 33.33 × 3 actually needs to be told.
      : fixedTotal > 0
        ? `${pct.message} of the remaining ${money(percentBase)} — the percentages must total exactly 100% of it`
        : `${pct.message} — a schedule must total exactly 100%`,
  };
}

/**
 * What GST a row bears, and what is therefore collectable on it.
 *
 * GST is computed PER ROW rather than once on the total and split, because the
 * per-instalment mode means different rows bear different amounts — and a total
 * that was split afterwards could not reproduce that. Whole-amount mode is the
 * same function with every row bearing it, which is what makes the two modes
 * impossible to disagree.
 */
function gstOnRow(amount, { gstMode = "none", gstPercent = 0, rowApplicable = false } = {}) {
  const amt = Math.round(Number(amount) || 0);
  const pct = Math.max(0, Math.min(MAX_GST_PERCENT, Number(gstPercent) || 0));
  const bears = gstMode === "whole" || (gstMode === "per_instalment" && rowApplicable);
  if (!bears || pct === 0 || amt <= 0) return { gst: 0, collectable: amt, bears: false };
  const gst = Math.round((amt * pct) / 100);
  return { gst, collectable: amt + gst, bears: true };
}

/**
 * The one sentence a row states about its own arithmetic.
 * "Instalment 1 — Rs. 1,00,000 + 18% GST = Rs. 1,18,000."
 *
 * A row that bears no GST says nothing extra; adding "+ 0% GST" to every plain
 * row is noise that makes the rows that DO bear it harder to spot.
 */
function rowArithmeticSentence(row, { gstPercent = 0 } = {}) {
  const label = row.label || "Instalment";
  if (!row.gst) return `${label} — ${money(row.amount)}`;
  return `${label} — ${money(row.amount)} + ${gstPercent}% GST = ${money(row.amount + row.gst)}`;
}

/** Normalise a GST setting from anything a client might send. */
function normaliseGst(raw) {
  const src = raw || {};
  const mode = GST_MODES.includes(String(src.gstMode || "").trim()) ? String(src.gstMode).trim() : "none";
  let percent = Number(src.gstPercent);
  if (!Number.isFinite(percent) || percent < 0) percent = 0;
  if (percent > MAX_GST_PERCENT) throw new ScheduleError(`GST cannot exceed ${MAX_GST_PERCENT}%`);
  // A mode with no rate is the same as no GST, and saying so here means every
  // consumer does not have to check both fields.
  if (mode === "none" || percent === 0) return { gstMode: mode === "none" ? "none" : mode, gstPercent: percent, effective: false };
  return { gstMode: mode, gstPercent: percent, effective: true };
}

const DAY_MS = 86400000;

/**
 * Generate a dated, costed schedule from a shape.
 *
 * @param {object} args
 * @param {Array}  args.rows        [{ label, percent, offsetDays }]
 * @param {number} args.totalValue  the booking value in whole rupees
 * @param {number} [args.advanceAmount=0]  already negotiated and collected; the
 *        percentages apply to what remains after it
 * @param {Date|string} [args.eventDate]  earliest event day; offsets hang off it
 * @param {Date} [args.now]
 * @returns {{ rows: Array, totals: object }}
 */
function generateSchedule({ rows, totalValue, advanceAmount = 0, eventDate, gstMode = "none", gstPercent = 0, now = new Date() }) {
  if (!Array.isArray(rows) || !rows.length) throw new ScheduleError("A schedule needs at least one row");
  if (rows.length > MAX_ROWS) throw new ScheduleError(`At most ${MAX_ROWS} rows`);

  const value = Math.max(0, Math.round(Number(totalValue) || 0));
  const advance = Math.max(0, Math.round(Number(advanceAmount) || 0));
  if (advance > value) {
    throw new ScheduleError("The advance is more than the booking value");
  }
  // THE BASE THE PERCENTAGES APPLY TO. With no advance this IS the booking
  // value, so the no-advance case is unchanged.
  const balance = value - advance;

  const prepared = rows.map((r, i) => {
    const hasAmount = r.amount !== null && r.amount !== undefined && r.amount !== "";
    const hasPercent = r.percent !== null && r.percent !== undefined && r.percent !== "";
    // A PERCENTAGE WINS when both are present — the caller's amount is then the
    // derived display of that percentage, which is exactly what the wizard
    // sends for every shape-generated row. Classifying by amount-first made
    // those rows "fixed" and the percentages split nothing.
    const fixed = !hasPercent && hasAmount;
    return {
      label: String(r.label || "").trim().slice(0, MAX_LABEL) || `Instalment ${i + 1}`,
      // `fixed` is the discriminator every branch reads, so the two shapes
      // cannot be confused by looking at whichever field is falsy.
      fixed,
      fixedAmount: fixed ? Math.round(Number(r.amount) || 0) : 0,
      percentHundredths: fixed ? null : toHundredths(hasPercent ? r.percent : 0, `rows[${i}]`),
      gstApplicable: Boolean(r.gstApplicable),
      offsetDays:
        r.offsetDays === null || r.offsetDays === undefined || r.offsetDays === "" ? null : Math.trunc(Number(r.offsetDays)),
    };
  });

  // ONE validation, shared with the wizard's live indicator, so a schedule the
  // client showed as buildable is one the server accepts.
  const mixed = checkMixedTotal(
    prepared.map((r) => (r.fixed ? { amount: r.fixedAmount } : { percent: fromHundredths(r.percentHundredths) })),
    balance
  );
  if (!mixed.ok) throw new ScheduleError(mixed.message);

  const gst = normaliseGst({ gstMode, gstPercent });
  const ev = eventDate ? new Date(eventDate) : null;
  const evValid = ev && !Number.isNaN(ev.getTime());

  // Amounts: fixed rows are themselves; percentage rows split what is LEFT
  // after the fixed ones. The residue lands on the last PERCENTAGE row — never
  // on a fixed one, because a fixed amount that quietly gained a rupee is no
  // longer the number the owner typed.
  const percentBase = mixed.percentBase;
  const amounts = prepared.map((r) => (r.fixed ? r.fixedAmount : Math.floor((percentBase * r.percentHundredths) / FULL)));
  const lastPercentIdx = prepared.reduce((acc, r, i) => (r.fixed ? acc : i), -1);
  if (lastPercentIdx >= 0) {
    const percentAllocated = prepared.reduce((sum, r, i) => (r.fixed ? sum : sum + amounts[i]), 0);
    amounts[lastPercentIdx] += percentBase - percentAllocated;
  }

  const out = prepared.map((r, i) => {
    let dueDate = null;
    if (r.offsetDays === null) {
      // "On booking" — today, not the event date.
      dueDate = new Date(now.getTime());
    } else if (evValid) {
      dueDate = new Date(ev.getTime() + r.offsetDays * DAY_MS);
    }
    const g = gstOnRow(amounts[i], { gstMode: gst.gstMode, gstPercent: gst.gstPercent, rowApplicable: r.gstApplicable });
    return {
      label: r.label,
      // A fixed row reports percent: null. Reporting the percentage it happens
      // to work out to would be a number nobody agreed, and it would move the
      // next time the booking value did.
      percent: r.fixed ? null : fromHundredths(r.percentHundredths),
      isFixed: r.fixed,
      amount: amounts[i],
      gst: g.gst,
      gstApplicable: g.bears,
      /** What the couple actually transfers for this row. */
      collectable: g.collectable,
      dueDate,
      offsetDays: r.offsetDays,
    };
  });

  const amountTotal = out.reduce((s, r) => s + r.amount, 0);
  const gstTotal = out.reduce((s, r) => s + r.gst, 0);

  return {
    rows: out,
    totals: {
      percent: mixed.totalPercent === undefined ? 100 : mixed.totalPercent,
      amount: amountTotal,
      bookingValue: value,
      advanceAmount: advance,
      // What the percentages were applied to — the number the wizard shows so
      // an owner never has to work out why 50% is not half the booking.
      balance,
      fixedTotal: mixed.fixedTotal,
      percentBase,
      // ── BOTH NUMBERS, ALWAYS ──
      // `amount` is what was AGREED; `collectable` is what the couple transfers.
      // Keeping them apart is the whole point of GST sitting outside the agreed
      // value — a single "total" would have to silently be one or the other.
      gstMode: gst.gstMode,
      gstPercent: gst.gstPercent,
      gst: gstTotal,
      collectable: amountTotal + gstTotal,
      // The assertions a caller should trust rather than recompute. The rows
      // total the BALANCE; the advance plus the rows total the booking.
      amountsMatchBalance: amountTotal === balance,
      amountsMatchBookingValue: advance + amountTotal === value,
    },
  };
}

/** N equal instalments as a shape, ready for generateSchedule. */
function equalInstalmentRows(n, { firstOnBooking = true } = {}) {
  const parts = equalSplit(n);
  return parts.map((h, i) => ({
    label: i === 0 ? "Advance" : i === parts.length - 1 ? "Balance" : `Instalment ${i + 1}`,
    percent: fromHundredths(h),
    // First on booking, last a week before the event, the rest spread between.
    offsetDays: i === 0 && firstOnBooking ? null : i === parts.length - 1 ? -7 : -30 * (parts.length - 1 - i),
  }));
}

module.exports = {
  BUILTIN_SLABS,
  normalizeSlabs,
  generateSchedule,
  equalInstalmentRows,
  equalSplit,
  checkTotal,
  toHundredths,
  fromHundredths,
  ScheduleError,
  FULL,
  PCT_SCALE,
  MAX_ROWS,
  checkMixedTotal,
  gstOnRow,
  rowArithmeticSentence,
  normaliseGst,
  GST_MODES,
};
