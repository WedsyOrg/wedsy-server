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
    // ── "exited" ADDED 2026-08-25 ───────────────────────────────────────────
    // WHY IT BELONGS HERE AND ALSO NEEDS A DATE. Adding the value to this enum
    // is what makes an exit take effect everywhere at once: dozens of selectors
    // already filter status:"active" (assignableFilter chief among them), so a
    // leaver drops out of assignment, pools and notification targets the moment
    // this flips — without hunting down and patching every one of them.
    //
    // But a STATUS CANNOT ANSWER PAYROLL'S QUESTION. "Were they employed on
    // 2026-07-15?" needs a date, and a flag has none. So the authoritative fact
    // is meta.exitedAt below and this enum is the fast index into it. They are
    // written together, never one without the other.
    //
    // NOT "inactive": that value is ambiguous — suspended, sabbatical, never
    // started — and an exit is a specific, irreversible thing that deserves to
    // say so.
    status: { type: String, enum: ["active", "inactive", "on_leave", "exited"], default: "active" },
    joinedAt: { type: Date, default: null },
    // Lifecycle (additive): round-robin auto-assignment cursor (least-recently-assigned wins).
    lastAssignedAt: { type: Date, default: null },
    // W1 (Workspaces, additive): the department workspace this admin last
    // entered — persisted by PUT /me/workspace, read back by GET /me/workspaces.
    lastWorkspaceId: { type: ObjectId, ref: "Department", default: null },
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
      // ── HR (2026-08-21) ────────────────────────────────────────────────────
      // Per-person shift start, "HH:MM". NULL means the company default
      // (Setting "hr.workStartTime"). Deliberately per-PERSON, not per-role: a
      // shift is an employment term, and Role here is a permission bundle — so
      // changing someone's hours must not change what they can see.
      workStartTime: { type: String, default: null },
      // A login that is not a person: integrations, shared service accounts,
      // seed/test users. Excluded from every HR roll-up. Set explicitly by a
      // human — nothing here guesses from a name.
      isServiceAccount: { type: Boolean, default: false },
      // Employment end — the LAST WORKING DAY, inclusive. Together with joinedAt
      // this is the "employed on this date" window; both null means UNKNOWN, and
      // the predicate says so rather than assuming.
      //
      // ⚠️ THIS IS THE AUTHORITATIVE DATE and utils/employment.employedOn reads
      // it directly. The exit record below sits beside it deliberately rather
      // than nesting the date inside a new object: moving it would mean two
      // places holding the same fact, which is how they drift apart.
      exitedAt: { type: Date, default: null },
      // ── THE EXIT RECORD (2026-08-25) ──────────────────────────────────────
      // Who recorded the exit and why. Kept because an exit removes someone from
      // payroll and revokes their access — decisions that get queried later, and
      // "the system says they left" is not an answer without a name against it.
      exitReason: { type: String, default: "" },
      exitRecordedBy: { type: ObjectId, ref: "Admin", default: null },
      exitRecordedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Admin", AdminSchema);
