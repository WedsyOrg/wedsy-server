// COUPLE APP § 05.3 / § 06.2 — THE TASKS UNION, AND ITS WRITE ISOLATION.
// Run: node tests/couple-tasks-union.test.js
//
// PURE unit tests (NO DATABASE).
//
// GET /wedding/:id/tasks is the union of the couple's own CoupleTask rows and
// the CRM's WeddingMilestone timeline. The union is the whole point of the
// screen (§ 05.3: "Tasks the Wedsy team creates for the couple appear here
// too, attributed") and the isolation is the whole point of not widening
// WeddingMilestone: those rows are already rendered inside the CRM lead page,
// and the couple app must leave them exactly as it found them.
//
// The last block is a SOURCE-LEVEL assertion, in the manner of
// tests/objectid-strict.test.js: it reads the couple-app people files and
// proves no write verb is ever aimed at WeddingMilestone. A behavioural test
// for that would need a database; this one cannot be made green by accident.
const fs = require("fs");
const path = require("path");
const CoupleTaskService = require("../services/CoupleTaskService");
const rules = require("../services/CouplePeopleRules");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const ME = "6512f0aa11bb22cc33dd44ee";
const PARTNER = "6512f0aa11bb22cc33dd4400";

const coupleTasks = () => [
  { _id: "k2", title: "Choose a palette for the sangeet", dueDate: "2026-09-14", done: false, remind: false, createdByName: "Ananya Sharma", createdBy: ME },
  { _id: "k4", title: "Confirm the haldi venue with Amma", dueDate: "2026-09-04", done: false, remind: false, createdByName: "Karthik Reddy", createdBy: PARTNER },
  { _id: "k9", title: "Someday: write the vows", dueDate: null, done: false, remind: false, createdByName: "Ananya Sharma", createdBy: ME },
];
const milestones = () => [
  { _id: "m1", title: "Send Ravi the guest count for the sangeet", dueDate: "2026-09-12", status: "PENDING", source: "AI" },
  { _id: "m2", title: "Book the trial with Aisha", dueDate: "2026-10-20", status: "COMPLETED", source: "Custom" },
];

console.log("Both halves arrive:");
{
  const rows = CoupleTaskService.unite(coupleTasks(), milestones(), ME);
  eq(rows.length, 5, "three of the couple's and two of the team's");
  eq(rows.filter((r) => r.source === "couple").length, 3, "the couple's are marked 'couple'");
  eq(rows.filter((r) => r.source === "milestone").length, 2, "the team's are marked 'milestone'");
  eq(rows.find((r) => r.id === "m1").createdBy, "Your planner", "a milestone is attributed (§ 05.3)");
  eq(rows.find((r) => r.id === "m2").done, true, "COMPLETED reads as done");
  eq(rows.find((r) => r.id === "m1").remind, false, "a milestone has no reminder — that flag is the couple's");
  eq(CoupleTaskService.unite([], [], ME).length, 0, "an empty wedding is an empty list, not a throw");
  eq(CoupleTaskService.unite(null, undefined, ME).length, 0, "missing halves are not a throw");
}

console.log("readOnly marks the half the couple cannot write:");
{
  const rows = CoupleTaskService.unite(coupleTasks(), milestones(), ME);
  ok(rows.filter((r) => r.source === "milestone").every((r) => r.readOnly === true), "every milestone row is readOnly");
  ok(rows.filter((r) => r.source === "couple").every((r) => r.readOnly === false), "every couple row is not");
  // The marker is a courtesy so a screen can grey the row rather than offer a
  // toggle that will be refused. It is NOT the control — the control is that
  // no write in this service touches WeddingMilestone at all.
  ok(rules.isWritableTask(rows.find((r) => r.id === "k2")), "a couple task is writable");
  ok(!rules.isWritableTask(rows.find((r) => r.id === "m1")), "a milestone is not");
  ok(!rules.isWritableTask({ source: "couple", readOnly: true }), "a row marked readOnly is not, whatever its source");
  ok(!rules.isWritableTask({ source: "milestone" }), "source alone is enough to refuse");
  ok(!rules.isWritableTask(null), "no row is not writable");
  ok(!rules.isWritableTask({}), "a row with no source is not writable — fail closed");
  ok(!rules.isWritableTask({ source: "AI" }), "nor one carrying WeddingMilestone's own source values");
  ok(!rules.isWritableTask({ source: "Custom" }), "…either of them");
}

