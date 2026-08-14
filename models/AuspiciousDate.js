const mongoose = require("mongoose");
const { TRADITIONS } = require("../utils/weddingTraditions");

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
    // WHOSE calendar says so — a SEPARATE axis from region (see
    // utils/weddingTraditions). Region is the place; this is the community
    // calendar, and the same Bangalore venue serves both. Empty = unspecified,
    // which applies to everyone rather than to nobody.
    traditions: { type: [{ type: String, enum: TRADITIONS }], default: [] },
    // FALSE until a human has checked this row against a regional panchang.
    // The 2026-27 seed is an AI-sourced summary that says so itself, so the
    // default is the truth about it — unverified data that is displayed as
    // though it were confirmed is worse than no data, because an owner prices
    // against it. Every surface must mark it.
    verified: { type: Boolean, default: false },
    notes: { type: String, default: "", trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true }
);

// The idempotency guard: one row per (calendar date, region). Re-submitting a
// date the venue team already entered updates that row instead of creating a
// twin — Mongo treats null as a value here, so two national rows for the same
// date collide exactly as two regional ones would.
//
// TRADITIONS THEREFORE MERGE onto that one row: a date auspicious for both
// North and South Indian weddings is ONE row carrying both tokens, not two
// rows. The consequence, stated plainly: `tier` is per row, so a date that is
// major for one tradition and moderate for another cannot be expressed today.
// No source we have makes that distinction, and inventing a shape for it now
// would be speculative — it is on the punch list, not in the schema.
AuspiciousDateSchema.index({ date: 1, region: 1 }, { unique: true });
// Range lookups (calendars, demand maps) scan by date.
AuspiciousDateSchema.index({ date: 1 });
// Month-grid and year reads.
AuspiciousDateSchema.index({ year: 1, month: 1 });
// "Everything for this region" — the admin list filter.
AuspiciousDateSchema.index({ region: 1 });
// "What still needs checking against a panchang" — the settings-UI review queue.
AuspiciousDateSchema.index({ year: 1, verified: 1 });

module.exports =
  mongoose.models.AuspiciousDate || mongoose.model("AuspiciousDate", AuspiciousDateSchema);
