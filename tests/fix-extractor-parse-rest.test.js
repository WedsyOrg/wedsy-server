/**
 * FIX — fence-tolerant parse for the two remaining extractors:
 *   • services/WhatsAppAgentService.js  (qualification extractor)
 *   • services/KiaraFactExtractionService.js  (handoff fact extractor)
 *
 * Both previously did a raw JSON.parse and threw on a ```json fence / prose wrap,
 * dropping the extracted object into their safe fallback. They now route through
 * utils/parseModelJson (the same drop-in used by InstagramAgentService). This
 * mirrors tests/fix-ig-extractor-parse.test.js: feed each extractor's
 * representative payload fenced / prose-wrapped and assert the real object comes
 * back; feed garbage and assert null (→ each extractor's safe fallback).
 *
 *   node tests/fix-extractor-parse-rest.test.js
 */
const parseModelJson = require("../utils/parseModelJson");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const oldRawParseThrows = (text) => { try { JSON.parse(text); return false; } catch (_) { return true; } };

// Representative payloads matching each extractor's real output shape.
const WA_EXTRACTOR = {
  qualified: true, escalate: true, escalateReason: "Qualified — ready for your call",
  classification: "lead",
  data: { name: "Asha", eventType: "wedding", city: "Bengaluru", budget: "15L" },
};
const KFE_FACTS = {
  eventType: "wedding", city: "Bengaluru", eventDate: "2026-12-20", numberOfEvents: "2",
  venueStatus: "looking", venueName: "", servicesRequired: "decor, photography",
  budget: "15L", weddingStyle: "South Indian", guests: "400",
  summary: "Dec 2026 Bengaluru wedding, 400 guests, decor + photography.",
};

const run = (label, obj, classKey, classVal) => {
  const body = JSON.stringify(obj, null, 2);
  console.log(label);

  // 1. plain
  const plain = parseModelJson(body);
  ok(plain && plain[classKey] === classVal, "plain JSON → object returned");

  // 2. ```json fenced — the reported failure mode
  const jsonFenced = "```json\n" + body + "\n```";
  const r2 = parseModelJson(jsonFenced);
  ok(r2 && r2[classKey] === classVal, "```json fenced → object returned");
  ok(oldRawParseThrows(jsonFenced), "old raw JSON.parse WOULD throw on ```json fence (regression proof)");

  // 3. ``` fence, no language tag
  const bareFenced = "```\n" + body + "\n```";
  ok(parseModelJson(bareFenced)?.[classKey] === classVal, "``` (no lang) fenced → object returned");

  // 4. prose-wrapped (no fence)
  const prose = `Sure! Here's the extracted data: ${body}\nHope that helps.`;
  const r4 = parseModelJson(prose);
  ok(r4 && r4[classKey] === classVal, "prose-wrapped → object returned");
  ok(oldRawParseThrows(prose), "old raw JSON.parse WOULD throw on prose wrap");

  // 5. garbage → null (safe fallback preserved)
  ok(parseModelJson("not json at all, sorry") === null, "garbage → null (safe fallback)");
};

run("WhatsAppAgentService extractor payload (classification:'lead')", WA_EXTRACTOR, "classification", "lead");
// KiaraFactExtraction has no classification field — assert a representative key round-trips.
run("KiaraFactExtractionService facts payload (city:'Bengaluru')", KFE_FACTS, "city", "Bengaluru");
// Extra: nested data + summary survive intact through a fence.
const fencedWa = parseModelJson("```json\n" + JSON.stringify(WA_EXTRACTOR) + "\n```");
ok(fencedWa && fencedWa.data && fencedWa.data.budget === "15L", "WA nested data preserved through fence");
const fencedKfe = parseModelJson("```json\n" + JSON.stringify(KFE_FACTS) + "\n```");
ok(fencedKfe && fencedKfe.summary && fencedKfe.guests === "400", "KFE summary + guests preserved through fence");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
