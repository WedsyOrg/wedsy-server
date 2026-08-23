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

    // ── LATENESS, FROZEN AT CHECK-IN (2026-08-21) ────────────────────────────
    // A fine is MONEY and the Setting store has no history: editing hr.lateBands
    // must change tomorrow's fines and never last month's sheet. So lateness is
    // computed once, at check-in, against the policy in force at that moment —
    // and the policy itself is copied onto the row. Every past payable sheet is
    // therefore reproducible from the rows alone, with no dependency on what the
    // settings happen to say today.
    lateMinutes: { type: Number, default: 0 }, // past the grace cutoff; 0 = on time
    fineAmount: { type: Number, default: 0 },  // rupees, from the band that matched
    // The exact policy this row was judged against. Never read for a decision —
    // it exists so a disputed fine can be explained months later.
    policySnapshot: {
      workStartTime: { type: String, default: "" },   // effective (person override or company)
      graceMinutes: { type: Number, default: null },
      lateBands: { type: mongoose.Schema.Types.Mixed, default: null },
      source: { type: String, default: "" },          // "person" | "company"
    },

    // ── HOW THE DAY WAS CLOSED ───────────────────────────────────────────────
    // "self"   — the person checked out.
    // "system" — the 04:00 sweep closed a forgotten check-out at the last
    //            EVIDENCE of presence. It is NOT a full day worked and must
    //            reach the sheet as "needs manager confirmation".
    closure: {
      by: { type: String, enum: ["self", "system", null], default: null },
      at: { type: Date, default: null },
      reason: { type: String, default: "" },
    },

    // ── THE DAY, AS PAYROLL SEES IT ──────────────────────────────────────────
    // dayType is calendar truth; dayStatus is what the day RESOLVED to.
    // Rows exist for WORKING days only — Sundays and holidays are derivable and
    // materialising them would be noise.
    dayType: { type: String, enum: ["working", "weekly_off", "holiday"], default: "working" },
    // absent_unexplained ≠ lop. The sweep records "no attendance was recorded";
    // LOP is a DECISION taken at sheet time, never a fact written by a cron.
    dayStatus: {
      type: String,
      enum: ["present", "half_day", "incomplete", "leave_paid", "comp_off", "absent_unexplained", "lop"],
      default: "present",
    },
    // 1 = full day, 0.5 = half day, 0 = not worked. Denormalised FROM an
    // approved LeaveRequest by the one chokepoint that may write it — see
    // services/AttendanceDayService. A finalised sheet run should RECOMPUTE from
    // the leave records rather than trust this cache.
    dayFraction: { type: Number, default: 1 },
    leaveRequestId: { type: ObjectId, ref: "LeaveRequest", default: null },

    // ── HOW AN INCOMPLETE DAY WAS RESOLVED ───────────────────────────────────
    // A manager's decision on a system-closed day, with its author. Separate
    // from `closure`, which records how the day was CLOSED (self or the 04:00
    // sweep) — closure is evidence, this is judgement, and conflating them
    // would let a resolution look like something the cron did.
    //
    // `reason` is MANDATORY for outcome "lop" and optional otherwise: LOP is
    // the only one of the three that moves money, and an unexplained deduction
    // is the thing nobody can defend a month later.
    resolution: {
      outcome: { type: String, enum: ["full", "half", "lop", null], default: null },
      reason: { type: String, default: "" },
      by: { type: ObjectId, ref: "Admin", default: null },
      at: { type: Date, default: null },
    },

    // ── THE EMPLOYEE'S OWN EXPLANATION ───────────────────────────────────────
    // ONE field, not two. "Explain the day" and "explain the fine" are the same
    // act from the employee's side, and the fine already lives on this row —
    // splitting them would force the writer to classify their own sentence and
    // the founder to read two places before deciding. It carries CONTEXT to the
    // run; it never waives anything. Owner-written only.
    employeeNote: {
      text: { type: String, default: "", trim: true },
      at: { type: Date, default: null },
      by: { type: ObjectId, ref: "Admin", default: null },
    },
  },
  { timestamps: true }
);

AttendanceSchema.index({ adminId: 1, date: 1 }, { unique: true });
AttendanceSchema.index({ date: 1 });
// The 04:00 sweep's working set: open rows in a bounded window.
AttendanceSchema.index({ date: 1, checkOutAt: 1 });
// Sheet reads: everything that resolved to something needing attention.
AttendanceSchema.index({ date: 1, dayStatus: 1 });

module.exports =
  mongoose.models.Attendance || mongoose.model("Attendance", AttendanceSchema);
