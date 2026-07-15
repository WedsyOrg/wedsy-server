const mongoose = require("mongoose");

const DepartmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    // W1 (Workspaces) — stable machine key for the workspace switcher. Optional
    // and additive: legacy departments have "" and key off a slugified name.
    slug: { type: String, default: "" },
    isSystem: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Department", DepartmentSchema);
