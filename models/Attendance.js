const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// HRMS brick #1 (MB5 Slice 2): one row per admin per IST day. Timestamps are
// permanent — payroll inherits this later. Idle is DERIVED from activity
// heartbeats (gaps > 5 min while checked in), in-OS activity only — no screen
// capture, and the employee sees their own numbers (transparency rule).
const AttendanceSchema = new mongoose.Schema(
  {
    adminId: { type: ObjectId, ref: "Admin", required: true, index: true },
    // IST calendar day "YYYY-MM-DD" — the uniqueness key with adminId.
    date: { type: String, required: true },
    checkInAt: { type: Date, required: true },
    checkOutAt: { type: Date, default: null },
    // Last activity ping (60s cadence from an active tab). Drives idle derivation.
    lastHeartbeatAt: { type: Date, default: null },
    // Closed idle windows: gap > 5 min between heartbeats while checked in.
    idleSegments: {
      type: [
        {
          from: { type: Date, required: true },
          to: { type: Date, required: true },
        },
      ],
      default: [],
    },
    // Denormalized sum of idleSegments (ms) — cheap reads for lists/payroll.
    idleMs: { type: Number, default: 0 },
  },
  { timestamps: true }
);

AttendanceSchema.index({ adminId: 1, date: 1 }, { unique: true });
AttendanceSchema.index({ date: 1 });

module.exports =
  mongoose.models.Attendance || mongoose.model("Attendance", AttendanceSchema);
