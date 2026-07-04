/* MB7b Slice 1 — internal multi-member chat per lead: post, @mention
 * notification, attachments, RBAC lead-scope, pagination, read-marking, edit/
 * delete own. Port 8150. */
require("dotenv").config();
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PORT = 8150; const BASE = `http://localhost:${PORT}`; const MARK = "MB7B-S1";
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; failures.push(l); console.error(`  ✗ ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, l, t = 30000) => { const u = Date.now() + t; while (Date.now() < u) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(300); } throw new Error(`waitFor: ${l}`); };

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const Admin = require("../models/Admin"); const Role = require("../models/Role"); const Department = require("../models/Department");
  const Enquiry = require("../models/Enquiry"); const LeadChatMessage = require("../models/LeadChatMessage");
  const AdminNotification = require("../models/AdminNotification"); const LeadInternalEvent = require("../models/LeadInternalEvent");

  const dept = await Department.create({ name: `${MARK} Dept` });
  const allRole = await Role.create({ name: `${MARK} All`, departmentId: dept._id, permissions: ["leads:view:all", "leads:edit:all"] });
  const ownRole = await Role.create({ name: `${MARK} Own`, departmentId: dept._id, permissions: ["leads:view:own", "leads:edit:own"] });
  const u = (s) => `9197${String(Date.now()).slice(-7)}${s}`;
  const A = await Admin.create({ name: `${MARK} A`, email: `s1a-${Date.now()}@t.local`, phone: u(1), password: "x", roleIds: [allRole._id], departmentId: dept._id, status: "active" });
  const B = await Admin.create({ name: `${MARK} B`, email: `s1b-${Date.now()}@t.local`, phone: u(2), password: "x", roleIds: [allRole._id], departmentId: dept._id, status: "active" });
  const C = await Admin.create({ name: `${MARK} C`, email: `s1c-${Date.now()}@t.local`, phone: u(3), password: "x", roleIds: [ownRole._id], departmentId: dept._id, status: "active" });
  const tok = (a) => jwt.sign({ _id: String(a._id), isAdmin: true }, process.env.JWT_SECRET);
  const aT = tok(A), bT = tok(B), cT = tok(C);

  const phone = `9190${String(Date.now()).slice(-8)}`;
  const lead = await Enquiry.create({ name: "Chat Couple", phone, verified: false, source: "Website", stage: "lead", assignedTo: A._id, additionalInfo: {} });

  const child = spawn("node", ["server.js"], { cwd: `${__dirname}/..`, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const api = async (m, p, t, b) => { const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, data: d }; };

  try {
    await waitFor(() => fetch(`${BASE}/`).then((r) => r.ok).catch(() => false), "boot");

    console.log("\n── Post + author enrichment + first-message journey ──");
    const p1 = await api("POST", `/enquiry/${lead._id}/chat`, aT, { body: "First internal note" });
    ok(p1.status === 201 && p1.data.authorName === A.name, "A posts a message (author name enriched)");
    const started = await LeadInternalEvent.countDocuments({ leadId: lead._id, type: "chat_started" });
    ok(started === 1, "first message records exactly one chat_started journey marker");
    await api("POST", `/enquiry/${lead._id}/chat`, aT, { body: "Second note" });
    const started2 = await LeadInternalEvent.countDocuments({ leadId: lead._id, type: "chat_started" });
    ok(started2 === 1, "subsequent messages do NOT re-fire chat_started");

    console.log("\n── Unread + read-marking ──");
    const beforeRead = await LeadChatMessage.countDocuments({ leadId: lead._id, authorId: { $ne: B._id }, readBy: { $ne: B._id } });
    ok(beforeRead === 2, "B has 2 unread before opening the thread");
    const bList = await api("GET", `/enquiry/${lead._id}/chat`, bT);
    ok(bList.status === 200 && bList.data.messages.length === 2, "B reads the thread (2 messages, oldest first)");
    const afterRead = await LeadChatMessage.countDocuments({ leadId: lead._id, authorId: { $ne: B._id }, readBy: { $ne: B._id } });
    ok(afterRead === 0, "GET marked the thread read for B");

    console.log("\n── @mention → DISTINCT notification ──");
    const pm = await api("POST", `/enquiry/${lead._id}/chat`, bT, { body: "Hey, take a look", mentions: [String(A._id)] });
    ok(pm.status === 201 && pm.data.mentions.length === 1, "B posts with an @mention of A");
    const mentionNotif = await AdminNotification.find({ adminId: A._id, type: "chat_mention" }).lean();
    ok(mentionNotif.length === 1 && String(mentionNotif[0].leadId) === String(lead._id), "A gets a distinct chat_mention notification");
    const selfMention = await api("POST", `/enquiry/${lead._id}/chat`, aT, { body: "noting self", mentions: [String(A._id)] });
    ok(selfMention.data.mentions.length === 0, "self-mention is dropped (no self-notify)");

    console.log("\n── Attachments (image + pdf), invalid filtered ──");
    const pa = await api("POST", `/enquiry/${lead._id}/chat`, aT, { body: "proof", attachments: [{ type: "image", url: "https://x/y.jpg", name: "y.jpg" }, { type: "pdf", url: "https://x/z.pdf" }, { type: "exe", url: "https://x/bad" }] });
    ok(pa.status === 201 && pa.data.attachments.length === 2 && pa.data.attachments.every((a) => ["image", "pdf"].includes(a.type)), "image+pdf stored; invalid type filtered out");
    const empty = await api("POST", `/enquiry/${lead._id}/chat`, aT, {});
    ok(empty.status === 400, "empty message (no text, no attachment) rejected");

    console.log("\n── RBAC lead-scope ──");
    const denied = await api("GET", `/enquiry/${lead._id}/chat`, cT); // C: own-scope, lead not theirs
    ok(denied.status === 403, "out-of-scope admin → 403 on GET chat");
    const deniedPost = await api("POST", `/enquiry/${lead._id}/chat`, cT, { body: "x" });
    ok(deniedPost.status === 403, "out-of-scope admin → 403 on POST chat");
    const members = await api("GET", `/enquiry/${lead._id}/chat/members`, aT);
    // MB9a: chat membership is now PHASE-GATED. This pre-qual lead is assigned to
    // A (who has no reporting manager) → members = [A] only.
    ok(members.status === 200 && Array.isArray(members.data.list) && members.data.list.length === 1 && String(members.data.list[0]._id) === String(A._id), "pre-qual chat members = the assignee (phase-gated, MB9a)");

    console.log("\n── Pagination ──");
    for (let i = 0; i < 5; i++) await api("POST", `/enquiry/${lead._id}/chat`, aT, { body: `bulk ${i}` });
    const page1 = await api("GET", `/enquiry/${lead._id}/chat?limit=3`, aT);
    ok(page1.status === 200 && page1.data.messages.length === 3 && page1.data.hasMore === true, "limit=3 returns a page with hasMore");
    const oldest = page1.data.messages[0];
    const page2 = await api("GET", `/enquiry/${lead._id}/chat?limit=3&before=${oldest._id}`, aT);
    ok(page2.status === 200 && page2.data.messages.length === 3, "before cursor pages to older messages");

    console.log("\n── Edit / delete own ──");
    const target = pm.data; // B's message
    const editOwn = await api("PATCH", `/enquiry/${lead._id}/chat/${target._id}`, bT, { body: "edited text" });
    ok(editOwn.status === 200 && editOwn.data.body === "edited text" && editOwn.data.editedAt, "author edits own message (editedAt stamped)");
    const editOther = await api("PATCH", `/enquiry/${lead._id}/chat/${target._id}`, aT, { body: "hijack" });
    ok(editOther.status === 404, "non-author cannot edit (404)");
    const delOther = await api("DELETE", `/enquiry/${lead._id}/chat/${target._id}`, aT);
    ok(delOther.status === 404, "non-author cannot delete (404)");
    const delOwn = await api("DELETE", `/enquiry/${lead._id}/chat/${target._id}`, bT);
    ok(delOwn.status === 200, "author deletes own message");
  } catch (e) {
    fail++; failures.push(`fatal: ${e.message}`); console.error("FATAL", e); console.error(log.slice(-1500));
  } finally {
    await LeadChatMessage.deleteMany({ leadId: lead._id });
    await LeadInternalEvent.deleteMany({ leadId: lead._id });
    await AdminNotification.deleteMany({ adminId: { $in: [A._id, B._id, C._id] } });
    await Enquiry.deleteMany({ _id: lead._id });
    await Admin.deleteMany({ _id: { $in: [A._id, B._id, C._id] } });
    await Role.deleteMany({ _id: { $in: [allRole._id, ownRole._id] } });
    await Department.deleteMany({ _id: dept._id });
    child.kill(); await mongoose.disconnect();
    console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
    if (failures.length) console.log("failures:", failures.join(" | "));
    process.exit(fail === 0 ? 0 : 1);
  }
})();
