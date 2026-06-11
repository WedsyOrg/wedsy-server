/* Lifecycle one-time idempotent patch (LOCAL DEV — also part of the prod deploy
 * checklist, run once there by a human):
 *   1. "Won" stage record (slug "won", category "won") — terminal stage for
 *      converted leads; the pipeline validates stages against this collection.
 *   2. Client Servicing Executive role gains projects:view:own + projects:edit:own
 *      (needed to see their own handed-off projects).
 *   3. "Sales Intern" role (Sales department) exists — the primary auto-assignment
 *      pool. Created with leads:view:own + leads:edit:own if missing.
 * Idempotent: every step checks before writing. Run: node scripts/lifecycle-role-patch.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Stage = require("../models/Stage");
const Role = require("../models/Role");
const Department = require("../models/Department");

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const log = [];

  // 1. Won stage
  const won = await Stage.findOne({ slug: "won" });
  if (!won) {
    const maxOrder = await Stage.findOne({ deletedAt: null }).sort({ order: -1 }).lean();
    await Stage.create({
      name: "Won",
      slug: "won",
      order: maxOrder ? maxOrder.order + 1 : 99,
      color: "#0E7A4B",
      category: "won",
      isSystem: true,
    });
    log.push("created Won stage");
  } else {
    log.push("Won stage already present");
  }

  // 2. CS Executive projects perms
  const csRole = await Role.findOne({ name: "Client Servicing Executive", deletedAt: null });
  if (csRole) {
    const needed = ["projects:view:own", "projects:edit:own"];
    const missing = needed.filter((p) => !csRole.permissions.includes(p));
    if (missing.length) {
      csRole.permissions.push(...missing);
      await csRole.save();
      log.push(`added to CS Executive: ${missing.join(", ")}`);
    } else {
      log.push("CS Executive already has projects perms");
    }
  } else {
    log.push("WARN: Client Servicing Executive role not found — skipped");
  }

  // 3. Sales Intern role
  const intern = await Role.findOne({ name: "Sales Intern", deletedAt: null });
  if (!intern) {
    const salesDept = await Department.findOne({ name: "Sales", deletedAt: null });
    if (salesDept) {
      await Role.create({
        name: "Sales Intern",
        departmentId: salesDept._id,
        description: "First-call pool — receives auto-assigned new leads",
        permissions: ["leads:view:own", "leads:edit:own"],
        isSystem: false,
      });
      log.push("created Sales Intern role");
    } else {
      log.push("WARN: Sales department not found — Sales Intern role skipped");
    }
  } else {
    log.push("Sales Intern role already present");
  }

  console.log(log.join("\n"));
  await mongoose.disconnect();
})();
