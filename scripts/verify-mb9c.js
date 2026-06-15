/* MB9c — lead-list bulk actions + soft-delete. Verifies bulk tag/stage/lost,
 * scope rejection of out-of-scope batches, the FOUNDER-only soft-delete (a
 * non-founder gets 403; soft-delete sets archivedAt, is recoverable/not hard-
 * removed, excluded from the list, and audited). Test port 8163. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8163; const BASE = `http://localhost:${PORT}`; const MARK = "MB9C";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry"); const ActivityLog = require("../models/ActivityLog"); const LeadInternalEvent = require("../models/LeadInternalEvent");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const founderRole = await Role.create({ name: `${MARK} Founder`, departmentId: dept._id, permissions: ["*:*:all"] });
  const ownRole = await Role.create({ name: `${MARK} Own`, departmentId: dept._id, permissions: ["leads:view:own", "leads:edit:own"] });
  const u = (s) => `9197${String(Date.now()).slice(-7)}${s}`;
  const FOUNDER = await Admin.create({ name: `${MARK} Founder`, email: `f-${Date.now()}@t.local`, phone: u(1), password: "x", roleIds: [founderRole._id], departmentId: dept._id, status: "active" });
  const MEMBER = await Admin.create({ name: `${MARK} Member`, email: `m-${Date.now()}@t.local`, phone: u(2), password: "x", roleIds: [ownRole._id], departmentId: dept._id, status: "active" });
  const OUTSIDER = await Admin.create({ name: `${MARK} Outsider`, email: `o-${Date.now()}@t.local`, phone: u(3), password: "x", roleIds: [ownRole._id], status: "active" });
  const fT = jwt.sign({ _id: String(FOUNDER._id), isAdmin: true }, process.env.JWT_SECRET);
  const mT = jwt.sign({ _id: String(MEMBER._id), isAdmin: true }, process.env.JWT_SECRET);

  const now = Date.now();
  const mk = (n, owner) => Enquiry.create({ name: `${MARK} ${n}`, phone: `9190${String(now).slice(-7)}${n}`, verified: false, source: "Website", stage: "new", assignedTo: owner, additionalInfo: {} });
  const a = await mk("A", MEMBER._id); const b = await mk("B", MEMBER._id); const c = await mk("C", MEMBER._id);
  const outLead = await mk("Out", OUTSIDER._id);

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, bd) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(bd ? { "Content-Type": "application/json" } : {}) }, body: bd ? JSON.stringify(bd) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── bulk tag / stage / lost (member, own scope) ──");
    const tag = await api("POST", "/enquiry/bulk-tag", mT, { leadIds: [String(a._id), String(b._id)], tag: "Premium", mode: "add" });
    ok(tag.status === 200 && tag.data.updated === 2, "bulk-tag adds a tag to the selection");
    ok((await Enquiry.findById(a._id).lean()).tags.includes("Premium"), "tag persisted on the lead");
    const untag = await api("POST", "/enquiry/bulk-tag", mT, { leadIds: [String(a._id)], tag: "Premium", mode: "remove" });
    ok(untag.status === 200 && !(await Enquiry.findById(a._id).lean()).tags.includes("Premium"), "bulk-tag remove works");
    const stage = await api("POST", "/enquiry/bulk-stage", mT, { leadIds: [String(a._id), String(b._id)], stage: "contacted" });
    ok(stage.status === 200 && (await Enquiry.findById(a._id).lean()).stage === "contacted", "bulk-stage moves the selection");
    const lost = await api("POST", "/enquiry/bulk-lost", mT, { leadIds: [String(c._id)], reason: "budget" });
    const cDoc = await Enquiry.findById(c._id).lean();
    ok(lost.status === 200 && cDoc.isLost === true && cDoc.lostStatus === "approved", "bulk-lost marks the selection lost");

    console.log("\n── scope rejection (out-of-scope batch) ──");
    const oos = await api("POST", "/enquiry/bulk-tag", mT, { leadIds: [String(a._id), String(outLead._id)], tag: "X", mode: "add" });
    ok(oos.status === 403, "a batch containing an out-of-scope lead is rejected (403)");
    ok(!((await Enquiry.findById(a._id).lean()).tags || []).includes("X"), "no lead in the rejected batch was tagged");

    console.log("\n── soft-delete: FOUNDER-only ──");
    const memberDel = await api("POST", "/enquiry/bulk-archive", mT, { leadIds: [String(a._id)] });
    ok(memberDel.status === 403, "a non-founder cannot delete (leads:delete:all gate → 403)");
    const founderDel = await api("POST", "/enquiry/bulk-archive", fT, { leadIds: [String(a._id), String(b._id)] });
    ok(founderDel.status === 200 && founderDel.data.archived === 2, "founder soft-deletes the selection");

    console.log("\n── soft-delete: recoverable + excluded + audited ──");
    const aDoc = await Enquiry.findById(a._id).lean();
    ok(aDoc && aDoc.archivedAt && String(aDoc.archivedBy) === String(FOUNDER._id), "archivedAt/By set — the doc still exists (NOT hard-deleted, recoverable)");
    const list = await api("GET", `/enquiry?search=${MARK}%20A&limit=50`, fT);
    ok(list.status === 200 && !(list.data.list || []).some((l) => String(l._id) === String(a._id)), "archived lead is excluded from the default list");
    const audit = await ActivityLog.findOne({ entityId: String(a._id), action: "bulk_archive" }).lean();
    ok(!!audit, "soft-delete is audited (ActivityLog bulk_archive)");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-2000));
  } finally {
    const ids = [a._id, b._id, c._id, outLead._id];
    await ActivityLog.deleteMany({ entityId: { $in: ids.map(String) } });
    await LeadInternalEvent.deleteMany({ leadId: { $in: ids } });
    await Enquiry.deleteMany({ _id: { $in: ids } });
    await Admin.deleteMany({ _id: { $in: [FOUNDER._id, MEMBER._id, OUTSIDER._id] } });
    await Role.deleteMany({ _id: { $in: [founderRole._id, ownRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
