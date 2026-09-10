/* THE DECISIONS QUEUE (§ 03.1, § 06.3).
 *
 *   "Server-ranked: items blocked on couple input, urgency-ordered, capped at 3.
 *    The top-bar 'N decisions open' pill and Home's cards read the same query."
 *
 * Decision cards are GENERATED, NEVER AUTHORED (§ 03.1). The rule is: anything
 * where the couple's answer is what the team is waiting on. Everything else —
 * work in progress, things the team is doing, things already decided — is not a
 * decision and does not belong here however urgent it is.
 *
 * The cap of 3 is the product's, and it is enforced in ONE place (rank below)
 * so the pill and the cards cannot disagree about how many are open. The pill
 * shows the number of BLOCKING candidates, not the capped list — "3 decisions
 * open" when there are five is a lie the couple finds out about later.
 *
 * PURE. Candidates in, ranked cards out. No mongoose, no clock except the `now`
 * you pass.
 */

const CAP = 3;

const DAY = 86400000;

/**
 * Tie-break weight when two things are equally urgent. Lower goes first.
 * A venue hold expires and cannot be recovered; a task can be done tomorrow.
 */
const TYPE_WEIGHT = {
  venue: 0,
  decor: 1,
  palette: 2,
  payment: 3,
  guests: 4,
  website: 5,
  task: 6,
};

const weightOf = (type) => (TYPE_WEIGHT[type] === undefined ? 9 : TYPE_WEIGHT[type]);

/** Days until a deadline. No deadline sorts last, never first. */
const daysUntil = (date, now) => {
  if (!date) return Number.MAX_SAFE_INTEGER;
  const at = new Date(date).getTime();
  if (Number.isNaN(at)) return Number.MAX_SAFE_INTEGER;
  return Math.floor((at - new Date(now).getTime()) / DAY);
};

/**
 * Rank and cap.
 *
 * @param {object[]} candidates each { id, type, category, title, body, image,
 *                              action, blocking: boolean, dueAt: Date|null }
 * @param {Date}     now
 * @returns {{ decisions: object[], openCount: number }}
 *
 * `openCount` is every blocking candidate; `decisions` is the top three, each
 * stamped with its position and the variant § 03.1 asks for (card 1 primary).
 */
const rank = (candidates, now = new Date()) => {
  const blocking = (Array.isArray(candidates) ? candidates : []).filter(
    (c) => c && c.blocking
  );

  const ordered = blocking.slice().sort((a, b) => {
    const da = daysUntil(a.dueAt, now);
    const db = daysUntil(b.dueAt, now);
    if (da !== db) return da - db;                       // urgency first
    const wa = weightOf(a.type);
    const wb = weightOf(b.type);
    if (wa !== wb) return wa - wb;                       // then irreversibility
    return String(a.id || "").localeCompare(String(b.id || "")); // then stable
  });

  return {
    openCount: blocking.length,
    decisions: ordered.slice(0, CAP).map((c, index) => ({
      id: c.id,
      type: c.type,
      category: c.category,
      position: index + 1,
      variant: index === 0 ? "primary" : "secondary",
      title: c.title,
      body: c.body,
      image: c.image || null,
      action: c.action || null,
    })),
  };
};

/**
 * Turn the wedding's state into candidates. Pure — everything it needs is
 * passed in, so a test can produce any situation without a database.
 *
 * Each rule below answers one question: is the TEAM waiting on the COUPLE?
 *
 * @param {object[]} days       the wedding's functions AS THE COUPLE APP SHAPES
 *                              THEM (CoupleWeddingService.shapeDay) — so the
 *                              décor state this ranks on is the same derived
 *                              value the Planner screen renders, not a second
 *                              reading of the raw Event
 * @param {object[]} payments   couple-app payment rows (plain)
 * @param {object[]} tasks      CoupleTask rows (plain)
 * @param {object[]} holds      venue holds awaiting a reaction
 * @param {Date}     now
 */
const candidates = ({ days = [], payments = [], tasks = [], holds = [], now = new Date() } = {}) => {
  const out = [];

  days.forEach((day) => {
    const state = day && day.decorStatus;
    const id = String((day && day.id) || (day && day.name) || "");
    // PRICED — three tiers are on the table and nobody can order anything until
    // the couple picks one.
    if (state === "priced") {
      out.push({
        id: `decor-${id}`,
        type: "decor",
        category: "Décor",
        blocking: true,
        dueAt: day.date || null,
        title: `Your ${String(day.name || "décor").toLowerCase()} has been priced`,
        body: "Compare the tiers and choose one.",
        action: { label: "Compare tiers", view: "planner", tab: "decor" },
      });
    }
    // NEEDS INPUT — the décor lead cannot draw anything without a direction.
    if (state === "needs_input") {
      out.push({
        id: `palette-${id}`,
        type: "palette",
        category: day.name || "Décor",
        blocking: true,
        dueAt: day.date || null,
        title: `The ${String(day.name || "function").toLowerCase()} has no palette yet`,
        body: "Your décor lead needs a direction before she can draw anything.",
        action: { label: "Pick a palette", view: "planner", tab: "decor" },
      });
    }
  });

  // VENUE HOLDS — a held date is a promise with an expiry. This is the most
  // irreversible thing on the list, hence weight 0 above.
  const live = (Array.isArray(holds) ? holds : []).filter((h) => h && !h.reaction);
  if (live.length) {
    const soonest = live.reduce(
      (best, h) => (best && daysUntil(best.expiresAt, now) <= daysUntil(h.expiresAt, now) ? best : h),
      null
    );
    out.push({
      id: "venue-holds",
      type: "venue",
      category: "Venue",
      blocking: true,
      dueAt: soonest ? soonest.expiresAt : null,
      title: `${live.length} venue${live.length === 1 ? " is" : "s are"} holding your date`,
      body: "Tell your planner what you think of them.",
      action: { label: "React to them", view: "planner", tab: "venue" },
    });
  }

  // PAYMENTS — money due is blocked on the couple by definition.
  (Array.isArray(payments) ? payments : []).forEach((payment) => {
    if (!payment || payment.status === "paid") return;
    if (daysUntil(payment.dueDate, now) > 14) return; // not yet theirs to worry about
    out.push({
      id: `payment-${payment.id || payment._id}`,
      type: "payment",
      category: "Payments",
      blocking: true,
      dueAt: payment.dueDate || null,
      title: payment.label || "A payment is due",
      body: payment.vendor ? `Due to ${payment.vendor}.` : "Due soon.",
      action: { label: "Review it", view: "payments" },
    });
  });

  // TASKS — only the ones already overdue. An open task with a week to run is
  // not a decision; it is a task, and Home has a different place for it.
  (Array.isArray(tasks) ? tasks : []).forEach((task) => {
    if (!task || task.done) return;
    if (daysUntil(task.dueDate, now) > 0) return;
    out.push({
      id: `task-${task.id || task._id}`,
      type: "task",
      category: "Tasks",
      blocking: true,
      dueAt: task.dueDate || null,
      title: task.title,
      body: "This one is past its date.",
      action: { label: "Open tasks", view: "tasks" },
    });
  });

  return out;
};

module.exports = { rank, candidates, daysUntil, CAP, TYPE_WEIGHT };
