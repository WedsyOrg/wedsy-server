const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// ── A leave application ──────────────────────────────────────────────────────
//
// Every requested day is its own entry with its own fraction, so a request can
// mix a half-day with full days without a second shape. `days` is the unit of
// truth; there is no separate from/to to drift out of sync with it.
//
// NOTHING HERE IS EVER DELETED. A same-day application is accepted and
// AUTO-REJECTED rather than blocked, because a blocked submission leaves no
// trace of the attempt and the pattern of attempts is itself information.
const LeaveRequestSchema = new mongoose.Schema(
  {
    adminId: { type: ObjectId, ref: "Admin", required: true, index: true },
    type: { type: String, enum: ["CL", "SL", "EL", "WFH", "COMP_OFF"], required: true },

    // One entry per requested day. date is the IST day key "YYYY-MM-DD" — the
    // same key Attendance and CompanyHoliday use, so nothing joins on a Date.
    days: {
      type: [
        {
          date: { type: String, required: true },
          // 1 = full day, 0.5 = half. WFH is whole-day only (enforced in policy).
          fraction: { type: Number, enum: [0.5, 1], default: 1 },
        },
      ],
      default: [],
    },
    // Denormalised Σ fraction — what the balance is reserved/charged for.
    totalDays: { type: Number, default: 0 },

    reason: { type: String, default: "", trim: true },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "auto_rejected", "cancelled"],
      default: "pending",
      index: true,
    },

    // ── Advance notice: WARN AND FLAG, never block ──────────────────────────
    // An EL applied 10 days out submits successfully and arrives on the
    // approver's desk marked short-notice, for them to weigh. A hard block just
    // makes people work around it.
    shortNotice: { type: Boolean, default: false },
    noticeDays: { type: Number, default: null },      // actual days of notice given
    requiredNoticeDays: { type: Number, default: null },

    // SL over 2 total days requires one. Stored as the uploaded file's URL.
    medicalCertificate: { type: String, default: "" },

    // Who was asked. Two levels: the applicant's manager AND that manager's
    // manager; EITHER may approve. Fallback holders of leave:approve:all are
    // included when the chain is empty, so a request is never unactionable.
    approvers: { type: [{ type: ObjectId, ref: "Admin" }], default: [] },

    decidedBy: { type: ObjectId, ref: "Admin", default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: "", trim: true },

    // Comp-off grants consumed by this request (COMP_OFF type only).
    compOffIds: { type: [{ type: ObjectId, ref: "CompOff" }], default: [] },
  },
  { timestamps: true }
);

LeaveRequestSchema.index({ adminId: 1, status: 1 });
LeaveRequestSchema.index({ "days.date": 1 });
LeaveRequestSchema.index({ status: 1, createdAt: -1 });

module.exports =
  mongoose.models.LeaveRequest || mongoose.model("LeaveRequest", LeaveRequestSchema);
