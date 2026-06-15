/* MB9c-fix — server-side lead-list sort + normalized source filter. Verifies
 * default createdAt-desc across pages (stable), sort=name|activity over the full
 * set, the normalized source filter (messy strings match their canonical chip),
 * archivedAt still excluded, pagination respects sort. Test port 8164. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8164; const BASE = `http://localhost:${PORT}`; const MARK = "MB9CF";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };
const DAY = 86400000;

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const role = await Role.create({ name: `${MARK} All`, departmentId: dept._id, permissions: ["*:*:all"] });
  const FOUNDER = await Admin.create({ name: `${MARK} Founder`, email: `f-${Date.now()}@t.local`, phone: `9197${String(Date.now()).slice(-7)}1`, password: "x", roleIds: [role._id], departmentId: dept._id, status: "active" });
  const fT = jwt.sign({ _id: String(FOUNDER._id), isAdmin: true }, process.env.JWT_SECRET);

  const now = Date.now();
  // NOTE: createdAt is immutable in Mongoose, so we rely on CREATION ORDER to set
  // it (oldest first) and only override the mutable updatedAt (for the activity sort).
  const mk = async (n, source, updatedDaysAgo, archived) => {
    const lead = await Enquiry.create({ name: `${MARK} ${n}`, phone: `9190${String(now).slice(-7)}${n.length}${Math.floor(Math.random() * 9)}`, verified: false, source, stage: "new", assignedTo: FOUNDER._id, additionalInfo: {}, ...(archived ? { archivedAt: new Date() } : {}) });
    await Enquiry.updateOne({ _id: lead._id }, { $set: { updatedAt: new Date(now - updatedDaysAgo * DAY) } }, { timestamps: false });
    return lead;
  };
  // Create oldest→newest so createdAt order is Delta < Alpha < Bravo < Charlie
  // (default desc ⇒ Charlie, Bravo, Alpha, Delta). Echo archived → excluded.
  const D = await mk("Delta", "Website", 0, false);     // most-recent activity (updated today)
  const A = await mk("Alpha", "WhatsApp", 1, false);
  const B = await mk("Bravo", "Instagram DM", 3, false);
  const C = await mk("Charlie", "Kiara", 2, false);
  const E = await mk("Echo", "Facebook Ads", 5, true);  // archived → excluded

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (p, t) => { const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${t}` } }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };
  const names = (res) => (res.data.list || []).map((l) => (l.name || "").replace(`${MARK} `, ""));

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");
    const S = `search=${MARK}`; // isolates our 4 (non-archived) leads

    console.log("\n── Slice 1: default sort = createdAt desc, stable across pages ──");
    const def = await api(`/enquiry?${S}&limit=20`, fT);
    ok(JSON.stringify(names(def)) === JSON.stringify(["Charlie", "Bravo", "Alpha", "Delta"]), `default newest-created first (got ${names(def).join(",")})`);
    ok((def.data.list || []).every((l) => String(l._id) !== String(E._id)), "archived lead excluded from the list");
    const p1 = await api(`/enquiry?${S}&limit=2&page=1`, fT);
    const p2 = await api(`/enquiry?${S}&limit=2&page=2`, fT);
    ok(JSON.stringify(names(p1)) === JSON.stringify(["Charlie", "Bravo"]), `page 1 = newest 2 (got ${names(p1).join(",")})`);
    ok(JSON.stringify(names(p2)) === JSON.stringify(["Alpha", "Delta"]), `page 2 = next 2, no overlap (got ${names(p2).join(",")})`);

    console.log("\n── Slice 2: server-side sort over the full set ──");
    const byName = await api(`/enquiry?${S}&sort=name&limit=20`, fT);
    ok(JSON.stringify(names(byName)) === JSON.stringify(["Alpha", "Bravo", "Charlie", "Delta"]), `sort=name A→Z (got ${names(byName).join(",")})`);
    const byNameDesc = await api(`/enquiry?${S}&sort=name&dir=desc&limit=20`, fT);
    ok(names(byNameDesc)[0] === "Delta", "sort=name&dir=desc reverses");
    const byActivity = await api(`/enquiry?${S}&sort=activity&limit=20`, fT);
    ok(names(byActivity)[0] === "Delta", `sort=activity → most-recently-updated first (got ${names(byActivity).join(",")})`);
    // Sort spans the FULL set, not one page: page 1 of a name sort is the global first.
    const namePage1 = await api(`/enquiry?${S}&sort=name&limit=2&page=1`, fT);
    ok(JSON.stringify(names(namePage1)) === JSON.stringify(["Alpha", "Bravo"]), "sort applies across pages (page 1 = global first 2 by name)");

    console.log("\n── Slice 3: normalized source filter (messy strings) ──");
    const ig = await api(`/enquiry?${S}&source=instagram&limit=20`, fT);
    ok(JSON.stringify(names(ig)) === JSON.stringify(["Bravo"]), `source=instagram matches "Instagram DM" (got ${names(ig).join(",")})`);
    const waKiara = await api(`/enquiry?${S}&source=whatsapp,kiara&limit=20`, fT);
    ok(names(waKiara).sort().join(",") === "Alpha,Charlie", `source=whatsapp,kiara matches both (got ${names(waKiara).join(",")})`);
    const web = await api(`/enquiry?${S}&source=website&limit=20`, fT);
    ok(JSON.stringify(names(web)) === JSON.stringify(["Delta"]), `source=website matches "Website" (got ${names(web).join(",")})`);
    const fb = await api(`/enquiry?${S}&source=facebook&limit=20`, fT);
    ok(!names(fb).includes("Echo"), "archived Facebook lead still excluded even when its source matches");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-2000));
  } finally {
    await Enquiry.deleteMany({ _id: { $in: [A._id, B._id, C._id, D._id, E._id] } });
    await Admin.deleteMany({ _id: FOUNDER._id });
    await Role.deleteMany({ _id: role._id });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
