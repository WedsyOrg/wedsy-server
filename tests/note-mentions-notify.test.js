/**
 * @-TAGGING A NOTE MUST ACTUALLY NOTIFY.
 *
 * The composer now inserts "@Name " into the note body, and nothing happens:
 * POST /enquiry/:_id/note has no mentions field, so no one is told.
 *
 * chat_mention already exists and already fires from LeadStepService.addNote
 * (step notes) and LeadChatService (chat messages). This route must fire THE
 * SAME trigger — not a third notification type, and not a third copy of the
 * firing code.
 *
 * Born red: a note posted with mentions[] produces no chat_mention today.
 *
 *   node tests/note-mentions-notify.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const express = require("express");
const bp = require("body-parser");
const jwt = require("jsonwebtoken");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const AdminNotification = require("../models/AdminNotification");
const LeadInternalEvent = require("../models/LeadInternalEvent");

const TAG = `mention-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l} (got ${JSON.stringify(g)})`);
const cleanup = { leads: [], admins: [], roles: [], depts: [] };
let seq = 0;
const nextPhone = () => `9${String(Date.now()).slice(-6)}${String(++seq).padStart(3, "0")}`;

(async () => {
  let srv;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const dept = await Department.create({ name: `${TAG}-d`, slug: `${TAG}-d` });
    const role = await Role.create({ name: `${TAG}-f`, departmentId: dept._id, permissions: ["*:*:all"] });
    cleanup.depts.push(dept._id); cleanup.roles.push(role._id);
    const mk = async (n) => {
      const a = await Admin.create({ name: `${TAG}-${n}`, email: `${TAG}-${n}@x.com`, phone: nextPhone(),
        password: "x", roles: ["owner"], roleId: role._id, roleIds: [role._id],
        departmentId: dept._id, status: "active" });
      cleanup.admins.push(a._id); return a;
    };
    const author = await mk("author"), alice = await mk("alice"), bob = await mk("bob");
    const lead = await Enquiry.create({ name: `${TAG}-lead`, phone: nextPhone(), source: "instagram",
      stage: "new", verified: false, isInterested: false, isLost: false, assignedTo: author._id });
    cleanup.leads.push(lead._id);

    const token = jwt.sign({ _id: author._id, isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const app = express(); app.use(bp.json()); app.use("/", require("../routes/router"));
    srv = app.listen(0);
    const base = `http://127.0.0.1:${srv.address().port}`;
    const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const postNote = (body) => fetch(`${base}/enquiry/${lead._id}/note`, {
      method: "POST", headers: H, body: JSON.stringify(body),
    });
    const mentionsFor = async (adminId) => AdminNotification.countDocuments({
      adminId, type: "chat_mention", leadId: lead._id,
    });

    console.log("\n1. EACH NAMED ADMIN IS NOTIFIED — via the EXISTING trigger");
    {
      const res = await postNote({ text: `@${alice.name} @${bob.name} can you both look at this?`,
        mentions: [String(alice._id), String(bob._id)] });
      eq(res.status, 201, "the note still posts");
      eq(await mentionsFor(alice._id), 1, "alice gets a chat_mention");
      eq(await mentionsFor(bob._id), 1, "bob gets a chat_mention");
      const row = await AdminNotification.findOne({ adminId: alice._id, type: "chat_mention" }).lean();
      ok(row && /mentioned you/i.test(row.title || ""), "…with the existing chat_mention wording");
      eq(row && String(row.leadId), String(lead._id), "…and the lead it happened on");
    }

    console.log("\n2. THE NOTE ITSELF IS UNCHANGED");
    {
      const ev = await LeadInternalEvent.countDocuments({ leadId: lead._id, type: "commented" });
      ok(ev >= 1, "the note is still recorded as a 'commented' event");
      const after = await Enquiry.findById(lead._id).lean();
      ok((after.updates?.conversations || []).length >= 1, "…and still mirrored into conversations");
    }

    console.log("\n3. THE SAME FILTERING addNote ALREADY DOES");
    {
      const before = await mentionsFor(author._id);
      await postNote({ text: "note to self", mentions: [String(author._id)] });
      eq(await mentionsFor(author._id), before, "the AUTHOR is never notified of their own mention");
    }
    {
      const res = await postNote({ text: "bad ids", mentions: ["not-an-id", "", null, 123, {}] });
      eq(res.status, 201, "invalid ids do not break the post");
      // 123 is the trap: ObjectId.isValid(123) is TRUE, so a loose filter lets a
      // number through to fail at the database instead of being dropped here.
      const { cleanMentions } = require("../services/MentionNotifyService");
      eq(JSON.stringify(cleanMentions(["not-an-id", "", null, 123, {}], null)), "[]",
        "…every invalid shape is dropped by the filter, including a NUMBER");
      const total = await AdminNotification.countDocuments({ leadId: lead._id, type: "chat_mention" });
      eq(total, 2, "…and produce no notifications (still just alice + bob)");
    }
    {
      const res = await postNote({ text: "no mentions field at all" });
      eq(res.status, 201, "a note with no mentions still posts");
      eq(await AdminNotification.countDocuments({ leadId: lead._id, type: "chat_mention" }), 2,
        "…and notifies nobody");
    }

    console.log("\n4. ONE IMPLEMENTATION — the trigger is fired from a single place");
    {
      const fs = require("fs");
      const files = ["LeadStepService", "LeadChatService", "LeadLifecycleService"]
        .map((f) => fs.readFileSync(require.resolve(`../services/${f}`), "utf8"));
      const firing = files.filter((s) => /type:\s*["']chat_mention["']/.test(s)).length;
      eq(firing, 0, "no service builds the chat_mention payload inline any more");
      const helper = fs.readFileSync(require.resolve("../services/MentionNotifyService"), "utf8");
      ok(/type:\s*["']chat_mention["']/.test(helper), "…it is built in exactly one shared place");
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite crashed:", e.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await AdminNotification.deleteMany({ leadId: { $in: cleanup.leads } });
    await LeadInternalEvent.deleteMany({ leadId: { $in: cleanup.leads } });
    await Enquiry.deleteMany({ _id: { $in: cleanup.leads } });
    await Admin.deleteMany({ _id: { $in: cleanup.admins } });
    await Role.deleteMany({ _id: { $in: cleanup.roles } });
    await Department.deleteMany({ _id: { $in: cleanup.depts } });
    await mongoose.disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
