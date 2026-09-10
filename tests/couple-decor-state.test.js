// COUPLE APP — THE FIVE-STATE DÉCOR JOURNEY, and "needs_input" in particular.
// Run: node tests/couple-decor-state.test.js
// PURE unit tests (NO DATABASE).
//
// docs/couple-app-api.md § 7 lists `decorStatus: "needs_input"` as the one enum
// value nothing on the Event could express, and hands it to the décor
// endpoints. This asserts the derivation those endpoints supply — including
// that it never overrides `finalised`, never invents itself out of `none`, and
// that the OTHER FOUR are still CoupleWeddingService.decorStateOf's answer and
// not a second copy of that ladder.
const state = require("../services/CoupleDecorStateService");
const wedding = require("../services/CoupleWeddingService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

const day = (over = {}) => ({ _id: "d1", name: "Wedding", decorItems: [], packages: [], status: {}, ...over });
const priced = (over) => day({ decorItems: [{ price: 145000 }], ...over });
const drafted = (over) => day({ decorItems: [{ price: 0 }], ...over });
const locked = () => day({ decorItems: [{ price: 145000 }], status: { finalized: true } });

const decor = (over = {}) => ({ hearts: [], days: [], tier: "", ...over });

console.log("The base four are decorStateOf's, not a second ladder:");
{
  eq(wedding.decorStateOf(day()), "none", "nothing drawn is none, in the foundation's own function");
  eq(state.stateOf(day(), decor()), "none", "and the overlay agrees");
  eq(state.stateOf(locked(), decor()), "finalised", "a locked day is finalised");
  eq(
    state.stateOf(priced(), decor({ tier: "signature" })),
    "priced",
    "priced, with a tier chosen, is priced"
  );
  eq(
    state.stateOf(drafted(), decor({ hearts: [{ kind: "theme", ref: "t-rose" }] })),
    "drafted",
    "drafted, with something hearted, is drafted"
  );
}

console.log("needs_input · 1 — THE TEAM ASKED (the stored flag):");
{
  const asked = decor({ days: [{ dayId: "d1", needsInput: true, needsInputNote: "Which palette?" }] });
  eq(state.stateOf(drafted(), asked), "needs_input", "a drafted day the team is waiting on");
  eq(state.stateOf(priced(), { ...asked, tier: "signature" }), "needs_input", "and a PRICED one — the ask outranks the price");
  eq(state.reasonFor(drafted(), asked), "Which palette?", "the reason is the team's own words");
  eq(
    state.stateOf(drafted(), decor({ days: [{ dayId: "OTHER", needsInput: true }] })),
    "needs_input",
    "a flag on ANOTHER day does not rescue this one — it is unhearted, so it needs input for its own reason"
  );
  eq(
    state.stateOf(
      drafted(),
      decor({ days: [{ dayId: "OTHER", needsInput: true }], hearts: [{ kind: "theme", ref: "t" }] })
    ),
    "drafted",
    "and with a heart, a flag on another day leaves this one alone"
  );
}

console.log("needs_input · 2 — PRICED, AND NOBODY HAS CHOSEN:");
{
  eq(state.stateOf(priced(), decor()), "needs_input", "tiers are in front of them and no tier is chosen");
  eq(state.stateOf(priced(), decor({ tier: "royal" })), "priced", "the wedding-wide choice answers it");
  eq(
    state.stateOf(priced(), decor({ days: [{ dayId: "d1", tier: "essential" }] })),
    "priced",
    "so does a per-day choice"
  );
  ok(
    state.reasonFor(priced(), decor()).indexOf("compare") !== -1,
    "and the reason says what to do about it"
  );
}

console.log("needs_input · 3 — DRAFTED, AND NOTHING HEARTED FOR THAT FUNCTION:");
{
  eq(state.stateOf(drafted(), decor()), "needs_input", "looks are up and they have loved none of them");
  eq(
    state.stateOf(drafted(), decor({ hearts: [{ kind: "theme", ref: "t-sun", event: "haldi" }] })),
    "needs_input",
    "a heart on ANOTHER function does not answer this one"
  );
  eq(
    state.stateOf(drafted(), decor({ hearts: [{ kind: "theme", ref: "t-rose", event: "wedding" }] })),
    "drafted",
    "a heart on THIS function does"
  );
  eq(
    state.stateOf(drafted(), decor({ hearts: [{ kind: "product", ref: "p1", event: "" }] })),
    "drafted",
    "a heart with no function counts everywhere — they expressed a direction and must not be nagged for it"
  );
}

console.log("What it must NEVER override:");
{
  const asked = decor({ days: [{ dayId: "d1", needsInput: true }] });
  eq(state.stateOf(locked(), asked), "finalised", "a stale flag cannot unlock a finalised day (§ 06.2: irreversible)");
  eq(state.stateOf(day(), asked), "none", "a day with nothing drawn is waiting on the TEAM, not on the couple");
  eq(state.stateOf(null, asked), "none", "a missing day is none, not a throw");
  eq(state.stateOf(drafted(), null), "needs_input", "a wedding with no couple-décor block still derives");
  eq(state.stateOf(drafted(), undefined), "needs_input", "…and so does one with nothing at all");
}

console.log("Every answer is inside the shared enum (§ 06.1 DecorState):");
{
  const cases = [
    [day(), decor()],
    [drafted(), decor()],
    [drafted(), decor({ hearts: [{ kind: "theme", ref: "t", event: "wedding" }] })],
    [priced(), decor()],
    [priced(), decor({ tier: "x" })],
    [locked(), decor()],
  ];
  ok(
    cases.every(([d, c]) => state.isDecorState(state.stateOf(d, c))),
    "no branch can return a value the client's enum has never heard of"
  );
  const seen = new Set(cases.map(([d, c]) => state.stateOf(d, c)));
  eq(seen.size, 5, "and these six cases cover all five distinct states");
  ok(seen.has("needs_input"), "including needs_input, which is the one this milestone had to supply");
}

console.log("The reason is empty unless there is something to say:");
{
  eq(state.reasonFor(locked(), decor()), "", "a finalised day has no reason");
  eq(state.reasonFor(priced(), decor({ tier: "x" })), "", "and neither has a settled priced one");
  eq(state.reasonFor(day(), decor()), "", "nor an empty one — never invented copy");
}

console.log("The JOURNEY state (§ 3.2.2's five, which are NOT DecorState's five):");
{
  const days = (...states) => states.map((s, i) => ({ id: `d${i}`, decorStatus: s }));
  eq(state.journeyState([], decor()), "holding", "a wedding with no days has not begun");
  eq(state.journeyState(days("none", "none"), decor()), "holding", "nothing drawn anywhere is still holding");
  eq(state.journeyState(days("drafted", "none"), decor()), "presented", "looks are up and nothing is hearted");
  eq(
    state.journeyState(days("drafted", "needs_input"), decor({ hearts: [{ kind: "theme", ref: "t" }] })),
    "selections",
    "hearted, nothing priced"
  );
  eq(state.journeyState(days("priced", "drafted"), decor()), "drafts", "one priced day puts them in the drafts state");
  eq(state.journeyState(days("finalised", "priced"), decor()), "drafts", "…and one finalised day does NOT — the others are still open");
  eq(state.journeyState(days("finalised", "finalised"), decor()), "finalised", "every day locked is the ceremony's end state");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
