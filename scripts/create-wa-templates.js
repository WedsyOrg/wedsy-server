#!/usr/bin/env node
/**
 * Create the WhatsApp message templates needed to migrate off the cancelled
 * AiSensy account, via the WhatsApp Business Management API.
 *
 * WHY A SCRIPT AND NOT WHATSAPP MANAGER: 22 templates by hand is 22 chances to
 * mistype a variable placeholder, and a wrong placeholder count is the #132000
 * error that took a day to find last time. This is reviewable in a diff.
 *
 *   Dry run (prints payloads, sends nothing):
 *     node scripts/create-wa-templates.js --dry-run
 *
 *   For real:
 *     node scripts/create-wa-templates.js
 *
 * Requires (already present in the EC2 .env):
 *   META_WA_WABA_ID       — 1880312775963329, the notification number's WABA
 *   META_WA_ACCESS_TOKEN  — needs whatsapp_business_management
 *
 * SAFE TO RE-RUN: existing templates are fetched first and any name already on
 * the WABA is skipped, not duplicated. Meta rejects duplicate names anyway, but
 * skipping keeps the output readable when only a few failed last time.
 */

// The credentials live in .env on EC2, exactly as server.js expects them.
// A standalone script gets no dotenv for free, so it must ask for it — without
// this, META_WA_ACCESS_TOKEN reads as undefined and the script stops.
require("dotenv").config();

const GRAPH = process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com/v19.0";
const WABA_ID = process.env.META_WA_WABA_ID;
const TOKEN = process.env.META_WA_ACCESS_TOKEN;
const DRY = process.argv.includes("--dry-run");

// Every template is UTILITY. Each is sent in direct response to something the
// recipient did (booked, bid, requested, paid) or to an event on a booking they
// already own — never promotional. Category matters: MARKETING requires opt-in,
// is rate limited per user, and carries a far higher block rate, and blocks
// lower the number's quality rating, which throttles OTPs too.
//
// `example` values are REQUIRED by Meta for any template containing {{n}}.
// They are what a reviewer sees; they are not sent to anyone.
const TEMPLATES = [
  // ── Vendor-facing ────────────────────────────────────────────────────────
  { name: "mua_account_verify_success",
    body: "Hi {{1}}, your Wedsy profile has been verified. You can now receive booking requests from customers. Log in to your dashboard to get started.",
    example: ["Glow Studio"] },

  { name: "mua_bid_req",
    body: "Hi {{1}}, you have a new bid request on Wedsy. Open your dashboard to view the requirements and submit your quote.",
    example: ["Glow Studio"] },

  { name: "mua_bid_accept",
    body: "Hi {{1}}, your bid has been accepted. The customer has confirmed and a chat is now open on your Wedsy dashboard.",
    example: ["Glow Studio"] },

  { name: "mua_bid_cnfrm",
    body: "Hi {{1}}, your booking is confirmed. The full details are on your Wedsy dashboard.",
    example: ["Glow Studio"] },

  { name: "mua_pkg_req",
    body: "Hi {{1}}, you have a new package booking request on Wedsy. Open your dashboard to review and respond.",
    example: ["Glow Studio"] },

  { name: "mua_pkg_cnfrm",
    body: "Hi {{1}}, a package booking has been confirmed. The event details are on your Wedsy dashboard.",
    example: ["Glow Studio"] },

  { name: "mua_prsnl_pkg_req",
    body: "Hi {{1}}, you have a new personal package request on Wedsy. Open your dashboard to review and respond.",
    example: ["Glow Studio"] },

  { name: "mua_prsnl_pkg_cnfrm",
    body: "Hi {{1}}, your personal package booking is confirmed. The event details are on your Wedsy dashboard.",
    example: ["Glow Studio"] },

  { name: "mua_rmnd_dminus1",
    body: "Hi {{1}}, a reminder that you have a booking tomorrow. Please check the timing and address on your Wedsy dashboard.",
    example: ["Glow Studio"] },

  { name: "mua_rmnd_d_day",
    body: "Hi {{1}}, you have a booking today. The timing and address are on your Wedsy dashboard.",
    example: ["Glow Studio"] },

  { name: "mua_settlement",
    body: "Hi {{1}}, your settlement has been processed. The breakdown is available on your Wedsy dashboard.",
    example: ["Glow Studio"] },

  { name: "eventtool_link",
    body: "Your Wedsy event planner is ready. You can open it here: {{1}}",
    example: ["https://www.wedsy.in/event/"] },

  // ── Customer-facing ──────────────────────────────────────────────────────
  { name: "cust_bidreq_send",
    body: "Hi {{1}}, your request has been sent to matching artists on Wedsy. You will be notified as quotes come in.",
    example: ["Priya"] },

  { name: "cx_bid_cnfrm",
    body: "Hi {{1}}, your booking is confirmed. You can now chat with your artist on Wedsy.",
    example: ["Priya"] },

  { name: "cx_prslpkg_req_send",
    body: "Hi {{1}}, your personal package request has been sent to the artist. You will hear back shortly.",
    example: ["Priya"] },

  { name: "cust_prslpkg_accept",
    body: "Hi {{1}}, your personal package request has been accepted. Open Wedsy to confirm and complete your booking.",
    example: ["Priya"] },

  { name: "cust_prslpkg_reject",
    body: "Hi {{1}}, unfortunately the artist is not available for your request. Open Wedsy to see other artists available on your date.",
    example: ["Priya"] },

  { name: "cx_pkg_cnfrm",
    body: "Hi {{1}}, your package booking is confirmed. All the details are on Wedsy.",
    example: ["Priya"] },

  { name: "cx_artist_detail",
    body: "Your Wedsy artist for the upcoming booking is {{1}}. You can reach them on {{2}}.",
    example: ["Glow Studio", "+91 98765 43210"] },

  { name: "cust_booking_rmnd",
    body: "Hi {{1}}, a reminder about your upcoming Wedsy booking. The timing and artist details are on your booking page.",
    example: ["Priya"] },

  { name: "event_approval_confirm",
    body: "Hi {{1}}, your event has been approved on Wedsy. You can now view and manage it from your event planner.",
    example: ["Priya"] },

  // Variable ORDER is load-bearing and comes from utils/update.js:
  //   [0] name  [1] total  [2] received  [3] due
  // Get this wrong and every send fails with #132000.
  { name: "cx_pmnt_rmnd_prsnl",
    body: "Hi {{1}}, a payment update for your Wedsy booking. Total: \u20b9{{2}}. Received: \u20b9{{3}}. Balance due: \u20b9{{4}}. Please complete the balance to confirm your booking.",
    example: ["Priya", "25000", "10000", "15000"] },
];

