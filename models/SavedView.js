const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// MB6 Slice 9 — per-user named filter sets for the leads page. The filters
// array is the same {field,op,value}[] shape the filter builder validates;
// it is re-validated on save AND on every use (the builder runs at read time).
const SavedViewSchema = new mongoose.Schema(
  {
    adminId: { type: ObjectId, ref: "Admin", required: true, index: true },
    name: { type: String, required: true },
    filters: { type: [Object], default: [] },
    // Optional lifecycle chip ("active"|"meeting"|"won"|"recycled"|"lost"|"triage").
    view: { type: String, default: "" },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

SavedViewSchema.index({ adminId: 1, name: 1 }, { unique: true });

module.exports = mongoose.models.SavedView || mongoose.model("SavedView", SavedViewSchema);
