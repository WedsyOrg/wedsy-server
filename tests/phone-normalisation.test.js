/**
 * PHONE NORMALISATION — one implementation, and it must not invent a country.
 *
 * The stakes are not "a hash does not match". waDigits builds wa.me links from
 * the same digits, so a wrongly-derived country code opens a WhatsApp
 * conversation with a DIFFERENT PERSON, silently.
 *
 *   · "+971501234567" survives untouched — no 91 anywhere in the result
 *   · a 10-digit number gets the CONFIGURED default AND emits the log
 *   · changing DEFAULT_COUNTRY_CODE changes the result — proving it is read
 *     per call, not baked in at module load
 *   · a short number and an "ig:" placeholder both yield NO phone
 *
 * No DB, no network.
 *
 *   node tests/phone-normalisation.test.js
 */
const crypto = require("crypto");
const { normalisePhone } = require("../utils/phone");
const MetaCAPI = require("../services/MetaConversionsService");

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l}${g === w ? "" : `\n      expected ${JSON.stringify(w)}\n      got      ${JSON.stringify(g)}`}`);

// Capture the "we guessed" log without hiding it.
let logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(" ")); realLog(...a); };
const withLogs = (fn) => { logs = []; const r = fn(); return { r, logs: [...logs] }; };

const ORIGINAL_CC = process.env.DEFAULT_COUNTRY_CODE;

try {
  console.log("\n1. A NUMBER THAT ALREADY CARRIES A COUNTRY CODE IS UNTOUCHED");
  {
    const { r, logs: l } = withLogs(() => normalisePhone("+971501234567", { leadId: "L1" }));
    eq(r, "971501234567", "+971501234567 survives as its own digits");
    ok(!String(r).includes("91501234567".slice(0, 0) + "91" + "501234567"),
      "…and no default was spliced into it");
    ok(!r.startsWith("91"), "the result does not begin with 91");
    eq(l.filter((x) => x.includes("ASSUMED")).length, 0, "…and nothing was assumed, so nothing was logged");
  }
  {
    // The dangerous near-miss: a UAE number is 12 digits, an Indian one with a
    // country code is also 12. Neither may be re-derived.
    eq(normalisePhone("971501234567"), "971501234567", "no '+' but >10 digits is still left alone");
    eq(normalisePhone("+91 98765 43210"), "919876543210", "an Indian number with '+91' keeps its own 91, not a prepended one");
    eq(normalisePhone("+1 (415) 555-0134"), "14155550134", "a US number keeps its 1");
    eq(normalisePhone("+44 7700 900123"), "447700900123", "a UK number keeps its 44");
  }

  console.log("\n2. TEN DIGITS AND NO '+' — THE ONE GUESS, AND IT SAYS SO");
  {
    delete process.env.DEFAULT_COUNTRY_CODE;
    const { r, logs: l } = withLogs(() => normalisePhone("9876543210", { leadId: "LEAD123" }));
    eq(r, "919876543210", "the configured default (91 when unset) is applied");
    ok(l.some((x) => x.includes("ASSUMED")), "…and the assumption is LOGGED, not silent");
    ok(l.some((x) => x.includes("lead=LEAD123")), "…with the lead id, so it can be chased");
  }
  {
    const { r } = withLogs(() => normalisePhone("09876543210", { leadId: "L2" }));
    eq(r, "919876543210", "a leading trunk zero is stripped before the length test, not read as a country code");
    eq(normalisePhone("98765-43210"), "919876543210", "symbols are stripped from a bare local number");
  }

  console.log("\n3. THE DEFAULT IS READ, NOT BAKED IN");
  {
    process.env.DEFAULT_COUNTRY_CODE = "971";
    const { r, logs: l } = withLogs(() => normalisePhone("5012345678", { leadId: "L3" }));
    eq(r, "9715012345678", "changing DEFAULT_COUNTRY_CODE changes the result");
    ok(r.startsWith("971"), "…the new code is on the front");
    ok(!r.startsWith("91"), "…and the old one is gone entirely");
    ok(l.some((x) => x.includes("+971")), "…and the log names the code it applied");

    process.env.DEFAULT_COUNTRY_CODE = "44";
    eq(normalisePhone("7700900123"), "447700900123", "and again, per call — no module-load memoisation");
    delete process.env.DEFAULT_COUNTRY_CODE;
    eq(normalisePhone("9876543210"), "919876543210", "unset falls back to 91");
  }

  console.log("\n4. NO PHONE IS A VALID ANSWER");
  {
    eq(normalisePhone("12345"), null, "fewer than 10 digits yields no phone");
    eq(normalisePhone("999"), null, "…and is never padded to reach 10");
    eq(normalisePhone("ig:17841400000001"), null, "an 'ig:' placeholder yields no phone");
    eq(normalisePhone(""), null, "empty yields no phone");
    eq(normalisePhone(null), null, "null yields no phone");
    eq(normalisePhone("   "), null, "whitespace yields no phone");
    const { logs: l } = withLogs(() => normalisePhone("ig:17841400000001", { leadId: "L4" }));
    eq(l.filter((x) => x.includes("ASSUMED")).length, 0, "…and a rejected value never claims an assumed country code");
  }

  console.log("\n5. THE CAPI HASHES WHAT THIS FUNCTION RETURNS — ONE IMPLEMENTATION");
  {
    // Independently computed, as before: never via the code's own normaliser.
    const UAE_SHA256 = crypto.createHash("sha256").update("971501234567", "utf8").digest("hex");
    const { event } = MetaCAPI.buildEvent({ _id: "x1", phone: "+971501234567", qualifiedAt: new Date() });
    eq(event.user_data.ph, UAE_SHA256, "a UAE lead hashes its OWN number, with no 91 introduced");

    const IN_SHA256 = crypto.createHash("sha256").update("919876543210", "utf8").digest("hex");
    const { event: e2 } = MetaCAPI.buildEvent({ _id: "x2", phone: "9876543210", qualifiedAt: new Date() });
    eq(e2.user_data.ph, IN_SHA256, "a bare 10-digit lead hashes the defaulted number");

    const { event: e3 } = MetaCAPI.buildEvent({ _id: "x3", phone: "ig:17841400000001", qualifiedAt: new Date() });
    ok(!e3.user_data.ph, "a placeholder contributes no ph at all");

    // THE DISCRIMINATING ONE. The three assertions above pass against a
    // hardcoded "91" too — a UAE number is untouched either way, and a bare
    // 10-digit number gets 91 either way while the default IS 91. Only the env
    // default reaching the hash proves there is one implementation and not two
    // that happen to agree.
    process.env.DEFAULT_COUNTRY_CODE = "971";
    const UAE_DEFAULTED = crypto.createHash("sha256").update("9715012345678", "utf8").digest("hex");
    const { event: e4 } = MetaCAPI.buildEvent({ _id: "x4", phone: "5012345678", qualifiedAt: new Date() });
    eq(e4.user_data.ph, UAE_DEFAULTED,
      "DEFAULT_COUNTRY_CODE reaches the CAPI hash — the service is not hashing via its own copy");
    delete process.env.DEFAULT_COUNTRY_CODE;

    ok(MetaCAPI.normalisePhone === normalisePhone,
      "…and the service re-exports utils/phone rather than defining a second normaliser");
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error("suite crashed:", e && e.stack ? e.stack : e);
  fail++;
} finally {
  console.log = realLog;
  if (ORIGINAL_CC === undefined) delete process.env.DEFAULT_COUNTRY_CODE;
  else process.env.DEFAULT_COUNTRY_CODE = ORIGINAL_CC;
  process.exit(fail === 0 ? 0 : 1);
}
