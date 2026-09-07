const mongoose = require("mongoose");

// ───────────────────────────────────────────────────────────────────────────
// THE ONE isId. Do not write another.
//
// mongoose's ObjectId.isValid() is not an input validator. It answers "could
// this be coerced into an ObjectId", and the answer is TRUE for any
// 12-character string and for numbers, because those are legitimate 12-byte
// binary ids in a driver context. Nothing arriving over HTTP is legitimately a
// 12-byte binary string, so any request-facing check built on it accepts input
// it should refuse.
//
// WHY THE 12-CHARACTER CASE IS THE DANGEROUS ONE. A number stringifies to "123"
// and throws loudly at cast — a bug that announces itself. A 12-character
// string does not throw at all:
//
//     "123456789012" -> ObjectId 313233343536373839303132
//     "aaaaaaaaaaaa" -> ObjectId 616161616161616161616161
//
// Well-formed, and matching nothing. A write or a notification aimed at an id
// that can never resolve, with no error, no catch and no log. It was measured
// reaching the mentions[] array of step notes and chat messages, where the ids
// are persisted before any notification filter runs.
//
// STRICT means: a real ObjectId instance, or a 24-character hex string. That is
// correct at every call site in this codebase — all of them are checking a
// value that arrived from a request or was read back out of Mongo, and both of
// those are 24-hex.
//
// WHY IT LIVES HERE AND NOWHERE ELSE. This rule had been hand-copied into 37
// local definitions in three shapes — isValid(v), isValid(String(v)) and
// isValidObjectId(v) — which is a hand-maintained mirror of one rule. Mirrors
// drift: fixing the few exposed call sites would have left the rest to rot, and
// copy thirty-eight is one careless paste away. tests/objectid-strict.test.js
// asserts there is exactly one definition in the repo, which is what stops it.
// ───────────────────────────────────────────────────────────────────────────
const isId = (v) =>
  v instanceof mongoose.Types.ObjectId ||
  (typeof v === "string" && /^[a-f0-9]{24}$/i.test(v));

module.exports = { isId };
