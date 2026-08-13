const mongoose = require("mongoose");

/**
 * models/AuspiciousDate.js — the platform's ONE source of truth for muhurat
 * (auspicious) wedding dates.
 *
 * An auspicious date drives demand: couples want it, so several will chase the
 * same venue on the same day, and the venue should price it accordingly. Every
 * surface that shows a date — the OS venue department, the venue owner portal,
 * the couple site — must agree on which dates those are, which is why this is
 * one collection rather than a per-surface list.
 *
 * DATE IS A DAY KEY, NOT AN INSTANT. `date` is midnight UTC of the calendar
 * date, exactly the VenueSpaceDate / VenueRoomNight convention (see the header
 * of utils/venueTime.js on why that distinction matters here). There is no time
 * of day: "25 November 2026 is auspicious" is a statement about a calendar
 * square, not about a moment. year/month/day are denormalised off that same key
 * so month grids and year listings never have to range-scan.
 *
 * REGION IS NULLABLE, AND NULL MEANS NATIONAL. A row with region=null applies
 * everywhere; a row with a region applies only there. So a date is auspicious
 * for a venue when a national row OR a matching-region row exists — never
 * "the most specific row wins", because these are additive traditions, not
 * overrides. Resolution lives in utils/auspiciousDates.js and nowhere else.
 *
 * TIER IS OPTIONAL. Absent means "auspicious, unspecified strength" — which is
 * the honest state when whoever entered the year knew the date but not its
 * weight. It must never be inferred or defaulted to a value.
 */
const AuspiciousDateSchema = new mongoose.Schema(
  {
    // Midnight UTC of the calendar date. Always written through
    // utils/auspiciousDates.toDayStart so the key can never drift.
    date: { type: Date, required: true },
    // Denormalised from `date` (UTC parts) — the query path for "show me this
    // month" and "show me this year", which is how the data is entered and read.
    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    day: { type: Number, required: true, min: 1, max: 31 },
    // null / absent = NATIONAL (applies to every venue). A string scopes the row
    // to venues in that region — matched against the venue's state, then city
    // (see utils/auspiciousDates.venueRegions).
    region: { type: String, default: null, trim: true },
    // Optional strength. null = unspecified, and that is a real answer.
    tier: { type: String, enum: ["major", "moderate", null], default: null },
    notes: { type: String, default: "", trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true }
);

// The idempotency guard: one row per (calendar date, region). Re-submitting a
// date the venue team already entered updates that row instead of creating a
// twin — Mongo treats null as a value here, so two national rows for the same
// date collide exactly as two regional ones would.
AuspiciousDateSchema.index({ date: 1, region: 1 }, { unique: true });
// Range lookups (calendars, demand maps) scan by date.
AuspiciousDateSchema.index({ date: 1 });
// Month-grid and year reads.
AuspiciousDateSchema.index({ year: 1, month: 1 });
// "Everything for this region" — the admin list filter.
AuspiciousDateSchema.index({ region: 1 });

module.exports =
  mongoose.models.AuspiciousDate || mongoose.model("AuspiciousDate", AuspiciousDateSchema);
