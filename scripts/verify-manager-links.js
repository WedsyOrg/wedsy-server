/**
 * READ-ONLY audit — which active admins have no reportingManagerId?
 *
 * The disqualify/lose-lead flow notifies the owner's reporting manager; an
 * unset link used to drop that notification silently (now it falls back to the
 * Revenue Heads, Signal Matrix Slice 2). This script lists everyone whose
 * manager link is missing so the data can be repaired through the normal
 * admin/people edit flow. No writes.
 *
 *   node scripts/verify-manager-links.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");

const URI = process.env.DATABASE_URL;
if (!URI) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 10000 });
  try {
    const [total, linked, unlinkedAdmins, roles, departments] = await Promise.all([
      Admin.countDocuments({ status: "active" }),
      Admin.countDocuments({ status: "active", reportingManagerId: { $ne: null } }),
      Admin.find(
        { status: "active", $or: [{ reportingManagerId: null }, { reportingManagerId: { $exists: false } }] },
        { name: 1, email: 1, roleId: 1, roleIds: 1, departmentId: 1 }
      ).lean(),
      Role.find({}, { name: 1 }).lean(),
      Department.find({}, { name: 1 }).lean(),
    ]);
    const roleName = new Map(roles.map((r) => [String(r._id), r.name]));
    const deptName = new Map(departments.map((d) => [String(d._id), d.name]));

    console.log(`Active admins: ${total} — with reportingManagerId: ${linked} — WITHOUT: ${unlinkedAdmins.length}\n`);
    if (!unlinkedAdmins.length) {
      console.log("Every active admin has a reporting manager. Nothing to repair.");
      return;
    }
    console.log("Active admins with NO reportingManagerId (notification fallback → Revenue Heads):");
    for (const a of unlinkedAdmins) {
      const rid = a.roleId || (Array.isArray(a.roleIds) && a.roleIds[0]);
      const role = rid ? roleName.get(String(rid)) || "?" : "—";
      const dept = a.departmentId ? deptName.get(String(a.departmentId)) || "?" : "—";
      console.log(`  - ${a.name} <${a.email}>  role: ${role}  dept: ${dept}  (${a._id})`);
    }
    console.log(
      "\nRepair via PUT /admin/:id (reportingManagerId) or the People editor — top-of-chain roles (Founder/Revenue Head) are expected to be unset."
    );
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error("Audit failed:", e);
  process.exit(1);
});
