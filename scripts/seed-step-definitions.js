/* MB8b — seed the 3-phase Wedsy journey step definitions. Idempotent:
 * re-running inserts only missing systemKeys; never clobbers admin edits.
 * Usage: node scripts/seed-step-definitions.js */
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.DATABASE_URL);
  const StepDefinitionService = require("../services/StepDefinitionService");
  const r = await StepDefinitionService.seed();
  console.log(`Step definitions seeded: ${r.created} created (${r.total} in the set).`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
