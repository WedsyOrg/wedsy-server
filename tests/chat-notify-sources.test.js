/**
 * THE NEW-LEAD PING FOR EVERY SOURCE, NOT JUST AD LEADS.
 *
 * One implementation, because there is one place every intake path converges:
 * LeadIntakeService.afterCreate. (Three paths bypass it — named in the branch
 * report — and those are pre-existing bugs, not worked around here.)
 *
 * WHAT MUST DEGRADE. The sources do not carry the same fields:
 *   ad form      name, phone, source, answers
 *   WhatsApp     name + phone from the WA profile, no answers
 *   Instagram DM an instagramId and often NO PHONE — the stored "phone" is the
 *                placeholder "ig:<senderId>", which must never be shown as one
 *   website      name + phone
 * So a field that exists is shown and a field that does not is OMITTED. Never a
 * label with nothing after it.
 *
 * THE SOURCE LINE reuses the distinction already written down in
 * services/MetaConversionsService.js — bare "instagram" WITH
 * additionalInfo.instagramId is an organic DM, without it is an ad. A second
 * copy of that rule would drift from the first.
 *
 *   node tests/chat-notify-sources.test.js
 */
require("dotenv").config();

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l}${g === w ? "" : `\n      expected ${JSON.stringify(w)}\n      got      ${JSON.stringify(g)}`}`);

const chatMessages = require("../utils/chatMessages");
const { newLeadChatMessage, sourceLabel } = chatMessages;

const URL = "https://os.example/leads/L1";

// One lead per source shape, as they are ACTUALLY stored by each intake path.
const SHAPES = {
  fbAd: {
    label: "Facebook ad form",
    lead: { _id: "L1", name: "Priya & Arjun", phone: "+919876543210", source: "facebook_june_decor" },
    assignedToName: "Anita",
  },
  metaAds: {
    label: "Meta Ads (the literal source value)",
    lead: { _id: "L1", name: "Riya", phone: "919876500011", source: "Meta Ads" },
    assignedToName: "Anita",
  },
  igAd: {
    label: "Instagram AD lead (no DM fingerprint)",
    lead: { _id: "L1", name: "Sneha", phone: "+919876500012", source: "instagram", additionalInfo: { adFormAnswers: { city: "Mysore" } } },
    assignedToName: "Anita",
  },
  igDm: {
    label: "Instagram DM, NO PHONE — the placeholder shape",
    lead: { _id: "L1", name: "sneha.weds", phone: "ig:17841400000001", source: "instagram", additionalInfo: { instagramId: "17841400000001", awaitingNumber: true } },
    assignedToName: null,
  },
  whatsapp: {
    label: "WhatsApp (Kiara is already replying)",
    lead: { _id: "L1", name: "WhatsApp 3210", phone: "919876543210", source: "whatsapp" },
    assignedToName: "Ravi",
  },
  website: {
    label: "Website form",
    lead: { _id: "L1", name: "Meera", phone: "+919876500013", source: "Website" },
    assignedToName: "Anita",
  },
  signup: {
    label: "User signup",
    lead: { _id: "L1", name: "Kavya", phone: "919876500014", source: "User Signup (Account Creation)" },
    assignedToName: null,
  },
  noPhone: {
    label: "No phone at all",
    lead: { _id: "L1", name: "Unknown", phone: "", source: "Website" },
    assignedToName: null,
  },
};

const render = (k) => newLeadChatMessage({
  name: SHAPES[k].lead.name,
  phone: SHAPES[k].lead.phone,
  sourceLabel: sourceLabel(SHAPES[k].lead),
  assignedToName: SHAPES[k].assignedToName,
  leadUrl: URL,
  instagramId: SHAPES[k].lead.additionalInfo?.instagramId || null,
});

try {
  ok(typeof sourceLabel === "function", "sourceLabel is exported");

  console.log("\n1. THE SOURCE, IN HUMAN WORDS");
  {
    ok(/facebook/i.test(sourceLabel(SHAPES.fbAd.lead)), "a facebook_* campaign reads as Facebook");
    ok(!sourceLabel(SHAPES.fbAd.lead).includes("_"),
      "…without the raw campaign slug's underscores");
    ok(/meta|facebook|instagram/i.test(sourceLabel(SHAPES.metaAds.lead)), '"Meta Ads" reads as an ad source');
    ok(/whatsapp/i.test(sourceLabel(SHAPES.whatsapp.lead)), "whatsapp reads as WhatsApp");
    ok(/website/i.test(sourceLabel(SHAPES.website.lead)), "Website reads as Website");
    ok(sourceLabel(SHAPES.signup.lead).length > 0, "a signup still gets a label");
  }

  console.log("\n2. THE instagram DISTINCTION, REUSED NOT REINVENTED");
  {
    const dm = sourceLabel(SHAPES.igDm.lead);
    const ad = sourceLabel(SHAPES.igAd.lead);
    ok(/dm|message/i.test(dm), `an instagram lead WITH instagramId reads as a DM (got "${dm}")`);
    ok(/ad/i.test(ad), `an instagram lead WITHOUT it reads as an ad (got "${ad}")`);
    ok(dm !== ad, "…and the two are not the same words");

    // The rule must come from MetaConversionsService, not a private copy.
    const { metaAdOrigin } = require("../services/MetaConversionsService");
    const flipped = { ...SHAPES.igDm.lead, additionalInfo: { adFormAnswers: { city: "x" } } };
    eq(metaAdOrigin(flipped).eligible, true, "sanity: metaAdOrigin calls the flipped lead an ad");
    ok(/ad/i.test(sourceLabel(flipped)),
      "removing instagramId flips the label too — the label follows metaAdOrigin");
  }

  console.log("\n3. IT DEGRADES — NO EMPTY LABELS, NO PLACEHOLDER PHONES");
  {
    for (const k of Object.keys(SHAPES)) {
      const msg = render(k);
      const lines = msg.split("\n");
      ok(!msg.includes("ig:"), `${k}: never prints an "ig:" placeholder as a phone`);
      ok(!/\b(undefined|null|NaN)\b/.test(msg), `${k}: no undefined/null leaks into it`);
      // A label with nothing after it: a line that is only an emoji/label and
      // whitespace, or one ending in ":" or ": ".
      const empty = lines.filter((l) => /:\s*$/.test(l) || /^[^\w]*$/.test(l.trim()));
      eq(empty.length, 0, `${k}: no line carries a label with an empty value`);
      ok(lines.every((l) => l.trim().length > 0), `${k}: no blank lines`);
    }
  }

  console.log("\n4. THE FIELDS THAT EXIST ARE SHOWN; THE ONES THAT DO NOT ARE OMITTED");
  {
    const withPhone = render("fbAd");
    ok(withPhone.includes("+919876543210"), "a real phone IS shown, unmasked");

    const dm = render("igDm");
    ok(!/📞/.test(dm), "an Instagram DM lead with no real number shows NO phone line at all");
    ok(dm.includes("17841400000001"), "…but its Instagram id IS shown, since that field exists");
    ok(dm.includes("sneha.weds"), "…along with the name it does have");

    const none = render("noPhone");
    ok(!/📞/.test(none), "a lead with an empty phone shows no phone line");
    ok(none.includes("Unknown"), "…and still names the lead");
    ok(none.includes(URL), "…and still links to it");

    const wa = render("whatsapp");
    ok(wa.includes("919876543210"), "a WhatsApp lead shows its profile number");
    ok(!wa.includes("Instagram"), "…and carries no Instagram line it does not have");
  }

  console.log("\n5. OWNERSHIP READS CORRECTLY EITHER WAY");
  {
    ok(render("fbAd").includes("Anita"), "an assigned lead names the owner");
    ok(/triage|unassigned|grab/i.test(render("igDm")), "an unassigned lead says it is in triage");
  }

  // ── What a person will actually see ──────────────────────────────────────
  console.log("\n\n══════ RENDERED MESSAGES, ONE PER SOURCE ══════");
  for (const k of Object.keys(SHAPES)) {
    console.log(`\n── ${SHAPES[k].label} ──`);
    console.log(render(k).split("\n").map((l) => "   " + l).join("\n"));
  }

  console.log(`\n\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error("suite crashed:", e && e.stack ? e.stack : e);
  fail++;
}
process.exit(fail === 0 ? 0 : 1);
