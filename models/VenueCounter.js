const mongoose = require("mongoose");

/**
 * VenueCounter — atomic per-venue sequence counters (e.g. invoice numbers).
 * Use findOneAndUpdate($inc) with upsert to allocate a sequence value with no
 * read-modify-write race under concurrency.
 *   key: `${venueId}:invoice`   seq: monotonically increasing
 */
const VenueCounterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/** Atomically increment and return the next sequence value for a key. */
VenueCounterSchema.statics.next = async function next(key) {
  const doc = await this.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return doc.seq;
};

module.exports = mongoose.models.VenueCounter || mongoose.model("VenueCounter", VenueCounterSchema);
