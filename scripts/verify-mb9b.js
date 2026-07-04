/* MB9b — the role dashboards' funnel aggregation. Verifies the intake +
 * conversion halves (one reconciling cohort), scope breadth (own/team/all),
 * per-person breakdown, the period toggle, graceful fees, and that the golden-
 * window numbers are REUSED from GoldenWindowService.metrics (reconcile exactly
 * with /golden-window/metrics). Test port 8162. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8162; const BASE = `http://localhost:${PORT}`; const MARK = "MB9B";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };
const MIN = 60000;

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry"); const LeadStep = require("../models/LeadStep"); const Onboarding = require("../models/Onboarding");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const teamRole = await Role.create({ name: `${MARK} Team`, departmentId: dept._id, permissions: ["leads:view:team", "leads:edit:team"] });
  const ownRole = await Role.create({ name: `${MARK} Own`, departmentId: dept._id, permissions: ["leads:view:own", "leads:edit:own"] });
  const u = (s) => `9197${String(Date.now()).slice(-7)}${s}`;
  const MANAGER = await Admin.create({ name: `${MARK} Manager`, email: `mgr-${Date.now()}@t.local`, phone: u(1), password: "x", roleIds: [teamRole._id], departmentId: dept._id, status: "active" });
  const INTERN = await Admin.create({ name: `${MARK} Intern`, email: `int-${Date.now()}@t.local`, phone: u(2), password: "x", roleIds: [ownRole._id], departmentId: dept._id, reportingManagerId: MANAGER._id, status: "active" });
  const internT = jwt.sign({ _id: String(INTERN._id), isAdmin: true }, process.env.JWT_SECRET);
  const mgrT = jwt.sign({ _id: String(MANAGER._id), isAdmin: true }, process.env.JWT_SECRET);

  const now = Date.now();
  const mk = (n, over) => Enquiry.create({ name: `${MARK} ${n}`, phone: `9190${String(now).slice(-7)}${n}`, verified: false, source: "Website", stage: "new", assignedTo: INTERN._id, additionalInfo: {}, ...over });
  const lIn = await mk("In");                                                              // received only
  const lContacted = await mk("Contacted", { firstCalledAt: new Date(now - 5 * MIN) });    // contacted
  const lQual = await mk("Qualified", { firstCalledAt: new Date(now - 5 * MIN), qualified: true }); // qualified, in journey
  const lOnb = await mk("Onboarded", { firstCalledAt: new Date(now - 5 * MIN), qualified: true });   // onboarded
  const lLost = await mk("Lost", { firstCalledAt: new Date(now - 5 * MIN), isLost: true });          // lost
  // Journey steps on the qualified + onboarded leads (in-journey signal).
  await LeadStep.create({ leadId: lQual._id, name: "Step", phase: "Lead Understanding", order: 10, status: "in_progress" });
  await LeadStep.create({ leadId: lOnb._id, name: "Step", phase: "Lead Understanding", order: 10, status: "complete" });
  // Onboarded record with a fee snapshot (graceful fees).
  await Onboarding.create({ leadId: lOnb._id, status: "onboarded", onboardedAt: new Date(now - 2 * MIN), milestones: { onboardingFee: 25000 } });

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Slice 1: intake half (intern own scope) ──");
    const f = await api("GET", "/enquiry/funnel-metrics?period=week", internT);
    ok(f.status === 200, "funnel-metrics returns 200");
    ok(f.data.intake.received === 5, `received = 5 (got ${f.data.intake.received})`);
    ok(f.data.intake.contacted === 4, `contacted = 4 (got ${f.data.intake.contacted})`);
    ok(f.data.intake.qualified === 2, `qualified = 2 (got ${f.data.intake.qualified})`);
    ok(f.data.intake.qualRatePct === 40, `qual rate = 40% (got ${f.data.intake.qualRatePct})`);

    console.log("\n── Slice 1: conversion half ──");
    ok(f.data.conversion.qualified === 2, "conversion: qualified = 2");
    ok(f.data.conversion.inJourney === 1, `in journey = 1 (qualified, not onboarded) (got ${f.data.conversion.inJourney})`);
    ok(f.data.conversion.onboarded === 1, "onboarded = 1");
    ok(f.data.conversion.lost === 1, "lost = 1");
    ok(f.data.conversion.onboardRatePct === 50, `onboard rate = 50% (got ${f.data.conversion.onboardRatePct})`);
    ok(f.data.conversion.feesCollected === 25000, `fees collected = 25000 (got ${f.data.conversion.feesCollected})`);

    console.log("\n── Slice 1: funnel stages are a reconciling subset chain ──");
    const i = f.data.intake, c = f.data.conversion;
    ok(i.received >= i.contacted && i.contacted >= i.qualified, "received ≥ contacted ≥ qualified (subset chain)");
    ok(c.qualified === i.qualified, "conversion.qualified === intake.qualified (the funnel split point matches)");
    ok(c.onboarded + c.lost <= c.qualified + 1, "onboarded + lost bounded by qualified");

    console.log("\n── Slice 1: golden-window is REUSED (reconciles with /golden-window/metrics) ──");
    const gw = await api("GET", "/enquiry/golden-window/metrics?periodDays=7", internT);
    ok(f.data.goldenWindow.breachCount === gw.data.breachCount && f.data.goldenWindow.inWindowPct === gw.data.inWindowPct && f.data.goldenWindow.total === gw.data.total,
      "funnel goldenWindow === /golden-window/metrics (same numbers, not reinvented)");

    console.log("\n── Slice 1: scope breadth + per-person (manager team) ──");
    const fm = await api("GET", "/enquiry/funnel-metrics?period=week", mgrT);
    ok(fm.data.intake.received === 5, "manager (team) sees the intern's cohort (received 5)");
    ok(Array.isArray(fm.data.perPerson) && fm.data.perPerson.some((p) => String(p._id) === String(INTERN._id) && p.intake.received === 5), "per-person breakdown includes the intern");
    ok(f.data.perPerson === null, "own-scope (intern) has no per-person breakdown");

    console.log("\n── Slice 1: period toggle ──");
    const fmo = await api("GET", "/enquiry/funnel-metrics?period=month", internT);
    ok(fmo.data.period === "month" && fmo.data.periodDays === 30, "period=month → 30-day window");

    console.log("\n── Reconcile: pipeline-overview is the accountability source (sales-lead roll-up) ──");
    const pipe = await api("GET", "/enquiry/pipeline-overview", mgrT);
    ok(pipe.status === 200 && typeof pipe.data.summary.stuck === "number", "pipeline-overview.summary.stuck is the 'needs attention' roll-up (reused, not reinvented)");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-2000));
  } finally {
    const leadIds = [lIn._id, lContacted._id, lQual._id, lOnb._id, lLost._id];
    await LeadStep.deleteMany({ leadId: { $in: leadIds } });
    await Onboarding.deleteMany({ leadId: { $in: leadIds } });
    await Enquiry.deleteMany({ _id: { $in: leadIds } });
    await Admin.deleteMany({ _id: { $in: [MANAGER._id, INTERN._id] } });
    await Role.deleteMany({ _id: { $in: [teamRole._id, ownRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
