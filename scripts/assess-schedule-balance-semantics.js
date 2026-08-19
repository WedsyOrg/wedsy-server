/**
 * DRY RUN ONLY — never writes. House convention: assess, report, do not apply.
 *
 * Does any STORED booking change meaning now that percentages split the
 * balance after the advance rather than the whole booking value?
 *
 * The honest answer needs data, not reasoning: a stored schedule is a list of
 * AMOUNTS with optional percentages. Amounts do not recompute — nothing
 * re-derives them — so no stored row silently changes. What can be wrong is a
 * booking whose rows were generated under the old rule and therefore
 * OVER-COLLECT: advance + instalments exceeding the booking value.
 *
 * That is the population this reports. Fixing one means re-agreeing money with
 * a couple, so it is a business decision and not something a script should do.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const VenueBooking = require("../models/VenueBooking");

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const bookings = await VenueBooking.find({ "paymentSchedule.0": { $exists: true } })
    .select("_id venue totalValue paymentSchedule")
    .lean();

  let clean = 0;
  const over = [];
  const under = [];
  for (const b of bookings) {
    const rows = b.paymentSchedule || [];
    const scheduled = rows.reduce((s, r) => s + (r.amount || 0), 0);
    const value = b.totalValue || 0;
    if (!value) continue;
    const delta = scheduled - value;
    if (delta === 0) clean += 1;
    else if (delta > 0) over.push({ id: String(b._id), value, scheduled, delta });
    else under.push({ id: String(b._id), value, scheduled, delta });
  }

  console.log(`bookings with a schedule : ${bookings.length}`);
  console.log(`schedule totals the value: ${clean}`);
  console.log(`OVER-collecting          : ${over.length}`);
  console.log(`under-collecting         : ${under.length}`);
  for (const r of over.slice(0, 10)) {
    console.log(`  over  ${r.id}  value ${r.value}  scheduled ${r.scheduled}  (+${r.delta})`);
  }
  for (const r of under.slice(0, 5)) {
    console.log(`  under ${r.id}  value ${r.value}  scheduled ${r.scheduled}  (${r.delta})`);
  }
  console.log("\nDRY RUN — nothing was written.");
  await mongoose.disconnect();
})();
