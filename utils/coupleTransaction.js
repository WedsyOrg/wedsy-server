/**
 * utils/coupleTransaction.js — ONE WRITE, OR NONE.
 *
 * The couple-app's money endpoints are the first thing on this server that has
 * to move two collections together. A guest's gift writes a Contribution AND a
 * WalletTxn credit AND the gift's running total, and § 06.3 is unambiguous
 * about what happens if only some of them land: "a Contribution without its
 * WalletTxn is money the couple cannot see."
 *
 * ── WHAT THIS ACTUALLY GUARANTEES ────────────────────────────────────────────
 * MongoDB multi-document transactions need a REPLICA SET (or mongos). Wedsy's
 * production database is Atlas — hard rule 4 says the URL ends `.mongodb.net`,
 * and every Atlas cluster is a replica set — so in production `runAtomically`
 * takes the real path and the three writes are genuinely atomic.
 *
 * A standalone `mongod` (a laptop, a plain docker image) cannot. Rather than
 * pretend, this helper DETECTS that, tells the caller so in the return value,
 * and runs the callback without a session — and the callers are written so that
 * the un-transacted ordering is still safe:
 *
 *     1. reserve on the GIFT first, with a conditional single-document update
 *        (that update is atomic on any MongoDB, replica set or not — it is the
 *        race guard, and it does not depend on this file at all);
 *     2. write the Contribution as `pending`, which counts towards NOTHING —
 *        not the balance, not `funded`, not the thank-you list;
 *     3. write the WalletTxn credit;
 *     4. only then flip the Contribution to `settled` with its `walletTxn` set.
 *
 * So the fallback's invariant is: **a settled Contribution always has its
 * credit.** A crash between 2 and 4 leaves a `pending` row that no screen reads
 * and a reconciliation job can complete or fail. That is a reconciliation path,
 * not a silent loss — and it is strictly what is available without a replica
 * set, said plainly rather than papered over.
 *
 * `atomic` comes back on every result so the caller can record which path ran.
 */

const mongoose = require("mongoose");

/**
 * Does this error mean "this deployment has no transactions", as opposed to
 * "this transaction failed"? Only the first justifies the fallback; anything
 * else must surface, because retrying a real failure without a session would
 * write half of what the caller asked for.
 */
const unsupported = (error) => {
  if (!error) return false;
  // IllegalOperation — what a standalone mongod answers to startTransaction.
  if (error.code === 20 || error.codeName === "IllegalOperation") return true;
  if (typeof error.message !== "string") return false;
  return (
    /Transaction numbers are only allowed on a replica set member or mongos/i.test(error.message) ||
    /Transactions are not supported/i.test(error.message) ||
    /This MongoDB deployment does not support retryable writes/i.test(error.message) ||
    /session.*not supported/i.test(error.message)
  );
};

/**
 * Run `work(session)` inside one transaction where the deployment allows it.
 *
 * `work` MUST pass the session to every write it makes and MUST re-read
 * anything it branches on, because `withTransaction` re-runs the whole callback
 * on a transient write conflict — which is exactly how two guests racing for
 * the same gift are serialised.
 *
 * A domain refusal (a 409, a 422) is thrown with `.status` set; it aborts the
 * transaction and is re-thrown untouched, so the controller answers with it.
 *
 * @param {(session: object|null) => Promise<any>} work
 * @param {object} [deps.connection]  injected in tests; defaults to mongoose's
 * @returns {Promise<{result:any, atomic:boolean}>}
 */
const runAtomically = async (work, deps = {}) => {
  const connection = deps.connection || mongoose.connection;
  let session = null;

  try {
    session = await connection.startSession();
  } catch (error) {
    if (!unsupported(error)) throw error;
    return { result: await work(null), atomic: false };
  }

  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return { result, atomic: true };
  } catch (error) {
    if (!unsupported(error)) throw error;
    // The deployment refused the transaction itself, not the work inside it.
    return { result: await work(null), atomic: false };
  } finally {
    try {
      await session.endSession();
    } catch (_) {
      /* a session that cannot be ended must not fail a write that succeeded */
    }
  }
};

/** `{ session }` when there is one, `{}` when there is not — for query options. */
const withSession = (session) => (session ? { session } : {});

module.exports = { runAtomically, withSession, unsupported };
