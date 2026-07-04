/**
 * utils/venueHoldExpiryJob.js — hourly sweep that expires stale holds (D3).
 *
 * A hold expires when expiresAt has passed while it is still "requested" or
 * "approved". Expiry frees any held VenueSpaceDate rows (the dates become
 * available again) and surfaces a follow-up: if the hold is linked to a lead,
 * the lead's followUpDate is pulled up to NOW so it lands in the owner's
 * overdue/today follow-up queue (never pushed later than an earlier date).
 *
 * Safety: pure DB mutation + logs; no external sends, so it is log-only-safe
 * by construction. Disable entirely with HOLD_EXPIRY_DISABLED=true.
 */
const VenueHold = require("../models/VenueHold");
const VenueSpaceDate = require("../models/VenueSpaceDate");
const VenueEnquiry = require("../models/VenueEnquiry");

async function runHoldExpirySweep(now = new Date()) {
  if (process.env.HOLD_EXPIRY_DISABLED === "true") return { skipped: "disabled" };
  const stale = await VenueHold.find({ status: { $in: ["requested", "approved"] }, expiresAt: { $lt: now } })
    .select("_id venue status linkedEnquiry")
    .lean();
  let expired = 0;
  let freedRows = 0;
  let followUps = 0;
  for (const hold of stale) {
    // Guard against a race with approve/convert: only flip from the state we saw.
    const flip = await VenueHold.updateOne(
      { _id: hold._id, status: hold.status },
      { $set: { status: "expired", decidedAt: now, decidedBy: "system (expiry sweep)" } }
    );
    if (flip.modifiedCount === 0) continue;
    expired++;
    const freed = await VenueSpaceDate.deleteMany({ holdRef: hold._id, state: "held" });
    freedRows += freed.deletedCount;
    if (hold.linkedEnquiry) {
      const bump = await VenueEnquiry.updateOne(
        {
          _id: hold.linkedEnquiry,
          stage: { $nin: ["booked", "lost"] },
          $or: [{ followUpDate: null }, { followUpDate: { $gt: now } }],
        },
        { $set: { followUpDate: now } }
      );
      followUps += bump.modifiedCount;
    }
  }
  if (expired > 0) console.log(`[holdExpiry] expired=${expired} freedRows=${freedRows} followUpsBumped=${followUps}`);
  return { expired, freedRows, followUps };
}

module.exports = { runHoldExpirySweep };
