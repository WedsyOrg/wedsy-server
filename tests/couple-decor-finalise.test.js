// COUPLE APP INVARIANT 3 — DÉCOR FINALISE → BUDGET → PAYMENTS.
// Run: node tests/couple-decor-finalise.test.js
// PURE unit tests (NO DATABASE). § 06.3: finalising writes the committed amount
// into the Budget and generates the payment schedule rows. The test that
// matters most is IDEMPOTENCE: finalising twice must not double the schedule or
// the commitment, because the finalise is irreversible (§ 06.2) and a doubled
// commitment cannot be taken back.
const finalise = require("../services/CoupleDecorFinaliseService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

const NOW = new Date("2026-09-08T00:00:00Z");
const event = (lines = []) => ({
  _id: "w1",
  eventDate: "2026-12-14",
  coupleApp: { budget: { estimate: 1840000, target: 1840000, lines } },
});

console.log("Committed is Σ lines — there is no stored total:");
{
  eq(finalise.committedTotal(event()), 0, "no lines is 0");
  eq(finalise.committedTotal(event([{ sourceKey: "a", amount: 410000 }])), 410000, "one line");
  eq(finalise.committedTotal(event([{ sourceKey: "a", amount: 410000 }, { sourceKey: "b", amount: 90000 }])), 500000, "two lines sum");
  eq(finalise.committedTotal({}), 0, "an Event with no coupleApp block is 0, not a throw");
  eq(finalise.committedTotal(null), 0, "a missing event is 0");
}

console.log("The first finalise:");
{
  const r = finalise.plan({ event: event(), dayId: "d3", amount: 410000, label: "Wedding décor", now: NOW });
  ok(r.alreadyFinalised === false, "it is not already finalised");
  eq(r.previousCommitted, 0, "nothing was committed before");
  eq(r.committed, 410000, "the committed budget is now the finalised amount");
  eq(r.budgetLines.length, 1, "one budget line was added");
  eq(r.budgetLine.sourceKey, "decor:d3", "keyed on the day being finalised");
  eq(r.scheduleRows.length, 3, "three payment rows were generated");
  eq(r.scheduleRows.reduce((s, row) => s + row.amount, 0), 410000, "the schedule sums to the committed amount EXACTLY — no unclearable ₹1 balance");
  ok(r.scheduleRows.every((row) => row.sourceKey.indexOf("decor:d3:") === 0), "every row carries the day's key");
  ok(new Set(r.scheduleRows.map((row) => row.sourceKey)).size === 3, "the row keys are distinct");
}

console.log("FINALISING TWICE (the whole point):");
{
  const first = finalise.plan({ event: event(), dayId: "d3", amount: 410000, now: NOW });
  const after = event(first.budgetLines);          // as if the first write landed
  const second = finalise.plan({ event: after, dayId: "d3", amount: 410000, now: NOW });

  ok(second.alreadyFinalised === true, "the second finalise reports it is already done");
  eq(second.budgetLines.length, 1, "the budget still has ONE line — not two");
  eq(second.committed, 410000, "the commitment did not double");
  eq(second.scheduleRows.length, 3, "still three schedule rows");
  ok(
    second.scheduleRows.every((row, i) => row.sourceKey === first.scheduleRows[i].sourceKey),
    "with the SAME source keys, so the caller's upsert overwrites instead of appending"
  );
}

console.log("Re-finalising at a different amount (a repriced day):");
{
  const first = finalise.plan({ event: event(), dayId: "d3", amount: 410000, now: NOW });
  const second = finalise.plan({ event: event(first.budgetLines), dayId: "d3", amount: 480000, now: NOW });
  ok(second.alreadyFinalised === false, "a changed amount is not 'already finalised'");
  eq(second.budgetLines.length, 1, "it still REPLACES the line rather than adding one");
  eq(second.committed, 480000, "and the commitment is the new number, not the sum of both");
}

console.log("Two different days:");
{
  const first = finalise.plan({ event: event(), dayId: "d3", amount: 410000, now: NOW });
  const second = finalise.plan({ event: event(first.budgetLines), dayId: "d1", amount: 90000, now: NOW });
  eq(second.budgetLines.length, 2, "a second DAY adds a second line");
  eq(second.committed, 500000, "and the commitments add up");
  eq(second.previousCommitted, 410000, "the previous total is reported for the activity line");
}

console.log("The schedule:");
{
  const r = finalise.plan({ event: event(), dayId: "d3", amount: 100000, now: NOW });
  eq(r.scheduleRows[0].amount, 25000, "25% advance");
  eq(r.scheduleRows[1].amount, 50000, "50% instalment");
  eq(r.scheduleRows[2].amount, 25000, "25% balance");
  const dates = r.scheduleRows.map((row) => new Date(row.dueDate).getTime());
  ok(dates[0] < dates[1] && dates[1] < dates[2], "the rows fall due in order");
  ok(dates[2] < new Date("2026-12-14").getTime(), "and all of them before the wedding day");

  const odd = finalise.plan({ event: event(), dayId: "d3", amount: 100001, now: NOW });
  eq(odd.scheduleRows.reduce((s, row) => s + row.amount, 0), 100001, "an amount that does not divide still sums exactly — the last row absorbs it");

  const explicit = finalise.plan({
    event: event(), dayId: "d3", amount: 200000, now: NOW,
    schedule: [{ label: "On signing", amount: 200000, dueDate: new Date("2026-09-20") }],
  });
  eq(explicit.scheduleRows.length, 1, "a caller with a real schedule overrides the default entirely");
  eq(explicit.scheduleRows[0].label, "On signing", "and keeps its own labels");

  eq(finalise.plan({ event: event(), dayId: "d3", amount: 0, now: NOW }).scheduleRows.length, 0, "a zero finalise generates no rows to chase");
}

console.log("A wedding with no date yet:");
{
  const undated = { _id: "w1", coupleApp: { budget: { lines: [] } } };
  const r = finalise.plan({ event: undated, dayId: "d3", amount: 100000, now: NOW });
  eq(r.scheduleRows.length, 3, "the schedule still generates");
  ok(r.scheduleRows.every((row) => row.dueDate instanceof Date && !Number.isNaN(row.dueDate.getTime())), "with real dates counted forward from today, never Invalid Date");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
