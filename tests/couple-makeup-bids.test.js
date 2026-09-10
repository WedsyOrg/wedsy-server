// COUPLE APP — MAKEUP: the brief, the bids, and what accepting one does to the
// others. Run: node tests/couple-makeup-bids.test.js
// PURE unit tests (NO DATABASE).
//
// § 3.5's round is models/Bidding + models/BiddingBid — the vendor
// marketplace's own records — so the couple-facing side of it is a shaping and
// a DECISION, and the decision is what this asserts:
//
//   · which bid wins, which lose, and that EVERY other bid is marked;
//   · that accepting the same bid twice is a VALUE (`alreadyAccepted`), the way
//     CoupleDecorFinaliseService returns `alreadyFinalised`, and that accepting
//     a DIFFERENT one is refused;
//   · that the retainer goes down the shared finalise path and is not
//     recomputed anywhere in the makeup service.
const fs = require("fs");
const path = require("path");
const rules = require("../services/CouplePlanningRules");
const finalise = require("../services/CoupleDecorFinaliseService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
/** The file with its COMMENTS STRIPPED. The marked comments naming the triggers
 *  this feature wants deliberately spell out "NotificationService" and
 *  "Aisensy"; what must be absent is the CODE, so the code is what is read. */
const code = (file) =>
  read(file).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const bid = (id, over = {}) => ({ _id: id, vendor: `v-${id}`, bid: 40000, status: {}, ...over });
const BIDS = [bid("bd1"), bid("bd2"), bid("bd3"), bid("bd4")];

console.log("Accepting a bid — one winner, and EVERY other bid loses:");
{
  const decision = rules.acceptance(BIDS, "bd2");
  ok(decision.ok, "the decision stands");
  eq(String(decision.winner._id), "bd2", "the named bid wins");
  eq(decision.losers.length, 3, "and all three others are marked");
  eq(decision.losers.sort().join(","), "bd1,bd3,bd4", "by name, so none is left waiting in silence");
  ok(decision.alreadyAccepted === false, "this is the first time");
}

console.log("Accepting the SAME bid twice is a value, not an error:");
{
  const after = BIDS.map((row) => (String(row._id) === "bd2" ? { ...row, status: { userAccepted: true } } : row));
  const decision = rules.acceptance(after, "bd2");
  ok(decision.ok, "it still stands — a couple who tapped twice has accepted");
  ok(decision.alreadyAccepted === true, "and it says so");
  eq(decision.losers.length, 3, "the losers are re-marked, so a retry CONVERGES rather than leaving a row missed");
}

console.log("Accepting a DIFFERENT bid once one is accepted is refused:");
{
  const after = BIDS.map((row) => (String(row._id) === "bd2" ? { ...row, status: { userAccepted: true } } : row));
  const decision = rules.acceptance(after, "bd3");
  ok(decision.ok === false, "refused");
  eq(decision.reason, "already_accepted", "…as already_accepted, not as a not-found");
  eq(decision.acceptedId, "bd2", "and the refusal names the artist who was booked");
  eq(decision.losers.length, 0, "nothing is marked on a refusal — an artist must not be rejected by a failed request");
}

console.log("A bid that is not on this round:");
{
  const decision = rules.acceptance(BIDS, "bd99");
  ok(decision.ok === false, "refused");
  eq(decision.reason, "not_found", "as not-found, which the service turns into a 404 — a stranger never learns which ids are real");
  eq(decision.losers.length, 0, "and nothing is marked");
  eq(rules.acceptance(null, "bd1").reason, "not_found", "an empty round is not-found rather than a throw");
  eq(rules.acceptance(BIDS, null).reason, "not_found", "and neither is a missing id");
}

console.log("A previously rejected bid can still be the one they come back to:");
{
  const rejected = BIDS.map((row) => (String(row._id) === "bd4" ? { ...row, status: { userRejected: true } } : row));
  const decision = rules.acceptance(rejected, "bd4");
  ok(decision.ok, "nothing about a rejection is terminal while no bid is accepted");
  eq(decision.losers.length, 3, "and the other three are marked when they do");
}

console.log("THE RETAINER comes down the shared finalise path (§ 06.3 invariant 3):");
{
  const NOW = new Date("2026-09-10T00:00:00Z");
  const event = { _id: "w1", eventDate: "2026-12-14", coupleApp: { budget: { lines: [] } } };
  const planned = finalise.plan({
    event,
    dayId: "makeup:bd1",
    amount: 42000,
    label: "Makeup — Aisha Khan",
    vendor: "Aisha Khan",
    now: NOW,
  });
  eq(planned.scheduleRows.length, 3, "the same three-row schedule the décor finalise generates");
  eq(planned.scheduleRows[0].amount, 10500, "the retainer is the first row: 25% of the bid");
  eq(planned.scheduleRows[0].vendor, "Aisha Khan", "billed to the artist, not to Wedsy");
  eq(
    planned.scheduleRows.reduce((sum, row) => sum + row.amount, 0),
    42000,
    "and the three rows sum to the bid exactly — no balance nobody can clear"
  );
  eq(planned.committed, 42000, "the bid is committed to the budget in full");
}

console.log("SOURCE-LEVEL: no bespoke retainer, no second bidding system:");
{
  const makeup = read("services/CoupleMakeupService.js");
  ok(makeup.includes("finaliseService.plan("), "acceptBid calls CoupleDecorFinaliseService.plan");
  ok(makeup.includes("scheduleService.apply("), "and writes through the shared CoupleScheduleService");
  ok(
    !/0\.25|0\.2 |retainerPercent|\* 0\./.test(makeup),
    "and holds NO percentage of its own — the 25/50/25 decision lives in one place"
  );
  ok(
    !/Payment\.updateOne|Payment\.create|new Payment\(/.test(makeup),
    "it never writes a Payment row itself"
  );
  ok(
    !/require\(["'][^"']*models\/Payment/.test(makeup),
    "…and does not even import the model"
  );
  ok(
    makeup.includes("models/Bidding") && makeup.includes("models/BiddingBid") && makeup.includes("models/BiddingBooking"),
    "the round, the bids and the trial are the EXISTING three models"
  );
  ok(
    makeup.includes("status.userAccepted") && makeup.includes("status.userRejected"),
    "and it sets the SAME two flags routes/bidding.js already sets, so the vendor app sees what it always saw"
  );
  ok(!/mongoose\.model\(/.test(makeup), "no new model is defined anywhere in the makeup path");
}

console.log("SOURCE-LEVEL: no notification is sent, and the ones that belong are named:");
{
  const files = [
    "services/CoupleMakeupService.js",
    "services/CoupleDecorService.js",
    "services/CoupleStoreService.js",
    "services/CoupleVenueService.js",
    "services/CoupleBudgetService.js",
    "controllers/coupleAppPlanning.js",
    "routes/coupleApp-planning.js",
  ];
  files.forEach((file) => {
    const text = code(file);
    ok(!/NotificationService|\bsend\s*\(\s*["'][a-z_]+["']/.test(text), `${file} sends nothing`);
    ok(!/aisensy/i.test(text), `${file} has no Aisensy call`);
  });
  const marked = files.filter((file) => read(file).includes("NOTIFICATION TRIGGER — NOT ADDED"));
  ok(marked.length >= 4, `${marked.length} files carry a marked comment naming the trigger they want`);
}

console.log("SOURCE-LEVEL: nothing here logs (repo rule 6):");
{
  const files = [
    "services/CoupleMakeupService.js",
    "services/CoupleDecorService.js",
    "services/CoupleStoreService.js",
    "services/CoupleVenueService.js",
    "services/CoupleBudgetService.js",
    "services/CoupleBudgetRules.js",
    "services/CouplePlanningRules.js",
    "services/CoupleDecorStateService.js",
    "services/CoupleScheduleService.js",
    "routes/coupleApp-planning.js",
  ];
  files.forEach((file) => ok(!/console\.log\(/.test(read(file)), `${file} has no console.log`));
  const controller = read("controllers/coupleAppPlanning.js");
  ok(!/console\.log\(/.test(controller), "and neither has the controller");
  ok(/console\.error\(/.test(controller), "…which does keep console.error on the 500 path, as the other couple-app controllers do");
}

console.log("SOURCE-LEVEL: no hardcoded URL (repo rule 3):");
{
  const files = [
    "services/CoupleMakeupService.js",
    "services/CoupleDecorService.js",
    "services/CoupleStoreService.js",
    "services/CoupleVenueService.js",
    "services/CoupleBudgetService.js",
    "services/CoupleScheduleService.js",
    "controllers/coupleAppPlanning.js",
    "routes/coupleApp-planning.js",
  ];
  files.forEach((file) => ok(!/https?:\/\/[a-z0-9]/i.test(read(file)), `${file} carries no absolute URL`));
}

console.log("The brief a couple may post:");
{
  const keys = ["haldi", "sangeet", "wedding", "reception"];
  const brief = rules.briefFrom(
    { date: "2026-12-14", functions: ["haldi", "wedding", "mehndi"], budgetLow: 55000, budgetHigh: 30000, people: 3, looks: "Bridal for the muhurtham" },
    keys
  );
  eq(brief.functions.join(","), "haldi,wedding", "a function this wedding does not have is dropped (§ 06.3 'Events')");
  eq(brief.budgetLow, 30000, "a low above a high is ordered, not refused — that is a slider dragged past itself");
  eq(brief.budgetHigh, 55000, "…and the high is the higher of the two");
  eq(brief.people, 3, "the number of faces");
  eq(rules.briefFrom({ budgetLow: 30000, people: 99 }, keys).people, 20, "which is capped at twenty");
  eq(rules.briefFrom({ budgetLow: 30000, people: 0 }, keys).people, 1, "and floored at one — the bride is always one of them");
  eq(rules.briefFrom({ budgetHigh: 40000 }, keys).budgetLow, 40000, "one figure sets both ends of the band");

  let threw = null;
  try { rules.briefFrom({ looks: "anything" }, keys); } catch (error) { threw = error; }
  ok(threw && threw.status === 422, "a brief with NO budget is refused — an artist cannot bid against a blank");
  ok(threw && threw.extra.fields.budgetLow, "and the refusal names the field");
}

console.log("A bid card is comparable, and honest about what it cannot say:");
{
  const shaped = rules.shapeBid(
    { _id: "bd1", vendor: "v1", bid: 42000, vendor_notes: "I would start at half past four.", status: { userAccepted: true }, createdAt: "2026-08-29" },
    { _id: "v1", businessName: "Aisha Khan", rating: 5, gallery: { coverPhoto: "/a.webp" }, businessAddress: { city: "Bengaluru" }, other: { makeupProducts: ["Airbrush", "Bobbi Brown"] } },
    128
  );
  eq(shaped.amount, 42000, "the price");
  eq(shaped.name, "Aisha Khan", "the business name, not the person's");
  eq(shaped.reviews, 128, "the review count, counted rather than claimed");
  eq(shaped.products, "Airbrush, Bobbi Brown", "the products, from the vendor's own profile");
  ok(shaped.accepted === true, "and whether this is the one they booked");
  eq(shaped.covers, "", "`covers` is EMPTY — BiddingBid has no field for it, and assembling one out of the note would be an invention");
  eq(shaped.travel, "", "so is travel");
  eq(shaped.trial, "", "and the trial line");
  eq(rules.shapeBid(null, null, 0).amount, 0, "a missing bid shapes to zero rather than throwing");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
