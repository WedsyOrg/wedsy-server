/**
 * DRY RUN ONLY — never writes. House convention: assess, report, do not apply.
 *
 * The Settings column "Days vs event" became "Days before event", and the owner
 * now types an unsigned count plus a before/after direction instead of a signed
 * number. THE STORED FIELD DID NOT CHANGE: `offsetDays` is still a signed
 * offset from the event date, because that is exactly what
 * `dueDate = eventDate + offsetDays` needs and because a half-applied flip
 * would leave some shapes silently meaning the opposite of what they say.
 *
 * This script exists so that decision is data-backed rather than asserted. It
 * reports what is actually stored, and — if anyone still wants a storage flip —
 * exactly which rows it would touch and what they would become.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Venue = require("../models/Venue");

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const venues = await Venue.find({}).select("slug settings.bookingSettings.paymentShapes settings.paymentSlabs").lean();

  let shapes = 0, rows = 0, before = 0, after = 0, onBooking = 0;
  const wouldFlip = [];
  for (const v of venues) {
    const sets = [
      ...(v.settings?.bookingSettings?.paymentShapes || []),
      ...(v.settings?.paymentSlabs || []),
    ];
    for (const s of sets) {
      shapes += 1;
      for (const r of s.rows || []) {
        rows += 1;
        if (r.offsetDays === null || r.offsetDays === undefined) { onBooking += 1; continue; }
        if (r.offsetDays < 0) before += 1; else after += 1;
        wouldFlip.push({ venue: v.slug, shape: s.name || "(unnamed)", label: r.label, offsetDays: r.offsetDays, ifFlipped: -r.offsetDays });
      }
    }
  }

  console.log(`venues                 : ${venues.length}`);
  console.log(`saved shapes           : ${shapes}`);
  console.log(`rows                   : ${rows}`);
  console.log(`  before the event     : ${before}   (offsetDays < 0)`);
  console.log(`  after the event      : ${after}   (offsetDays > 0)`);
  console.log(`  on booking           : ${onBooking}   (null)`);
  console.log("");
  if (!wouldFlip.length) {
    console.log("No dated rows are stored, so a storage flip would touch NOTHING.");
    console.log("The UI-edge conversion is therefore free of migration risk either way.");
  } else {
    console.log(`A storage flip would rewrite ${wouldFlip.length} row(s):`);
    for (const r of wouldFlip.slice(0, 20)) {
      console.log(`  ${r.venue} · ${r.shape} · ${r.label}: ${r.offsetDays} → ${r.ifFlipped}`);
    }
    console.log("");
    console.log("Each of those rows would MEAN THE OPPOSITE until the flip completes.");
    console.log("That is why the conversion was put at the UI edge instead.");
  }
  console.log("\nDRY RUN — nothing was written.");
  await mongoose.disconnect();
})();
