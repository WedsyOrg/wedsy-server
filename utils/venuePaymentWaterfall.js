/**
 * utils/venuePaymentWaterfall.js — where a payment actually goes.
 *
 * ── THE PROBLEM WITH ASKING ─────────────────────────────────────────────────
 * Before this, recording money required naming the instalment it was for. But
 * a couple does not send money "against Instalment 2" — they send ₹1,00,000,
 * and it is the venue's job to work out that ₹50,000 of it finishes what was
 * outstanding on the first instalment and the rest starts the second. Making
 * the owner do that arithmetic by hand, one milestone at a time, is how a
 * schedule ends up with two part-payments that do not reconcile with the bank.
 *
 * So the DEFAULT is a waterfall: fill the oldest outstanding instalment first,
 * carry the remainder to the next, and keep going.
 *
 * ── THE WATERFALL IS A DEFAULT, NOT A CAGE ──────────────────────────────────
 * Sometimes a client says "this is for the final instalment specifically", and
 * they are entitled to say that — it is their money and their agreement. So an
 * explicit allocation always wins, and this module treats an override as a
 * first-class input rather than an escape hatch bolted on afterwards.
 *
 * ── ONE FUNCTION, BECAUSE THE PREVIEW MUST BE THE TRUTH ─────────────────────
 * The whole point of showing the allocation before saving is that the owner
 * agrees to what will happen. If the preview and the write computed it
 * separately they would eventually disagree, and the preview would become a
 * decoration that lies. `allocate` is called by both, and the write does not
 * re-derive anything the preview did not already show.
 *
 * Everything here is PURE — it takes described rows and returns a plan. It
 * never touches a document, which is what makes it testable against the exact
 * shapes real callers produce.
 */

const round = (n) => Math.round(Number(n) || 0);

/**
 * The order money fills instalments in: oldest due date first.
 *
 * A row with no due date sorts LAST rather than first. An undated row is
 * usually a token or an ad-hoc addition, and letting it swallow a payment
 * ahead of a genuinely overdue instalment would leave the overdue one still
 * outstanding — which is the opposite of what the owner recording the money
 * is trying to achieve.
 *
 * Ties keep their schedule order, so two instalments due the same day fill in
 * the order the owner wrote them.
 */
function orderRows(rows) {
  return rows
    .map((r, index) => ({ r, index }))
    .sort((a, b) => {
      const ad = a.r.dueDate ? new Date(a.r.dueDate).getTime() : Infinity;
      const bd = b.r.dueDate ? new Date(b.r.dueDate).getTime() : Infinity;
      if (ad !== bd) return ad - bd;
      return a.index - b.index;
    })
    .map((x) => x.r);
}

/**
 * Plan where an amount goes.
 *
 * @param {Array}  rows     described milestones (from summarizeSchedule), each
 *                          carrying _id, label, amount, outstanding, dueDate
 * @param {number} amount   what actually arrived
 * @param {Array}  [override] explicit [{ milestoneId, amount }] — the owner's
 *                          own allocation, which wins over the waterfall
 *
 * @returns {{lines: Array, allocated: number, unallocated: number, totalOutstanding: number, error: ?object}}
 *          `lines` is one entry per milestone the money touches, in the order
 *          it fills them. `error` is set when the plan cannot be honoured; the
 *          caller turns it into a refusal rather than silently allocating less.
 */
