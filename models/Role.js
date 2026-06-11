const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const RoleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    departmentId: { type: ObjectId, ref: "Department", required: true },
    description: { type: String, default: "" },
    permissions: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false },
    protected: { type: Boolean, default: false },
    // Settings Suite (additive): stable machine key; "founder" marks the immutable role.
    systemKey: { type: String, default: "" },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Role", RoleSchema);
