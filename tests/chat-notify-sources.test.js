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
const NOW = new Date("2026-09-10T12:00:00Z");

// One lead per source shape, as they are ACTUALLY stored by each intake path.
const SHAPES = {
  fbAd: {
    label: "Facebook ad form",
    lead: {
      _id: "L1", name: "Priya & Arjun", phone: "+919876543210", source: "facebook_june_decor",
      createdAt: new Date("2026-09-10T11:58:00Z"),
      additionalInfo: { adFormAnswers: { state: "Karnataka", eventMonth: "between_3-6_months" } },
    },
    assignedToName: "Anita",
  },
  metaAds: {
    label: "Meta Ads (the literal source value)",
    lead: { _id: "L1", name: "Riya", phone: "919876500011", source: "Meta Ads", createdAt: NOW },
    assignedToName: "Anita",
  },
  igAd: {
    label: "Instagram AD lead (no DM fingerprint)",
    lead: { _id: "L1", name: "Sneha", phone: "+919876500012", source: "instagram", createdAt: NOW, additionalInfo: { adFormAnswers: { city: "Mysore" } } },
    assignedToName: "Anita",
  },
  igDm: {
    label: "Instagram DM, NO PHONE — the placeholder shape",
    lead: { _id: "L1", name: "sneha.weds", phone: "ig:17841400000001", source: "instagram", createdAt: NOW, additionalInfo: { instagramId: "17841400000001", awaitingNumber: true } },
    assignedToName: null,
  },
  whatsapp: {
    label: "WhatsApp (Kiara is already replying)",
    lead: { _id: "L1", name: "WhatsApp 3210", phone: "919876543210", source: "whatsapp", createdAt: NOW },
    assignedToName: "Ravi",
  },
  website: {
    label: "Website form",
    lead: { _id: "L1", name: "Meera", phone: "+919876500013", source: "Website", createdAt: NOW },
    assignedToName: "Anita",
  },
  signup: {
    label: "User signup",
    lead: { _id: "L1", name: "Kavya", phone: "919876500014", source: "User Signup (Account Creation)", createdAt: NOW },
    assignedToName: null,
  },
  noPhone: {
    label: "No phone at all",
    lead: { _id: "L1", name: "Unknown", phone: "", source: "Website" },
    assignedToName: null,
  },
};

const render = (k, over = {}) => newLeadChatMessage({
  lead: SHAPES[k].lead,
  assignedToName: SHAPES[k].assignedToName,
  leadUrl: URL,
  now: NOW,
  ...over,
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

  console.log("\n5. THE HEADER AND THE URGENCY SPLIT BY SOURCE");
  {
    // Ad and website leads are COLD and silent — nobody has spoken to them, so
    // the five minutes is real and the alert marker earns its place.
    for (const k of ["fbAd", "metaAds", "igAd", "website", "signup"]) {
      const m = render(k);
      ok(m.startsWith("🚨 NEW LEAD — "), `${k}: header is the 🚨 alert marker`);
      ok(m.includes("⚡ Call within 5 minutes"), `${k}: carries the ⚡ line`);
      ok(!m.includes("💬"), `${k}: and no Kiara line — nobody is talking to them`);
    }
    // WhatsApp and Instagram DM are the opposite: Kiara is ALREADY replying, so
    // "call within 5 minutes" would interrupt a conversation that is going fine
    // — and on an IG DM lead there is often no number to call at all.
    for (const k of ["whatsapp", "igDm"]) {
      const m = render(k);
      ok(m.startsWith("🔔 NEW LEAD — "), `${k}: header is the quieter 🔔`);
      ok(!m.includes("⚡"), `${k}: no ⚡ — Kiara is mid-conversation`);
      ok(m.includes("💬 Kiara is already replying"), `${k}: says so instead`);
    }
    ok(render("fbAd").startsWith("🚨 NEW LEAD — Facebook Ad"),
      "the header names the source");
    ok(render("whatsapp").startsWith("🔔 NEW LEAD — WhatsApp"), "…on both variants");
  }

  console.log("\n5b. URGENCY NEEDS A NUMBER TO DIAL, NOT JUST AN URGENT SOURCE");
  {
    // The rule was scoped to SOURCE, and that was wrong. A website lead with no
    // phone was getting 🚨 and "⚡ Call within 5 minutes" — the very objection
    // raised against Instagram DM, reappearing through a different door,
    // because the real precondition is whether there is a number to call.
    const none = render("noPhone");
    ok(!none.includes("⚡"),
      "a WEBSITE lead with no phone gets NO ⚡ — there is nothing to dial");
    ok(!none.startsWith("🚨"),
      "…and no 🚨 either: the alert marker promises an action that cannot be taken");
    ok(none.startsWith("🔔 NEW LEAD — Website"),
      "…it falls back to 🔔, still naming the source");
    ok(!none.includes("💬"),
      "…and does NOT claim Kiara is replying, which would be false for a website lead");
    ok(!/📞/.test(none), "…consistent with having no phone line at all");

    // The counterpart must be untouched: an urgent source WITH a number keeps
    // both, or this fix would have quietly removed the feature.
    const withPhone = render("website");
    ok(withPhone.startsWith("🚨") && withPhone.includes("⚡ Call within 5 minutes"),
      "a website lead WITH a phone still gets 🚨 and ⚡");

    // A placeholder is not a number, so the same rule must catch it. Built as
    // an ad lead so the source alone would otherwise say "urgent".
    const placeholderAd = newLeadChatMessage({
      lead: { _id: "L1", name: "Someone", phone: "ig:17841400000009", source: "facebook_june_decor", createdAt: NOW },
      assignedToName: "Anita", leadUrl: URL, now: NOW,
    });
    ok(!placeholderAd.includes("⚡") && !placeholderAd.startsWith("🚨"),
      'an "ig:" placeholder is not dialable either — no ⚡, no 🚨');

    // And Kiara's line is about the CONVERSATION, not the phone: an IG DM lead
    // has no number and must still say Kiara is replying.
    ok(render("igDm").includes("💬 Kiara is already replying"),
      "an Instagram DM with no phone still says Kiara is replying — that is about the conversation");
  }

  console.log("\n6. THE CONTEXT AND TIME LINES");
  {
    const ctx = render("fbAd");
    ok(ctx.includes("📍 Karnataka · Wedding in 3-6 months"),
      "📍 carries location · timeline from the form answers");
    ok(!render("whatsapp").includes("📍"),
      "a WhatsApp lead with no answers shows NO 📍 line at all");

    ok(render("fbAd", { now: new Date(SHAPES.fbAd.lead.createdAt.getTime() + 2 * 60000) }).includes("🕒 2 min ago"),
      "🕒 reads as '2 min ago'");
    ok(render("fbAd", { now: SHAPES.fbAd.lead.createdAt }).includes("🕒 just now"),
      "…and 'just now' when it has only landed");
    ok(!render("noPhone").includes("🕒"),
      "a lead with no createdAt shows no 🕒 line rather than an empty one");
  }

  console.log("\n7. OWNERSHIP READS CORRECTLY EITHER WAY");
  {
    ok(render("fbAd").includes("🙋 Anita"), "an assigned lead names the owner on the 🙋 line");
    ok(render("igDm").includes("🙋 Unassigned — sitting in triage, grab it"),
      "an unassigned lead reads as triage, in those exact words");
    ok(render("fbAd").includes("👤 Priya & Arjun"), "and 👤 is the LEAD, not the owner");
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
