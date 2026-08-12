const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

/**
 * MB-OSV S0 — a week's committed venue work for one person on one track job.
 *
 * This is a WORKLIST, not a scoreboard. The point of persisting it is that on
 * Monday someone commits to a specific SET of venues, and that exact set stays
 * visible and clickable all week — "enrich 20" with no list is a number to feel
 * bad about; "enrich these 20" is a day's work. `venues` is therefore the
 * substance of the record, and `target` is only its size.
 *
 * Progress is never stored. It is derived on read by asking each track whether
 * the work actually happened inside the week window (see
 * controllers/adminVenuePartnership.js buildWorklist), so a target cannot drift
 * out of sync with the venues it points at.
 */
const VenueWorkTargetSchema = new mongoose.Schema(
  {
    // Monday 00:00 in venue-local time (Asia/Kolkata). One row per
    // (week, assignee, kind).
    weekStart: { type: Date, required: true },
    assignee: { type: ObjectId, ref: "Admin", required: true },
    // Which track job this commitment is for. Mirrors the venues_* capability
    // split so a target can only be set by someone who could do the work.
    kind: { type: String, enum: ["enrich", "verify", "visit", "onboard"], required: true },
    // The committed set — the venues behind the number.
    venues: [{ type: ObjectId, ref: "Venue" }],
    // Committed size. Normally venues.length, but kept separate so a target can
    // be set before the list is picked (a Monday half-step we should not block).
    target: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: "", maxlength: 2000 },
    createdBy: { type: ObjectId, ref: "Admin" },
  },
  { timestamps: true }
);

VenueWorkTargetSchema.index({ weekStart: 1, assignee: 1, kind: 1 }, { unique: true });
VenueWorkTargetSchema.index({ assignee: 1, weekStart: -1 });

module.exports =
  mongoose.models.VenueWorkTarget ||
  mongoose.model("VenueWorkTarget", VenueWorkTargetSchema);
