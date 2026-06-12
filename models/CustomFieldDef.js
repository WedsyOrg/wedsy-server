const mongoose = require("mongoose");

// Custom qualification field definitions (Settings Suite, Slice 3). Values live on
// Enquiry.customFields (Mixed). Defs are ARCHIVED, never deleted, once any lead
// holds a value for them.
const CustomFieldDefSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true }, // slug
    label: { type: String, required: true },
    type: {
      type: String,
      enum: ["text", "number", "select", "date", "boolean"],
      required: true,
    },
    options: { type: [String], default: [] }, // for type "select"
    showInCockpit: { type: Boolean, default: true },
    required: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    status: { type: String, enum: ["active", "archived"], default: "active" },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.CustomFieldDef || mongoose.model("CustomFieldDef", CustomFieldDefSchema);
