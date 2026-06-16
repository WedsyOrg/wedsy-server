/* SEQ-1 — unit test for DiscoveryService.computeDiscovery (no DB, no port).
 *
 * discoveryComplete = eventDate AND city AND guests AND services present.
 * Budget is NOT a factor.
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

// All four core facts present (via Kiara answers + structured services) → complete.
// Budget deliberately absent.
const allFour = {
  qualificationData: { servicesRequired: ["Decor"] },
  additionalInfo: { kiaraAnswers: { eventDate: "2026-12-12", city: "Goa", guests: "300" } },
};
const r1 = computeDiscovery(allFour);
assert("all four core fields → discoveryComplete=true", r1.discoveryComplete, true);
assert("all four → no missing", r1.discovery.missing, []);

// Budget missing but four core present → still complete (budget not required).
const noBudget = {
  qualificationData: { servicesRequired: ["Makeup"], budgetAmount: null, budgetNote: "" },
  additionalInfo: { kiaraAnswers: { eventDate: "2026-11-01", city: "Jaipur", guests: "150" } },
};
assert("budget missing, four core present → still complete", computeDiscovery(noBudget).discoveryComplete, true);

// Missing guests → incomplete, missing lists guests.
const noGuests = {
  qualificationData: { servicesRequired: ["Decor"] },
  additionalInfo: { kiaraAnswers: { eventDate: "2026-12-12", city: "Goa" } },
};
const r3 = computeDiscovery(noGuests);
assert("missing guests → discoveryComplete=false", r3.discoveryComplete, false);
assert("missing guests → missing=['guests']", r3.discovery.missing, ["guests"]);

// City resolved via the structured qualificationData.venueArea path.
const cityViaVenueArea = {
  qualificationData: { venueArea: "Udaipur", servicesRequired: ["Photography"] },
  additionalInfo: { kiaraAnswers: { eventDate: "2027-02-02", guests: "200" } },
};
assert("city via qualificationData.venueArea → complete", computeDiscovery(cityViaVenueArea).discoveryComplete, true);

// Empty lead → all four missing, incomplete.
const empty = {};
const r5 = computeDiscovery(empty);
assert("empty lead → discoveryComplete=false", r5.discoveryComplete, false);
assert("empty lead → all four missing", r5.discovery.missing, ["eventDate", "city", "guests", "services"]);

// Component booleans exposed.
assert("empty lead → hasEventDate=false", r5.discovery.hasEventDate, false);
assert("all four → hasServices=true", r1.discovery.hasServices, true);

if (failures) {
  console.error(`\n✗ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n✓ all discovery-complete assertions passed");
