/* THE COMMITMENT WRITER — § 06.3 invariant 3, "Décor finalise → Budget →
 * Payments", turned into writes exactly once.
 *
 * ── WHAT THIS FILE IS AND IS NOT ───────────────────────────────────────────
 * It is NOT a second finalise. Every number, every date, every source key and
 * the whole idempotence story belong to services/CoupleDecorFinaliseService,
 * which was written and unit-tested by the foundation. This file contains no
 * percentage, no due date and no key format; it takes that service's `plan()`
 * result and performs the two writes it describes:
 *
 *   1. Event.coupleApp.budget.lines  ← the UPSERTED array plan() returned
 *   2. Payment (one per schedule row) ← UPSERTED on coupleApp.sourceKey
 *
 * ── WHY IT IS SHARED ───────────────────────────────────────────────────────
 * Two things in the couple app commit money: finalising décor (§ 3.2.2) and
 * accepting a makeup bid (§ 3.5, whose retainer is the first row of the same
 * schedule). Both call plan() and both call apply() here. A bespoke schedule
 * for the second would be a second definition of "what the couple owes and
 * when", which is precisely what invariant 3 exists to prevent.
 *
 * ── WHY FINALISING TWICE CANNOT DOUBLE ANYTHING ────────────────────────────
 * Three things, and only the first is code in this file:
 *
 *   · every Payment write is an UPSERT on { coupleApp.weddingId,
 *     coupleApp.sourceKey } — the same keys plan() derived, so a retry lands
 *     on the same rows;
 *   · Payment carries a UNIQUE SPARSE INDEX on that exact pair (models/
 *     Payment.js), so two CONCURRENT finalises cannot both insert. One wins,
 *     the other takes E11000 and is retried onto the winner's row;
 *   · the budget line array plan() returns already REPLACES the line with the
 *     same sourceKey rather than appending one.
 *
 * A row that has already been PAID is never rewritten. A schedule that
 * regenerated over a settled payment would reopen money the couple has sent.
 */

const mongoose = require("mongoose");
const Event = require("../models/Event");
const Payment = require("../models/Payment");
const { runAtomically, withSession } = require("../utils/coupleTransaction");

const DUPLICATE_KEY = 11000;

/**
 * The writes, as plain descriptions. PURE — no mongoose, no I/O — so the whole
 * shape of what a finalise does to the database is unit-testable with literals
 * (tests/couple-planning-schedule.test.js).
 *
 * @param {object} planned  a CoupleDecorFinaliseService.plan() result
 * @param {string} weddingId
 * @param {string} userId    whose Payment rows these are (Payment.user is required)
 * @param {string} [source]  what KIND of commitment the budget line is
 *                           ("decor" | "makeup" | …). plan() stamps "decor";
 *                           this is the caller's one word, and the only thing
 *                           about the line the caller may say.
 * @param {string} [ref]     the couple-facing reference on every row
 * @param {string[]} [sourceKeys] which budget lines this call planned. Defaults
 *                           to the keys plan() itself produced — a schedule row
 *                           key is its budget line's key plus ":<n>", so the
 *                           set is derivable and no caller has to keep a list.
 *                           Lines from EARLIER finalises keep the source word
 *                           they were written with.
 */
const operations = ({ planned, weddingId, userId, source, ref, sourceKeys } = {}) => {
  const plan = planned || {};

  const planned_keys = new Set(
    Array.isArray(sourceKeys) && sourceKeys.length
      ? sourceKeys.map(String)
      : (plan.scheduleRows || [])
          .map((row) => String(row.sourceKey || "").replace(/:\d+$/, ""))
          .concat(plan.budgetLine && plan.budgetLine.sourceKey ? [String(plan.budgetLine.sourceKey)] : [])
  );

  const budgetLines = (plan.budgetLines || []).map((line) =>
    line && source && planned_keys.has(String(line.sourceKey)) ? { ...line, source } : line
  );

  const payments = (plan.scheduleRows || []).map((row) => ({
    filter: {
      "coupleApp.weddingId": weddingId,
      "coupleApp.sourceKey": row.sourceKey,
    },
    update: {
      $set: {
        // The couple-facing half of the row. Nothing existing on Payment moves.
        "coupleApp.weddingId": weddingId,
        "coupleApp.label": row.label,
        "coupleApp.vendor": row.vendor,
        "coupleApp.ref": ref || "",
        "coupleApp.dueDate": row.dueDate,
        "coupleApp.sourceKey": row.sourceKey,
        amount: row.amount,
        amountDue: row.amount,
      },
      // Only on INSERT: a row that already exists keeps its user, its gateway
      // status and anything the money milestone's Pay flow has written on it.
      $setOnInsert: {
        user: userId,
        event: weddingId,
        paymentFor: "event",
        status: "null",
        amountPaid: 0,
      },
    },
  }));

  return { budgetLines, payments, committed: plan.committed, alreadyFinalised: Boolean(plan.alreadyFinalised) };
};

/**
 * Apply them. One transaction where the deployment has one — production is
 * Atlas and Atlas is a replica set (hard rule 4) — and, where it does not, the
 * budget line first and the payment rows after, so a crash between them leaves
 * a commitment with a short schedule rather than a schedule for a commitment
 * that was never made. Both are reconcilable by re-running the finalise, which
 * is exactly what idempotence buys.
 *
 * @returns {{committed:number, alreadyFinalised:boolean, rows:number, atomic:boolean}}
 */
const apply = async ({ planned, weddingId, userId, source, ref } = {}) => {
  const ops = operations({ planned, weddingId, userId, source, ref });

  const { atomic } = await runAtomically(async (session) => {
    await Event.updateOne(
      { _id: weddingId },
      { $set: { "coupleApp.budget.lines": ops.budgetLines } },
      withSession(session)
    );

    for (let i = 0; i < ops.payments.length; i += 1) {
      const row = ops.payments[i];
      try {
        await Payment.updateOne(
          // A row the couple has already PAID is left exactly as it is.
          { ...row.filter, status: { $ne: "paid" } },
          row.update,
          { upsert: true, ...withSession(session) }
        );
      } catch (error) {
        // The unique index refused a concurrent insert, or the row it would
        // have inserted is a paid one the filter excluded. Either way the row
        // now exists and must not be duplicated — retry as a plain update, and
        // let a paid row keep everything it holds.
        if (error && error.code === DUPLICATE_KEY) {
          await Payment.updateOne(
            { ...row.filter, status: { $ne: "paid" } },
            { $set: row.update.$set },
            withSession(session)
          );
        } else {
          throw error;
        }
      }
    }
    return true;
  });

  return {
    committed: ops.committed,
    alreadyFinalised: ops.alreadyFinalised,
    rows: ops.payments.length,
    atomic,
  };
};

/** What has actually left the bank against this wedding. */
const paidTotal = async (weddingId) => {
  const rows = await Payment.aggregate([
    { $match: { "coupleApp.weddingId": new mongoose.Types.ObjectId(String(weddingId)), status: "paid" } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return (rows[0] && rows[0].total) || 0;
};

module.exports = { operations, apply, paidTotal };
