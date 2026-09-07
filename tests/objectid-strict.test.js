/**
 * ONE isId, AND IT IS STRICT.
 *
 * mongoose's ObjectId.isValid() returns TRUE for any 12-character string and
 * for numbers, because those are legitimate 12-byte binary ids in a driver
 * context. Nothing arriving over HTTP is legitimately a 12-byte binary string,
 * so every call site that trusts isValid() accepts input it should refuse.
 *
 * WHY THIS IS WORSE THAN A CAST ERROR. A number stringifies to "123" and throws
 * loudly at cast. A 12-character string does NOT: it coerces to a well-formed
 * ObjectId ("123456789012" -> 313233343536373839303132) that matches nothing.
 * No error, no catch, no log — a write or a notify aimed at an id that will
 * never resolve. A bug that announces itself is not the dangerous one.
 *
 * The rule was hand-copied into 37 local definitions. A hand-maintained mirror
 * of one rule drifts: fixing the exposed few leaves the rest to rot, and copy
 * thirty-eight is one careless paste away. So there is ONE definition, and the
 * second assertion here is what stops the next copy.
 *
 *   node tests/objectid-strict.test.js
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { isId } = require("../utils/objectId");

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l} (got ${JSON.stringify(g)})`);

console.log("\n1. THE POISON SET — none of it may survive");
{
  // Every one of these passes a bare ObjectId.isValid().
  const POISON = ["123456789012", "aaaaaaaaaaaa", 123, 0];
  POISON.forEach((v) => {
    ok(mongoose.Types.ObjectId.isValid(v),
      `  (proof) bare isValid accepts ${JSON.stringify(v)} — this is what we are fixing`);
  });
  eq(POISON.filter(isId).length, 0, "strict isId lets NONE of the poison through");
  POISON.forEach((v) => eq(isId(v), false, `isId(${JSON.stringify(v)}) is false`));
}

console.log("\n2. REAL IDS STILL PASS");
{
  const real = new mongoose.Types.ObjectId();
  eq(isId(real), true, "an ObjectId instance passes");
  eq(isId(String(real)), true, "its 24-hex string passes");
  eq(isId("6a9da9f5595534f3a7291599"), true, "a lowercase 24-hex string passes");
  eq(isId("6A9DA9F5595534F3A7291599"), true, "an uppercase 24-hex string passes");
}

console.log("\n3. THE OBVIOUS RUBBISH STILL FAILS");
{
  [null, undefined, "", "not-an-id", {}, [], true, "6a9da9f5595534f3a729159", "6a9da9f5595534f3a72915999"]
    .forEach((v) => eq(isId(v), false, `isId(${JSON.stringify(v)}) is false`));
}

console.log("\n4. EXACTLY ONE DEFINITION IN THE REPO — this is what stops copy 38");
{
  const roots = ["services", "controllers", "middlewares", "utils", "repositories", "routes", "scripts"];
  const defs = [];
  const DEF = /(?:^|\n)\s*(?:const|let|var)\s+isId\s*=|(?:^|\n)\s*function\s+isId\s*\(/;
  for (const r of roots) {
    const dir = path.join(__dirname, "..", r);
    if (!fs.existsSync(dir)) continue;
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) { walk(p); continue; }
        if (!f.name.endsWith(".js")) continue;
        const src = fs.readFileSync(p, "utf8");
        if (DEF.test(src)) defs.push(path.relative(path.join(__dirname, ".."), p));
      }
    };
    walk(dir);
  }
  eq(defs.length, 1, `isId is defined exactly once${defs.length !== 1 ? " — found: " + defs.join(", ") : ""}`);
  eq(defs[0], "utils/objectId.js", "…and that one place is utils/objectId.js");
}

console.log("\n5. NO LOOSE isValid SURVIVES AS AN ID CHECK");
{
  // A bare isValid() anywhere outside the shared util is the old rule wearing a
  // different name. utils/objectId.js is allowed to call it — that is where the
  // strictness is added on top.
  const roots = ["services", "controllers", "middlewares", "repositories"];
  const offenders = [];
  for (const r of roots) {
    const dir = path.join(__dirname, "..", r);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".js")) continue;
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      src.split("\n").forEach((line, i) => {
        if (/^\s*\/\//.test(line)) return;
        if (/(?:mongoose\.)?(?:Types\.ObjectId\.isValid|isValidObjectId)\s*\(/.test(line)) {
          offenders.push(`${r}/${f}:${i + 1}`);
        }
      });
    }
  }
  eq(offenders.length, 0,
    `no service/controller calls a loose isValid directly${offenders.length ? " — " + offenders.slice(0, 8).join(", ") + (offenders.length > 8 ? ` (+${offenders.length - 8} more)` : "") : ""}`);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
