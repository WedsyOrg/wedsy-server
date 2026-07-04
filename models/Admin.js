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
    // --- RBAC v2 (MB7a) — multi-role: permissions are the UNION of all roleIds.
    // Additive + back-compat: empty roleIds falls back to the single roleId.
    roleIds: { type: [{ type: ObjectId, ref: "Role" }], default: [] },
    departmentId: { type: ObjectId, ref: "Department", default: null },
    reportingManagerId: { type: ObjectId, ref: "Admin", default: null },
    // --- MB10 (additive, optional) — MULTI-HAT. A person can carry >1
    // (department, role, manager) hat. hats[0] is the PRIMARY hat and ALWAYS
    // mirrors the live top-level departmentId/roleId/reportingManagerId above,
    // which remain the single authoritative anchor for scope resolution
    // (getDepartmentMemberIds(departmentId) + reportingManagerId traversal —
    // UNCHANGED). Secondary hats only add their role to roleIds[] (the existing
    // permission UNION) and render as dotted edges in the org chart. Empty hats[]
    // ⇒ the primary hat is reconstructed from the top-level fields (back-compat).
    hats: {
      type: [
        {
          departmentId: { type: ObjectId, ref: "Department", default: null },
          roleId: { type: ObjectId, ref: "Role", default: null },
          reportingManagerId: { type: ObjectId, ref: "Admin", default: null },
        },
      ],
      default: [],
    },
    status: { type: String, enum: ["active", "inactive", "on_leave"], default: "active" },
    joinedAt: { type: Date, default: null },
    // Lifecycle (additive): round-robin auto-assignment cursor (least-recently-assigned wins).
    lastAssignedAt: { type: Date, default: null },
    // Password reset (additive): sha256 hash of the emailed token + its expiry.
    resetToken: { type: String, default: null },
    resetTokenExpiresAt: { type: Date, default: null },
    // Settings Suite (additive): force a password change on first login.
    mustResetPassword: { type: Boolean, default: false },
    // Access control (additive): a disabled admin cannot log in AND existing
    // tokens are rejected by CheckAdminLogin — disabling cuts access immediately.
    isDisabled: { type: Boolean, default: false },
    meta: {
      designation: { type: String, default: "" },
      employeeId: { type: String, default: "" },
      profilePhoto: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Admin", AdminSchema);
