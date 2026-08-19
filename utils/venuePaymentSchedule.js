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
function generateSchedule({ rows, totalValue, advanceAmount = 0, eventDate, now = new Date() }) {
  if (!Array.isArray(rows) || !rows.length) throw new ScheduleError("A schedule needs at least one row");
  if (rows.length > MAX_ROWS) throw new ScheduleError(`At most ${MAX_ROWS} rows`);

  const prepared = rows.map((r, i) => ({
    label: String(r.label || "").trim().slice(0, MAX_LABEL) || `Instalment ${i + 1}`,
    percentHundredths: toHundredths(r.percent, `rows[${i}]`),
    offsetDays:
      r.offsetDays === null || r.offsetDays === undefined || r.offsetDays === "" ? null : Math.trunc(Number(r.offsetDays)),
  }));

  const total = checkTotal(prepared);
  if (!total.ok) throw new ScheduleError(`Schedule totals ${total.totalPercent}% — it must total exactly 100%`);

  const value = Math.max(0, Math.round(Number(totalValue) || 0));
  const advance = Math.max(0, Math.round(Number(advanceAmount) || 0));
  if (advance > value) {
    throw new ScheduleError("The advance is more than the booking value");
  }
  // THE BASE THE PERCENTAGES APPLY TO. With no advance this IS the booking
  // value, so the no-advance case is unchanged.
  const balance = value - advance;
  const ev = eventDate ? new Date(eventDate) : null;
  const evValid = ev && !Number.isNaN(ev.getTime());

  // Amounts: floor each row, then hand the residue to the last row so the
  // schedule adds up to the BALANCE exactly — and the advance plus the rows
  // add up to the booking value.
  const amounts = prepared.map((r) => Math.floor((balance * r.percentHundredths) / FULL));
  const residue = balance - amounts.reduce((s, a) => s + a, 0);
  if (amounts.length) amounts[amounts.length - 1] += residue;

  const out = prepared.map((r, i) => {
    let dueDate = null;
    if (r.offsetDays === null) {
      // "On booking" — today, not the event date.
      dueDate = new Date(now.getTime());
    } else if (evValid) {
      dueDate = new Date(ev.getTime() + r.offsetDays * DAY_MS);
    }
    return {
      label: r.label,
      percent: fromHundredths(r.percentHundredths),
      amount: amounts[i],
      dueDate,
      offsetDays: r.offsetDays,
    };
  });

  return {
    rows: out,
    totals: {
      percent: total.totalPercent,
      amount: out.reduce((s, r) => s + r.amount, 0),
      bookingValue: value,
      advanceAmount: advance,
      // What the percentages were applied to — the number the wizard shows so
      // an owner never has to work out why 50% is not half the booking.
      balance,
      // The assertions a caller should trust rather than recompute. The rows
      // total the BALANCE; the advance plus the rows total the booking.
      amountsMatchBalance: out.reduce((s, r) => s + r.amount, 0) === balance,
      amountsMatchBookingValue: advance + out.reduce((s, r) => s + r.amount, 0) === value,
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
};
