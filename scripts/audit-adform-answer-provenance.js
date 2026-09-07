/* READ-ONLY census — who actually wrote additionalInfo.adFormAnswers.
 *
 * THE PROBLEM. Six frontend surfaces render adFormAnswers as "what the couple
 * answered". Two things write it:
 *
 *   controllers/webhook.js         a real ad-form submission (the couple typed it)
 *   KiaraFactExtractionService     the model's inferences from a DM thread
 *
 * Nothing records WHICH keys came from which. The only marker is
 * additionalInfo.factsExtractedAt, a bare timestamp saying "the extractor ran
 * at some point" — not what it wrote. Both writers are fill-only-empty, so a
 * lead can hold real answers and machine inferences side by side in one bucket
 * with no way to tell them apart.
 *
 * WHY (3) IS THE NUMBER THAT MATTERS. A DM lead (whatsapp / instagram) has no
 * ad form, so its adFormAnswers can ONLY be Kiara's — unambiguous, and
 * correctly labelled only by luck. A form-capable lead (website / ads) is the
 * mixed population: some keys are the couple's, some are the model's, and the
 * UI presents all of them as the couple's.
 *
 * WHAT (4) FOUND ON THE WAY. The webhook merges with
 *     if (!(k in existingAnswers)) …
 * — existing answers win. So when a real form arrives AFTER the extractor has
 * filled a key, the couple's actual answer is DISCARDED in favour of the
 * model's guess. Section 4b counts those specifically: they are not merely
 * mislabelled, they are wrong.
 *
 * WRITES NOTHING. No update, create or delete anywhere in this file. Safe
 * against production.
 *
 * Usage:  node scripts/audit-adform-answer-provenance.js
 *         node scripts/audit-adform-answer-provenance.js --list
 */
require("dotenv").config();
const mongoose = require("mongoose");

const LIST = process.argv.includes("--list");
const { ANSWER_KEYS } = require("../services/KiaraFactExtractionService");
const { sourceChannelOf } = require("../utils/leadSource");

// A DM channel has no ad form, so anything in adFormAnswers there is the
// extractor's by construction. website/ads can carry genuine form answers.
const DM_ONLY = new Set(["whatsapp", "instagram"]);
const FORM_CAPABLE = new Set(["website", "ads"]);

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "—");

