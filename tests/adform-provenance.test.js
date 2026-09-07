/**
 * A FORM SUBMISSION IS AUTHORITATIVE FOR ITS OWN KEYS,
 * AND THE EXTRACTOR RECORDS WHAT IT WROTE.
 *
 * Two writers share additionalInfo.adFormAnswers: the ad-form webhook (the
 * couple typed it) and KiaraFactExtractionService (the model inferred it).
 *
 * 1. THE MERGE. controllers/webhook.js merged with `if (!(k in existingAnswers))`
 *    — existing answers win — so a real form answer arriving after the extractor
 *    had filled that key was DISCARDED in favour of the model's guess. The
 *    production census found 4b = 0: reachable, never yet exercised. Inverted
 *    for the keys the form actually carries. adFormAnswers is the raw-answers
 *    bucket, not the edited brief, so no human edit is at risk.
 *
 * 2. PROVENANCE. The extractor stamped factsExtractedAt — "it ran" — but never
 *    which keys it wrote, so nothing could tell a machine inference from a real
 *    answer. It now records the keys it actually merged in: only those, never
 *    the ones that were already there.
 *
 * Additive. No migration, no backfill — 28 leads is not worth one.
 *
 *   node tests/adform-provenance.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const express = require("express");
const bp = require("body-parser");

const Enquiry = require("../models/Enquiry");

const TAG = `prov-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l} (got ${JSON.stringify(g)})`);
const cleanup = [];
let seq = 0;
const nextPhone = () => `98${String(Date.now()).slice(-6)}${String(++seq).padStart(2, "0")}`;

(async () => {
  let srv;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const app = express();
    app.use(bp.json());
    app.use("/", require("../routes/router"));
    srv = app.listen(0);
    const base = `http://127.0.0.1:${srv.address().port}`;

    const seedLead = async (phone, answers, extra = {}) => {
      const l = await Enquiry.create({
        name: `${TAG}-lead`, phone, source: "facebook", stage: "new",
        verified: false, isInterested: false, isLost: false,
        additionalInfo: { adFormAnswers: answers, factsExtractedAt: new Date(Date.now() - 864e5), ...extra },
      });
      cleanup.push(l._id);
      return l;
    };
    // The real contract: POST /webhook/ad-leads, name+phone required, shared
    // secret when configured. `source` is omitted so it does not land in
    // adFormAnswers as an answer key of its own.
    const postForm = (phone, body) => fetch(`${base}/webhook/ad-leads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.AD_LEADS_INTAKE_SECRET
          ? { "x-wedsy-intake-key": process.env.AD_LEADS_INTAKE_SECRET }
          : {}),
      },
      body: JSON.stringify({ name: `${TAG}-lead`, phone, ...body }),
    });

    console.log("\n1. A LATER FORM ANSWER WINS — the exact production case");
    {
      const phone = nextPhone();
      // The extractor guessed Mysore yesterday.
      const lead = await seedLead(phone, { city: "Mysore", budget: "3L" });
      // The couple then filled a form saying Bengaluru.
      const res = await postForm(phone, { city: "Bengaluru", guests: "400" });
      eq(res.status, 201, "the webhook still answers 201 (contract unchanged)");
      const after = await Enquiry.findById(lead._id).lean();
      const a = after.additionalInfo.adFormAnswers || {};
      eq(a.city, "Bengaluru", "the COUPLE'S answer wins over the model's guess");
      eq(a.guests, "400", "a key the form newly carries is still added");
      eq(a.budget, "3L", "a key the form did NOT carry is left alone");
    }
    {
      // The form must not blank a key by carrying an empty value for it.
      const phone = nextPhone();
      const lead = await seedLead(phone, { city: "Mysore" });
      await postForm(phone, { city: "" });
      const after = await Enquiry.findById(lead._id).lean();
      eq((after.additionalInfo.adFormAnswers || {}).city, "Mysore",
        "an EMPTY form value does not erase an existing answer");
    }

    console.log("\n2. THE EXTRACTOR RECORDS WHICH KEYS IT WROTE");
    {
      const KiaraFactExtractionService = require("../services/KiaraFactExtractionService");
      const { ANSWER_KEYS } = KiaraFactExtractionService;
      ok(Array.isArray(ANSWER_KEYS) && ANSWER_KEYS.length === 11,
        `ANSWER_KEYS is the 11 documented keys (got ${ANSWER_KEYS.length})`);

      // Drive the merge decision directly: a lead already holding city, with the
      // model returning city + eventType + budget. Only the two NEW keys are the
      // extractor's; city was already there and must not be claimed.
      const { mergeExtractedFacts } = KiaraFactExtractionService;
      ok(typeof mergeExtractedFacts === "function",
        "the merge is exposed as a pure function, so provenance is testable without the model");

      const existing = { city: "Mysore" };
      const facts = { city: "Bengaluru", eventType: "wedding", budget: "5L", summary: "x" };
      const { merged, writtenKeys } = mergeExtractedFacts(existing, facts);

      eq(merged.city, "Mysore", "fill-only-empty is unchanged: the extractor does NOT overwrite");
      eq(merged.eventType, "wedding", "…and does fill an empty key");
      eq(JSON.stringify([...writtenKeys].sort()), JSON.stringify(["budget", "eventType"]),
        "writtenKeys is EXACTLY what it merged in");
      ok(!writtenKeys.includes("city"), "…and never claims a key that was already there");
      ok(!writtenKeys.includes("summary"), "…nor a non-ANSWER_KEY field");
    }
    {
      const { mergeExtractedFacts } = require("../services/KiaraFactExtractionService");
      const { writtenKeys } = mergeExtractedFacts({ city: "X" }, { city: "Y" });
      eq(JSON.stringify(writtenKeys), "[]", "a run that merges nothing claims nothing");
      const blank = mergeExtractedFacts({}, { eventType: "   " });
      eq(JSON.stringify(blank.writtenKeys), "[]", "a whitespace-only value is not a written key");
    }

    console.log("\n3. THE RECORD LANDS ON THE LEAD");
    {
      const lead = await seedLead(nextPhone(), { city: "Mysore" }, { factsExtractedKeys: ["budget", "eventType"] });
      const after = await Enquiry.findById(lead._id).lean();
      eq(JSON.stringify(after.additionalInfo.factsExtractedKeys), JSON.stringify(["budget", "eventType"]),
        "additionalInfo.factsExtractedKeys persists");
      ok(after.additionalInfo.factsExtractedAt, "…alongside the existing factsExtractedAt, which is unchanged");
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite crashed:", e.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await Enquiry.deleteMany({ _id: { $in: cleanup } });
    await Enquiry.deleteMany({ name: new RegExp(`^${TAG}`) });
    await mongoose.disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
