/* Unit test for DiscoveryService.computeDiscovery (no DB, no port).
 *
 * THE GATE, and the ONLY gate, is two things — BOTH required:
 *   1. qualificationData.eventDate     — the canonical intern-filled date
 *   2. qualificationData.servicesRequired — non-empty
 *
 * Name, city, guests, budget and eventDatePart do NOT gate. hasName is still
 * computed for display, which is why "name" never appears in discovery.missing.
 *
 * WHY THIS FILE WAS REWRITTEN (5 Sep 2026). It previously asserted the
 * PRE-SEQ-3c rule — name + (exact date AND/OR part-of-day) — which
 * DiscoveryService says in its own header that it REPLACED. Nine assertions had
 * been failing against the real service, and the script exits 1 correctly, so
 * it was not lying about it: it was simply not being run. The stale rule
 * survived long enough that a frontend adapter was built against it.
 *
 * DiscoveryService is the source of truth. If this file and the service
 * disagree, the service is right and this file is the thing to fix.
 *
 * Usage: node scripts/test-discovery-complete.js
 */
const { computeDiscovery } = require("../services/DiscoveryService");

let failures = 0;
const assert = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  — ${label}`);
  } else {
    failures++;
    console.error(`  FAIL — ${label}\n        expected ${e}\n        got      ${a}`);
  }
};

// ── The gate: date AND services ─────────────────────────────────────────────
const dateAndServices = {
  name: "Priya",
  qualificationData: { eventDate: "2026-12-20", servicesRequired: ["Decor"] },
};
const r1 = computeDiscovery(dateAndServices);
assert("date + services → discoveryComplete=true", r1.discoveryComplete, true);
assert("date + services → no missing", r1.discovery.missing, []);

// Either one alone is NOT enough — both gate.
const dateOnly = { name: "Priya", qualificationData: { eventDate: "2026-12-20" } };
const r2 = computeDiscovery(dateOnly);
assert("date without services → discoveryComplete=false", r2.discoveryComplete, false);
assert("date without services → missing=['services']", r2.discovery.missing, ["services"]);

const servicesOnly = { name: "Priya", qualificationData: { servicesRequired: ["Decor"] } };
const r3 = computeDiscovery(servicesOnly);
assert("services without date → discoveryComplete=false", r3.discoveryComplete, false);
assert("services without date → missing=['eventDate']", r3.discovery.missing, ["eventDate"]);

// ── Name does NOT gate ──────────────────────────────────────────────────────
// The pre-SEQ-3c rule required a name. It no longer does, and name is therefore
// never reported as missing — hasName survives for display only.
const noName = {
  name: "",
  qualificationData: { eventDate: "2026-12-20", servicesRequired: ["Decor"] },
};
const r4 = computeDiscovery(noName);
assert("NO name but date + services → complete (name does not gate)", r4.discoveryComplete, true);
assert("…and 'name' never appears in missing", r4.discovery.missing, []);
assert("…while hasName is still reported for display", r4.discovery.hasName, false);

// ── eventDatePart is RETIRED from the gate ──────────────────────────────────
// It used to satisfy the date requirement on its own. It must not any more.
const partOfDayOnly = {
  name: "Priya",
  qualificationData: { eventDatePart: "evening", servicesRequired: ["Decor"] },
};
const r5 = computeDiscovery(partOfDayOnly);
assert("part-of-day does NOT satisfy the date gate", r5.discoveryComplete, false);
assert("…date still counted missing", r5.discovery.missing, ["eventDate"]);

// ── AD-BAND EXCLUSION: a fuzzy month band must never satisfy the gate ───────
const adBandNoDate = {
  name: "Priya",
  additionalInfo: {
    adFormAnswers: { eventMonth: "between_3-6_months", weddingDate: "between_3-6_months", date: "beyond_6_months" },
    kiaraAnswers: { eventDate: "in 3-6 months" },
  },
  qualificationData: { servicesRequired: ["Decor"] },
};
const r6 = computeDiscovery(adBandNoDate);
assert("ad-band present but no canonical date → incomplete", r6.discoveryComplete, false);
assert("ad-band excluded → missing=['eventDate']", r6.discovery.missing, ["eventDate"]);

// ── City / guests / budget do not gate ──────────────────────────────────────
const noExtras = {
  name: "Priya",
  qualificationData: { eventDate: "2026-12-20", servicesRequired: ["Decor"] },
  additionalInfo: {},
};
assert("city/guests/budget absent → still complete", computeDiscovery(noExtras).discoveryComplete, true);

// ── Empty lead ──────────────────────────────────────────────────────────────
const r7 = computeDiscovery({});
assert("empty lead → discoveryComplete=false", r7.discoveryComplete, false);
assert("empty lead → missing=['eventDate','services']", r7.discovery.missing, ["eventDate", "services"]);
assert("empty lead → hasEventDate=false", r7.discovery.hasEventDate, false);
assert("empty lead → hasServices=false", r7.discovery.hasServices, false);
assert("empty lead → hasName=false", r7.discovery.hasName, false);
assert("date + services → hasEventDate=true", r1.discovery.hasEventDate, true);
assert("date + services → hasServices=true", r1.discovery.hasServices, true);

// ── The three-way state (additive; `complete` unchanged) ────────────────────
assert("empty lead → state=not_started", r7.discovery.state, "not_started");
assert("partially captured → state=in_progress", r2.discovery.state, "in_progress");
assert("gate met → state=complete", r1.discovery.state, "complete");
assert(
  "a logged call alone starts it",
  computeDiscovery({ qualificationData: {}, callLog: [{ at: new Date() }] }).discovery.state,
  "in_progress"
);
// A schema-default boolean must NOT read as "captured".
assert(
  "whatsappSameNumber:false does not count as started",
  computeDiscovery({ qualificationData: { whatsappSameNumber: false } }).discovery.state,
  "not_started"
);

if (failures) {
  console.error(`\n✗ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n✓ all discovery-complete assertions passed");
