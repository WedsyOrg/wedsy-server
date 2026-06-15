/* MB8b — Journey Steps + Notes + Mirror. Verifies: step-definition seed
 * (idempotent, 3-phase) + CRUD/reorder; per-lead instantiation (endpoint AND
 * the qualification trigger); 4 statuses only; owners from the roster
 * (multi-owner, off-roster rejected); dependency soft-block + cycle-validate;
 * actor-named journey events; step notes mirroring into the lead chat with
 * back-link + @tag notification; one-direction. Test port 8156. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8156; const BASE = `http://localhost:${PORT}`; const MARK = "MB8B";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry"); const LeadStep = require("../models/LeadStep"); const StepDefinition = require("../models/StepDefinition");
  const LeadTeamMember = require("../models/LeadTeamMember"); const LeadChatMessage = require("../models/LeadChatMessage");
  const AdminNotification = require("../models/AdminNotification"); const LeadInternalEvent = require("../models/LeadInternalEvent");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const bossRole = await Role.create({ name: `${MARK} Boss`, departmentId: dept._id, permissions: ["leads:view:all", "leads:edit:all", "settings:edit:all"] });
  const u = (s) => `9197${String(Date.now()).slice(-7)}${s}`;
  const BOSS = await Admin.create({ name: `${MARK} Boss`, email: `boss-${Date.now()}@t.local`, phone: u(1), password: "x", roleIds: [bossRole._id], departmentId: dept._id, status: "active" });
  const MATE = await Admin.create({ name: `${MARK} Mate`, email: `mate-${Date.now()}@t.local`, phone: u(2), password: "x", roleIds: [bossRole._id], departmentId: dept._id, status: "active" });
  const tok = (a) => jwt.sign({ _id: String(a._id), isAdmin: true }, process.env.JWT_SECRET);
  const bossT = tok(BOSS);

  const phone1 = `9190${String(Date.now()).slice(-8)}`;
  const phone2 = `9191${String(Date.now()).slice(-8)}`;
  const lead = await Enquiry.create({ name: "Steps Couple", phone: phone1, verified: false, source: "Website", stage: "lead", assignedTo: BOSS._id, additionalInfo: {} });
  // Second lead for the qualification-trigger test. kiaraSummary preset so the
  // qualified path skips the (Anthropic) summary call and we isolate the trigger.
  const lead2 = await Enquiry.create({ name: "Trigger Couple", phone: phone2, verified: false, source: "Website", stage: "lead", assignedTo: BOSS._id, additionalInfo: {}, kiaraSummary: { text: "preset", generatedAt: new Date() } });

  // Roster: BOSS + MATE are on lead 1's team (so they can own steps).
  await LeadTeamMember.create({ leadId: lead._id, personId: BOSS._id, departmentName: `${MARK} Dept`, addedBy: BOSS._id });
  await LeadTeamMember.create({ leadId: lead._id, personId: MATE._id, departmentName: `${MARK} Dept`, addedBy: BOSS._id });
  // An admin NOT on the roster (off-roster owner rejection test).
  const OUTSIDER = await Admin.create({ name: `${MARK} Outsider`, email: `out-${Date.now()}@t.local`, phone: u(3), password: "x", roleIds: [bossRole._id], status: "active" });

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  const createdDefIds = [];
  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Slice 1: step-definition seed (idempotent, 3-phase) ──");
    const seed1 = await api("POST", "/step-definition/seed", bossT);
    ok(seed1.status === 200 && seed1.data.total === 18, "seed reports the 18-step Wedsy set");
    const seed2 = await api("POST", "/step-definition/seed", bossT);
    ok(seed2.status === 200 && seed2.data.created === 0, "re-seed is idempotent (creates 0)");
    const defs = await api("GET", "/step-definition", bossT);
    ok(defs.status === 200 && defs.data.phases.length === 3, "definitions expose the 3 phases");
    const active = defs.data.list;
    const followUps = active.filter((d) => d.name === "Client Follow Up");
    ok(followUps.length === 2 && followUps.every((d) => d.rolling), "'Client Follow Up' appears in 2 phases, both rolling");
    const va = active.find((d) => d.name === "Venue Assistance");
    ok(va && va.rolling && va.optional, "'Venue Assistance' is rolling + optional");

    console.log("\n── Slice 1: definition CRUD + reorder + settings gate ──");
    const created = await api("POST", "/step-definition", bossT, { name: `${MARK} Custom Step`, phase: "Lead Understanding" });
    ok(created.status === 201 && created.data._id, "create a step definition");
    createdDefIds.push(created.data._id);
    const renamed = await api("PUT", `/step-definition/${created.data._id}`, bossT, { name: `${MARK} Renamed`, rolling: true, optional: true });
    ok(renamed.status === 200 && renamed.data.name === `${MARK} Renamed` && renamed.data.rolling && renamed.data.optional, "rename + toggle rolling/optional");
    const archived = await api("DELETE", `/step-definition/${created.data._id}`, bossT);
    ok(archived.status === 200 && archived.data.status === "archived", "delete archives (soft)");
    // A roleless admin proves the settings:edit:all gate on definition writes.
    const nobody = await Admin.create({ name: `${MARK} Nobody`, email: `nob-${Date.now()}@t.local`, phone: u(4), password: "x", roleIds: [], status: "active" });
    const gate = await api("POST", "/step-definition", jwt.sign({ _id: String(nobody._id), isAdmin: true }, process.env.JWT_SECRET), { name: "x", phase: "Lead Understanding" });
    ok(gate.status === 403, "no-permission admin cannot edit definitions (settings gate)");
    await Admin.deleteMany({ _id: nobody._id });

    console.log("\n── Slice 2: per-lead instantiation (endpoint + idempotent) ──");
    const inst1 = await api("POST", `/enquiry/${lead._id}/steps/instantiate`, bossT);
    ok(inst1.status === 200 && inst1.data.created > 0, `instantiate stamps steps (${inst1.data.created})`);
    const inst2 = await api("POST", `/enquiry/${lead._id}/steps/instantiate`, bossT);
    ok(inst2.status === 200 && inst2.data.created === 0, "instantiate is idempotent (creates 0 the second time)");
    const steps = (await api("GET", `/enquiry/${lead._id}/steps`, bossT)).data.list;
    ok(steps.length > 0 && steps.every((s) => s.status === "not_started"), "steps start as not_started");
    ok(steps.every((s) => ["Lead Understanding", "Client Servicing & Proposal", "Follow Up & Conversion"].includes(s.phase)), "steps carry their phase");

    console.log("\n── Slice 2: qualification TRIGGER instantiates steps ──");
    const CallCockpitService = require("../services/CallCockpitService");
    await CallCockpitService.logCall(lead2._id, { startedAt: new Date().toISOString(), durationSeconds: 60, connected: true, outcome: "qualified", notes: "trigger" }, BOSS._id);
    const trigCount = await waitFor(async () => { const c = await LeadStep.countDocuments({ leadId: lead2._id }); return c > 0 ? c : false; }, "trigger created steps");
    ok(trigCount > 0, `qualified call instantiated steps on the lead (${trigCount})`);

    console.log("\n── Slice 2: owners from roster (multi) + 4 statuses only ──");
    const s0 = steps[0], s1 = steps[1], s2 = steps[2];
    const own = await api("PATCH", `/enquiry/${lead._id}/steps/${s0._id}`, bossT, { ownerIds: [String(BOSS._id), String(MATE._id)] });
    ok(own.status === 200 && own.data.owners.length === 2, "assign multiple owners from the roster");
    const offRoster = await api("PATCH", `/enquiry/${lead._id}/steps/${s0._id}`, bossT, { ownerIds: [String(OUTSIDER._id)] });
    ok(offRoster.status === 400, "off-roster owner rejected");
    const badStatus = await api("PATCH", `/enquiry/${lead._id}/steps/${s0._id}`, bossT, { status: "blocked" });
    ok(badStatus.status === 400, "invalid status rejected (only the 4 allowed)");
    const goodStatus = await api("PATCH", `/enquiry/${lead._id}/steps/${s0._id}`, bossT, { status: "in_progress" });
    ok(goodStatus.status === 200 && goodStatus.data.status === "in_progress", "valid status accepted");

    console.log("\n── Slice 2: dependencies (soft-block + cycle-validate) ──");
    const dep = await api("PATCH", `/enquiry/${lead._id}/steps/${s2._id}`, bossT, { dependsOn: [String(s1._id)] });
    ok(dep.status === 200 && dep.data.blocked === true, "s2 depends on s1 → blocked while s1 incomplete");
    const blockedStart = await api("PATCH", `/enquiry/${lead._id}/steps/${s2._id}`, bossT, { status: "in_progress" });
    ok(blockedStart.status === 409, "cannot START a blocked step (soft guard, 409)");
    await api("PATCH", `/enquiry/${lead._id}/steps/${s1._id}`, bossT, { status: "complete" });
    const unblockedStart = await api("PATCH", `/enquiry/${lead._id}/steps/${s2._id}`, bossT, { status: "in_progress" });
    ok(unblockedStart.status === 200, "after the prerequisite completes, the step can start");
    const cycle = await api("PATCH", `/enquiry/${lead._id}/steps/${s1._id}`, bossT, { dependsOn: [String(s2._id)] });
    ok(cycle.status === 400, "a dependency that would form a cycle is rejected");

    console.log("\n── Slice 2: journey events are actor-named ──");
    const journey = (await api("GET", `/enquiry/${lead._id}/journey`, bossT)).data.entries || [];
    const statusEv = journey.find((e) => e.type === "step_status_changed");
    ok(statusEv && statusEv.actor === `${MARK} Boss`, "step_status_changed event names the actor");
    ok(statusEv && /→ (In progress|Complete)/.test(statusEv.title), `status event title reads the step + status ("${statusEv && statusEv.title}")`);
    const ownerEv = journey.find((e) => e.type === "step_owners_assigned");
    ok(ownerEv && /Assigned .*Boss.*Mate/.test(ownerEv.title), "step_owners_assigned event names the owners");

    console.log("\n── Slice 3: step note MIRRORS into the lead chat (+ back-link, @tag) ──");
    const note = await api("POST", `/enquiry/${lead._id}/steps/${s0._id}/notes`, bossT, { body: "Spoke to the couple, sharing decor refs", mentions: [String(MATE._id)] });
    const noteStep = note.data;
    ok(note.status === 201 && (noteStep.notes || []).some((n) => /decor refs/.test(n.body)), "note saved on the step");

    const chat = (await api("GET", `/enquiry/${lead._id}/chat`, bossT)).data.messages || [];
    const mirrored = chat.find((m) => m.systemType === "step_note" && /added a note in .* — Spoke to the couple/.test(m.body));
    ok(!!mirrored, "note mirrored into the lead chat as a contextualized system message");
    ok(mirrored && String(mirrored.stepId) === String(s0._id), "mirrored chat message links back to the step (stepId)");
    ok(mirrored && (mirrored.mentions || []).map(String).includes(String(MATE._id)), "mirror preserves the @tag");
    const stepNote = (noteStep.notes || []).find((n) => /decor refs/.test(n.body));
    ok(stepNote && stepNote.chatMessageId, "step note stores its chat echo id (clickable both ways)");

    const mention = await waitFor(async () => { const n = await AdminNotification.findOne({ adminId: MATE._id, type: "chat_mention" }).lean(); return n || false; }, "chat_mention notification");
    ok(!!mention && String(mention.payload?.stepId) === String(s0._id), "@tag fires a chat_mention notification carrying the stepId");

    console.log("\n── Slice 3: ONE-DIRECTION (chat → step does NOT sync) ──");
    const beforeNotes = (await api("GET", `/enquiry/${lead._id}/steps`, bossT)).data.list.find((s) => String(s._id) === String(s0._id)).notes.length;
    await api("POST", `/enquiry/${lead._id}/chat`, bossT, { body: "a plain chat reply" });
    const afterNotes = (await api("GET", `/enquiry/${lead._id}/steps`, bossT)).data.list.find((s) => String(s._id) === String(s0._id)).notes.length;
    ok(beforeNotes === afterNotes, "posting in the chat does NOT create a step note (one-direction)");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-2000));
  } finally {
    await LeadStep.deleteMany({ leadId: { $in: [lead._id, lead2._id] } });
    await LeadChatMessage.deleteMany({ leadId: { $in: [lead._id, lead2._id] } });
    await LeadInternalEvent.deleteMany({ leadId: { $in: [lead._id, lead2._id] } });
    await LeadTeamMember.deleteMany({ leadId: lead._id });
    await AdminNotification.deleteMany({ adminId: { $in: [BOSS._id, MATE._id, OUTSIDER._id] } });
    await Enquiry.deleteMany({ _id: { $in: [lead._id, lead2._id] } });
    await Admin.deleteMany({ _id: { $in: [BOSS._id, MATE._id, OUTSIDER._id] } });
    await Role.deleteMany({ _id: bossRole._id });
    await Department.deleteMany({ _id: dept._id });
    if (createdDefIds.length) await StepDefinition.deleteMany({ _id: { $in: createdDefIds } });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
