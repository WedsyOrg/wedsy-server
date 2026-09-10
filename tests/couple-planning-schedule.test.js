// COUPLE APP — WHAT A FINALISE WRITES, AND WHY FINALISING TWICE CHANGES
// NOTHING. Run: node tests/couple-planning-schedule.test.js
// PURE unit tests (NO DATABASE).
//
// § 06.3 invariant 3 — "Décor finalise → Budget → Payments" — is
// services/CoupleDecorFinaliseService, written and tested by the foundation.
// This file asserts the two things THIS milestone added on top of it:
//
//   1. services/CoupleScheduleService.operations — the writes that plan()'s
//      answer becomes, and that every one of them is an UPSERT on the source
//      key rather than a push;
//   2. the FOLD that finalises four days as one write, which is what
//      CoupleDecorService.finalise does when the ceremony locks the whole
//      décor surface.
//
// And it asserts that the makeup accept commits money down the SAME path,
// with the retainer as the first row of the same schedule, rather than a
// bespoke one.
const finalise = require("../services/CoupleDecorFinaliseService");
const schedule = require("../services/CoupleScheduleService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

const NOW = new Date("2026-09-10T00:00:00Z");
const WEDDING = "6500000000000000000000a1";
const USER = "6500000000000000000000b2";

const event = (lines = []) => ({
  _id: WEDDING,
  user: USER,
  eventDate: "2026-12-14",
  coupleApp: { budget: { estimate: 1840000, target: 1840000, lines } },
});

/** The fold CoupleDecorService.finalise performs over the wedding's days. */
const finaliseDays = (base, rows, now = NOW) => {
  let working = base;
  let budgetLines = ((base.coupleApp && base.coupleApp.budget && base.coupleApp.budget.lines) || []).slice();
  let scheduleRows = [];
  let committed = finalise.committedTotal(base);
  let everyDayAlready = true;
  rows.forEach((row) => {
    const planned = finalise.plan({
      event: working,
      dayId: row.dayId,
      amount: row.amount,
      label: `${row.name} — décor`,
      vendor: "Wedsy",
      now,
    });
    if (!planned.alreadyFinalised) everyDayAlready = false;
    budgetLines = planned.budgetLines;
    committed = planned.committed;
    scheduleRows = scheduleRows.concat(planned.scheduleRows);
    working = { ...working, coupleApp: { ...working.coupleApp, budget: { ...working.coupleApp.budget, lines: budgetLines } } };
  });
  return { budgetLines, scheduleRows, committed, alreadyFinalised: everyDayAlready };
};

const DAYS = [
  { dayId: "d1", name: "Haldi", amount: 97000 },
  { dayId: "d2", name: "Sangeet", amount: 187000 },
  { dayId: "d3", name: "Wedding", amount: 323000 },
  { dayId: "d4", name: "Reception", amount: 82000 },
];

console.log("Finalising the whole wedding — four days, one write:");
{
  const planned = finaliseDays(event(), DAYS);
  eq(planned.budgetLines.length, 4, "one budget line per day");
  eq(planned.committed, 689000, "committed is Σ the four days");
  eq(planned.scheduleRows.length, 12, "three instalments per day");
  eq(
    planned.scheduleRows.reduce((sum, row) => sum + row.amount, 0),
    689000,
    "and the schedule sums to the committed amount EXACTLY — no unclearable balance"
  );
  ok(
    new Set(planned.scheduleRows.map((row) => row.sourceKey)).size === 12,
    "every schedule row has a distinct source key"
  );
  ok(
    planned.budgetLines.every((line) => line.sourceKey.indexOf("decor:") === 0),
    "and every budget line is keyed on the day it came from"
  );
}

console.log("FINALISING TWICE (the whole point):");
{
  const first = finaliseDays(event(), DAYS);
  const second = finaliseDays(event(first.budgetLines), DAYS);   // as if the first write landed

  ok(second.alreadyFinalised === true, "the second finalise reports it is already done");
  eq(second.budgetLines.length, 4, "the budget still has FOUR lines — not eight");
  eq(second.committed, 689000, "the commitment did not double");
  eq(second.scheduleRows.length, 12, "still twelve schedule rows");
  ok(
    second.scheduleRows.every((row, i) => row.sourceKey === first.scheduleRows[i].sourceKey),
    "with the SAME source keys, so the caller's upsert overwrites instead of appending"
  );
}

console.log("The writes those rows become (CoupleScheduleService.operations):");
{
  const planned = finaliseDays(event(), DAYS);
  const ops = schedule.operations({ planned, weddingId: WEDDING, userId: USER, source: "decor" });

  eq(ops.payments.length, 12, "twelve payment writes");
  ok(
    ops.payments.every(
      (row) =>
        row.filter["coupleApp.weddingId"] === WEDDING &&
        typeof row.filter["coupleApp.sourceKey"] === "string" &&
        row.filter["coupleApp.sourceKey"].length > 0
    ),
    "EVERY one is filtered on { weddingId, sourceKey } — the pair Payment carries a unique sparse index on"
  );
  ok(
    ops.payments.every((row) => row.update.$set && row.update.$setOnInsert),
    "each is an upsert: $set for what a re-finalise refreshes, $setOnInsert for what it must not touch"
  );
  ok(
    ops.payments.every((row) => row.update.$setOnInsert.user === USER && row.update.$setOnInsert.status === "null"),
    "the user and the gateway status are written ONLY on insert — a re-finalise cannot reset a row's status"
  );
  ok(
    !JSON.stringify(ops.payments).includes("$push"),
    "nothing anywhere in the writes pushes — a push is how a schedule doubles"
  );
  eq(ops.budgetLines.length, 4, "and the budget is written as the whole upserted array");
  eq(ops.committed, 689000, "carrying plan()'s committed total, not a recomputed one");
}

console.log("Re-finalising at a NEW price replaces rather than adds:");
{
  const first = finaliseDays(event(), DAYS);
  const repriced = DAYS.map((day) => (day.dayId === "d3" ? { ...day, amount: 400000 } : day));
  const second = finaliseDays(event(first.budgetLines), repriced);

  ok(second.alreadyFinalised === false, "a changed amount is not 'already finalised'");
  eq(second.budgetLines.length, 4, "the budget STILL has four lines");
  eq(second.committed, 766000, "and the commitment is the new number, not the sum of both");
  eq(second.scheduleRows.length, 12, "still twelve rows, on the same twelve keys");
}

console.log("The `source` word is the caller's, and only that word:");
{
  const planned = finaliseDays(event(), [DAYS[0]]);
  const asDecor = schedule.operations({ planned, weddingId: WEDDING, userId: USER, source: "decor" });
  const asMakeup = schedule.operations({ planned, weddingId: WEDDING, userId: USER, source: "makeup" });
  eq(asDecor.budgetLines[0].source, "decor", "a décor finalise stamps decor");
  eq(asMakeup.budgetLines[0].source, "makeup", "the makeup accept stamps makeup");
  eq(asDecor.budgetLines[0].amount, asMakeup.budgetLines[0].amount, "and nothing else about the line moves");
  eq(asDecor.budgetLines[0].sourceKey, asMakeup.budgetLines[0].sourceKey, "the key is plan()'s either way");
  eq(
    JSON.stringify(asDecor.payments),
    JSON.stringify(asMakeup.payments),
    "the payment rows are byte-identical — the caller names the KIND of line, never the money"
  );
}

console.log("ACCEPTING A MAKEUP BID uses the same path — the retainer is row one:");
{
  const bidId = "6500000000000000000000c3";
  const planned = finalise.plan({
    event: event(),
    dayId: `makeup:${bidId}`,
    amount: 42000,
    label: "Makeup — Aisha Khan",
    vendor: "Aisha Khan",
    now: NOW,
  });

  eq(planned.scheduleRows.length, 3, "the SAME 25/50/25 schedule, from the same one function");
  eq(planned.scheduleRows[0].amount, 10500, "the retainer is 25% of the bid");
  eq(
    planned.scheduleRows.reduce((sum, row) => sum + row.amount, 0),
    42000,
    "and the three rows sum to the bid exactly"
  );
  eq(
    planned.scheduleRows[0].dueDate.getTime(),
    NOW.getTime() + 7 * 86400000,
    "the retainer falls due in a week, which is the one place that decision lives"
  );
  eq(planned.budgetLine.sourceKey, `decor:makeup:${bidId}`, "keyed on the bid, so accepting twice lands on one row");

  // Accepting twice.
  const again = finalise.plan({
    event: event(planned.budgetLines),
    dayId: `makeup:${bidId}`,
    amount: 42000,
    now: NOW,
  });
  ok(again.alreadyFinalised === true, "the second accept reports it is already done");
  eq(again.budgetLines.length, 1, "and the commitment is not doubled");
  eq(again.committed, 42000, "…in rupees either");
}

console.log("A décor finalise and a makeup accept never collide:");
{
  const decorPlan = finalise.plan({ event: event(), dayId: "d3", amount: 323000, now: NOW });
  const makeupPlan = finalise.plan({
    event: event(decorPlan.budgetLines),
    dayId: "makeup:6500000000000000000000c3",
    amount: 42000,
    now: NOW,
  });
  eq(makeupPlan.budgetLines.length, 2, "two lines: the day and the artist");
  eq(makeupPlan.committed, 365000, "and the committed total is both");
  const keys = new Set(
    decorPlan.scheduleRows.concat(makeupPlan.scheduleRows).map((row) => row.sourceKey)
  );
  eq(keys.size, 6, "six distinct payment keys — no décor row can be overwritten by a makeup one");
}

console.log("A zero commitment writes nothing to chase:");
{
  const planned = finaliseDays(event(), [{ dayId: "d9", name: "Mehndi", amount: 0 }]);
  eq(planned.scheduleRows.length, 0, "no schedule rows for a day worth nothing");
  const ops = schedule.operations({ planned, weddingId: WEDDING, userId: USER, source: "decor" });
  eq(ops.payments.length, 0, "and therefore no payment writes");
}


console.log("WHAT a finalise commits — the frozen snapshot first, the live draft second:");
{
  const decor = require("../services/CoupleDecorService");
  const comparison = {
    pricingVisible: true,
    content: { drafts: [{ draftName: "Signature", gross: 689000, discount: 65000, net: 624000, days: [{ name: "Wedding", total: 323000 }] }] },
  };
  const itemised = {
    content: { draftName: "Signature", days: [{ name: "Wedding", date: "2026-12-14", venue: "Taj", items: [{ name: "Mandap", price: 145000, quantity: 1 }] }] },
  };
  const tier = decor.shapeDrafts(comparison, [itemised])[0];
  const ev = {
    _id: WEDDING,
    eventDays: [{ _id: "d1", name: "Wedding", status: {} }, { _id: "d2", name: "Haldi", status: {} }],
    amount: { summary: [{ eventDayId: "d1", total: 999999 }, { eventDayId: "d2", total: 97000 }] },
  };
  const amounts = decor.dayAmounts(ev, tier);

  eq(amounts[0].amount, 323000, "the wedding day commits the SNAPSHOT's figure — the one the couple was shown");
  eq(amounts[0].source, "snapshot", "…and says where it came from");
  ok(amounts[0].amount !== 999999, "NOT the live pricing engine's, which has moved since they looked");
  eq(amounts[1].amount, 97000, "a day the snapshot does not price falls back to the Event's own total");
  eq(amounts[1].source, "event", "…and says so too");
  eq(
    decor.dayAmounts(ev, null).map((row) => row.amount).join(","),
    "999999,97000",
    "with no snapshot at all, the Event's totals are what there is"
  );
}

console.log("A snapshot published WITHOUT prices leaks no figure (§ 3.2.2 state 2):");
{
  const decor = require("../services/CoupleDecorService");
  const content = { drafts: [{ draftName: "Signature", gross: 689000, discount: 65000, net: 624000, days: [{ name: "Wedding", total: 323000 }] }] };
  const itemised = { content: { draftName: "Signature", days: [{ name: "Wedding", items: [{ name: "Mandap", price: 145000 }] }] } };
  const shown = decor.shapeDrafts({ pricingVisible: false, content }, [itemised])[0];

  ok(!("total" in shown), "`total` is ABSENT, not zero — a zero is a number the couple would read as free");
  ok(!("gross" in shown), "so is gross");
  ok(!("discount" in shown), "and discount");
  ok(!("subtotal" in shown.events[0]), "no per-day subtotal");
  ok(!("amount" in shown.events[0].items[0]), "and no per-item amount");
  eq(shown.days.length, 0, "and the per-day totals a finalise would commit are not sent either");
  ok(shown.events[0].items[0].label === "Mandap", "…while the LOOK itself is still there, which is the whole of state 2");
  const text = JSON.stringify(shown);
  ok(text.indexOf("323000") === -1 && text.indexOf("624000") === -1 && text.indexOf("145000") === -1, "no price appears anywhere in the serialised body");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
