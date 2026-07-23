// MB-CRM S0a assignedTo-ref migration resolution. Run: node tests/venue-assignedto-migration.test.js
// Pure test of the per-value resolver: exact _id → exact name → case-insensitive
// name → unresolved, plus empty handling. No DB writes (the resolver is pure).
const mongoose = require("mongoose");
const { resolveAssignment } = require("../scripts/migrate-assignedto-ref");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const memberId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();
const group = {
  ids: new Set([String(memberId)]),
  byName: new Map([["Priya Rao", memberId]]),
  byNameLower: new Map([["priya rao", memberId]]),
};

console.log("[assignedto-migration]");

ok(resolveAssignment("", group).how === "empty", "empty string → empty (null)");
ok(resolveAssignment(null, group).how === "empty", "null → empty (null)");
ok(resolveAssignment("   ", group).how === "empty", "whitespace → empty (null)");

const byId = resolveAssignment(String(memberId), group);
ok(byId.how === "by_id" && String(byId.id) === String(memberId), "exact _id resolves to the member");

const byName = resolveAssignment("Priya Rao", group);
ok(byName.how === "by_name_exact" && String(byName.id) === String(memberId), "exact name resolves (same venue)");

const byCi = resolveAssignment("priya RAO", group);
ok(byCi.how === "by_name_ci" && String(byCi.id) === String(memberId), "case-insensitive name resolves");

ok(resolveAssignment("Someone Else", group).how === "unresolved", "unknown name → unresolved (null)");
ok(resolveAssignment(String(otherId), group).how === "unresolved", "valid ObjectId not in this venue → unresolved (null, not cross-venue)");
ok(resolveAssignment("garbage-value", group).how === "unresolved", "garbage string → unresolved (null)");

// precedence: an id that is ALSO a name string still resolves by id first
ok(resolveAssignment(String(memberId), group).how === "by_id", "precedence: _id wins over name paths");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
