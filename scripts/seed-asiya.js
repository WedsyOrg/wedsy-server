/* Seed Asiya Tarannum (Sales Executive) — LOCAL ONLY, idempotent.
 * On prod, Asiya is created via Settings → Users (founder) OR by running this
 * script once — founder's call (see deploy checklist).
 * Run: node scripts/seed-asiya.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const { CreateHash } = require("../utils/password");

(async () => {
  const url = process.env.DATABASE_URL || "";
  if (!url.includes("localhost") && !url.includes("127.0.0.1")) {
    console.error("ABORT: this seed is LOCAL ONLY (DATABASE_URL is not localhost).");
    process.exit(1);
  }
  await mongoose.connect(url);

  const existing = await Admin.findOne({ email: "asiya@wedsy.in" });
  if (existing) {
    console.log("asiya@wedsy.in already exists — nothing to do");
    await mongoose.disconnect();
    return;
  }

  const role = await Role.findOne({ name: "Sales Executive", deletedAt: null }).lean();
  if (!role) {
    console.error("ABORT: Sales Executive role not found");
    process.exit(1);
  }
  // Reporting manager: Asha (Revenue Head). Department: same as the other Sales Execs.
  const asha = await Admin.findOne({ name: /asha/i }).lean();
  const peer = await Admin.findOne({ roleId: role._id }).lean();
  const departmentId = peer ? peer.departmentId : role.departmentId;
  const legacyRoles = peer ? peer.roles : ["sales"];

  await Admin.create({
    name: "Asiya Tarannum",
    email: "asiya@wedsy.in",
    phone: "PENDING",
    password: await CreateHash("Wd$y-As9k2Qm"),
    roles: legacyRoles,
    roleId: role._id,
    departmentId,
    reportingManagerId: asha ? asha._id : null,
    status: "active",
    mustResetPassword: true,
  });
  console.log(
    `created asiya@wedsy.in (Sales Executive, manager=${asha ? asha.name : "none found"}, mustResetPassword=true)`
  );
  await mongoose.disconnect();
})();
