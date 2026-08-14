const mongoose = require("mongoose");

/**
 * models/PublicHoliday.js — gazetted holidays, kept deliberately SEPARATE from
 * auspiciousness.
 *
 * These are different facts and they must not be merged. An auspicious date is
 * one the couple's calendar says they may marry on. A public holiday is one the
 * GUESTS get off work — it eases travel, lifts attendance, and a holiday
 * adjacent to a weekend muhurat is a premium slot the venue should be pricing
 * as one. Diwali is both; Republic Day is only the second; a Tuesday muhurat in
 * May is only the first. Collapsing them would make all three read alike.
 *
 * NATIONAL vs REGIONAL IS A REAL DISTINCTION, NOT A CONTRADICTION. India's
 * gazetted list and a state's own notification genuinely differ — Diwali 2026
 * is 8 November nationally and 10 November in Karnataka's notification, and for
 * a Bangalore venue the Karnataka date is the one whose leave the guests
 * actually get. Both rows are seeded, each with its correct scope, because
 * both are true. `type` says which kind of claim a row is making; `region` is
 * required for regional rows and null for national ones.
 *
 * `date` is a midnight-UTC day key, same convention as AuspiciousDate.
 */
const PublicHolidaySchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    name: { type: String, required: true, trim: true },
    // national — the Government of India gazetted list.
    // regional — one state's own notification (its region is required).
    type: { type: String, enum: ["national", "regional"], default: "national" },
    // null for national rows; the state name for regional ones. Matched against
    // the venue's state/city exactly like AuspiciousDate.region.
    region: { type: String, default: null, trim: true },
    year: { type: Number, required: true },
    notes: { type: String, default: "", trim: true },
    // Same meaning as elsewhere: false until a human checks it against the
    // actual notification. Holiday dates move with lunar calendars and get
    // re-notified, so "we read this somewhere" is not "this is confirmed".
    verified: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true }
);

// One row per (date, name, region): the same holiday can legitimately appear
// twice on different dates (national vs state) and two different holidays can
// fall on one date, so the name is part of the key.
PublicHolidaySchema.index({ date: 1, name: 1, region: 1 }, { unique: true });
PublicHolidaySchema.index({ date: 1 });
PublicHolidaySchema.index({ year: 1, type: 1 });

module.exports =
  mongoose.models.PublicHoliday || mongoose.model("PublicHoliday", PublicHolidaySchema);
