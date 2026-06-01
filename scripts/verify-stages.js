/**
 * Verify Stage model + service (LOCAL DEV ONLY, read-only). Run after seeding.
 * node scripts/verify-stages.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const StageService = require("../services/StageService");
const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl.startsWith("mongodb://localhost")) { console.error("ABORT: not localhost"); process.exit(1); }
let pass = 0, fail = 0;
const check = (l, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); c ? pass++ : fail++; };
(async () => {
  await mongoose.connect(dbUrl);
  const { stages } = await StageService.getAllStages();
  console.log("stages:", stages.map(s => `${s.order}:${s.slug}(${s.name})`).join(", "));
  check("at least 3 stages seeded", stages.length >= 3);
  check("stages sorted by order ascending", stages.every((s, i) => i === 0 || stages[i-1].order <= s.order));
  check("each stage has slug + name", stages.every(s => s.slug && s.name));
  check("'new' stage is isSystem", (stages.find(s => s.slug === "new") || {}).isSystem === true);
  console.log(`\nResult: ${pass} passed, ${fail} failed.`);
  await mongoose.disconnect();
  if (fail > 0) process.exitCode = 1;
})();
