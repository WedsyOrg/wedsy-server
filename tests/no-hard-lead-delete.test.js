/**
 * THERE IS NO HARD BULK LEAD DELETE.
 *
 * DELETE /enquiry took { leadIds } straight from the request body and ran
 *     Enquiry.deleteMany({ _id: { $in: leadIds } })
 * behind CheckAdminLogin alone — no permission, no cap on the array, no audit
 * row. 25 models reference Enquiry (LeadPayment, PaymentMilestone, Event,
 * Project, Onboarding among them), so the children were orphaned rather than
 * cascaded: the lead vanished and its payments did not.
 *
 * Two hundred lines below in the same file, /bulk-archive does a SOFT delete
 * gated on leads:delete:all. The careful path was built and the old one left
 * open beside it. Nothing called the old one — the CRM's bulk delete already
 * posts to /bulk-archive ("Deleted (recoverable for 30 days)").
 *
 * So it is REMOVED, not gated. A gated hard delete is still unrecoverable data
 * loss for whoever holds the grant, and one implementation per thing beats two
 * where the dangerous one is the older.
 *
 * THE ASSERTION IS THAT THE LEADS SURVIVE, not that a route returns 404.
 *
 *   node tests/no-hard-lead-delete.test.js
 */
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");

const TAG = `nohard-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l} (got ${JSON.stringify(g)})`);
const cleanup = { leads: [], admins: [] };
let seq = 0;
const nextPhone = () => `9${String(Date.now()).slice(-6)}${String(++seq).padStart(3, "0")}`;

(async () => {
  let server;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    // An admin with ZERO permissions — the exact profile the audit was about.
    const admin = await Admin.create({
      name: `${TAG}-nobody`, email: `${TAG}@x.com`, phone: nextPhone(),
      password: "x", roles: ["sales"], status: "active",
    });
    cleanup.admins.push(admin._id);
    const token = jwt.sign({ _id: admin._id, isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const mkLead = async () => {
      const l = await Enquiry.create({
        name: `${TAG}-lead`, phone: nextPhone(), source: "instagram", stage: "new",
        verified: false, isInterested: false, isLost: false,
      });
      cleanup.leads.push(l._id);
      return l;
    };
    const a = await mkLead(), b = await mkLead(), c = await mkLead();

    const app = express();
    app.use(bodyParser.json());
    app.use("/", require("../routes/router"));
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;

    console.log("\n1. A ZERO-PERMISSION ADMIN CANNOT BULK-DESTROY LEADS");
    {
      const res = await fetch(`${base}/enquiry`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: [a._id, b._id, c._id] }),
      });
      const survivors = await Enquiry.countDocuments({ _id: { $in: [a._id, b._id, c._id] } });
      // THE assertion. Not the status code — the leads.
      eq(survivors, 3, "all three leads still exist after the call");
      eq(res.status, 404, "…and the route is gone (404), not merely refused");
    }

    console.log("\n2. THE HARD-DELETE IMPLEMENTATION IS GONE, NOT JUST UNROUTED");
    {
      const ctrl = require("../controllers/enquiry");
      eq(typeof ctrl.Delete, "undefined",
        "controllers/enquiry no longer exports a bulk hard-delete — a loaded gun for the next router line");
      const src = require("fs").readFileSync(require.resolve("../routes/enquiry"), "utf8");
      ok(!/router\.delete\(\s*["'`]\/["'`]/.test(src), "routes/enquiry declares no DELETE on the collection root");
    }

    console.log("\n3. THE SAFE PATH IS INTACT AND STILL GATED");
    {
      const src = require("fs").readFileSync(require.resolve("../routes/enquiry"), "utf8");
      ok(/bulk-archive/.test(src), "/bulk-archive still exists");
      ok(/leads:delete:all/.test(src), "…still gated on leads:delete:all");
      // A zero-permission admin must be refused by it.
      const res = await fetch(`${base}/enquiry/bulk-archive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: [a._id] }),
      });
      eq(res.status, 403, "a zero-permission admin is refused by the safe path too");
      eq(await Enquiry.countDocuments({ _id: a._id }), 1, "…and the lead is untouched");
    }

    console.log("\n4. NOTHING ELSE ON /enquiry MOVED");
    {
      const res = await fetch(`${base}/enquiry`, { headers: { Authorization: `Bearer ${token}` } });
      ok(res.status !== 404, `GET /enquiry still routes (status ${res.status})`);
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite crashed:", e.message);
    fail++;
  } finally {
    if (server) server.close();
    await Enquiry.deleteMany({ _id: { $in: cleanup.leads } });
    await Admin.deleteMany({ _id: { $in: cleanup.admins } });
    await mongoose.disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
