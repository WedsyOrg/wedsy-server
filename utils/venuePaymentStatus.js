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
 * The entries on a row, oldest first, as plain objects.
 * Mongoose subdocs and plain objects both arrive here (lean reads, tests), so
 * nothing may assume a document API.
 */
function entriesOf(row) {
  const list = (row && row.entries) || [];
  return Array.from(list).map((e) => ({
    _id: e._id,
    paymentId: e.paymentId || null,
    amount: round(e.amount),
    date: e.date || null,
    method: e.method || "",
    methodOther: e.methodOther || "",
    reference: e.reference || "",
    note: e.note || "",
    proofUrl: e.proofUrl || "",
    status: e.status || "approved",
    recordedBy: e.recordedBy || null,
    recordedByName: e.recordedByName || "",
    approvedByName: e.approvedByName || "",
    approvedAt: e.approvedAt || null,
    rejectionReason: e.rejectionReason || "",
  })).sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
}

/**
 * WHAT COUNTS AS RECEIVED on one row.
 *
 * Only APPROVED entries. Pending money has been claimed, not confirmed, and
 * counting it would make approval decorative — the whole point is that
 * unapproved money is not in the books. Rejected money never counted.
 *
 * ── THE LEGACY FALLBACK, AND WHY IT IS NOT A HACK ──────────────────────────
 * A row written before S1 has no entries and holds its total in `paidAmount`.
 * If this returned 0 for those, every un-migrated booking would report its full
 * value outstanding the moment this shipped — on the lead, on Today, in the
 * alerts and on the confirmation PDF at once. The fallback makes the migration
 * a cleanup rather than a prerequisite, which is the difference between a
 * deploy that can be rolled back and one that cannot.
 *
 * A row WITH entries ignores the legacy field completely: post-migration it is
 * zeroed, and "entries exist" is the unambiguous signal that this row has been
 * converted. A row whose entries are all rejected therefore reads 0, not the
 * stale scalar — which is correct, and is why the test suite covers it.
 */
function receivedOn(row) {
  const entries = (row && row.entries) || [];
  if (entries.length === 0) return round(row && row.paidAmount);
  return Array.from(entries)
    .filter((e) => (e.status || "approved") === "approved")
    .reduce((sum, e) => sum + round(e.amount), 0);
}

/** Money claimed against this row but not yet approved. Shown, never counted. */
function pendingOn(row) {
  return Array.from((row && row.entries) || [])
    .filter((e) => e.status === "pending")
    .reduce((sum, e) => sum + round(e.amount), 0);
}

/**
 * Status of one milestone.
 * @returns {"paid"|"partial"|"overdue"|"due"}
 */
function milestoneStatus(row, now = new Date()) {
  const amount = round(row && row.amount);
  const paid = receivedOn(row);
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
  const paid = Math.min(receivedOn(row), amount || Infinity);
  const outstanding = Math.max(0, amount - paid);
  const entries = entriesOf(row);
  const pending = pendingOn(row);
  // ── THE SINGLE-PAYMENT FIELDS STILL MEAN SOMETHING ────────────────────────
  // paidAt / paidMode / paidReference / paidNote / recordedByName were written
  // straight onto the row before S1 and are read by the lead's Money tab, the
  // confirmation PDF and the payments UI. Now that payments live in a list,
  // they are derived from the LATEST APPROVED entry rather than left empty —
  // otherwise every one of those surfaces would silently lose the method and
  // reference of a payment the moment this shipped, which is a regression the
  // storage change has no business causing.
  //
  // "Latest approved" is the right one to surface: it is the most recent thing
  // that actually happened to this milestone. The full history is in `entries`
  // for anything that wants more than a headline.
  //
  // "Latest" means most recently RECORDED, which is insertion order — NOT the
  // largest date. The record form sends a date-only `paidAt`, so a payment
  // entered today lands at midnight while an entry created earlier the same
  // day carries a real timestamp: sorting by date put the newer payment first
  // and made the row report the OLDER payment's method. A date is also
  // legitimately backdated ("it actually arrived on the 12th"), so it cannot
  // be what decides which payment is the headline.
  const rawApproved = Array.from((row && row.entries) || []).filter((e) => (e.status || "approved") === "approved");
  const latest = rawApproved.length ? entriesOf({ entries: [rawApproved[rawApproved.length - 1]] })[0] : null;
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
    paidAt: latest ? latest.date : row.paidAt || null,
    paidMode: latest ? latest.method : row.paidMode || "",
    paidModeOther: latest ? latest.methodOther : row.paidModeOther || "",
    paidReference: latest ? latest.reference : row.paidReference || "",
    paidNote: latest ? latest.note : row.paidNote || "",
    recordedByName: latest ? latest.recordedByName : row.recordedByName || "",
    // The list itself, so a surface can show WHO SENT WHAT rather than only a
    // total — and so a pending or rejected entry is visible where it happened.
    entries,
    /** Claimed but unapproved. Deliberately NOT part of paidAmount. */
    pendingAmount: pending,
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

  const pendingTotal = rows.reduce((s, r) => s + r.pendingAmount, 0);

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
      // Surfaced beside the balance, never inside it. An owner chasing a late
      // instalment has to know money has been offered — silence there is how
      // somebody chases a couple who has already paid.
      pending: pendingTotal,
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

module.exports = { milestoneStatus, describeMilestone, summarizeSchedule, overdueSentence, receivedOn, pendingOn, entriesOf };
