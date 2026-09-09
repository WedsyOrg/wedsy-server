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

    // ══ D. THE SAFETY NET'S LENGTH GUARD ═════════════════════════════════════
    console.log("\nD. THE KIARA SAFETY NET SKIPS SHORT NUMBERS — OUT LOUD");
    {
      // engageLead gated on `phone.length < 12`, which is "91 + ten digits" —
      // an INDIAN length standing in for "is this a usable number". A US number
      // is 11 digits with its code and a Maldives number 10, so both were
      // dropped, silently. The census found leads in exactly those countries.
      //
      // WHO gets messaged is deliberately NOT changed here: that is a product
      // call (Meta bills per country, and the template's language is fixed).
      // The SILENCE is the bug, and the silence is what this asserts.
      const mongoose = require("mongoose");
      if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
      }
      const Enquiry = require("../models/Enquiry");
      const SettingsService = require("../services/SettingsService");
      const made = [];
      const mk = async (phone, tag) => {
        const l = await Enquiry.create({
          name: `INTLFIX-${tag}`, phone, source: "Website",
          stage: "new", verified: false, isInterested: false, isLost: false,
        });
        made.push(l._id);
        return l.toObject();
      };
      // The safety net is dormant without a template name; give it one so the
      // guard under test is actually reached.
      const realGet = SettingsService.get;
      SettingsService.get = async (k) =>
        k === "kiara.welcomeTemplateName" ? "kiara_welcome" : realGet(k);

      try {
        reset();
        const us = await mk("+14155550134", "us");
        await KiaraSafetyNet.engageLead(us, "test");
        eq(sent.whatsapp.length, 0, "a US number is still not engaged (policy unchanged)");
        ok(logs.some((l) => l.includes("[kiara-safety-net] SKIPPED")),
          "…but the skip is LOGGED instead of returning silently");
        ok(logs.some((l) => l.includes(String(us._id))), "…naming the lead");
        ok(logs.some((l) => l.includes("1415")), "…and the number's leading digits");

        reset();
        const inr = await mk("+919876500099", "in");
        await KiaraSafetyNet.engageLead(inr, "test");
        eq(sent.whatsapp.length, 1, "an Indian number is still engaged, exactly as before");
      } finally {
        SettingsService.get = realGet;
        if (made.length) await Enquiry.deleteMany({ _id: { $in: made } });
      }
    }

    // ══ E. THE DISPATCHER'S WhatsApp LEGS ════════════════════════════════════
    console.log("\nE. NotificationService BUILDS A CLEAN wa DESTINATION");
    {
      // Both legs used to pass the stored phone VERBATIM. A stored
      // "+91 98765 43210" therefore reached Meta as a `to` with spaces in it —
      // broken for domestic numbers too, not only international ones. The
      // digits-only shape is the one controllers/auth.international.js:53
      // already produces for this same function, so the "+" question is
      // settled by precedent rather than by guessing.
      process.env.AISENSY_API_URL = "https://stub.invalid/aisensy";

      reset();
      // et_reciept carries BOTH an AiSensy campaign and an SMS template.
      NotificationService.send("event_pmnt_rmnd", { phone: "+91 98765 43210", name: "Priya", variables: ["x"] });
      await new Promise((r) => setTimeout(r, 50));
      const aisensy = sent.sms.find((c) => String(c.url).includes("aisensy"));
      ok(!!aisensy, "the AiSensy leg fired");
      if (aisensy) {
        const dest = JSON.parse(aisensy.data).destination;
        eq(dest, "919876543210", "AiSensy gets digits only — no '+', no spaces");
        ok(!/[^0-9]/.test(dest), "…nothing but digits");
      }

      reset();
      // user_signup_greet carries a metaTemplate — the Meta Cloud API leg.
      NotificationService.send("user_signup_greet", { phone: "+91 98765 43210", name: "Priya", variables: ["Priya"] });
      await new Promise((r) => setTimeout(r, 50));
      const metaDest = (sent.whatsapp[0] || [])[0];
      eq(metaDest, "919876543210", "the Meta template leg gets the same digits-only shape");

      reset();
      NotificationService.send("user_signup_greet", { phone: "+971 50 123 4567", name: "Sara", variables: ["Sara"] });
      await new Promise((r) => setTimeout(r, 50));
      eq((sent.whatsapp[0] || [])[0], "971501234567",
        "…and an international number keeps its OWN code, spaces stripped");

      reset();
      NotificationService.send("user_signup_greet", { phone: "ig:17841400000001", name: "X", variables: ["X"] });
      await new Promise((r) => setTimeout(r, 50));
      eq(sent.whatsapp.length, 0, "an ig: placeholder produces no WhatsApp send at all");
      ok(logs.some((l) => l.includes("[notify] SKIPPED")), "…and says so");
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
