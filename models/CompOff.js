const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// ── A single earned comp-off ────────────────────────────────────────────────
//
// THE ONLY BALANCE WITH A PER-INSTANCE EXPIRY, which is why it cannot be a
// counter. Each Sunday worked earns ONE grant carrying its own earn date and its
// own +30-day deadline, so two grants earned three weeks apart expire three
// weeks apart. A single number could not express that.
//
// No carry-forward and no encashment: an unused grant simply expires.
const CompOffSchema = new mongoose.Schema(
  {
    adminId: { type: ObjectId, ref: "Admin", required: true, index: true },
    // The Sunday that was worked — IST day key "YYYY-MM-DD".
    earnedFor: { type: String, required: true },
    // earnedFor + 30 days. The date USED must be on or before this; applying
    // inside the window for a day beyond it does not count.
    expiresAt: { type: String, required: true },

    status: { type: String, enum: ["pending", "granted", "rejected", "consumed", "expired"], default: "pending", index: true },
    grantedBy: { type: ObjectId, ref: "Admin", default: null },
    grantedAt: { type: Date, default: null },

    // The leave request that spent it, and the day it was spent on.
    consumedBy: { type: ObjectId, ref: "LeaveRequest", default: null },
    consumedFor: { type: String, default: null },
    note: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

// One grant per person per Sunday — working a Sunday twice is not a thing.
CompOffSchema.index({ adminId: 1, earnedFor: 1 }, { unique: true });
CompOffSchema.index({ adminId: 1, status: 1, expiresAt: 1 });

module.exports = mongoose.models.CompOff || mongoose.model("CompOff", CompOffSchema);