console.log("createdBy is the one viewer-relative field:");
{
  // Tasks.js hides the attribution line when it reads "you", so a task shows
  // its author to the OTHER partner and not back to its own.
  const mine = CoupleTaskService.unite(coupleTasks(), [], ME);
  eq(mine.find((r) => r.id === "k2").createdBy, "you", "my own task says 'you'");
  eq(mine.find((r) => r.id === "k4").createdBy, "Karthik Reddy", "my partner's task names them");
  const theirs = CoupleTaskService.unite(coupleTasks(), [], PARTNER);
  eq(theirs.find((r) => r.id === "k2").createdBy, "Ananya Sharma", "…and the same row names me, to them");
  eq(theirs.find((r) => r.id === "k4").createdBy, "you", "symmetrically");
  eq(CoupleTaskService.unite(coupleTasks(), [], null).find((r) => r.id === "k2").createdBy, "Ananya Sharma",
     "with no viewer, nobody is 'you'");
}

console.log("The order the screen opens on:");
{
  const rows = CoupleTaskService.unite(coupleTasks(), milestones(), ME);
  eq(rows.map((r) => r.id).join(","), "k4,m1,k2,m2,k9", "by due date, both halves interleaved, undated last");
  eq(rows[rows.length - 1].id, "k9", "an undated task sinks to the bottom, not to 1970");
  eq(rules.taskOrder({ dueDate: "not a date" }, { dueDate: "2026-01-01" }) > 0, true,
     "an unparseable date sinks too, rather than sorting as NaN");
  eq(rules.taskOrder({ dueDate: null, title: "a" }, { dueDate: null, title: "b" }) < 0, true,
     "two undated tasks are ordered by title, so the list does not reshuffle between loads");
  eq(rules.taskOrder(null, null), 0, "two missing rows do not throw");
}

console.log("The union does not touch what it read:");
{
  const source = milestones();
  const before = JSON.stringify(source);
  CoupleTaskService.unite(coupleTasks(), source, ME);
  ok(JSON.stringify(source) === before, "the milestone documents are unchanged by being rendered");
  const own = coupleTasks();
  const ownBefore = JSON.stringify(own);
  CoupleTaskService.unite(own, source, ME);
  ok(JSON.stringify(own) === ownBefore, "…and so are the couple's");
}

console.log("The refusal a milestone write gets:");
{
  const denial = rules.milestoneDenial();
  eq(denial.error, "forbidden", "403, in the foundation's own body shape — wedsy-user's read() keys on this");
  eq(denial.section, "tasks", "it names the section");
  eq(denial.required, "edit", "and the level asked for");
  ok(/planner/i.test(denial.message), "and says whose task it is rather than pretending it is missing");
  ok(!/error|invalid/i.test(denial.message), "in the product's voice, not a stack trace's");
}

console.log("WRITE ISOLATION — no couple-app file writes WeddingMilestone:");
{
  const files = [
    "services/CoupleTaskService.js",
    "services/CoupleGuestService.js",
    "services/CoupleMemberService.js",
    "services/CouplePeopleRules.js",
    "controllers/coupleAppPeople.js",
    "routes/coupleApp-people.js",
  ];
  // Every mongoose verb that can change a document. `find`/`findById` are the
  // only two this feature is allowed to aim at the CRM's timeline.
  const WRITES = /WeddingMilestone\s*\.\s*(create|insertMany|save|update|updateOne|updateMany|replaceOne|deleteOne|deleteMany|remove|bulkWrite|findByIdAndUpdate|findByIdAndDelete|findByIdAndRemove|findOneAndUpdate|findOneAndDelete|findOneAndReplace|findOneAndRemove)\b/;
  files.forEach((rel) => {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    ok(!WRITES.test(src), `${rel} aims no write verb at WeddingMilestone`);
  });
  const service = fs.readFileSync(path.join(__dirname, "..", "services/CoupleTaskService.js"), "utf8");
  const refs = service.match(/WeddingMilestone\s*\.\s*[A-Za-z]+/g) || [];
  eq(refs.join(","), "WeddingMilestone.find", "the ONE call the tasks service makes on it is a read");
  const routes = fs.readFileSync(path.join(__dirname, "..", "routes/coupleApp-people.js"), "utf8");
  const routeRefs = routes.match(/WeddingMilestone\s*\.\s*[A-Za-z]+/g) || [];
  eq(routeRefs.join(","), "WeddingMilestone.findById", "and the one the router makes is a read too");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
