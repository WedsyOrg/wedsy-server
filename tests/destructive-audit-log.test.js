/**
 * EVERY DESTRUCTIVE REQUEST IS LOGGED — including the ones that were refused.
 *
 * Finding 7 of docs/rbac-coverage-audit.md: of the 66 ungated admin-reachable
 * DELETE routes, ALL 66 were unlogged. A deletion left no trace of who did it.
 *
 * A gate stops the wrong person; a log tells you what happened. The log is
 * worth more, because it is the only one of the two that helps AFTER the fact —
 * and it needs no product decision about who may delete what, which is why it
 * can land while those eight questions are still open.
 *
 * DESIGN (docs/rbac-coverage-audit.md):
 *   WHAT   actorId · action · entityType · entityId · summary · meta{status,
 *          path, params} · timestamps. NEVER the request body — a delete body
 *          can carry names, phones, ids of other people.
 *   WHERE  the auth chokepoint, not 66 route edits. Logging who deleted what
 *          presupposes no decision about who MAY, so it cannot collide with the
 *          open questions.
 *   WHEN   on response finish, so the OUTCOME is recorded: a refused attempt is
 *          as interesting as a successful one.
 *   HOW LONG  a TTL on the collection — see the doc; the number is Rohaan's.
 *
 * Born red.
 *
 *   node tests/destructive-audit-log.test.js
 */
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const ActivityLog = require("../models/ActivityLog");
const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");

const TAG = `audit-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l} (got ${JSON.stringify(g)})`);
const cleanup = { admins: [], leads: [], logs: [] };
let seq = 0;
const nextPhone = () => `9${String(Date.now()).slice(-6)}${String(++seq).padStart(3, "0")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let server;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const admin = await Admin.create({ name: `${TAG}-actor`, email: `${TAG}@x.com`,
      phone: nextPhone(), password: "x", roles: ["sales"], status: "active" });
    cleanup.admins.push(admin._id);
    const token = jwt.sign({ _id: admin._id, isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const app = express();
    app.use(bodyParser.json());
    app.use("/", require("../routes/router"));
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const since = new Date();
    const logsSince = async () => {
      await sleep(120); // the write is fire-and-safe, after the response
      return ActivityLog.find({ createdAt: { $gte: since }, actorId: admin._id }).lean();
    };

    console.log("\n1. A DESTRUCTIVE REQUEST IS RECORDED, WITH ITS ACTOR");
    {
      await fetch(`${base}/tag/64b7f9c2e1a2b3c4d5e6f7a8`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      const rows = await logsSince();
      const row = rows.find((r) => String(r.meta && r.meta.path).includes("/tag/"));
      ok(!!row, "a DELETE writes an ActivityLog row");
      eq(row && String(row.actorId), String(admin._id), "…naming the admin who did it");
      ok(row && /delete/i.test(row.action), `…with a delete action (${row && row.action})`);
      ok(row && typeof row.summary === "string" && row.summary.length > 0, "…and a human-readable summary");
      cleanup.logs.push(...rows.map((r) => r._id));
    }

    console.log("\n2. A REFUSED ATTEMPT IS LOGGED TOO — attempts matter");
    {
      const before = (await logsSince()).length;
      const res = await fetch(`${base}/enquiry/bulk-archive`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: [] }),
      });
      eq(res.status, 403, "the zero-permission admin is refused");
      const rows = await logsSince();
      const refused = rows.find((r) => r.meta && r.meta.status === 403);
      ok(!!refused, "…and the refusal is still recorded");
      ok(refused && /bulk-archive/.test(String(refused.meta.path)), "…naming what they tried to reach");
      cleanup.logs.push(...rows.map((r) => r._id));
    }

    console.log("\n3. THE REQUEST BODY IS NEVER LOGGED");
    {
      const secret = `${TAG}-SENSITIVE-PAYLOAD`;
      await fetch(`${base}/enquiry/bulk-archive`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: [], note: secret, phone: "9876543210" }),
      });
      const rows = await logsSince();
      const blob = JSON.stringify(rows);
      ok(!blob.includes(secret), "no body field reaches the log");
      ok(!blob.includes("9876543210"), "…including anything that looks like a phone number");
      cleanup.logs.push(...rows.map((r) => r._id));
    }

    console.log("\n4. READS ARE NOT LOGGED — this is an audit trail, not traffic capture");
    {
      const before = (await logsSince()).length;
      await fetch(`${base}/enquiry`, { headers: { Authorization: `Bearer ${token}` } });
      const after = (await logsSince()).length;
      eq(after, before, "a GET writes nothing");
    }

    console.log("\n5. LOGGING NEVER BREAKS THE REQUEST");
    {
      const orig = ActivityLog.create;
      ActivityLog.create = async () => { throw new Error("audit store down"); };
      const res = await fetch(`${base}/tag/64b7f9c2e1a2b3c4d5e6f7a8`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      ActivityLog.create = orig;
      ok(res.status !== 500, `the request still completes when the audit write fails (status ${res.status})`);
    }

    console.log("\n6. RETENTION IS DECLARED, NOT LEFT TO GROW FOREVER");
    {
      const idx = await ActivityLog.collection.indexes();
      const ttl = idx.find((i) => i.expireAfterSeconds !== undefined);
      ok(!!ttl, "the collection carries a TTL index");
      ok(ttl && ttl.expireAfterSeconds > 300 * 86400,
        `…retaining at least ~a year (${ttl && Math.round(ttl.expireAfterSeconds / 86400)} days)`);
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite crashed:", e.message);
    fail++;
  } finally {
    if (server) server.close();
    await ActivityLog.deleteMany({ _id: { $in: cleanup.logs } });
    await Admin.deleteMany({ _id: { $in: cleanup.admins } });
    await Enquiry.deleteMany({ _id: { $in: cleanup.leads } });
    await mongoose.disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