(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("DATABASE_URL is not set."); process.exit(1); }
  await mongoose.connect(dbUrl, { serverSelectionTimeoutMS: 10000 });
  console.log(`[adform-provenance] ${dbUrl.replace(/\/\/[^@]*@/, "//<redacted>@").split("/").slice(0, 3).join("/")}  (READ ONLY)`);
  console.log(`ANSWER_KEYS (${ANSWER_KEYS.length}): ${ANSWER_KEYS.join(", ")}\n`);

  const Enquiry = require("../models/Enquiry");
  const LeadInternalEvent = require("../models/LeadInternalEvent");

  const leads = await Enquiry.find(
    { "additionalInfo.adFormAnswers": { $exists: true, $ne: null } },
    { source: 1, marketingSource: 1, name: 1,
      "additionalInfo.adFormAnswers": 1, "additionalInfo.factsExtractedAt": 1 }
  ).lean();

  // A lead counts only if the bucket actually holds one of the keys.
  const withAny = leads.filter((l) => {
    const a = (l.additionalInfo && l.additionalInfo.adFormAnswers) || {};
    return ANSWER_KEYS.some((k) => a[k] !== undefined && String(a[k] ?? "").trim() !== "");
  });
  const extracted = withAny.filter((l) => l.additionalInfo && l.additionalInfo.factsExtractedAt);

  console.log("1. LEADS WITH adFormAnswers");
  console.log(`   documents with the field   : ${leads.length}`);
  console.log(`   …holding at least one key  : ${withAny.length}\n`);

  console.log("2. OF THOSE, THE EXTRACTOR HAS RUN");
  console.log(`   factsExtractedAt set       : ${extracted.length}  (${pct(extracted.length, withAny.length)})`);
  console.log(`   never extracted            : ${withAny.length - extracted.length}\n`);

  console.log("3. PER-KEY, SPLIT BY WHETHER A FORM COULD HAVE WRITTEN IT");
  console.log("   Only leads where the extractor has run — elsewhere provenance is not in doubt.");
  console.log("");
  console.log("   key                 DM-only   form-capable   other    total");
  console.log("   " + "-".repeat(58));
  const tally = {};
  for (const k of ANSWER_KEYS) tally[k] = { dm: 0, form: 0, other: 0 };
  const channelOf = (l) => sourceChannelOf(l.source, l.marketingSource);
  for (const l of extracted) {
    const ch = channelOf(l);
    const bucket = DM_ONLY.has(ch) ? "dm" : FORM_CAPABLE.has(ch) ? "form" : "other";
    const a = (l.additionalInfo && l.additionalInfo.adFormAnswers) || {};
    for (const k of ANSWER_KEYS) {
      if (a[k] !== undefined && String(a[k] ?? "").trim() !== "") tally[k][bucket]++;
    }
  }
  for (const k of ANSWER_KEYS) {
    const t = tally[k];
    console.log(
      `   ${k.padEnd(18)} ${String(t.dm).padStart(7)} ${String(t.form).padStart(14)} ${String(t.other).padStart(7)} ${String(t.dm + t.form + t.other).padStart(8)}`
    );
  }
  const dmLeads = extracted.filter((l) => DM_ONLY.has(channelOf(l))).length;
  const formLeads = extracted.filter((l) => FORM_CAPABLE.has(channelOf(l))).length;
  console.log("   " + "-".repeat(58));
  console.log(`   leads:             ${String(dmLeads).padStart(7)} ${String(formLeads).padStart(14)} ${String(extracted.length - dmLeads - formLeads).padStart(7)} ${String(extracted.length).padStart(8)}`);
  console.log(`\n   DM-only leads are unambiguously the extractor's: ${dmLeads}`);
  console.log(`   FORM-CAPABLE leads are the mixed, mislabelled population: ${formLeads}\n`);

  // ── 4 · a real form arrived AFTER the extractor ──────────────────────────
  // The signal is a re_enquired event carrying adFormAnswers, recorded after
  // factsExtractedAt. adFormAnswers has no per-key timestamps, so this event —
  // written by LeadIntakeService.recordReEnquiry from the ad-form webhook — is
  // the only durable evidence that a form landed later. lead.updatedAt is not
  // usable: it moves for anything.
  const ids = extracted.map((l) => l._id);
  const events = ids.length
    ? await LeadInternalEvent.find(
        { leadId: { $in: ids }, type: "re_enquired", "payload.adFormAnswers": { $exists: true } },
        { leadId: 1, createdAt: 1, "payload.adFormAnswers": 1 }
      ).lean()
    : [];
  const byLead = new Map(extracted.map((l) => [String(l._id), l]));
  const later = [];
  let clobbered = 0;
  const clobberedKeys = {};
  for (const e of events) {
    const lead = byLead.get(String(e.leadId));
    if (!lead) continue;
    const at = lead.additionalInfo.factsExtractedAt;
    if (!(new Date(e.createdAt) > new Date(at))) continue;
    const formAnswers = (e.payload && e.payload.adFormAnswers) || {};
    const stored = (lead.additionalInfo && lead.additionalInfo.adFormAnswers) || {};
    // 4b — the form carried a key the extractor had already filled, so the
    // webhook's "existing answers win" merge DISCARDED the couple's answer.
    const dropped = Object.keys(formAnswers).filter(
      (k) => ANSWER_KEYS.includes(k) &&
             String(formAnswers[k] ?? "").trim() !== "" &&
             String(stored[k] ?? "").trim() !== "" &&
             String(stored[k]) !== String(formAnswers[k])
    );
    dropped.forEach((k) => { clobberedKeys[k] = (clobberedKeys[k] || 0) + 1; });
    if (dropped.length) clobbered++;
    later.push({ leadId: String(e.leadId), name: lead.name, at, formAt: e.createdAt, dropped });
  }

  console.log("4. A REAL FORM ARRIVED AFTER THE EXTRACTOR HAD WRITTEN");
  console.log(`   leads with a later form submission : ${later.length}`);
  console.log(`4b. …AND THE COUPLE'S ANSWER WAS DISCARDED`);
  console.log(`   leads where a real answer lost to a machine guess : ${clobbered}   ${clobbered ? "<-- these are WRONG, not merely mislabelled" : ""}`);
  if (Object.keys(clobberedKeys).length) {
    console.log("   by key:");
    Object.entries(clobberedKeys).sort((a, b) => b[1] - a[1])
      .forEach(([k, n]) => console.log(`     ${k.padEnd(18)} ${n}`));
  }
  if (LIST && later.length) {
    console.log("\n   rows:");
    later.slice(0, 50).forEach((r) =>
      console.log(`     ${r.leadId}  ${String(r.name || "").slice(0, 22).padEnd(22)}  extracted ${new Date(r.at).toISOString().slice(0, 10)}  form ${new Date(r.formAt).toISOString().slice(0, 10)}  dropped: ${r.dropped.join(", ") || "(none)"}`)
    );
    if (later.length > 50) console.log(`     … ${later.length - 50} more`);
  }

  console.log("\n" + "─".repeat(64));
  console.log(`Mixed population needing a provenance decision: ${formLeads} lead(s).`);
  console.log(`Unambiguously the extractor's (DM-only): ${dmLeads} lead(s).`);
  console.log("\nNothing was written.");
  await mongoose.disconnect();
})();
