/**
 * utils/venuePaymentStatus.js — what a payment schedule currently says.
 *
 * ── ONE DERIVATION, BECAUSE THREE SURFACES MUST AGREE ───────────────────────
 * The balance and the overdue list appear on the lead, on Today, and in
 * controllers/venuePayment.summary. If each computed its own, they would drift
 * the first time one of them was changed — and a balance that differs between
 * two screens is worse than no balance, because the owner cannot tell which to
 * believe. So every surface calls this.
 *
 * ── STATUS IS DERIVED, NEVER STORED ─────────────────────────────────────────
 * A milestone's state follows entirely from paidAmount vs amount vs dueDate.
 * Storing it would mean a nightly job to flip rows to overdue, and a row that is
 * wrong between midnight and whenever that job ran. Derived, "overdue" becomes
 * true the moment it is true.
 *
 * ── PARTIAL PAYMENT IS ALLOWED, DELIBERATELY ────────────────────────────────
 * A couple who owes 4,00,000 and sends 2,50,000 has genuinely paid something,
 * and the venue needs the balance to reflect it today rather than at the end of
 * a dispute. Refusing partials would push owners into the workaround of editing
 * the milestone amount down, which destroys the agreed schedule — the very
 * record that matters if the couple later disputes what was owed.
 *
 * So a partial keeps the milestone's ORIGINAL amount and records what arrived
 * against it. The instalment stays outstanding for the remainder, and stays
 * overdue if it is late, because part-payment of a late instalment does not make
 * it on time.
 *
 * ── OVERDUE MUST BE ACTIONABLE ──────────────────────────────────────────────
 * "This booking owes money" tells an owner nothing they can act on. Every
 * overdue entry produced here names the instalment, its due date, the amount
 * still outstanding, and how many days late it is, so the same sentence can be
 * shown on the lead, on Today, and in the alerts without any of them
 * re-deriving it.
 */
const { venueDayDiff } = require("./venueTime");

const round = (n) => Math.round(Number(n) || 0);

/**
 * Status of one milestone.
 * @returns {"paid"|"partial"|"overdue"|"due"}
 */
function milestoneStatus(row, now = new Date()) {
  const amount = round(row && row.amount);
  const paid = round(row && row.paidAmount);
  if (amount > 0 && paid >= amount) return "paid";
  const isLate = row && row.dueDate && new Date(row.dueDate) < now;
  if (isLate) return "overdue"; // late is late, whether or not part of it arrived
  if (paid > 0) return "partial";
  return "due";
}

/**
 * Expand one milestone into everything a surface needs to render or chase it.
 */
function describeMilestone(row, now = new Date()) {
  const amount = round(row.amount);
  const paid = Math.min(round(row.paidAmount), amount || Infinity);
  const outstanding = Math.max(0, amount - paid);
  const status = milestoneStatus(row, now);
  // Whole venue-local days late — the number an owner would say out loud.
  const daysLate = row.dueDate && status === "overdue" ? Math.max(0, venueDayDiff(now, new Date(row.dueDate))) : 0;
  return {
    _id: row._id,
    label: row.label || "Instalment",
    percent: row.percent === null || row.percent === undefined ? null : Number(row.percent),
    amount,
    paidAmount: paid,
    outstanding,
    dueDate: row.dueDate || null,
    paidAt: row.paidAt || null,
    paidMode: row.paidMode || "",
    paidReference: row.paidReference || "",
    recordedByName: row.recordedByName || "",
    status,
    isOverdue: status === "overdue",
    daysLate,
  };
}

/**
 * The whole schedule, plus the totals every surface shows.
 *
 * `balance` is deliberately computed from the BOOKING VALUE rather than from the
 * schedule's own sum: those can legitimately differ (a schedule entered as
 * amounts may not tally, and an owner may correct the value later), and what the
 * couple owes is a function of the price, not of how the plan was typed.
 */
function summarizeSchedule(booking, now = new Date()) {
  const rows = ((booking && booking.paymentSchedule) || []).map((r) => describeMilestone(r, now));
  const scheduled = rows.reduce((s, r) => s + r.amount, 0);
  const received = rows.reduce((s, r) => s + r.paidAmount, 0);
  const bookingValue = round(booking && booking.totalValue);
  const overdue = rows.filter((r) => r.isOverdue && r.outstanding > 0);
  const next = rows
    .filter((r) => r.outstanding > 0 && r.dueDate)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0] || null;

  return {
    rows,
    totals: {
      bookingValue,
      scheduled,
      received,
      balance: Math.max(0, bookingValue - received),
      // Surfaced rather than hidden: a schedule that does not add up to the
      // booking value is a real condition an owner should see, not one to paper
      // over by quietly using whichever number is larger.
      scheduleMatchesValue: bookingValue === 0 || scheduled === bookingValue,
      outstanding: rows.reduce((s, r) => s + r.outstanding, 0),
    },
    overdue,
    overdueTotal: overdue.reduce((s, r) => s + r.outstanding, 0),
    next,
  };
}

/**
 * The one sentence an overdue instalment gets, everywhere it appears.
 * Names the instalment, what is outstanding, and how late it is — the three
 * things that make it actionable rather than merely alarming.
 */
function overdueSentence(m) {
  const amount = `Rs. ${m.outstanding.toLocaleString("en-IN")}`;
  const late = m.daysLate === 0 ? "due today" : m.daysLate === 1 ? "1 day late" : `${m.daysLate} days late`;
  const partial = m.paidAmount > 0 ? ` (${`Rs. ${m.paidAmount.toLocaleString("en-IN")}`} of ${`Rs. ${m.amount.toLocaleString("en-IN")}`} received)` : "";
  return `${m.label} — ${amount} outstanding, ${late}${partial}`;
}

module.exports = { milestoneStatus, describeMilestone, summarizeSchedule, overdueSentence };
