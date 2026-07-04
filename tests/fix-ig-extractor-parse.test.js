/**
 * FIX — IG extractor parse bug blocking lead creation.
 *
 * The IG extractor (InstagramAgentService.checkQualified) parsed model output
 * with a raw JSON.parse. When the model wrapped the JSON in a ```json fence or
 * added prose, parse threw and the fallback dropped `classification`, so the
 * weddingIntent gate (classification === 'lead') failed and no lead was created.
 *
 * This proves the new fence-tolerant parser (utils/parseModelJson) recovers the
 * object — including classification === 'lead' — from fenced / prose-wrapped
 * output, and that the OLD raw JSON.parse would have thrown on the same inputs.
 *
 *   node tests/fix-ig-extractor-parse.test.js
 */
const parseModelJson = require("../utils/parseModelJson");

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); }
};
// True when the OLD behavior (raw JSON.parse on the verbatim text) would throw.
const oldRawParseThrows = (text) => {
  try { JSON.parse(text); return false; } catch (_) { return true; }
};

const EXTRACTOR = {
  qualified: true,
  escalate: true,
  escalateReason: "Qualified — ready for your call",
  classification: "lead",
  data: { name: "Asha", phoneNumber: "9876543210", eventType: "wedding" },
};
const BODY = JSON.stringify(EXTRACTOR, null, 2);

console.log("FIX — IG extractor fence-tolerant parse");

// 1. Plain valid JSON — unchanged behavior.
const plain = parseModelJson(BODY);
ok(plain && plain.classification === "lead", "plain JSON → classification === 'lead'");

// 2. ```json fenced — the reported failure mode.
const jsonFenced = "```json\n" + BODY + "\n```";
const r2 = parseModelJson(jsonFenced);
ok(r2 && r2.classification === "lead", "```json fenced → classification === 'lead'");
ok(r2 && r2.data && r2.data.phoneNumber === "9876543210", "```json fenced → data.phoneNumber preserved");
ok(oldRawParseThrows(jsonFenced), "old raw JSON.parse WOULD throw on ```json fence (regression proof)");

// 3. ``` fence with no language tag.
const bareFenced = "```\n" + BODY + "\n```";
const r3 = parseModelJson(bareFenced);
ok(r3 && r3.classification === "lead", "``` (no lang) fenced → classification === 'lead'");
ok(oldRawParseThrows(bareFenced), "old raw JSON.parse WOULD throw on bare fence");

// 4. Prose-wrapped (no fence) — model added a sentence around the object.
const proseWrapped = `Sure! Here's the extracted data: ${BODY}\nHope that helps.`;
const r4 = parseModelJson(proseWrapped);
ok(r4 && r4.classification === "lead", "prose-wrapped → classification === 'lead'");
ok(oldRawParseThrows(proseWrapped), "old raw JSON.parse WOULD throw on prose wrap");

// 5. Genuinely unparseable → null (safe fallback preserved).
ok(parseModelJson("not json at all, sorry") === null, "unparseable text → null (safe fallback)");
ok(parseModelJson("") === null, "empty string → null");
ok(parseModelJson(null) === null, "null input → null");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
