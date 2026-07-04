/* Slice 4 verify — journey renderer names its actors for every event type.
 * Seeds a lead + two admins + one event per actor-bearing type, runs
 * JourneyService.buildJourney, asserts the rendered titles, cleans up.
 * Local DB only, no server. Run: node scripts/test-journey-actors.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.error(`  ✗ ${label}`); }
};

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Enquiry = require("../models/Enquiry");
  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const Department = require("../models/Department");
  const LeadInternalEvent = require("../models/LeadInternalEvent");
  const JourneyService = require("../services/JourneyService");

  const MARK = "JOURNEY-ACTORS";
  const dept = await Department.create({ name: `${MARK} Dept` });
  const role = await Role.create({ name: `${MARK} Role`, departmentId: dept._id, permissions: ["leads:view:own"] });
  const alice = await Admin.create({ name: "Alice Intern", email: `ja-alice-${Date.now()}@test.local`, phone: "919900000401", password: "x", roleId: role._id, departmentId: dept._id, status: "active" });
  const bob = await Admin.create({ name: "Bob Manager", email: `ja-bob-${Date.now()}@test.local`, phone: "919900000402", password: "x", roleId: role._id, departmentId: dept._id, status: "active" });
  const carol = await Admin.create({ name: "Carol Head", email: `ja-carol-${Date.now()}@test.local`, phone: "919900000403", password: "x", roleId: role._id, departmentId: dept._id, status: "active" });

  const lead = await Enquiry.create({
    name: "Journey Test Lead", phone: "919900000400", verified: false, source: "Website",
    additionalInfo: {}, stage: "new", assignedTo: bob._id,
  });

  const ev = (type, payload, actorId = null) =>
    LeadInternalEvent.create({ leadId: lead._id, type, actorId, payload });

  try {
    // One event per actor-bearing type, with the SAME payload shape the real
    // producers write (see LeadAssignmentService / TriageService / CalendarEventService).
    await ev("transferred", { from: String(alice._id), to: String(bob._id), toName: "Bob Manager" }, carol._id);
    await ev("transferred", { from: String(alice._id), to: String(bob._id), toName: "Bob Manager", reason: "meet_handoff" }, alice._id);
    await ev("meet_handoff", { internId: String(alice._id), internName: "Alice Intern", managerId: String(bob._id), managerName: "Bob Manager" }, alice._id);
    await ev("auto_assigned", { assignedTo: String(alice._id), assignedToName: "Alice Intern" });
    await ev("triage_assigned", { to: String(alice._id), toName: "Alice Intern", self: false }, carol._id);
    await ev("triage_assigned", { to: String(carol._id), toName: "Carol Head", self: true }, carol._id);
    await ev("triage_auto_assigned", { to: String(alice._id), toName: "Alice Intern", reason: "auto-assigned: triage was in meetings" });
    await ev("resurfaced_by_reenquiry", { source: "whatsapp", reassignedTo: String(bob._id) });
    await ev("wa_human_takeover", {}, bob._id);

    const { entries } = await JourneyService.buildJourney(lead._id);
    const byType = (t) => entries.filter((e) => e.type === t);
    const titleOf = (t, i = 0) => (byType(t)[i] || {}).title || "";

    console.log("\n── Journey actor naming ──");
    ok(titleOf("transferred", 0) === "Transferred from Alice Intern to Bob Manager", `transfer names from+to (got: "${titleOf("transferred", 0)}")`);
    ok(titleOf("transferred", 1) === "Auto-transferred from Alice Intern to Bob Manager — meeting booked", `transfer(meet_handoff) reads auto-transfer (got: "${titleOf("transferred", 1)}")`);
    ok(titleOf("meet_handoff") === "Auto-transferred from Alice Intern to Bob Manager — meeting booked", `meet_handoff names intern+manager (got: "${titleOf("meet_handoff")}")`);
    ok(titleOf("auto_assigned") === "Auto-assigned to Alice Intern", `auto_assigned names assignee (got: "${titleOf("auto_assigned")}")`);
    ok(titleOf("triage_assigned", 0) === "Assigned from triage to Alice Intern", `triage_assigned names assignee (got: "${titleOf("triage_assigned", 0)}")`);
    ok(titleOf("triage_assigned", 1) === "Took it from triage", `triage self-assign reads "took it" (got: "${titleOf("triage_assigned", 1)}")`);
    ok(titleOf("triage_auto_assigned") === "Auto-assigned from triage to Alice Intern", `triage_auto_assigned names assignee (got: "${titleOf("triage_auto_assigned")}")`);
    ok(titleOf("resurfaced_by_reenquiry").includes("back to Bob Manager"), `resurfaced names reassignee (got: "${titleOf("resurfaced_by_reenquiry")}")`);
    // The actor field is populated (not "—") for human-actor events.
    ok(byType("transferred")[0].actor === "Carol Head", `transfer actor resolved (got: "${byType("transferred")[0].actor}")`);
    ok(byType("wa_human_takeover")[0].actor === "Bob Manager", `wa takeover actor resolved (got: "${byType("wa_human_takeover")[0].actor}")`);
    // No actor-bearing entry shows an unresolved "—".
    const dashes = entries.filter((e) => e.actor === "—");
    ok(dashes.length === 0, `no unresolved actors (found ${dashes.length}: ${dashes.map((d) => d.type).join(",")})`);
  } catch (e) {
    fail++;
    failures.push(`fatal: ${e.message}`);
    console.error("FATAL", e);
  } finally {
    await LeadInternalEvent.deleteMany({ leadId: lead._id });
    await Enquiry.deleteMany({ _id: lead._id });
    await Admin.deleteMany({ _id: { $in: [alice._id, bob._id, carol._id] } });
    await Role.deleteMany({ _id: role._id });
    await Department.deleteMany({ _id: dept._id });
    await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
