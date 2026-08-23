const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;
const Mixed = mongoose.Schema.Types.Mixed;

// ── One payroll run per calendar month ──────────────────────────────────────
//
// draft → finalised, and finalised is TERMINAL. There is no re-opening: a
// mistake found afterwards becomes an adjustment line on the next month's run,
// never a rewrite of a month someone has already been paid for.
//
// FINALISING RECOMPUTES FROM SOURCE rather than trusting the draft's numbers —
// the same warning AttendanceDayService carries about its own denormalisation.
// Only then does it freeze `snapshot`, which is what makes a finalised run
// reproducible without re-reading attendance that may since have been corrected.
const DecisionSchema = new mongoose.Schema(
  {
    adminId: { type: ObjectId, ref: "Admin", required: true },
    // "lop" — a day proposed for deduction. "fine" — a late-arrival fine.
    kind: { type: String, enum: ["lop", "fine"], required: true },
    date: { type: String, required: true }, // IST day key — the natural key with adminId+kind
    // approved = deduct it. waived = do not.
    //
    // WAIVED IS A DISTINCT STATE, not a silent zero. A waived LOP day must never
    // quietly consume a leave balance instead — the person would find themselves
    // short later with nothing to point at. Waived means "we are not docking
    // you", and it stays on the record saying so.
    status: { type: String, enum: ["pending", "approved", "waived"], default: "pending" },
    reason: { type: String, default: "", trim: true },
    decidedBy: { type: ObjectId, ref: "Admin", default: null },
    decidedAt: { type: Date, default: null },
  },
  { _id: false }
);

const PayrollRunSchema = new mongoose.Schema(
  {
    // IST calendar month "YYYY-MM".
    month: { type: String, required: true, unique: true },
    status: { type: String, enum: ["draft", "finalised"], default: "draft", index: true },

    // Snapshotted so a finalised run explains its own arithmetic. Fixed 30 by
    // founder ruling — it matches Razorpay's default LOP basis, so their payslip
    // and this sheet agree exactly rather than differing 15-20% by month length.
    dayDivisor: { type: Number, default: 30 },

    // Founder decisions on proposed deductions. Keyed (adminId, kind, date) so a
    // recompute re-derives the PROPOSALS and merges these onto them — a decision
    // already taken is never lost by refreshing the draft.
    decisions: { type: [DecisionSchema], default: [] },

    // Frozen at finalise: the complete computed sheet, exactly as approved.
    snapshot: { type: Mixed, default: null },
    totals: { type: Mixed, default: null },

    finalisedBy: { type: ObjectId, ref: "Admin", default: null },
    finalisedAt: { type: Date, default: null },
    createdBy: { type: ObjectId, ref: "Admin", default: null },
  },
  {
    timestamps: true,
    // ⚠️ minimize:false — Mongoose's DEFAULT strips EMPTY nested objects on save,
    // so a frozen snapshot silently lost `leaveByType: {}` for anyone who took no
    // leave that month (i.e. most people), and the exporter then threw reading it
    // back. A snapshot must round-trip byte-for-byte or "reproducible" is a
    // claim rather than a property.
    minimize: false,
  }
);

module.exports =
  mongoose.models.PayrollRun || mongoose.model("PayrollRun", PayrollRunSchema);
