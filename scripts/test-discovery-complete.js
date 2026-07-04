/* SEQ-1 / SEQ-3c — unit test for DiscoveryService.computeDiscovery (no DB, no port).
 *
 * SEQ-3c gate: discoveryComplete = hasName && hasEventDate, where
 *   - hasName     = Enquiry.name OR qualificationData.groomName/brideName, and
 *   - hasEventDate = the INTERN-FILLED discovery date only — an exact date
 *     (qualificationData.eventDate) AND/OR a part-of-day (eventDatePart).
 * City / guests / services / budget are optional and DO NOT gate. The ad-form /
 * Kiara month BAND must NOT satisfy hasEventDate.
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

// name + exact date → complete.
const nameAndExact = { name: "Priya", qualificationData: { eventDate: "2026-12-20" } };
const r1 = computeDiscovery(nameAndExact);
assert("name + exact date → discoveryComplete=true", r1.discoveryComplete, true);
assert("name + exact date → no missing", r1.discovery.missing, []);

// name + part-of-day only (no exact date) → complete.
const nameAndPart = { name: "Priya", qualificationData: { eventDatePart: "evening" } };
assert("name + part-of-day only → discoveryComplete=true", computeDiscovery(nameAndPart).discoveryComplete, true);

// name via groom/bride (no enquiry name) + date → complete.
const coupleName = { name: "", qualificationData: { groomName: "Arjun", eventDate: "2027-01-10" } };
assert("groom name + date (no enquiry name) → complete", computeDiscovery(coupleName).discoveryComplete, true);

// name only, no date → incomplete, missing=['eventDate'].
const nameOnly = { name: "Priya", qualificationData: {} };
const r4 = computeDiscovery(nameOnly);
assert("name only → discoveryComplete=false", r4.discoveryComplete, false);
assert("name only → missing=['eventDate']", r4.discovery.missing, ["eventDate"]);

// date only, no name → incomplete, missing=['name'].
const dateOnly = { name: "", qualificationData: { eventDate: "2026-12-20" } };
const r5 = computeDiscovery(dateOnly);
assert("date only (no name) → discoveryComplete=false", r5.discoveryComplete, false);
assert("date only → missing=['name']", r5.discovery.missing, ["name"]);

// AD-BAND EXCLUSION: name present + ad-form/Kiara month band but NO intern date → incomplete.
const adBandNoDate = {
  name: "Priya",
  additionalInfo: {
    adFormAnswers: { eventMonth: "between_3-6_months", weddingDate: "between_3-6_months", date: "beyond_6_months" },
    kiaraAnswers: { eventDate: "in 3-6 months" },
  },
  qualificationData: {},
};
const r6 = computeDiscovery(adBandNoDate);
assert("ad-band present but no intern date → discoveryComplete=false", r6.discoveryComplete, false);
assert("ad-band excluded → missing=['eventDate']", r6.discovery.missing, ["eventDate"]);

// City/guests/services absent but name + intern date present → complete (they don't gate).
const noExtras = {
  name: "Priya",
  qualificationData: { eventDate: "2026-12-20", eventDatePart: "morning" },
  additionalInfo: {},
};
assert("city/guests/services absent, name+date present → complete", computeDiscovery(noExtras).discoveryComplete, true);

// Empty lead → both missing.
const empty = {};
const r8 = computeDiscovery(empty);
assert("empty lead → discoveryComplete=false", r8.discoveryComplete, false);
assert("empty lead → missing=['name','eventDate']", r8.discovery.missing, ["name", "eventDate"]);

// Component booleans exposed (new shape: hasName / hasEventDate).
assert("empty lead → hasName=false", r8.discovery.hasName, false);
assert("empty lead → hasEventDate=false", r8.discovery.hasEventDate, false);
assert("name+date → hasEventDate=true", r1.discovery.hasEventDate, true);

if (failures) {
  console.error(`\n✗ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n✓ all discovery-complete assertions passed");