function allocate(rows, amount, override) {
  const want = round(amount);
  const open = (rows || []).filter((r) => round(r.outstanding) > 0);
  const totalOutstanding = open.reduce((s, r) => s + round(r.outstanding), 0);

  if (!Number.isFinite(want) || want <= 0) {
    return { lines: [], allocated: 0, unallocated: 0, totalOutstanding, error: { code: "amount_required", message: "A payment amount is required" } };
  }

  // ── OVERPAYMENT BEYOND THE WHOLE SCHEDULE ────────────────────────────────
  // Refused, and named. Collecting more than the couple owes is legitimate
  // only through additional billing (S5) — silently accepting it here would
  // make the balance smaller than what is actually owed, the one error
  // direction nobody notices until it is too late.
  if (want > totalOutstanding) {
    return {
      lines: [], allocated: 0, unallocated: want, totalOutstanding,
      error: {
        code: "overpays_schedule",
        message:
          totalOutstanding === 0
            ? "This booking is fully paid. To collect more, add it as additional billing."
            : `That is more than this booking has outstanding. Rs. ${totalOutstanding.toLocaleString("en-IN")} is left to collect.`,
        outstanding: totalOutstanding,
      },
    };
  }

  // ── THE OWNER'S OWN ALLOCATION ───────────────────────────────────────────
  if (Array.isArray(override) && override.length) {
    const lines = [];
    let sum = 0;
    for (const o of override) {
      const row = open.find((r) => String(r._id) === String(o.milestoneId))
        || (rows || []).find((r) => String(r._id) === String(o.milestoneId));
      if (!row) {
        return { lines: [], allocated: 0, unallocated: want, totalOutstanding, error: { code: "unknown_milestone", message: "That instalment is not on this booking" } };
      }
      const put = round(o.amount);
      if (put <= 0) continue;
      // Each named row still may not take more than it is short. An override
      // says WHICH instalment, not "ignore what it is worth" — otherwise the
      // per-milestone overpayment rule could be bypassed by naming it.
      if (put > round(row.outstanding)) {
        return {
          lines: [], allocated: 0, unallocated: want, totalOutstanding,
          error: {
            code: "overpays_milestone",
            message: `Rs. ${put.toLocaleString("en-IN")} is more than ${row.label || "that instalment"} needs — Rs. ${round(row.outstanding).toLocaleString("en-IN")} is outstanding on it.`,
            milestoneId: row._id,
            outstanding: round(row.outstanding),
          },
        };
      }
      sum += put;
      lines.push({
        milestoneId: row._id,
        label: row.label || "Instalment",
        amount: put,
        outstandingBefore: round(row.outstanding),
        completes: put >= round(row.outstanding),
      });
    }
    if (sum !== want) {
      return {
        lines: [], allocated: 0, unallocated: want, totalOutstanding,
        error: {
          code: "allocation_mismatch",
          message: `The split comes to Rs. ${sum.toLocaleString("en-IN")}, but the payment is Rs. ${want.toLocaleString("en-IN")}.`,
          allocated: sum,
        },
      };
    }
    return { lines, allocated: sum, unallocated: 0, totalOutstanding, error: null };
  }

  // ── THE WATERFALL ────────────────────────────────────────────────────────
  const lines = [];
  let left = want;
  for (const r of orderRows(open)) {
    if (left <= 0) break;
    const short = round(r.outstanding);
    const put = Math.min(left, short);
    if (put <= 0) continue;
    lines.push({
      milestoneId: r._id,
      label: r.label || "Instalment",
      amount: put,
      outstandingBefore: short,
      completes: put >= short,
    });
    left -= put;
  }
  return { lines, allocated: want - left, unallocated: left, totalOutstanding, error: null };
}

const money = (n) => `Rs. ${round(n).toLocaleString("en-IN")}`;

/**
 * The allocation as one sentence, for the owner to agree to BEFORE saving.
 *
 * "Rs. 1,00,000 → Rs. 50,000 completes Instalment 1, Rs. 50,000 to Instalment 2."
 *
 * The verb carries the information: "completes" means that instalment is
 * finished and will stop appearing in the overdue list, "to" means it is a
 * part payment and the instalment stays outstanding. An owner reading the
 * preview should be able to tell those apart without doing the subtraction.
 */
function allocationSentence(plan, amount) {
  const lines = (plan && plan.lines) || [];
  if (!lines.length) return "";
  const parts = lines.map((l) => `${money(l.amount)} ${l.completes ? "completes" : "to"} ${l.label}`);
  const body = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}, ${parts[parts.length - 1]}`;
  return `${money(amount)} → ${body}.`;
}

module.exports = { allocate, allocationSentence, orderRows };
