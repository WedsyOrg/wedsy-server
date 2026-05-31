/**
 * RBAC Slice 5 — verify the protected-flag guard (LOCAL DEV ONLY, non-destructive).
 * Asserts: Founder (protected) -> 403 on updatePermissions; a non-protected role -> editable (then reverted).
 * Aborts if DATABASE_URL is not localhost.
 * Run: node scripts/rbac-phase-2b-verify-protected.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Role = require("../models/Role");
const RoleService = require("../services/RoleService");

const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.startsWith("mongodb://localhost")) {
  console.error("ABORT: DATABASE_URL is not a localhost URI. Verification runs on the local dev DB only.");
  console.error(`DATABASE_URL = ${dbUrl || "(empty)"}`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  cond ? pass++ : fail++;
};
const expectThrow = async (label, status, fn) => {
  try {
    await fn();
    check(`${label} (expected ${status})`, false);
  } catch (e) {
    check(`${label} -> ${e.status || "?"} ${e.message}`, e.status === status);
  }
};

(async () => {
  let restore = null;
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}\n`);

    const founder = await Role.findOne({ name: "Founder" }).lean();
    const sales = await Role.findOne({ name: "Sales Executive" }).lean();
    if (!founder || !sales) {
      console.warn("SKIP — Founder or Sales Executive role missing (run seed first).");
    } else {
      check("Founder.protected === true (run set-protected first if this fails)", founder.protected === true);

      await expectThrow("protected Founder rejected", 403, () =>
        RoleService.updatePermissions(String(founder._id), { permissions: ["*:*:all"] })
      );

      restore = { id: sales._id, permissions: sales.permissions };
      const updated = await RoleService.updatePermissions(String(sales._id), {
        permissions: ["leads:view:team", "leads:edit:team"],
      });
      check("non-protected role editable", !!(updated && updated._id));
      check(
        "permissions persisted",
        JSON.stringify(updated.permissions) === JSON.stringify(["leads:view:team", "leads:edit:team"])
      );
    }

    console.log(`\nResult: ${pass} passed, ${fail} failed.`);
    if (fail > 0) process.exitCode = 1;
  } catch (error) {
    console.error("Verification error:", error);
    process.exitCode = 1;
  } finally {
    if (restore) {
      await Role.findByIdAndUpdate(restore.id, { $set: { permissions: restore.permissions } });
      console.log("Restored Sales Executive permissions.");
    }
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
