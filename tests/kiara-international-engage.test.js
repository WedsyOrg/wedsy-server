/**
 * KIARA ENGAGES INTERNATIONAL LEADS TOO.
 *
 * engageLead gated on `phone.length < 12` — "91 + ten digits" wearing a
 * disguise. The result was that UK, Germany, Greece and UAE leads got engaged
 * and US/Canada, France and Maldives did not, decided by digit counts rather
 * than by anyone.
 *
 * LENGTH CANNOT ANSWER THE QUESTION, which is why this does not swap one magic
 * number for another. A Maldives number is 960 + 7 digits = 10 in total —
 * EXACTLY the length of a bare Indian mobile with no country code. No threshold
 * separates those two. What separates them is the leading "+", and that is
 * precisely what utils/phone.js keys on. So the guard asks the real question —
 * did normalisation yield a number we can message? — and decides on the answer,
 * not on the string's length.
 *
 * Still refused, still with a logged reason: an "ig:" placeholder, an empty
 * value, and anything too short to be a phone number.
 *
 * Shapes below are the ones the production census actually found.
 *
 *   node tests/kiara-international-engage.test.js
 */
require("dotenv").config();
const Module = require("module");
const mongoose = require("mongoose");

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l}${g === w ? "" : `\n      expected ${JSON.stringify(w)}\n      got      ${JSON.stringify(g)}`}`);

// Meta's send, stubbed at the loader — nothing here can reach the network.
const sentTemplates = [];
const fakeWhatsApp = {
  sendWhatsApp: (...args) => { sentTemplates.push(args); return Promise.resolve({ messages: [{ id: "wamid.TEST" }] }); },
  sendWhatsAppText: () => Promise.resolve({ messages: [{ id: "wamid.TEST" }] }),
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../utils/whatsapp" || request === "./whatsapp") return fakeWhatsApp;
  return realLoad.call(this, request, parent, isMain);
};

let logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(" ")); realLog(...a); };
const reset = () => { sentTemplates.length = 0; logs = []; };

const KiaraSafetyNet = require("../services/KiaraSafetyNetService");
const SettingsService = require("../services/SettingsService");
const Enquiry = require("../models/Enquiry");

const TAG = `kintl-${Date.now()}`;
const cleanup = [];
let seq = 0;

const seed = async (phone, tag) => {
  const l = await Enquiry.create({
    name: `${TAG}-${tag}`, phone: phone || `unset-${++seq}-${Date.now()}`,
    source: "Website", stage: "new", verified: false, isInterested: false, isLost: false,
    kiaraSafetyNetAt: null,
  });
  cleanup.push(l._id);
  const obj = l.toObject();
  // An EMPTY phone cannot be stored (the schema requires one), so the empty
  // case is exercised on the object the service actually receives.
  if (!phone) obj.phone = "";
  return obj;
};

// Did Kiara message this lead, and on what destination?
const engage = async (lead) => {
  reset();
  const result = await KiaraSafetyNet.engageLead(lead, "test");
  return { engaged: result !== false && sentTemplates.length > 0, to: (sentTemplates[0] || [])[0], logs: [...logs] };
};

(async () => {
  const realGet = SettingsService.get;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    // The safety net is dormant without a template name; give it one so the
    // guard under test is actually reached.
    SettingsService.get = async (k) => (k === "kiara.welcomeTemplateName" ? "kiara_welcome" : realGet(k));

    console.log("\n1. INTERNATIONAL LEADS ARE ENGAGED — the census countries");
    {
      const us = await engage(await seed("+14155550134", "us"));
      ok(us.engaged, "US/Canada (+1, 11 digits total) IS engaged");
      eq(us.to, "14155550134", "…on its own number, with no 91 introduced");

      const mv = await engage(await seed("+9607712345", "maldives"));
      ok(mv.engaged, "Maldives (+960, 10 digits total) IS engaged");
      eq(mv.to, "9607712345", "…on its own number");

      const ae = await engage(await seed("+971501234567", "uae"));
      ok(ae.engaged, "UAE (+971, 12 digits) is still engaged, as before");
      eq(ae.to, "971501234567", "…unchanged");

      const fr = await engage(await seed("+33612345678", "france"));
      ok(fr.engaged, "France (+33, 11 digits) IS engaged");

      const de = await engage(await seed("+4915123456789", "germany"));
      ok(de.engaged, "Germany (+49, 13 digits) is still engaged, as before");
    }

    console.log("\n2. THE DECISION IS NOT LENGTH — the case no threshold can settle");
    {
      // 960 + 7 = 10 digits. A bare Indian mobile is also 10 digits. NO length
      // rule can engage one and treat the other correctly; only the "+" can.
      const mv = await engage(await seed("+9607712399", "mv-ten"));
      const inr = await engage(await seed("9876500099", "in-bare"));
      ok(mv.engaged && inr.engaged, "a 10-digit Maldives number and a 10-digit Indian one are BOTH engaged");
      eq(mv.to, "9607712399", "…the Maldives one keeps its own country code");
      eq(inr.to, "919876500099", "…and the Indian one gets the default prepended");
      // Guard against passing vacuously: undefined !== "91…" is true but proves
      // nothing. Both must be real destinations AND differ.
      ok(!!mv.to && !!inr.to && mv.to !== inr.to,
        "…two identically-long inputs, two REAL and different destinations");
      ok(inr.logs.some((l) => l.includes("[phone] ASSUMED")),
        "…and the one that was GUESSED says so, as it always did");
    }

    console.log("\n3. STILL REFUSED, STILL WITH A REASON");
    {
      const ph = await engage(await seed("ig:17841400000001", "placeholder"));
      ok(!ph.engaged, 'an "ig:" placeholder is still refused');
      ok(ph.logs.some((l) => l.includes("SKIPPED")), "…and logs why");
      ok(ph.logs.some((l) => l.toLowerCase().includes("instagram") || l.toLowerCase().includes("placeholder")),
        "…naming it as a placeholder rather than a bad number");

      const empty = await engage(await seed("", "empty"));
      ok(!empty.engaged, "an empty phone is still refused");
      ok(empty.logs.some((l) => l.includes("SKIPPED")), "…and logs why");

      const short = await engage(await seed("12345", "short"));
      ok(!short.engaged, "a number too short to be one is still refused");
      ok(short.logs.some((l) => l.includes("SKIPPED")), "…and logs why");
      ok(short.logs.some((l) => l.includes(String(TAG).slice(0, 5)) || short.logs.some((x) => /lead=/.test(x))),
        "…with the lead id, so it can be chased");
    }

    console.log("\n4. THE ENGAGEMENT ITSELF IS UNCHANGED");
    {
      const lead = await seed("+919876500077", "in-plus");
      const r = await engage(lead);
      ok(r.engaged, "a domestic lead is engaged exactly as before");
      const after = await Enquiry.findById(lead._id).lean();
      ok(!!after.kiaraSafetyNetAt, "…the set-once marker is claimed");

      // Once per lead: a second call must not message again.
      reset();
      const second = await KiaraSafetyNet.engageLead(await Enquiry.findById(lead._id).lean(), "test");
      eq(second, false, "…and a second engage is refused by the CAS claim");
      eq(sentTemplates.length, 0, "…sending nothing the second time");
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite crashed:", e && e.stack ? e.stack : e);
    fail++;
  } finally {
    console.log = realLog;
    Module._load = realLoad;
    SettingsService.get = realGet;
    if (cleanup.length) await Enquiry.deleteMany({ _id: { $in: cleanup } });
    await Enquiry.deleteMany({ name: new RegExp(`^${TAG}`) });
    await mongoose.disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
