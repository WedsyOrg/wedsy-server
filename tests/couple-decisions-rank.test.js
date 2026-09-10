// COUPLE APP § 06.3 — THE DECISIONS QUEUE. Run: node tests/couple-decisions-rank.test.js
// PURE unit tests (NO DATABASE). "Server-ranked: items blocked on couple input,
// urgency-ordered, capped at 3." Also asserts the thing that makes the top bar
// honest: the pill's count is EVERY blocking item, not the capped three.
const d = require("../services/CoupleDecisionsService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

const NOW = new Date("2026-09-08T00:00:00Z");
const at = (days) => new Date(NOW.getTime() + days * 86400000);
const cand = (id, type, blocking, dueAt) => ({ id, type, category: type, blocking, dueAt, title: id, body: "" });

console.log("Only blocking items are decisions:");
{
  const r = d.rank([cand("a", "decor", true, at(5)), cand("b", "website", false, at(1))], NOW);
  eq(r.decisions.length, 1, "work in progress is not a decision, however urgent");
  eq(r.decisions[0].id, "a", "the blocking one survives");
  eq(d.rank([], NOW).decisions.length, 0, "nothing blocking is no decisions");
  eq(d.rank(null, NOW).openCount, 0, "a missing list is 0, not a throw");
}

console.log("Urgency ordering:");
{
  const r = d.rank([cand("far", "decor", true, at(60)), cand("near", "decor", true, at(2)), cand("mid", "decor", true, at(20))], NOW);
  eq(r.decisions.map((x) => x.id).join(","), "near,mid,far", "soonest first");
  const noDate = d.rank([cand("dated", "decor", true, at(60)), cand("undated", "decor", true, null)], NOW);
  eq(noDate.decisions[0].id, "dated", "an item with no deadline sorts LAST, never first");
}

console.log("Ties break on irreversibility:");
{
  const r = d.rank([cand("t", "task", true, at(3)), cand("v", "venue", true, at(3)), cand("p", "payment", true, at(3))], NOW);
  eq(r.decisions.map((x) => x.id).join(","), "v,p,t", "a venue hold that expires outranks a payment, which outranks a task");
}

console.log("The cap of 3:");
{
  const many = [1, 2, 3, 4, 5, 6].map((n) => cand(`c${n}`, "decor", true, at(n)));
  const r = d.rank(many, NOW);
  eq(r.decisions.length, 3, "capped at three cards");
  eq(r.openCount, 6, "but the PILL counts all six — '3 open' when six are is a lie the couple finds out about later");
  eq(r.decisions[0].position, 1, "positions are stamped 1..3");
  eq(r.decisions[2].position, 3, "…through 3");
  eq(r.decisions[0].variant, "primary", "card 1 is primary (§ 03.1)");
  eq(r.decisions[1].variant, "secondary", "the rest are secondary");
}

console.log("Ranking is stable:");
{
  const a = [cand("z", "decor", true, at(3)), cand("a", "decor", true, at(3))];
  eq(d.rank(a, NOW).decisions[0].id, "a", "identical urgency and type fall back to a stable key");
  eq(d.rank(a.slice().reverse(), NOW).decisions[0].id, "a", "and the input order does not change the answer");
}

console.log("Generating candidates from the wedding's state:");
{
  const days = [
    { id: "d1", name: "Haldi", date: "2026-12-12", decorStatus: "drafted" },
    { id: "d2", name: "Sangeet", date: "2026-12-13", decorStatus: "needs_input" },
    { id: "d3", name: "Wedding", date: "2026-12-14", decorStatus: "priced" },
    { id: "d4", name: "Reception", date: "2026-12-14", decorStatus: "none" },
  ];
  const c = d.candidates({ days, now: NOW });
  eq(c.length, 2, "only the two days actually waiting on the couple produce candidates");
  ok(c.some((x) => x.type === "palette"), "the sangeet needs a palette");
  ok(c.some((x) => x.type === "decor"), "the wedding has been priced");
  ok(c.every((x) => x.blocking), "and both are blocking");

  const withMoney = d.candidates({
    days: [],
    payments: [
      { id: "y2", label: "Venue hold", vendor: "Taj West End", dueDate: at(6), status: "due" },
      { id: "y3", label: "Décor instalment", dueDate: at(40), status: "due" },
      { id: "y1", label: "Paid already", dueDate: at(-3), status: "paid" },
    ],
    now: NOW,
  });
  eq(withMoney.length, 1, "a payment far in the future is not yet a decision, and a paid one never is");
  eq(withMoney[0].id, "payment-y2", "the one due this fortnight is");

  const withTasks = d.candidates({
    days: [],
    tasks: [{ id: "k4", title: "Confirm the haldi venue", dueDate: at(-4), done: false }, { id: "k1", title: "Later", dueDate: at(4), done: false }, { id: "k5", title: "Done", dueDate: at(-9), done: true }],
    now: NOW,
  });
  eq(withTasks.length, 1, "only an OVERDUE, open task is a decision");
  eq(withTasks[0].id, "task-k4", "that one");

  const holds = d.candidates({ days: [], holds: [{ id: "v1", expiresAt: at(4) }, { id: "v2", expiresAt: at(2) }, { id: "v3", reaction: "love", expiresAt: at(1) }], now: NOW });
  eq(holds.length, 1, "unreacted holds collapse into ONE card, not one per venue");
  eq(new Date(holds[0].dueAt).getTime(), at(2).getTime(), "and it is as urgent as the soonest of them");
  eq(holds[0].title.indexOf("2 venues") , 0, "the card counts the venues still awaiting a reaction");

  eq(d.candidates({}).length, 0, "a wedding with nothing pending produces no decisions — Home shows its reassurance card");
}

console.log("End to end:");
{
  const c = d.candidates({
    days: [{ id: "d3", name: "Wedding", date: "2026-12-14", decorStatus: "priced" }],
    payments: [{ id: "y2", label: "Venue hold", dueDate: at(6), status: "due" }],
    tasks: [{ id: "k4", title: "Confirm the haldi venue", dueDate: at(-4), done: false }],
    holds: [{ id: "v1", expiresAt: at(3) }],
    now: NOW,
  });
  const r = d.rank(c, NOW);
  eq(r.openCount, 4, "four things are blocked on the couple");
  eq(r.decisions.length, 3, "three are shown");
  eq(r.decisions[0].id, "task-k4", "the overdue task is the most urgent (it is already past)");
  eq(r.decisions[1].id, "venue-holds", "then the expiring holds");
  eq(r.decisions[2].id, "payment-y2", "then the payment");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
