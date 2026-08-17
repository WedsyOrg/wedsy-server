// Document dates must be identical on every runtime.
// Run: node tests/document-date.test.js
//
// WHY THIS EXISTS: the T&C cover page shipped in #130 rendered
// "Thursday 26 November, 2026" on prod (Node 18 / ICU 74.2) and
// "Thursday, 26 November 2026" in dev (Node 20 / ICU 78.2), because
// toLocaleDateString composes its output from the CLDR data bundled with the
// Node build. Couples received the first; nobody could see it locally.
//
// The interesting part is what did NOT diverge: at those two ICU versions the
// plain day/month/year shapes agreed, so five of the six document date formats
// looked fine by luck. This suite pins the composition itself, so a future ICU
// bump cannot move any of them.
//
// The strongest assertion here is the last section: it greps the document
// renderers for toLocaleDateString and fails if one comes back. A unit test on
// the helper cannot catch a new call site that bypasses it.
const fs = require("fs");
const path = require("path");

const dd = require("../utils/documentDate");
const cover = require("../utils/venueTermsCover");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} → ${JSON.stringify(got)}${got === want ? "" : ` (wanted ${JSON.stringify(want)})`}`);

// A Thursday, chosen because the weekday is what ICU disagreed about.
const D = "2026-11-26T00:00:00Z";

console.log("\n[A. the exact strings, composed by us]");
eq(dd.docDayWithWeekday(D), "Thursday, 26 November 2026", "docDayWithWeekday");
eq(dd.docDay(D), "26 November 2026", "docDay");
eq(dd.docDayShort(D), "26 Nov 2026", "docDayShort");
eq(dd.docDayFromKey("2026-11-26"), "26 November 2026", "docDayFromKey");
eq(dd.docDayFromKey("2026-11-26", { month: "short" }), "26 Nov 2026", "docDayFromKey short");
eq(dd.docDayFromKey("2026-11-26", { weekday: true }), "Thursday, 26 November 2026", "docDayFromKey weekday");
// The comma placement IS the bug. Pinned literally.
ok(dd.docDayWithWeekday(D).startsWith("Thursday, "), "the comma sits after the weekday, not after the month");
ok(!/November,/.test(dd.docDayWithWeekday(D)), "…and never after the month (the ICU 74 form)");

console.log("\n[B. the cover page helpers, which is where it shipped]");
eq(cover.longDate(D), "Thursday, 26 November 2026", "cover longDate");
eq(cover.plainDate(D), "26 November 2026", "cover plainDate");
eq(
  cover.issueSentence({ coupleName: "Priya & Arjun" }, [new Date(D)]),
  "These terms are issued for Priya & Arjun for their event on 26 November 2026.",
  "the issue sentence"
);

console.log("\n[C. no Intl anywhere in the output path]");
// Monkey-patching Intl proves the helpers never reach it. If any of them did,
// they would throw or return the sabotaged marker.
const realIntl = global.Intl;
const realToLocaleDateString = Date.prototype.toLocaleDateString;
let intlTouched = 0;
Date.prototype.toLocaleDateString = function sabotaged() { intlTouched++; return "ICU-WAS-USED"; };
try {
  const outs = [
    dd.docDayWithWeekday(D), dd.docDay(D), dd.docDayShort(D),
    dd.docDayFromKey("2026-11-26"), cover.longDate(D), cover.plainDate(D),
  ];
  ok(intlTouched === 0, `toLocaleDateString was never called (${intlTouched} calls)`);
  ok(!outs.some((o) => o.includes("ICU-WAS-USED")), "…and no output came from it");
  eq(dd.docDayWithWeekday(D), "Thursday, 26 November 2026", "still correct with toLocaleDateString sabotaged");
} finally {
  Date.prototype.toLocaleDateString = realToLocaleDateString;
  global.Intl = realIntl;
}

console.log("\n[D. absent and malformed dates render as nothing, never junk]");
for (const bad of [undefined, null, "", "not a date", NaN, {}]) {
  const got = dd.docDay(bad);
  ok(got === "", `docDay(${JSON.stringify(bad) || String(bad)}) → "" (got ${JSON.stringify(got)})`);
}
eq(dd.docDayFromKey("nonsense"), "", "docDayFromKey on nonsense");
eq(dd.docDayFromKey("2026-13-45"), "", "docDayFromKey rejects an impossible month");
eq(dd.docDay(undefined, "TBD"), "TBD", "an explicit fallback is honoured");
// These two are what the legacy invoice used to print at a customer.
ok(dd.docInstantDayShort(undefined) !== "Invalid Date", 'never the literal "Invalid Date"');
ok(dd.docInstantDayShort(null) !== "1 Jan 1970", 'and never "1 Jan 1970" for a null');

console.log("\n[E. day keys are labels, instants are moments]");
// A label must not be shifted by a zone — that would move the wedding.
eq(dd.docDayFromKey("2026-11-26"), "26 November 2026", "a label resolves to its own day");
eq(dd.docDay("2026-11-26T00:00:00Z"), "26 November 2026", "a midnight-UTC label stays on its day");
// 2026-11-26T20:30Z is already the 27th in Asia/Kolkata (UTC+5:30).
eq(dd.docInstantDay("2026-11-26T20:30:00Z"), "27 November 2026", "an instant past 18:30 UTC is the NEXT venue day");
eq(dd.docInstantDay("2026-11-26T18:29:00Z"), "26 November 2026", "…and just before that it is still the same day");
// The old code read the SERVER's zone here, so this was environment-dependent.
ok(dd.docInstantDay("2026-11-26T20:30:00Z") === "27 November 2026", "venue zone is used, not the process TZ");

console.log("\n[F. every month and weekday name is present and correctly ordered]");
ok(dd.MONTHS_LONG.length === 12 && dd.MONTHS_SHORT.length === 12, "12 months in both tables");
ok(dd.WEEKDAYS_LONG.length === 7 && dd.WEEKDAYS_SHORT.length === 7, "7 weekdays in both tables");
// Walk a full year: every month renders its own name, and the weekday matches
// what date arithmetic says it should be.
let monthsOk = true, weekdaysOk = true;
for (let m = 1; m <= 12; m++) {
  const key = `2026-${String(m).padStart(2, "0")}-15`;
  if (!dd.docDayFromKey(key).includes(dd.MONTHS_LONG[m - 1])) monthsOk = false;
  const expected = dd.WEEKDAYS_LONG[new Date(Date.UTC(2026, m - 1, 15)).getUTCDay()];
  if (!dd.docDayFromKey(key, { weekday: true }).startsWith(`${expected}, `)) weekdaysOk = false;
}
ok(monthsOk, "all 12 months render their own name");
ok(weekdaysOk, "all 12 sampled weekdays match date arithmetic");
// A leap day, because February is where off-by-one tables show up.
eq(dd.docDayFromKey("2028-02-29", { weekday: true }), "Tuesday, 29 February 2028", "29 February 2028 is a Tuesday");

console.log("\n[G. no document renderer reaches toLocaleDateString again]");
// The regression guard that matters: a new call site cannot slip in.
const DOC_RENDERERS = [
  "utils/venueTermsCover.js",
  "utils/venuePdf.js",
  "utils/invoice.js",
  "services/BillingDocService.js",
];
for (const rel of DOC_RENDERERS) {
  const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  // Strip comments so the explanatory prose above each fix does not trip this.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const hits = (code.match(/toLocaleDateString|toLocaleTimeString|Intl\.DateTimeFormat/g) || []).length;
  ok(hits === 0, `${rel} has no locale date formatting in code (${hits} found)`);
}

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
