const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const AdminSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    password: { type: String, required: true },
    roles: { type: [String], required: true, enum: ["owner", "crm", "sales", "ops", "finance"] },
    // --- Wedsy OS RBAC Phase 2B (additive, optional — legacy roles[] unchanged) ---
    roleId: { type: ObjectId, ref: "Role", default: null },
    departmentId: { type: ObjectId, ref: "Department", default: null },
    reportingManagerId: { type: ObjectId, ref: "Admin", default: null },
    status: { type: String, enum: ["active", "inactive", "on_leave"], default: "active" },
    joinedAt: { type: Date, default: null },
    // Lifecycle (additive): round-robin auto-assignment cursor (least-recently-assigned wins).
    lastAssignedAt: { type: Date, default: null },
    // Password reset (additive): sha256 hash of the emailed token + its expiry.
    resetToken: { type: String, default: null },
    resetTokenExpiresAt: { type: Date, default: null },
    meta: {
      designation: { type: String, default: "" },
      employeeId: { type: String, default: "" },
      profilePhoto: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Admin", AdminSchema);
