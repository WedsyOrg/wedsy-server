/**
 * RBAC Slice 5 — set protected:true on the Founder role (idempotent).
 * LOCAL DEV DB ONLY — aborts if DATABASE_URL is not localhost.
 * Run: node scripts/rbac-phase-2b-set-protected.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Role = require("../models/Role");

const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.startsWith("mongodb://localhost")) {
  console.error("ABORT: DATABASE_URL is not a localhost URI. This script runs on the local dev DB only.");
  console.error(`DATABASE_URL = ${dbUrl || "(empty)"}`);
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}`);

    const founder = await Role.findOne({ name: "Founder" });
    if (!founder) {
      console.error("ABORT: Founder role not found. Run rbac-phase-2b-seed-roles.js first.");
      process.exitCode = 1;
      return;
    }

    if (founder.protected === true) {
      console.log("No-op: Founder role already protected.");
    } else {
      await Role.updateOne({ _id: founder._id }, { $set: { protected: true } });
      console.log(`Set protected:true on Founder role (${founder._id}).`);
    }

    const check = await Role.find({}, { name: 1, protected: 1 }).sort({ name: 1 }).lean();
    console.log("\nRoles protected status:");
    console.dir(check, { depth: null });
  } catch (error) {
    console.error("Error:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
