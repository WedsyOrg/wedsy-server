/**
 * Slice A1 — set-password hardening + auth middleware messages.
 *
 *   node tests/fix-set-password-hardening.test.js
 *
 * 1. SetMemberPassword uses a WHITELISTED findByIdAndUpdate (runValidators:false):
 *    a target doc carrying an invalid legacy field (which would fail target.save())
 *    still gets its password reset.
 * 2. An ActivityLogService.record throw logs-and-continues — never 500s the reset.
 * 3. CheckAdminLogin: expired JWT → 401 "Your session expired — please log in again.";
 *    admin-lookup failure → 401 "Session invalid — please log in again.".
 *
 * Seeds uniquely-tagged docs against the local CRM DB; cleans up in finally.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const Admin = require("../models/Admin");
const ActivityLog = require("../models/ActivityLog");
const ActivityLogService = require("../services/ActivityLogService");
const { CheckHash } = require("../utils/password");
const adminController = require("../controllers/admin");
const { CheckAdminLogin } = require("../middlewares/auth");

const TAG = `setpw-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const mockRes = () => ({
  statusCode: 0,
  body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
  send(b) { this.body = b; return this; },
});

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

  const created = { admins: [] };
  try {
    const actor = await Admin.create({
      name: `${TAG}-actor`, email: `${TAG}-actor@x.com`, phone: `${TAG}a`,
      password: "irrelevant", roles: ["crm"], status: "active",
    });
    const target = await Admin.create({
      name: `${TAG}-target`, email: `${TAG}-tgt@x.com`, phone: `${TAG}t`,
      password: "old-hash-placeholder", roles: ["sales"], status: "active",
      mustResetPassword: true,
    });
    created.admins.push(actor._id, target._id);

    // ── 1. Dirty-doc target: invalid legacy enum written PAST validation ─────
    // roles enum is ["owner","crm","sales","ops","finance"]; "legacy-bogus" makes
    // any full-doc save()/validate() throw — exactly the trap the whitelisted
    // update must not fall into.
    await Admin.collection.updateOne(
      { _id: target._id },
      { $set: { roles: ["legacy-bogus"], status: "active" } }
    );
    const dirty = await Admin.findById(target._id);
    let saveFails = false;
    try { await dirty.validate(); } catch (_) { saveFails = true; }
    ok(saveFails, "sanity: the dirty target doc fails full-doc validation (save() would throw)");

    const res1 = mockRes();
    await adminController.SetMemberPassword(
      { body: { targetAdminId: String(target._id), newPassword: "brand-new-pass-9" }, auth: { user_id: String(actor._id) } },
      res1
    );
    ok(res1.statusCode === 200, `dirty-doc target still gets the reset (got ${res1.statusCode}: ${JSON.stringify(res1.body)})`);
    const after1 = await Admin.findById(target._id).lean();
    ok(await CheckHash("brand-new-pass-9", after1.password), "password hash actually updated");
    ok(after1.mustResetPassword === false, "mustResetPassword cleared");
    ok(Array.isArray(after1.roles) && after1.roles[0] === "legacy-bogus",
      "unrelated dirty field untouched (whitelisted $set only)");

    // ── 2. Audit-log throw never blocks the reset ─────────────────────────────
    const realRecord = ActivityLogService.record;
    ActivityLogService.record = async () => { throw new Error("audit backend down"); };
    let res2 = mockRes();
    try {
      await adminController.SetMemberPassword(
        { body: { targetAdminId: String(target._id), newPassword: "second-new-pass-9" }, auth: { user_id: String(actor._id) } },
        res2
      );
    } finally {
      ActivityLogService.record = realRecord;
    }
    ok(res2.statusCode === 200, `audit throw → reset still 200 (got ${res2.statusCode})`);
    const after2 = await Admin.findById(target._id).lean();
    ok(await CheckHash("second-new-pass-9", after2.password), "password updated despite audit failure");

    // ── validation guards preserved ──────────────────────────────────────────
    const res3 = mockRes();
    await adminController.SetMemberPassword(
      { body: { targetAdminId: "not-an-objectid", newPassword: "whatever-long" }, auth: { user_id: String(actor._id) } },
      res3
    );
    ok(res3.statusCode === 400, "invalid ObjectId → 400");
    const res4 = mockRes();
    await adminController.SetMemberPassword(
      { body: { targetAdminId: String(target._id), newPassword: "short" }, auth: { user_id: String(actor._id) } },
      res4
    );
    ok(res4.statusCode === 400, "password < 8 chars → 400");
    const res5 = mockRes();
    await adminController.SetMemberPassword(
      { body: { targetAdminId: String(new mongoose.Types.ObjectId()), newPassword: "whatever-long" }, auth: { user_id: String(actor._id) } },
      res5
    );
    ok(res5.statusCode === 404, "missing target → 404");

    // ── 3. CheckAdminLogin messages ───────────────────────────────────────────
    const expired = jwt.sign({ _id: String(actor._id), isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "-10s" });
    const res6 = mockRes();
    await new Promise((resolve) => {
      CheckAdminLogin({ headers: { authorization: `Bearer ${expired}` } }, res6, resolve);
      setTimeout(resolve, 500); // middleware ends at res.send — resolve either way
    });
    ok(res6.statusCode === 401, `expired token → 401 (got ${res6.statusCode})`);
    ok(res6.body && res6.body.message === "Your session expired — please log in again.",
      `expired token message (got ${JSON.stringify(res6.body && res6.body.message)})`);
    ok(!("error" in (res6.body || {})), "no raw error object leaked in the 401 body");

    // Lookup-failure branch: a VALID token whose _id casts to nothing Admin.findById
    // can process — force the .catch by making _id a non-ObjectId string.
    const badId = jwt.sign({ _id: "not-a-valid-objectid", isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "5m" });
    const res7 = mockRes();
    await new Promise((resolve) => {
      CheckAdminLogin({ headers: { authorization: `Bearer ${badId}` } }, res7, resolve);
      setTimeout(resolve, 500);
    });
    ok(res7.statusCode === 401, `admin-lookup failure → 401 (got ${res7.statusCode})`);
    ok(res7.body && res7.body.message === "Session invalid — please log in again.",
      `lookup-failure message (got ${JSON.stringify(res7.body && res7.body.message)})`);

    // Happy path unchanged: valid token still passes through to next().
    const good = jwt.sign({ _id: String(actor._id), isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "5m" });
    let nexted = false;
    const req8 = { headers: { authorization: `Bearer ${good}` } };
    const res8 = mockRes();
    await new Promise((resolve) => {
      CheckAdminLogin(req8, res8, () => { nexted = true; resolve(); });
      setTimeout(resolve, 800);
    });
    ok(nexted && req8.auth && String(req8.auth.user_id) === String(actor._id),
      "valid token: auth logic unchanged (next() called, req.auth set)");

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    await ActivityLog.deleteMany({ "meta.targetAdminId": { $in: created.admins.map(String) } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
