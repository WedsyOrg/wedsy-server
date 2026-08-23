const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// ── Salary — its own collection, deliberately NOT a field on Admin ───────────
//
// Admin is read and populated all over this codebase, and we have already had to
// project it down to name-only once (createdBy on Decor) to stop it leaking. A
// salary field there would reach a response eventually — not by anyone's
// decision, just by someone writing `.populate("adminId")` on a new endpoint.
// A separate collection cannot leak by accident; it has to be joined on purpose.
//
// EFFECTIVE-DATED, because a finalised past month must never move. An October
// raise means October's sheet keeps the old figure and November's uses the new
// one. The governing record for a month is the LATEST one whose effectiveFrom is
// on or before the 1st of that month.
//
// Annual CTC only for now (founder's call) — monthly gross = CTC / 12, with no
// basic/HRA/allowance split. Razorpay owns the statutory breakdown; this is
// extensible when their ingest needs it.
const EmployeeSalarySchema = new mongoose.Schema(
  {
    adminId: { type: ObjectId, ref: "Admin", required: true, index: true },
    annualCtc: { type: Number, required: true, min: 0 },
    // IST day key "YYYY-MM-DD" — same convention as Attendance and the run month.
    effectiveFrom: { type: String, required: true },
    note: { type: String, default: "", trim: true },
    createdBy: { type: ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

// One figure per person per effective date. Re-stating the same date is a
// correction, not a second salary.
EmployeeSalarySchema.index({ adminId: 1, effectiveFrom: 1 }, { unique: true });

module.exports =
  mongoose.models.EmployeeSalary || mongoose.model("EmployeeSalary", EmployeeSalarySchema);
