/**
 * RBAC Phase 2B — role-write verification (LOCAL DEV ONLY, non-destructive).
 * Exercises RoleService.updatePermissions + the validator directly.
 * Aborts if DATABASE_URL is not localhost.
 * Run: node scripts/rbac-phase-2b-verify-role-write.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Role = require("../models/Role");
const RoleService = require("../services/RoleService");
const { validatePermissions } = require("../utils/rbacPermissions");

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

    console.log("=== validator ===");
    check("valid set accepted", validatePermissions(["leads:view:team", "roles:*:all", "*:*:all"]).valid === true);
    check("malformed rejected", validatePermissions(["leads:view"]).valid === false);
    check("unknown resource rejected", validatePermissions(["widgets:view:all"]).valid === false);
    check("unknown action rejected", validatePermissions(["leads:frobnicate:all"]).valid === false);
    check("bad scope rejected", validatePermissions(["leads:view:galaxy"]).valid === false);
    check("scope wildcard rejected", validatePermissions(["leads:view:*"]).valid === false);

    console.log("\n=== guards ===");
    const founder = await Role.findOne({ name: "Founder" }).lean();
    const sales = await Role.findOne({ name: "Sales Executive" }).lean();
    if (!founder || !sales) {
      console.warn("SKIP guard/happy-path — Founder or Sales Executive role missing (run the seed first).");
    } else {
      await expectThrow("Founder protected", 403, () =>
        RoleService.updatePermissions(String(founder._id), { permissions: ["*:*:all"] })
      );
      await expectThrow("invalid permissions", 400, () =>
        RoleService.updatePermissions(String(sales._id), { permissions: ["leads:frobnicate:all"] })
      );
      await expectThrow("invalid id", 400, () =>
        RoleService.updatePermissions("not-an-objectid", { permissions: [] })
      );
      await expectThrow("unknown id", 404, () =>
        RoleService.updatePermissions(String(new mongoose.Types.ObjectId()), { permissions: [] })
      );

      console.log("\n=== happy path (mutate + restore) ===");
      restore = { id: sales._id, permissions: sales.permissions, description: sales.description ?? "" };
      const updated = await RoleService.updatePermissions(String(sales._id), {
        permissions: ["leads:view:team", "leads:edit:team", "leads:view:team"],
        description: "verify-temp",
      });
      check("update returned a role", !!(updated && updated._id));
      check(
        "permissions persisted + deduped",
        JSON.stringify(updated.permissions) === JSON.stringify(["leads:view:team", "leads:edit:team"])
      );
      check("description persisted", updated.description === "verify-temp");
      check("name unchanged", updated.name === "Sales Executive");
      check("isSystem unchanged", updated.isSystem === true);
    }

    console.log(`\nResult: ${pass} passed, ${fail} failed.`);
    if (fail > 0) process.exitCode = 1;
  } catch (error) {
    console.error("Verification error:", error);
    process.exitCode = 1;
  } finally {
    if (restore) {
      await Role.findByIdAndUpdate(restore.id, {
        $set: { permissions: restore.permissions, description: restore.description },
      });
      console.log("Restored Sales Executive permissions + description.");
    }
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
