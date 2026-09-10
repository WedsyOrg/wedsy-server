// COUPLE APP § 06.3 — HOW "ONE WRITE, OR NONE" DISPATCHES.
// Run: node tests/couple-money-atomicity.test.js
//
// PURE unit tests (NO DATABASE). To be precise about what this file does and
// does not prove: it asserts the DISPATCH in utils/coupleTransaction — which
// path runs, whether a domain refusal aborts, whether a session is always
// ended, and that a real failure is never quietly retried without one. It does
// NOT prove durability; that is MongoDB's, and it is exercised by
// tests/couple-registry-money.int.test.js against a real replica set.
//
// The connection handed in below is an INJECTED STUB, not a fake database: it
// answers `startSession` and nothing else, because the only thing under test is
// which branch runAtomically takes when it does or does not get a session.
const { runAtomically, unsupported } = require("../utils/coupleTransaction");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const err = (props) => Object.assign(new Error(props.message || "boom"), props);

/** A replica set: startSession works and withTransaction runs the callback. */
const replicaSet = () => {
  const state = { started: 0, committed: 0, ended: 0 };
  return {
    state,
    startSession: async () => {
      state.started += 1;
      return {
        withTransaction: async (fn) => { await fn(); state.committed += 1; },
        endSession: async () => { state.ended += 1; },
      };
    },
  };
};

/** A standalone mongod: startSession itself refuses. */
const standalone = () => ({
  startSession: async () => { throw err({ code: 20, codeName: "IllegalOperation", message: "Transaction numbers are only allowed on a replica set member or mongos" }); },
});

/** A deployment that hands out a session and then refuses to transact with it. */
const halfway = () => {
  const state = { ended: 0 };
  return {
    state,
    startSession: async () => ({
      withTransaction: async () => { throw err({ message: "Transaction numbers are only allowed on a replica set member or mongos" }); },
      endSession: async () => { state.ended += 1; },
    }),
  };
};

(async () => {
  console.log("On a replica set — the atomic path:");
  {
    const connection = replicaSet();
    const seen = [];
    const { result, atomic } = await runAtomically(async (session) => { seen.push(session); return "written"; }, { connection });
    eq(atomic, true, "it reports that it was atomic");
    eq(result, "written", "and returns what the work returned");
    eq(connection.state.committed, 1, "the transaction committed");
    eq(connection.state.ended, 1, "and the session was ended");
    ok(seen[0] !== null && seen[0] !== undefined, "the work was HANDED the session — so it can pass it to every write");
  }

  console.log("On a standalone mongod — the ordered path, said plainly:");
  {
    const seen = [];
    const { result, atomic } = await runAtomically(async (session) => { seen.push(session); return "written"; }, { connection: standalone() });
    eq(atomic, false, "it reports that it was NOT atomic — the caller can record which path ran");
    eq(result, "written", "the work still ran");
    eq(seen[0], null, "and was handed NULL, so it takes its own safe ordering");
  }

  console.log("A deployment that gives a session and then refuses to transact:");
  {
    const connection = halfway();
    const { atomic } = await runAtomically(async () => "written", { connection });
    eq(atomic, false, "falls back rather than failing the couple's write");
    eq(connection.state.ended, 1, "and still ends the session it was given");
  }

  console.log("A REAL failure is never retried without a session:");
  {
    let runs = 0;
    let caught = null;
    try {
      await runAtomically(async () => { runs += 1; throw err({ status: 409, code: "already_funded", message: "taken" }); }, { connection: replicaSet() });
    } catch (error) { caught = error; }
    eq(runs, 1, "the work ran ONCE — a 409 is not a reason to try again outside the transaction");
    eq(caught.status, 409, "and the refusal comes back untouched");
    eq(caught.code, "already_funded", "with its code, so the controller can answer with it");
  }
  {
    let runs = 0;
    let caught = null;
    try {
      await runAtomically(async () => { runs += 1; throw err({ code: 11000, message: "E11000 duplicate key" }); }, { connection: replicaSet() });
    } catch (error) { caught = error; }
    eq(runs, 1, "a duplicate-key error is not 'transactions unsupported' either");
    eq(caught.code, 11000, "and surfaces");
  }

  console.log("What counts as 'this deployment cannot transact':");
  {
    ok(unsupported(err({ code: 20, codeName: "IllegalOperation" })), "IllegalOperation / code 20");
    ok(unsupported(err({ message: "Transaction numbers are only allowed on a replica set member or mongos" })), "the replica-set message");
    ok(unsupported(err({ message: "Transactions are not supported by this deployment" })), "the plain refusal");
    ok(!unsupported(err({ code: 11000, message: "E11000 duplicate key" })), "a duplicate key is NOT");
    ok(!unsupported(err({ status: 409, message: "already_funded" })), "and neither is a domain refusal");
    ok(!unsupported(null), "nothing is not a reason to abandon transactions");
    ok(!unsupported(err({ message: "connection timed out" })), "nor is a timeout — that must surface, or half a gift is written");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
