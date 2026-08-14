const mongoose = require("mongoose");
const { TRADITIONS } = require("../utils/weddingTraditions");

/**
 * models/BlackoutPeriod.js — the stretches where Hindu weddings essentially do
 * not happen.
 *
 * A BLACKOUT IS A STRONG NEGATIVE SIGNAL, NOT MISSING DATA. This is the whole
 * point of the model. Before it, a date with no auspicious row and no enquiries
 * was indistinguishable from a date nobody had got round to entering — so the
 * owner portal could only ever shrug. With it, the product can say something
 * true and useful: "almost no Hindu weddings happen mid-July to October, so few
 * enquiries will come for this date — worth closing this one, or pitching it
 * for a corporate event."
 *
 * A RANGE, NOT A SET OF DAYS. Chaturmas is roughly mid-July to October;
 * Kharmas mid-December to mid-January. These are named seasons with real
 * boundaries, and storing them as ~100 individual rows would lose the name —
 * and the name is what makes the note explain itself rather than assert.
 * startDate/endDate are day keys (midnight UTC), INCLUSIVE at both ends.
 *
 * TRADITION-SCOPED. Kharmas closes the northern season on 14 December;
 * Dhanurmasam closes the southern one on the 15th. Holashtak is north-only.
 * Same axis as AuspiciousDate.traditions — empty means it applies to everyone.
 *
 * `verified` carries the same meaning and the same default as on
 * AuspiciousDate: false until a human checks it against a regional panchang.
 */
const BlackoutPeriodSchema = new mongoose.Schema(
  {
    // "Chaturmas", "Kharmas", "Holashtak", "Dhanurmasam" — the name is shown to
    // owners, so it is required and not derived from anything.
    name: { type: String, required: true, trim: true },
    // Midnight UTC day keys. INCLUSIVE both ends: a wedding on endDate is still
    // inside the blackout.
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    traditions: { type: [{ type: String, enum: TRADITIONS }], default: [] },
    // The year the period is filed under for the settings UI. A period that
    // straddles new year (Kharmas) is filed under the year it STARTS in, and
    // the range is what resolution actually uses — so nothing depends on this
    // being the "right" year for a straddling period.
    year: { type: Number, required: true },
    notes: { type: String, default: "", trim: true },
    verified: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true }
);

// Idempotency for the seed: one period per (name, startDate). Re-running the
// seed updates the row rather than laying down a second Chaturmas.
BlackoutPeriodSchema.index({ name: 1, startDate: 1 }, { unique: true });
// The resolution query: "any period covering this range".
BlackoutPeriodSchema.index({ startDate: 1, endDate: 1 });
BlackoutPeriodSchema.index({ year: 1 });

module.exports =
  mongoose.models.BlackoutPeriod || mongoose.model("BlackoutPeriod", BlackoutPeriodSchema);
