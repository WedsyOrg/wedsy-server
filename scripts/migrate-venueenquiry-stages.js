/**
 * Migrate VenueEnquiry.stage from the legacy 6-value enum to the 8-stage enum.
 *
 * Legacy enum: new, contacted, site_visit, negotiation, booked, lost
 * New enum:    new, contacted, site_visit_scheduled, site_visit_done,
 *              proposal_sent, negotiating, booked, lost
 *
 * Backfill mapping (only renamed values change; the rest already match):
 *   site_visit  -> site_visit_scheduled   (a visit was set up; not yet "done")
 *   negotiation -> negotiating
 *   missing / empty / any other unknown value -> new
 *
 * Touches ONLY the `stage` field. The legacy `status` field is left untouched —
 * Phase 3 outreach depends on it.
 *
 * Safety:
 *   - Reads MONGODB_ATLAS_URL (falls back to MONGODB_URI / MONGODB_URL).
 *   - The connection host is masked in all log output.
 *   - Requires an explicit mode flag so it can never write "ad hoc":
 *       --dry-run   report what would change, write nothing
 *       --apply     perform the backfill
 *     Running with neither flag aborts. Intended for local dev or the EC2
 *     deploy step (which passes --apply), never an unguarded prod invocation.
 *
 * Run:
 *   node scripts/migrate-venueenquiry-stages.js --dry-run
 *   node scripts/migrate-venueenquiry-stages.js --apply
 */

require("dotenv").config();
const mongoose = require("mongoose");
const VenueEnquiry = require("../models/VenueEnquiry");

const VALID_STAGES = [
  "new",
  "contacted",
  "site_visit_scheduled",
  "site_visit_done",
  "proposal_sent",
  "negotiating",
  "booked",
  "lost",
];

// Renamed legacy values -> their new equivalents.
const STAGE_REMAP = {
  site_visit: "site_visit_scheduled",
  negotiation: "negotiating",
};

const DRY_RUN = process.argv.includes("--dry-run");
const APPLY = process.argv.includes("--apply");

/** Mask credentials and host so a connection string is never logged in clear. */
function maskUri(uri) {
  if (!uri) return "(none)";
  const m = uri.match(/^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?([^/?]+)(.*)$/i);
  if (!m) return "(unparseable connection string)";
  const scheme = m[1];
  const maskedHost = m[2].replace(/[^.]/g, "*"); // keep dot structure, hide everything else
  return `${scheme}***:***@${maskedHost}`;
}

async function main() {
  if (DRY_RUN === APPLY) {
    // Both or neither — refuse rather than guess. Prevents accidental prod writes.
    console.error(
      "ABORT: choose exactly one mode — pass --dry-run to preview or --apply to execute."
    );
    process.exit(1);
  }

  const uri =
    process.env.MONGODB_ATLAS_URL ||
    process.env.MONGODB_URI ||
    process.env.MONGODB_URL;
  if (!uri) {
    console.error("ABORT: no Mongo connection string (set MONGODB_ATLAS_URL).");
    process.exit(1);
  }

  console.log(`Mode: ${DRY_RUN ? "DRY-RUN (no writes)" : "APPLY (writing)"}`);
  console.log(`Connecting to ${maskUri(uri)}`);
  await mongoose.connect(uri);

  try {
    const total = await VenueEnquiry.countDocuments({});
    console.log(`VenueEnquiry documents: ${total}`);

    let changed = 0;

    // 1) Renamed legacy values.
    for (const [from, to] of Object.entries(STAGE_REMAP)) {
      const count = await VenueEnquiry.countDocuments({ stage: from });
      if (!count) continue;
      console.log(`  ${from} -> ${to}: ${count}`);
      changed += count;
      if (APPLY) {
        await VenueEnquiry.updateMany({ stage: from }, { $set: { stage: to } });
      }
    }

    // 2) Missing / empty / otherwise-unknown values -> new.
    //    Exclude the renamed keys above so dry-run doesn't double-count them.
    const orphanFilter = {
      stage: { $nin: [...VALID_STAGES, ...Object.keys(STAGE_REMAP)] },
    };
    const orphanCount = await VenueEnquiry.countDocuments(orphanFilter);
    if (orphanCount) {
      console.log(`  (missing/unknown) -> new: ${orphanCount}`);
      changed += orphanCount;
      if (APPLY) {
        await VenueEnquiry.updateMany(orphanFilter, { $set: { stage: "new" } });
      }
    }

    if (!changed) {
      console.log("Nothing to migrate — all stages already valid.");
    } else if (DRY_RUN) {
      console.log(`DRY-RUN complete. ${changed} document(s) would be updated.`);
    } else {
      console.log(`Migration complete. Updated ${changed} document(s).`);
    }
  } catch (err) {
    console.error("Error during migration:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
}

main();
