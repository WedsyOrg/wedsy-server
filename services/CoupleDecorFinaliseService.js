/* INVARIANT 3 of 4 — DÉCOR FINALISE → BUDGET → PAYMENTS (§ 06.3).
 *
 *   "Finalising décor writes the committed amount into Budget and generates the
 *    payment schedule rows."
 *
 * The finalise is the one irreversible act in the couple app (§ 06.2), and it
 * is the write that turns a drawing into money owed. Two things must be true of
 * it and both are structural here rather than remembered at a call site:
 *
 *   1. ONE SOURCE FOR "COMMITTED". Event.coupleApp.budget has no `committed`
 *      field — the number is Σ lines[].amount. Home and the Budget tracker
 *      cannot drift because there is nothing for them to drift between.
 *
 *   2. FINALISING TWICE MUST NOT DOUBLE ANYTHING. Every row this produces
 *      carries a `sourceKey` derived from the day being finalised, and the
 *      caller UPSERTS on it. A retried request, a double-tapped button and a
 *      replayed webhook all land on the same keys and change nothing. That is
 *      why plan() returns rows to upsert instead of rows to push.
 *
 * PURE. No mongoose. The Event is a plain document in, the writes are plain
 * documents out; tests/couple-decor-finalise.test.js runs the whole invariant
 * with object literals.
 */

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

const DAY = 86400000;

/** The budget line key for one finalised day. Stable across retries. */
const budgetKeyFor = (dayId) => `decor:${dayId}`;

/** The payment-row key for instalment n of one finalised day. */
const scheduleKeyFor = (dayId, index) => `decor:${dayId}:${index}`;

/** Σ the budget lines. THE definition of "committed" — there is no other. */
const committedTotal = (event) => {
  const lines =
    (event && event.coupleApp && event.coupleApp.budget && event.coupleApp.budget.lines) || [];
  return lines.reduce((total, line) => total + money(line && line.amount), 0);
};

/**
 * THE DEFAULT PAYMENT SCHEDULE.
 *
 * 25% on finalising, 50% forty-five days out, 25% a week out. THE SPLIT IS A
 * PRODUCT DECISION, not an engineering one — this is a starting position that
 * matches how the décor team already bills (advance / instalment / balance),
 * and it is the only place to change it. A caller that already knows the real
 * schedule (a venue contract, a negotiated plan) passes it in and this is not
 * consulted at all.
 *
 * Rounding: the last row absorbs the remainder, so the rows always sum to the
 * committed amount exactly. A schedule that sums to ₹1 less than the bill is a
 * balance nobody can clear.
 */
const defaultSchedule = (total, { weddingDate, now = new Date() } = {}) => {
  const amount = money(total);
  if (amount <= 0) return [];
  const wedding = weddingDate ? new Date(weddingDate) : null;
  const valid = wedding && !Number.isNaN(wedding.getTime());
  const at = (daysBefore, fallbackDaysFromNow) =>
    valid
      ? new Date(wedding.getTime() - daysBefore * DAY)
      : new Date(new Date(now).getTime() + fallbackDaysFromNow * DAY);

  const first = Math.round(amount * 0.25);
  const second = Math.round(amount * 0.5);
  const third = amount - first - second; // absorbs the rounding
  return [
    { label: "Booking advance — décor", amount: first, dueDate: new Date(new Date(now).getTime() + 7 * DAY) },
    { label: "Décor instalment 1", amount: second, dueDate: at(45, 45) },
    { label: "Décor balance", amount: third, dueDate: at(7, 90) },
  ].filter((row) => row.amount > 0);
};

/**
 * Plan the finalise.
 *
 * @param {object}   event      the Event document (plain), for its existing
 *                              budget lines and its wedding date
 * @param {string}   dayId      the eventDays[] subdocument id being finalised
 * @param {number}   amount     the committed total for that day
 * @param {string}   [label]    what the budget line and the rows are called
 * @param {object[]} [schedule] an explicit schedule; the default is used if absent
 * @param {string}   [vendor]   who is being paid
 * @param {Date}     [now]
 *
 * @returns {{
 *   alreadyFinalised: boolean,   already committed at this exact amount — nothing to do
 *   budgetLine: object,          UPSERT on sourceKey into coupleApp.budget.lines
 *   budgetLines: object[],       the whole lines array after the upsert
 *   committed: number,           Σ budgetLines — the number Home shows
 *   previousCommitted: number,
 *   scheduleRows: object[],      UPSERT each on coupleApp.sourceKey into Payment
 * }}
 *
 * `alreadyFinalised` is the idempotency answer and it is deliberately not an
 * error: a couple who taps Finalise twice has finalised, and the second answer
 * should be the same as the first, not a failure.
 */
const plan = ({ event, dayId, amount, label, schedule, vendor, now = new Date() } = {}) => {
  const total = money(amount);
  const key = budgetKeyFor(dayId);
  const existingLines =
    (event && event.coupleApp && event.coupleApp.budget && event.coupleApp.budget.lines) || [];
  const previous = existingLines.find((line) => line && line.sourceKey === key) || null;
  const previousCommitted = committedTotal(event);

  const budgetLine = {
    sourceKey: key,
    source: "decor",
    label: label || "Décor",
    amount: total,
    at: now,
  };

  // The UPSERT, done here so the caller writes one array and the test can see
  // that a second finalise replaces rather than appends.
  const budgetLines = previous
    ? existingLines.map((line) => (line && line.sourceKey === key ? budgetLine : line))
    : existingLines.concat([budgetLine]);

  const weddingDate =
    (event && event.coupleApp && event.coupleApp.weddingDate) || (event && event.eventDate) || null;
  const rows = Array.isArray(schedule) && schedule.length
    ? schedule
    : defaultSchedule(total, { weddingDate, now });

  const scheduleRows = rows.map((row, index) => ({
    sourceKey: scheduleKeyFor(dayId, index + 1),
    label: row.label || `${label || "Décor"} — instalment ${index + 1}`,
    vendor: vendor || "Wedsy",
    amount: money(row.amount != null ? row.amount : total * (Number(row.percent) || 0)),
    dueDate: row.dueDate || null,
  }));

  return {
    alreadyFinalised: Boolean(previous) && money(previous.amount) === total,
    budgetLine,
    budgetLines,
    committed: budgetLines.reduce((sum, line) => sum + money(line && line.amount), 0),
    previousCommitted,
    scheduleRows,
  };
};

module.exports = { plan, committedTotal, defaultSchedule, budgetKeyFor, scheduleKeyFor };
