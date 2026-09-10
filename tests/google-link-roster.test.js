/**
 * WHO ON THE TEAM HAS LINKED THEIR GOOGLE ACCOUNT.
 *
 * Every read of GoogleAccount is scoped to one admin (status/disconnect take an
 * adminId; createMeetEvent looks up the organizer's row), so nothing could
 * answer the team-wide question. The consequence is not cosmetic: an admin who
 * has not linked books meetings that create no Meet link and invite nobody, and
 * MeetingsItem.tsx tells them "Invite sent — calendars blocked" regardless. The
 * gap is invisible to them and to everyone above them.
 *
 * ONE read-only endpoint. What is asserted:
 *   1  it lists every ACTIVE admin, linked or not, using the repo's own
 *      assignableFilter rather than a private definition of "active"
 *   2  linked rows carry linkedAt; unlinked rows are present and say so
 *   3  THE REFRESH TOKEN NEVER LEAVES THE SERVER — not the value, not its
 *      length, not a hash, not a boolean derived from it
 *   4  it is gated, and an admin without the permission gets 403
 *
 *   node tests/google-link-roster.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const express = require("express");
const bp = require("body-parser");
const jwt = require("jsonwebtoken");

const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const GoogleAccount = require("../models/GoogleAccount");

const TAG = `groster-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l}${g === w ? "" : `\n      expected ${JSON.stringify(w)}\n      got      ${JSON.stringify(g)}`}`);

const admins = [];
const roles = [];
const accounts = [];
const SECRET_TOKEN = "1//0gTHIS-IS-A-REFRESH-TOKEN-AND-MUST-NEVER-LEAVE-THE-SERVER";

(async () => {
  let srv;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const app = express();
    app.use(bp.json());
    app.use("/", require("../routes/router"));
    srv = app.listen(0);
    const base = `http://127.0.0.1:${srv.address().port}`;

    // Roles require a department; reuse any existing one rather than inventing.
    const dept = await Department.findOne({ deletedAt: null }).lean()
      || await Department.findOne().lean();
    const mkRole = async (name, permissions) => {
      const r = await Role.create({
        name: `${TAG}-${name}`, permissions, isSystem: false, departmentId: dept && dept._id,
      });
      roles.push(r._id);
      return r;
    };
    const mkAdmin = async (name, roleId, over = {}) => {
      const a = await Admin.create({
        name: `${TAG}-${name}`, email: `${TAG}-${name}@wedsy.in`.toLowerCase(),
        phone: `9198${String(Date.now()).slice(-8)}`, password: "x",
        roles: ["sales"], roleId, roleIds: roleId ? [roleId] : [],
        status: "active", isDisabled: false, joinedAt: new Date(), ...over,
      });
      admins.push(a._id);
      return a;
    };
    // isAdmin is what CheckAdminLogin branches on (middlewares/auth.js:42).
    const tokenFor = (a) => jwt.sign({ _id: String(a._id), isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const get = (path, tok) =>
      fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tok}` } });

    const viewerRole = await mkRole("viewer", ["users:view:all"]);
    const outsiderRole = await mkRole("outsider", ["leads:view:own"]);

    const viewer = await mkAdmin("viewer", viewerRole._id);
    const outsider = await mkAdmin("outsider", outsiderRole._id);
    const linked = await mkAdmin("linked", viewerRole._id);
    const unlinked = await mkAdmin("unlinked", viewerRole._id);
    const disabled = await mkAdmin("disabled", viewerRole._id, { isDisabled: true });
    const inactive = await mkAdmin("inactive", viewerRole._id, { status: "inactive" });

    const linkedAt = new Date("2026-09-01T10:00:00Z");
    const acc = await GoogleAccount.create({
      adminId: linked._id, email: `${TAG}-linked@wedsy.in`.toLowerCase(),
      refreshToken: SECRET_TOKEN, scopes: ["https://www.googleapis.com/auth/calendar.events"], linkedAt,
    });
    accounts.push(acc._id);
    // A row belonging to a DISABLED admin: linked once, no longer active.
    const acc2 = await GoogleAccount.create({
      adminId: disabled._id, email: `${TAG}-disabled@wedsy.in`.toLowerCase(),
      refreshToken: SECRET_TOKEN, scopes: [], linkedAt,
    });
    accounts.push(acc2._id);

    console.log("\n1. THE ROSTER EXISTS AND IS GATED");
    let body = null;
    {
      const res = await get("/google/link-roster", tokenFor(viewer));
      eq(res.status, 200, "an admin with the permission gets 200");
      body = res.status === 200 ? await res.json() : null;
      ok(body && Array.isArray(body.roster), "…and a roster array");

      const denied = await get("/google/link-roster", tokenFor(outsider));
      eq(denied.status, 403, "an admin WITHOUT the permission gets 403");

      // An unauthenticated request answers 400 {"message":"No Auth Token"} —
      // CheckAdminLogin's existing repo-wide behaviour for a missing token, not
      // something this route chose. Asserting 401/403 would be asserting a
      // convention this endpoint does not own; what matters is that it is
      // REFUSED and that no roster escapes.
      const anon = await fetch(`${base}/google/link-roster`);
      ok(anon.status !== 200, `no session is refused (got ${anon.status})`);
      const anonBody = await anon.text();
      ok(!anonBody.includes("roster"), "…and no roster is returned to an anonymous caller");
    }

    if (body && Array.isArray(body.roster)) {
      const rows = body.roster;
      const find = (a) => rows.find((r) => String(r.adminId) === String(a._id));

      console.log("\n2. EVERY ACTIVE ADMIN, LINKED OR NOT");
      {
        ok(!!find(linked), "a LINKED active admin is listed");
        ok(!!find(unlinked), "an UNLINKED active admin is listed — the whole point");
        ok(!!find(viewer), "…and so is the caller");

        // "Active" must be the repo's definition, not a private one:
        // status === "active" AND isDisabled !== true.
        ok(!find(disabled), "a DISABLED admin is excluded (isDisabled, not status)");
        ok(!find(inactive), 'an INACTIVE admin is excluded (status !== "active")');
      }

      console.log("\n3. THE FIELDS, AND ONLY THOSE");
      {
        const L = find(linked) || {};
        const U = find(unlinked) || {};
        eq(L.linked, true, "the linked admin reads linked:true");
        ok(!!L.name && !!L.email, "…with a name and email");
        eq(L.linkedAt ? new Date(L.linkedAt).toISOString() : null, linkedAt.toISOString(),
          "…and the linkedAt it was stored with");

        eq(U.linked, false, "the unlinked admin reads linked:false");
        ok(!!U.name && !!U.email, "…still with a name and email, so it can be chased");
        eq(U.linkedAt, null, "…and a null linkedAt rather than a missing key");

        ok(typeof body.unlinkedCount === "number",
          "the response carries the count that matters — how many cannot book");
        ok(body.unlinkedCount >= 1, "…and it is not zero here");
      }

      console.log("\n4. THE REFRESH TOKEN NEVER LEAVES THE SERVER");
      {
        const raw = JSON.stringify(body);
        ok(!raw.includes(SECRET_TOKEN), "the refresh token value is absent");
        ok(!raw.includes("refreshToken"), "…and so is the field name");
        ok(!/1\/\/0g/.test(raw), "…and nothing token-shaped appears anywhere");
        // A substring search for the token's LENGTH ("60") was tried here and
        // removed: it hits by chance inside ObjectIds, names and timestamps, so
        // it could not distinguish an exposed length from a coincidence. The
        // exact-keys assertion below is the sound version of the same intent —
        // it forecloses EVERY derived field, length and hash included, rather
        // than guessing at one spelling of a leak.
        ok(!/token/i.test(raw), "no key or value anywhere mentions a token");
        for (const r of rows) {
          const keys = Object.keys(r).sort().join(",");
          eq(keys, "adminId,email,linked,linkedAt,name",
            `a row carries exactly the five documented fields (${r.name || "?"})`);
        }
      }
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite crashed:", e && e.stack ? e.stack : e);
    fail++;
  } finally {
    if (srv) srv.close();
    if (accounts.length) await GoogleAccount.deleteMany({ _id: { $in: accounts } });
    if (admins.length) await Admin.deleteMany({ _id: { $in: admins } });
    if (roles.length) await Role.deleteMany({ _id: { $in: roles } });
    await mongoose.disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
