/**
 * INTERNATIONAL NUMBERS — the silent drops and the re-derived country codes.
 *
 * A  NotificationService.sendSMS returned silently for every non-+91 number.
 *    Fast2SMS is India-only (measured — see the service comment), so the
 *    REFUSAL is correct and stays. The SILENCE is the bug: an international
 *    lead got no SMS and nothing anywhere said so.
 * B  Three sites prepended a hardcoded 91 to a ten-digit number. One of them
 *    writes the result to the database.
 * C  utils/otp.js and sendSMS built the gateway's national number by string-
 *    replacing "+91", which does nothing to "+971501234567" — so the WhatsApp
 *    OTP destination became the malformed "91+971501234567".
 *
 * Every assertion below is on BEHAVIOUR — the request that was or was not
 * made, and its payload — never on "the function was called". The gateway is
 * stubbed at the module loader so a real HTTP call would be impossible.
 *
 *   node tests/international-numbers.test.js
 */
require("dotenv").config();
const Module = require("module");

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l}${g === w ? "" : `\n      expected ${JSON.stringify(w)}\n      got      ${JSON.stringify(g)}`}`);

// ── The gateway, stubbed at the loader ─────────────────────────────────────
// NotificationService and utils/otp.js both capture `axios` at module load, so
// the substitution has to happen before they are required. Nothing here can
// reach the network.
const sent = { sms: [], whatsapp: [] };
const fakeAxios = (config) => { sent.sms.push(config); return Promise.resolve({ data: { return: true } }); };
const fakeMetaWhatsApp = { sendWhatsApp: (...args) => { sent.whatsapp.push(args); return Promise.resolve({ ok: true }); } };

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "axios") return fakeAxios;
  if (request === "../utils/whatsapp" || request === "./whatsapp") return fakeMetaWhatsApp;
  return realLoad.call(this, request, parent, isMain);
};

let logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(" ")); realLog(...a); };
const reset = () => { sent.sms = []; sent.whatsapp = []; logs = []; };

const NotificationService = require("../services/NotificationService");
const KiaraSafetyNet = require("../services/KiaraSafetyNetService");
const InstagramAgent = require("../services/InstagramAgentService");
const { normalisePhone } = require("../utils/phone");

const ORIGINAL_CC = process.env.DEFAULT_COUNTRY_CODE;

(async () => {
  try {
    process.env.FAST2SMS_API_URL = "https://stub.invalid/sms";
    process.env.FAST2SMS_API_KEY = "STUBKEY";

    // ══ A. THE SILENT DROP ═══════════════════════════════════════════════════
    console.log("\nA. AN INTERNATIONAL LEAD IS REFUSED — OUT LOUD");
    {
      reset();
      // Fast2SMS accepts Indian destinations only, so this must NOT be sent.
      await NotificationService.sendSMS("+971501234567", "178508", ["x"], "WEDSYY", { leadId: "LEAD_UAE" });
      eq(sent.sms.length, 0, "a UAE number produces NO request to the SMS gateway");
      ok(logs.some((l) => l.includes("SKIPPED")), "…and the skip is LOGGED, not silent");
      ok(logs.some((l) => l.includes("LEAD_UAE")), "…naming the lead, so it can be chased");
      ok(logs.some((l) => l.includes("971")), "…and the number's country prefix");
      ok(!logs.some((l) => l.includes("501234567")), "…without printing the subscriber's full number");
    }
    {
      reset();
      // The counterpart: an Indian number IS sent, and the gateway gets the
      // bare national number it requires.
      await NotificationService.sendSMS("+91 98765 43210", "178508", ["x"], "WEDSYY", { leadId: "LEAD_IN" });
      eq(sent.sms.length, 1, "an Indian number DOES produce a request");
      const body = JSON.parse((sent.sms[0] || { data: "{}" }).data);
      eq(body.numbers, "9876543210", "the gateway gets the bare 10-digit national number");
      ok(!String(body.numbers).includes("+"), "…with no '+' and no country code");
      ok(logs.some((l) => l.includes("SENDING") || l.includes("SENT")), "and the send is logged too, not only the skips");
    }
    {
      reset();
      // The case the old string-replace mangled: a number with no country code
      // at all. It must still reach the gateway as ten digits.
      await NotificationService.sendSMS("9876543210", "178508", ["x"], "WEDSYY", { leadId: "LEAD_BARE" });
      eq(sent.sms.length, 1, "a bare 10-digit number is still sent");
      eq(JSON.parse(sent.sms[0].data).numbers, "9876543210", "…as those same ten digits");
    }
    {
      reset();
      await NotificationService.sendSMS("", "178508", ["x"]);
      eq(sent.sms.length, 0, "no phone at all → no request");
      ok(logs.some((l) => l.includes("SKIPPED")), "…and that is logged too");
    }

    // ══ B. NO MORE HARDCODED 91 PREPENDS ═════════════════════════════════════
    console.log("\nB. A STORED COUNTRY CODE IS NEVER RE-DERIVED");
    {
      // KiaraSafetyNetService.metaPhone — builds the Meta wa_id.
      eq(KiaraSafetyNet.metaPhone("+971501234567"), "971501234567",
        "metaPhone leaves a UAE number alone");
      eq(KiaraSafetyNet.metaPhone("9876543210"), "919876543210",
        "…and still defaults a bare 10-digit number");
      eq(KiaraSafetyNet.metaPhone("ig:17841400000001"), "",
        "…and yields nothing for an ig: placeholder rather than a fake number");
    }
    {
      // InstagramAgentService.toFullPhone — this one WRITES to the lead.
      ok(typeof InstagramAgent.toFullPhone === "function",
        "toFullPhone is exported so the rule that reaches the database is testable");
      if (typeof InstagramAgent.toFullPhone === "function") {
        eq(InstagramAgent.toFullPhone("+971501234567"), "971501234567",
          "toFullPhone leaves a UAE number alone");
        eq(InstagramAgent.toFullPhone("9876543210"), "919876543210",
          "…and still defaults a bare 10-digit number");
      }
    }
    {
      reset();
      process.env.DEFAULT_COUNTRY_CODE = "44";
      eq(KiaraSafetyNet.metaPhone("9876543210"), "449876543210",
        "the default is READ from env, not baked in");
      delete process.env.DEFAULT_COUNTRY_CODE;
      ok(logs.some((l) => l.includes("[phone] ASSUMED")),
        "…and every guess emits [phone] ASSUMED");
    }

    // ══ C. THE GATEWAY CODE IS DERIVED, NOT ASSUMED ══════════════════════════
    console.log("\nC. OTP — DERIVED, NOT STRING-REPLACED");
    {
      const mongoose = require("mongoose");
      await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
      const OTP = require("../models/OTP");
      const { SendOTP } = require("../utils/otp");

      reset();
      await SendOTP("+919876543210").catch(() => {});
      const smsBody = sent.sms.length ? JSON.parse(sent.sms[0].data) : {};
      eq(smsBody.numbers, "9876543210", "an Indian OTP reaches the gateway as ten digits");
      const waDest = (sent.whatsapp[0] || [])[0];
      eq(waDest, "919876543210", "…and WhatsApp gets the full international form");

      reset();
      await SendOTP("+971501234567").catch(() => {});
      const waDest2 = (sent.whatsapp[0] || [])[0];
      ok(!String(waDest2).includes("+"),
        `a UAE OTP does not produce a malformed WhatsApp destination (got ${JSON.stringify(waDest2)})`);
      eq(waDest2, "971501234567", "…it gets the UAE number, not 91 glued onto it");
      eq(sent.sms.length, 0, "…and no SMS, because the gateway cannot deliver it");
      ok(logs.some((l) => l.includes("SKIPPED")), "…logged, not silent");

      await OTP.deleteMany({ phone: { $in: ["+919876543210", "+971501234567"] } });
      await mongoose.disconnect();
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite crashed:", e && e.stack ? e.stack : e);
    fail++;
  } finally {
    console.log = realLog;
    Module._load = realLoad;
    if (ORIGINAL_CC === undefined) delete process.env.DEFAULT_COUNTRY_CODE;
    else process.env.DEFAULT_COUNTRY_CODE = ORIGINAL_CC;
    process.exit(fail === 0 ? 0 : 1);
  }
})();