function payloadFor(t) {
  const component = { type: "BODY", text: t.body };
  if (t.example && t.example.length) {
    component.example = { body_text: [t.example] };
  }
  return {
    name: t.name,
    language: "en",
    category: "UTILITY",
    components: [component],
  };
}

// A body must have exactly as many {{n}} placeholders as example values, and
// they must run 1..n with no gaps. Meta rejects anything else, but it rejects
// it one template at a time and slowly — cheaper to catch it here.
function validate(t) {
  const found = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const expected = Array.from({ length: (t.example || []).length }, (_, i) => i + 1);
  const uniqueSorted = [...new Set(found)].sort((a, b) => a - b);
  if (JSON.stringify(uniqueSorted) !== JSON.stringify(expected)) {
    return `placeholders ${JSON.stringify(uniqueSorted)} do not match ${expected.length} example value(s)`;
  }
  if (/^\s|\s$/.test(t.body)) return "body has leading or trailing whitespace";
  if (t.body.length > 1024) return "body exceeds 1024 characters";
  if (!/^[a-z0-9_]+$/.test(t.name)) return "name must be lowercase letters, digits and underscores only";
  return null;
}

async function existingNames() {
  const names = new Set();
  let url = `${GRAPH}/${WABA_ID}/message_templates?fields=name,status&limit=200`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const json = await res.json();
    if (!res.ok) throw new Error(`listing templates failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    (json.data || []).forEach((t) => names.add(t.name));
    url = json.paging && json.paging.next ? json.paging.next : null;
  }
  return names;
}

async function create(t) {
  const res = await fetch(`${GRAPH}/${WABA_ID}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payloadFor(t)),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json.error || json).slice(0, 300)}`);
  return json;
}

(async () => {
  const bad = TEMPLATES.map((t) => [t.name, validate(t)]).filter(([, e]) => e);
  if (bad.length) {
    console.error("VALIDATION FAILED — nothing was sent:");
    bad.forEach(([n, e]) => console.error(`  ${n}: ${e}`));
    process.exit(1);
  }
  console.log(`${TEMPLATES.length} templates validated.\n`);

  if (DRY) {
    TEMPLATES.forEach((t) => {
      console.log(`--- ${t.name} [UTILITY, ${(t.example || []).length} var(s)] ---`);
      console.log(t.body + "\n");
    });
    console.log("Dry run. Nothing sent. Re-run without --dry-run to submit.");
    return;
  }

  if (!WABA_ID || !TOKEN) {
    console.error("META_WA_WABA_ID and META_WA_ACCESS_TOKEN must be set.");
    process.exit(1);
  }

  const already = await existingNames();
  console.log(`WABA ${WABA_ID} already has ${already.size} templates.\n`);

  let created = 0, skipped = 0, failed = 0;
  for (const t of TEMPLATES) {
    if (already.has(t.name)) {
      console.log(`SKIP    ${t.name} (already exists)`);
      skipped++;
      continue;
    }
    try {
      const r = await create(t);
      console.log(`CREATED ${t.name}  id=${r.id || "?"} status=${r.status || "PENDING"}`);
      created++;
    } catch (e) {
      console.error(`FAILED  ${t.name}: ${e.message}`);
      failed++;
    }
    // Gentle on the API; template creation is not a high-throughput endpoint.
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\ncreated ${created}, skipped ${skipped}, failed ${failed}`);
  console.log("Approvals arrive on the message_template_status_update webhook, already subscribed.");
})().catch((e) => {
  console.error("fatal:", e.message);
  process.exit(1);
});
