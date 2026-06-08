/**
 * RBAC — Local lead fixtures seed (TEST TOOLING, LOCAL DEV DB ONLY)
 *
 * Seeds two Enquiry fixtures (plus the User + Event each needs to surface in the
 * ?status=Hot aggregate branch) so the enforcement harness can assert scope
 * filtering on the lead READ routes:
 *
 *   ZZZ-RBAC-FIXTURE-HOT-SE -> assignedTo = test-salesexec
 *   ZZZ-RBAC-FIXTURE-HOT-F  -> assignedTo = test-founder
 *
 * The ?status=Hot branch (controllers/enquiry.js GetAll) joins Enquiry.phone ->
 * User.phone -> Event.user, unwinds eventDays, and matches eventDays.date in
 * [today, today+56 days). So each fixture gets a matching User (by phone) and an
 * Event whose eventDay date lands inside that Hot window.
 *
 * Idempotent: every record is matched by a stable key (name sentinel / fixed phone)
 * and upserted, so re-runs don't duplicate. The event date is refreshed each run so
 * it stays inside the Hot window over time.
 *
 * Prereq: scripts/rbac-local-seed-test-admins.js (the two test admins must exist).
 *
 * Run: node scripts/rbac-local-seed-lead-fixtures.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");
const Event = require("../models/Event");

// --- HARD PROD GUARD (copied from scripts/rbac-local-seed-test-admins.js) ---
const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.startsWith("mongodb://localhost")) {
  console.error("ABORT: DATABASE_URL is not a localhost URI. This seed runs on the local dev DB only.");
  console.error(`DATABASE_URL = ${dbUrl || "(empty)"}`);
  process.exit(1);
}

// Hot window = eventDays.date in [today, today+56 days). Place fixtures mid-window
// (today + 14 days) using the SAME toISOString().slice(0,10) convention the controller
// uses, so the string comparison is apples-to-apples and safely inside under any timezone.
const hotDate = new Date();
hotDate.setDate(hotDate.getDate() + 14);
const HOT_EVENT_DATE = hotDate.toISOString().slice(0, 10); // "YYYY-MM-DD"

const FIXTURES = [
  { sentinel: "ZZZ-RBAC-FIXTURE-HOT-SE", adminEmail: "test-salesexec@local.test", phone: "9990000001" },
  { sentinel: "ZZZ-RBAC-FIXTURE-HOT-F", adminEmail: "test-founder@local.test", phone: "9990000002" },
  { sentinel: "ZZZ-RBAC-FIXTURE-HOT-MGR", adminEmail: "test-salesmgr@local.test", phone: "9990000003" },
];

(async () => {
  try {
    await mongoose.connect(dbUrl);
    console.log(`Connected to ${dbUrl}`);

    const founder = await Admin.findOne({ email: "test-founder@local.test" });
    const salesexec = await Admin.findOne({ email: "test-salesexec@local.test" });
    if (!founder || !salesexec) {
      console.error("ABORT: test admins missing — run scripts/rbac-local-seed-test-admins.js first");
      process.exitCode = 1;
      return;
    }
    const salesmgr = await Admin.findOne({ email: "test-salesmgr@local.test" });
    if (!salesmgr) {
      console.error("ABORT: test-salesmgr@local.test missing — run rbac-local-seed-hierarchy.js first");
      process.exitCode = 1;
      return;
    }
    const adminByEmail = {
      "test-founder@local.test": founder,
      "test-salesexec@local.test": salesexec,
      "test-salesmgr@local.test": salesmgr,
    };

    for (const f of FIXTURES) {
      const admin = adminByEmail[f.adminEmail];

      // 1. User — the join target by phone. Idempotent on phone.
      const user = await User.findOneAndUpdate(
        { phone: f.phone },
        { $set: { name: f.sentinel }, $setOnInsert: { phone: f.phone } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // 2. Event for that user, with an eventDay date INSIDE the Hot window. Idempotent on name.
      await Event.findOneAndUpdate(
        { name: f.sentinel },
        {
          $set: {
            user: user._id,
            eventDays: [
              { name: "Day 1", date: HOT_EVENT_DATE, time: "18:00", venue: "Test Venue" },
            ],
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // 3. Enquiry fixture. Idempotent on name sentinel; phone links to the User above.
      const enquiry = await Enquiry.findOneAndUpdate(
        { name: f.sentinel },
        {
          $set: {
            phone: f.phone,
            assignedTo: admin._id,
            source: "RBAC-TEST",
            stage: "new",
          },
          $setOnInsert: {
            verified: false,
            isInterested: false,
            isLost: false,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      console.log(`[fixture] ${enquiry.name}  _id=${enquiry._id}  assignedTo=${enquiry.assignedTo}`);
    }

    console.log(`\nFixtures upserted. Hot event date used: ${HOT_EVENT_DATE}`);
  } catch (error) {
    console.error("Fixture seed error:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
})();
