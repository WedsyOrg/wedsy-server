const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// MB7b Slice 4 — the founder-editable Nurture Library: categorized, copy-paste
// message ideas the CS team pastes into the couple's WhatsApp group.
const NurtureTemplateSchema = new mongoose.Schema(
  {
    category: { type: String, required: true },
    title: { type: String, required: true },
    text: { type: String, required: true },
    link: { type: String, default: "" },
    createdBy: { type: ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

NurtureTemplateSchema.index({ category: 1, createdAt: -1 });

module.exports =
  mongoose.models.NurtureTemplate ||
  mongoose.model("NurtureTemplate", NurtureTemplateSchema);
