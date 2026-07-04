const mongoose = require("mongoose");

// D10 activity spine — APPEND-ONLY, dual-actor. One row per observed change:
// who (venue_team | wedsy_team | system), what (action/entity/field), the
// old/new snapshots, and a severity for feed filtering. There is no update or
// delete path — the pre-hooks below make the model itself refuse them, so a
// future endpoint can't quietly grow rollback powers (no rollback, D10).
const VenueActivitySchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    actorType: { type: String, enum: ["venue_team", "wedsy_team", "system"], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId },
    actorName: { type: String, default: "" },
    action: { type: String, required: true }, // e.g. "listing_updated", "enriched"
    entity: { type: String, default: "venue" }, // venue | pricing | policy | photos | …
    field: { type: String, default: "" }, // dotted path when field-level
    old: { type: String, default: "" }, // JSON-stringified snapshot (truncated)
    new: { type: String, default: "" },
    severity: { type: String, enum: ["high", "normal", "low"], default: "normal" },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

VenueActivitySchema.index({ venue: 1, at: -1 });
VenueActivitySchema.index({ venue: 1, severity: 1, at: -1 });

// Append-only enforcement: every mutating query op throws.
const REFUSE = function () {
  throw new Error("VenueActivity is append-only");
};
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete", "replaceOne"]) {
  VenueActivitySchema.pre(op, REFUSE);
}
VenueActivitySchema.pre("save", function (next) {
  if (!this.isNew) return next(new Error("VenueActivity is append-only"));
  next();
});

module.exports = mongoose.models.VenueActivity || mongoose.model("VenueActivity", VenueActivitySchema);
