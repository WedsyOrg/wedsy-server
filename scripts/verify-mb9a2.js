/* MB9a-2 — golden-window clock + rescue escalation. Verifies the derived clock
 * (start = creation vs Kiara-handoff; in-window/breach; contact stamp; duration
 * from settings), the respond-now queue, scope-aware metrics, and the rescue
 * tiers incl. the ATOMIC first-claim-wins (two concurrent claims → one wins, the
 * other 409). Test port 8161. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8161; const BASE = `http://localhost:${PORT}`; const MARK = "MB9A2";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };
const MIN = 60000;

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry"); const WAConversation = require("../models/WAConversation");
  const LeadInternalEvent = require("../models/LeadInternalEvent"); const AdminNotification = require("../models/AdminNotification");
  const Setting = require("../models/Setting"); const SettingsService = require("../services/SettingsService");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const teamRole = await Role.create({ name: `${MARK} Team`, departmentId: dept._id, permissions: ["leads:view:team", "leads:edit:team"] });
  const revRole = await Role.create({ name: `${MARK} RevHead`, departmentId: dept._id, permissions: ["*:*:all"] });
  const ownRole = await Role.create({ name: `${MARK} Own`, departmentId: dept._id, permissions: ["leads:view:own", "leads:edit:own"] });
  const u = (s) => `9197${String(Date.now()).slice(-7)}${s}`;
  const mk = (name, roleIds, mgr) => Admin.create({ name: `${MARK} ${name}`, email: `${name}-${Date.now()}@t.local`, phone: u(Math.floor(Math.random() * 9)), password: "x", roleIds, departmentId: dept._id, reportingManagerId: mgr || null, status: "active" });
  const MANAGER = await mk("Manager", [teamRole._id]);
  const INTERN = await mk("Intern", [ownRole._id], MANAGER._id);
  const REVHEAD = await mk("RevHead", [revRole._id]);
  const OUTSIDER = await mk("Outsider", [ownRole._id]);
  const tok = (a) => jwt.sign({ _id: String(a._id), isAdmin: true }, process.env.JWT_SECRET);
  const internT = tok(INTERN), mgrT = tok(MANAGER), revT = tok(REVHEAD), outT = tok(OUTSIDER);

  const now = Date.now();
  const mkLead = async (n, over) => Enquiry.create({ name: `${MARK} ${n}`, phone: `9190${String(now).slice(-7)}${n}`, verified: false, source: "Website", stage: "new", assignedTo: INTERN._id, additionalInfo: {}, ...over });
  const direct = await mkLead("Direct");                                          // created now → in-window
  const kiara = await mkLead("Kiara");                                            // created now, but handoff 40m ago
  const contacted = await mkLead("Contacted", { firstCalledAt: new Date(now - 2 * MIN) }); // contacted in-window
  const breachLead = await mkLead("Breach", { createdAt: new Date(now - 40 * MIN) }); // created 40m ago → breached
  const dismissLead = await mkLead("Dismiss", { createdAt: new Date(now - 40 * MIN) });
  // Kiara handoff signal: needs-human 40m ago → its clock starts at handoff (breached).
  await WAConversation.create({ enquiryId: kiara._id, phone: kiara.phone, normalizedPhone: kiara.phone.slice(-10), needsHuman: true, needsHumanAt: new Date(now - 40 * MIN), status: "active" });

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Slice 1: clock start rule + states ──");
    const cD = await api("GET", `/enquiry/${direct._id}/golden-window`, internT);
    ok(cD.status === 200 && cD.data.state === "in_window" && cD.data.fromKiara === false, "direct lead: clock starts at creation → in-window");
    ok(cD.data.durationMinutes === 30, "duration from settings (default 30)");
    const cK = await api("GET", `/enquiry/${kiara._id}/golden-window`, internT);
    ok(cK.data.fromKiara === true && cK.data.state === "breached", "Kiara lead: clock starts at handoff (needsHumanAt) → breached");
    const cC = await api("GET", `/enquiry/${contacted._id}/golden-window`, internT);
    ok(cC.data.state === "contacted" && cC.data.inWindow === true, "contacted lead: first-contact stamps in-window, exits the window");

    console.log("\n── Slice 1: duration is settings-driven ──");
    await api("PUT", "/settings", revT, { key: "sla.goldenWindowMinutes", value: 10 });
    const cD10 = await api("GET", `/enquiry/${breachLead._id}/golden-window`, internT);
    ok(cD10.data.durationMinutes === 10, "duration follows the setting (10)");
    await api("PUT", "/settings", revT, { key: "sla.goldenWindowMinutes", value: 30 }); // restore

    console.log("\n── Slice 2: respond-now queue (urgency-sorted) ──");
    const rn = await api("GET", "/enquiry/respond-now", internT);
    const rnIds = (rn.data.rows || []).map((r) => r._id);
    ok(rn.status === 200 && rnIds.includes(String(direct._id)) && rnIds.includes(String(breachLead._id)), "respond-now lists the caller's uncontacted active leads");
    ok(!rnIds.includes(String(contacted._id)), "respond-now excludes already-contacted leads");
    ok(rn.data.rows[0].breached === true, "breached leads sort to the top (most urgent)");
    const rnOut = await api("GET", "/enquiry/respond-now", outT);
    ok(rnOut.status === 200 && rnOut.data.rows.length === 0, "another admin's respond-now is empty (scoped to their own leads)");

    console.log("\n── Slice 3: metrics (scope-aware, team) ──");
    const met = await api("GET", "/enquiry/golden-window/metrics?periodDays=7", mgrT);
    ok(met.status === 200 && typeof met.data.inWindowPct === "number" && met.data.breachCount >= 1, `metrics compute (inWindow ${met.data.inWindowPct}% · ${met.data.breachCount} breaches)`);
    ok(met.data.avgFirstResponseMinutes !== undefined, "metrics include avg first-response");

    console.log("\n── Slice 4: rescue queue (manager + RevHead see breached; IC does not) ──");
    const rqMgr = await api("GET", "/enquiry/rescue-queue", mgrT);
    const rqIds = (rqMgr.data.rows || []).map((r) => r._id);
    ok(rqMgr.status === 200 && rqIds.includes(String(breachLead._id)) && rqIds.includes(String(kiara._id)), "manager rescue-queue surfaces subordinates' breached leads");
    ok(rqMgr.data.rows.find((r) => r._id === String(breachLead._id)).tier === 3, "breached lead is tier-3 (persistent)");
    const rqRev = await api("GET", "/enquiry/rescue-queue", revT);
    ok((rqRev.data.rows || []).some((r) => r._id === String(breachLead._id)), "Revenue Head (all scope) also sees it");
    const rqIc = await api("GET", "/enquiry/rescue-queue", internT);
    ok(rqIc.status === 200 && rqIc.data.rows.length === 0, "an own-scope IC sees no rescue items");

    console.log("\n── Slice 4: tier-2 notify fired + rate-limited ──");
    // The assignee's reporting manager is a deterministic tier-2 recipient (the
    // Revenue-Head recipient depends on the canonical "Revenue Head" role, which
    // the dev DB also seeds — not asserted here to avoid the name collision).
    const note = await waitFor(async () => (await AdminNotification.findOne({ adminId: MANAGER._id, type: "rescue_needed" }).lean()) || false, "rescue_needed notification");
    ok(!!note, "tier-2 notifies the reporting manager via AdminNotificationService");
    const before = await AdminNotification.countDocuments({ adminId: MANAGER._id, type: "rescue_needed" });
    await api("GET", "/enquiry/rescue-queue", mgrT); // poll again immediately
    const after = await AdminNotification.countDocuments({ adminId: MANAGER._id, type: "rescue_needed" });
    ok(after === before, "re-poll within the cooldown does NOT re-notify (rate-limited)");

    console.log("\n── Slice 4: ATOMIC first-claim-wins (two concurrent claims) ──");
    const [c1, c2] = await Promise.all([
      api("POST", `/enquiry/${breachLead._id}/rescue/claim`, mgrT, {}),
      api("POST", `/enquiry/${breachLead._id}/rescue/claim`, revT, {}),
    ]);
    const statuses = [c1.status, c2.status].sort();
    ok(statuses[0] === 200 && statuses[1] === 409, `exactly one claim wins (got ${c1.status}/${c2.status})`);
    const winner = c1.status === 200 ? c1 : c2;
    ok(winner.data.claimed === true && winner.data.openCall === true, "the winning claim reassigns + signals openCall");
    const claimed = await Enquiry.findById(breachLead._id).lean();
    ok([String(MANAGER._id), String(REVHEAD._id)].includes(String(claimed.assignedTo)), "the lead is reassigned to the claimer");

    console.log("\n── Slice 4: dismiss removes from the rescue queue ──");
    await api("POST", `/enquiry/${dismissLead._id}/rescue/dismiss`, mgrT, {});
    const rqAfter = await api("GET", "/enquiry/rescue-queue", mgrT);
    ok(!(rqAfter.data.rows || []).some((r) => r._id === String(dismissLead._id)), "a dismissed lead drops out of the rescue queue");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-2000));
  } finally {
    const leadIds = [direct._id, kiara._id, contacted._id, breachLead._id, dismissLead._id];
    await WAConversation.deleteMany({ enquiryId: { $in: leadIds } });
    await LeadInternalEvent.deleteMany({ leadId: { $in: leadIds } });
    await AdminNotification.deleteMany({ adminId: { $in: [MANAGER._id, INTERN._id, REVHEAD._id, OUTSIDER._id] } });
    await Enquiry.deleteMany({ _id: { $in: leadIds } });
    await Admin.deleteMany({ _id: { $in: [MANAGER._id, INTERN._id, REVHEAD._id, OUTSIDER._id] } });
    await Role.deleteMany({ _id: { $in: [teamRole._id, revRole._id, ownRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    await Setting.deleteMany({ key: "sla.goldenWindowMinutes" });
    SettingsService.invalidate();
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
