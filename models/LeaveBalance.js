const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// ── One person's entitlement for one type in one calendar year ──────────────
//
// available = entitled + carriedIn − reserved − consumed
//
// RESERVED IS NOT A COUNTER FOR SHOW. Balance is held the moment a request is
// submitted and released on reject/cancel/auto-reject, because without it two
// pending requests each pass the sufficiency check independently and the second
// approval over-draws. Consumed only moves on approval.
//
// THE 2026 STUB. The system starts in August 2026 and Mar-Jul is written off, so
// the Aug-Dec window is pro-rated 5/12 — CL 5, SL 3.5, EL 5, WFH 5 — and is
// flagged `isStub`. It is NOT year one: nothing carries OUT of it, and 1 Jan
// 2027 is a clean reset to the full annual figures.
//
// ⚠️ Note the stub's 5 CL days can only ever be taken as 2 + 2 + 1, because CL
// caps at 2 consecutive working days. That is consistent with the policy, just
// tighter than the number looks — it is not a bug.
const LeaveBalanceSchema = new mongoose.Schema(
  {
    adminId: { type: ObjectId, ref: "Admin", required: true, index: true },
    year: { type: Number, required: true },
    type: { type: String, enum: ["CL", "SL", "EL", "WFH"], required: true },

    entitled: { type: Number, required: true, default: 0 },
    // EL only, and capped at 20: carry = min(unused, 20). The cap describes the
    // CARRY, not the total — so 2027 can open at up to 12 + 20 = 32.
    carriedIn: { type: Number, default: 0 },
    reserved: { type: Number, default: 0 },
    consumed: { type: Number, default: 0 },

    // True for the Aug-Dec 2026 window. Read by the year-end roll so the stub
    // never carries forward.
    isStub: { type: Boolean, default: false },
  },
  { timestamps: true }
);

LeaveBalanceSchema.index({ adminId: 1, year: 1, type: 1 }, { unique: true });

module.exports =
  mongoose.models.LeaveBalance || mongoose.model("LeaveBalance", LeaveBalanceSchema);
