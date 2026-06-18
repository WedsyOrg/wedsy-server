/**
 * scripts/e2e-onboarding-alert.js — deterministic checks for the onboarding
 * ops alert (utils/venueOpsAlert). No server, no DB, no network: exercises
 * the module directly with env permutations and a captured console.
 *
 * Usage: node scripts/e2e-onboarding-alert.js
 */
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`✓ PASS  ${name}`);
  } else {
    fail++;
    console.log(`✗ FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function withCapturedLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  return Promise.resolve()
    .then(fn)
    .then((r) => {
      console.log = orig;
      return { result: r, lines };
    })
    .catch((e) => {
      console.log = orig;
      throw e;
    });
}

async function run() {
  const { notifyOnboardingRequest, formatOnboardingAlert } = require("../utils/venueOpsAlert");
  const REQUEST = { name: "Rohaan", venueName: "Crown Estate", city: "Bangalore", phone: "+91 98765 43210" };

  // 1. Message format is exactly what ops expects.
  const msg = formatOnboardingAlert(REQUEST);
  check(
    "alert message format (venue, contact, city)",
    msg.includes("New venue onboarding request") &&
      msg.includes("Venue: Crown Estate") &&
      msg.includes("Contact: Rohaan · +91 98765 43210") &&
      msg.includes("City: Bangalore"),
    JSON.stringify(msg)
  );

  // 2. No OPS_ALERT_PHONE -> complete no-op (nothing logged, nothing sent).
  delete process.env.OPS_ALERT_PHONE;
  process.env.REMINDERS_LOG_ONLY = "true";
  {
    const { result, lines } = await withCapturedLog(() => notifyOnboardingRequest(REQUEST));
    check("no OPS_ALERT_PHONE -> skipped silently", result.skipped === "no OPS_ALERT_PHONE" && lines.length === 0, JSON.stringify({ result, lines }));
  }

  // 3. Log-only (prod default): composes + logs the formatted message, no send.
  process.env.OPS_ALERT_PHONE = "916364014464";
  process.env.REMINDERS_LOG_ONLY = "true";
  {
    const { result, lines } = await withCapturedLog(() => notifyOnboardingRequest(REQUEST));
    const joined = lines.join("\n");
    check(
      "log-only path logs the formatted message to the ops phone",
      result.logged === true && joined.includes("[opsAlert][log-only] to=916364014464") && joined.includes("Venue: Crown Estate"),
      JSON.stringify(lines)
    );
  }

  // 4. Send mode WITHOUT creds: gated by isConfigured(), still no throw.
  process.env.REMINDERS_LOG_ONLY = "false";
  process.env.WHATSAPP_CLOUD_TOKEN = "";
  process.env.META_WA_ACCESS_TOKEN = "";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "";
  process.env.META_WA_PHONE_NUMBER_ID = "";
  {
    const { result, lines } = await withCapturedLog(() => notifyOnboardingRequest(REQUEST));
    check(
      "send mode without creds -> skipped via isConfigured, never throws",
      result.skipped === "whatsapp unconfigured" && lines.join("\n").includes("not configured"),
      JSON.stringify({ result, lines })
    );
  }

  console.log(`\n[e2e-onboarding-alert] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
