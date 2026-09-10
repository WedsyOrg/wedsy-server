// COUPLE APP — THE BUDGET ESTIMATOR (§ 3.2.3).
// Run: node tests/couple-budget-estimate.test.js
// PURE unit tests (NO DATABASE).
//
// The two assertions that matter most are not about arithmetic:
//
//   · THE CATERING LINE READS THE SERVER'S HEADCOUNT (§ 06.3 invariant 1,
//     "computed server-side… consumed by Budget catering… never recomputed
//     client-side"). A `headcount` in the request body must reach no variable.
//   · DAYS ARE DISTINCT DATES OFF THE EVENT (§ 06.3 "Events: defined once").
//     A wedding and a reception on one date is ONE day of venue rental, and a
//     function this wedding does not have cannot buy a day of catering.
//
// The bands are also asserted figure-for-figure against the client's own
// (wedsy-user/lib/plan/seed/budget.js): the screen's whole claim is that the
// number is honest, and a rate that differs by a rupee is a screen and a server
// telling one couple two things.
const budget = require("../services/CoupleBudgetRules");
const headcountService = require("../services/CoupleHeadcountService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

const DAYS = [
  { id: "d1", key: "haldi", name: "Haldi", date: "2026-12-12" },
  { id: "d2", key: "sangeet", name: "Sangeet", date: "2026-12-13" },
  { id: "d3", key: "wedding", name: "Wedding", date: "2026-12-14" },
  { id: "d4", key: "reception", name: "Reception", date: "2026-12-14" }, // SAME DATE as the wedding
];

const ANSWERS = { venue: "banquet", decor: "signature", catering: "gold", rooms: 35, services: ["photo", "makeup", "invites"] };

console.log("The bands are the client's, verbatim (wedsy-user/lib/plan/seed/budget.js):");
{
  const rate = (list, id) => (list.find((row) => row.id === id) || {}).rate;
  eq(rate(budget.VENUE_TYPES, "lawn"), 65000, "lawn");
  eq(rate(budget.VENUE_TYPES, "banquet"), 120000, "banquet hall");
  eq(rate(budget.VENUE_TYPES, "convention"), 165000, "convention centre");
  eq(rate(budget.VENUE_TYPES, "resort"), 240000, "resort or palace");
  eq(rate(budget.DECOR_TIERS, "essential"), 95000, "décor · essential");
  eq(rate(budget.DECOR_TIERS, "signature"), 156000, "décor · signature");
  eq(rate(budget.DECOR_TIERS, "royal"), 280000, "décor · royal");
  eq(rate(budget.CATERING_BANDS, "silver"), 900, "catering · silver, per plate");
  eq(rate(budget.CATERING_BANDS, "gold"), 1400, "catering · gold, per plate");
  eq(rate(budget.CATERING_BANDS, "platinum"), 2200, "catering · platinum, per plate");
  eq(rate(budget.SERVICES, "photo"), 165000, "photo and video");
  eq(rate(budget.SERVICES, "invites"), 130, "invites, per guest");
  eq(rate(budget.SERVICES, "hospitality"), 260, "hospitality, per guest");
  eq(budget.ROOM_NIGHT_RATE, 3800, "a room a night in the December season");
  eq(budget.CATEGORIES.map((category) => category.id).join(","), "venue,catering,decor,stay,services", "and the five categories, in order");
}

console.log("DAYS are distinct DATES, not functions (§ 06.3 'Events'):");
{
  const built = budget.buildEstimate({ answers: ANSWERS, headcount: 200, days: DAYS });
  eq(built.days, 3, "four functions on three dates is THREE days of venue rental");
  eq(built.categories.find((c) => c.id === "venue").amount, 360000, "₹1,20,000 × 3 days");
  eq(built.categories.find((c) => c.id === "decor").amount, 624000, "…while décor is per FUNCTION: ₹1,56,000 × 4");
  eq(built.categories.find((c) => c.id === "stay").amount, 35 * 3800 * 3, "and stay is rooms × nights × DAYS");
}

console.log("The décor tier and the décor journey agree (§ 3.2.2's ₹6.24L):");
{
  const built = budget.buildEstimate({ answers: ANSWERS, headcount: 200, days: DAYS });
  eq(
    built.categories.find((c) => c.id === "decor").amount,
    624000,
    "the middle tier across four functions is the same ₹6.24L the décor journey quotes"
  );
}

console.log("CATERING READS THE SERVER'S HEADCOUNT, and only that:");
{
  const guests = [
    { party: 4, rsvp: "yes", events: ["wedding"] },
    { party: 2, rsvp: "pending", events: ["wedding"] },
    { party: 6, rsvp: "no", events: ["wedding"] },      // said no — never catered for
    { rsvp: "pending", events: ["wedding"] },            // no party ⇒ 1
  ];
  const server = headcountService.tally(guests).headcount;
  eq(server, 7, "the invariant's own tally: 4 + 2 + 1, and the 'no' subtracts nothing");

  const built = budget.buildEstimate({ answers: ANSWERS, headcount: server, days: DAYS });
  eq(built.seats, 7, "the estimate seats exactly that many");
  eq(built.categories.find((c) => c.id === "catering").amount, 1400 * 7 * 4, "₹1,400 a plate × 7 seats × 4 functions");
  eq(built.cateringLines.length, 4, "one catering line per function");
  ok(built.cateringLines.every((line) => line.seats === 7), "and every one of them counts the same seven people");
}

console.log("A `headcount` in the BODY reaches no variable:");
{
  const hostile = { ...ANSWERS, headcount: 9999, seats: 9999, estimate: 1, total: 1, days: 1 };
  const honest = budget.buildEstimate({ answers: ANSWERS, headcount: 200, days: DAYS });
  const attacked = budget.buildEstimate({ answers: hostile, headcount: 200, days: DAYS });
  eq(attacked.total, honest.total, "the total is identical with and without the hostile keys");
  eq(attacked.seats, 200, "the seats are the server's argument, not the body's 9,999");
  eq(attacked.days, 3, "and the days are the Event's three, not the body's 1");

  const stored = budget.estimateAnswers(hostile);
  ok(!("headcount" in stored), "and `headcount` is not even STORED — the whitelist has no key for it");
  ok(!("estimate" in stored), "nor `estimate`");
  ok(!("total" in stored), "nor `total`");
  ok(!("seats" in stored), "nor `seats`");
  ok(!("days" in stored), "nor `days`");
  eq(
    Object.keys(stored).sort().join(","),
    "catering,decor,rooms,services,venue",
    "exactly the five keys the arithmetic reads, and nothing else"
  );
}

console.log("Per-guest services multiply by the SAME seven, and flat ones do not:");
{
  const built = budget.buildEstimate({
    answers: { ...ANSWERS, services: ["photo", "invites", "hospitality"] },
    headcount: 7,
    days: DAYS,
  });
  const line = (id) => built.serviceLines.find((row) => row.id === id);
  eq(line("photo").amount, 165000, "photo and video is a flat fee");
  eq(line("invites").amount, 130 * 7, "invites are per guest");
  eq(line("hospitality").amount, 260 * 7, "so is hospitality");
  eq(built.categories.find((c) => c.id === "services").amount, 165000 + 910 + 1820, "and services is their sum");
}

console.log("Only the wedding's OWN functions can be chosen (§ 06.3 'Events'):");
{
  const narrowed = budget.buildEstimate({
    answers: { ...ANSWERS, events: ["wedding", "reception"] },
    headcount: 100,
    days: DAYS,
  });
  eq(narrowed.functions.length, 2, "two functions when two were ticked");
  eq(narrowed.days, 1, "and they share a date, so ONE day of rental");

  const invented = budget.buildEstimate({
    answers: { ...ANSWERS, events: ["mehndi"] },     // this wedding has no mehndi
    headcount: 100,
    days: DAYS,
  });
  eq(invented.functions.length, 4, "a function this wedding does not have narrows to nothing, so every day is counted");
  eq(
    budget.buildEstimate({ answers: { ...ANSWERS, events: [] }, headcount: 100, days: DAYS }).functions.length,
    4,
    "…and an empty selection means every function, never an estimate of ₹0"
  );
}

console.log("Both answer shapes work — the wizard's map and the request's list:");
{
  const asList = budget.buildEstimate({ answers: { ...ANSWERS, events: ["haldi", "wedding"] }, headcount: 50, days: DAYS });
  const asMap = budget.buildEstimate({
    answers: { ...ANSWERS, functions: { sangeet: false, reception: false } },
    headcount: 50,
    days: DAYS,
  });
  eq(asList.total, asMap.total, "a list of what is IN and a map of what is OUT reach the same number");
}

console.log("A wedding with nobody on the guest list yet:");
{
  const built = budget.buildEstimate({ answers: ANSWERS, headcount: 0, days: DAYS });
  eq(built.categories.find((c) => c.id === "catering").amount, 0, "nothing to cater for");
  ok(built.total > 0, "but the venue, décor and stay still give them a real number to read");
}

console.log("Defaults and fallbacks never throw:");
{
  const bare = budget.buildEstimate({});
  const nulls = budget.buildEstimate({ answers: null, headcount: null, days: null });
  eq(bare.days, 0, "no days, no headcount, no answers does not crash — it is zero DAYS");
  eq(bare.categories.find((c) => c.id === "venue").amount, 0, "so no venue rental");
  eq(bare.categories.find((c) => c.id === "catering").amount, 0, "no catering");
  eq(bare.categories.find((c) => c.id === "decor").amount, 0, "and no décor");
  eq(
    bare.categories.find((c) => c.id === "services").amount,
    260000,
    "the DEFAULT services still price, because photo and makeup are not bought by the function — this is the pencilled-in number § 3.2.3 wants on screen from the first paint, not a zero"
  );
  eq(nulls.total, bare.total, "nulls reach the same place as nothing at all");
  eq(
    budget.buildEstimate({ answers: { venue: "spaceship" }, headcount: 10, days: DAYS }).venueType.id,
    "banquet",
    "an unknown band falls back to the default rather than to zero"
  );
  eq(budget.roomsFor({ rooms: -5 }), 35, "a negative room count falls back to the default band");
  eq(budget.roomsFor({ roomBand: "none" }), 0, "and 'everyone is local' really is zero");
  eq(budget.roomsFor({ rooms: 0 }), 0, "an explicit zero is respected");
}

console.log("The target is the one figure a request may set:");
{
  eq(budget.targetFrom({ target: 1840000 }), 1840000, "a real number");
  eq(budget.targetFrom({ target: "1840000.4" }), 1840000, "rounded to whole rupees");
  eq(budget.targetFrom({ target: -1 }), null, "never negative");
  eq(budget.targetFrom({ target: "lots" }), null, "never a word");
  eq(budget.targetFrom({}), null, "and never absent");
  eq(budget.targetFrom({ target: 1e12 }), null, "eleven digits is a typo, refused rather than stored");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
