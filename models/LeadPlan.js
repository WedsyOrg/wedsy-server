const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// P1 — THE PLAN. ONE per lead (unique leadId): the inspiration + selection
// layers of the planner. Looks are pinned inspiration (decor / package /
// upload) with a display SNAPSHOT taken at add time (name/image/price chip —
// survives catalog edits); reactions carry the three voices (couple / family
// / wedsy). The build layer lives in draft Events, NOT here.
const ReactionSchema = new mongoose.Schema(
  {
    voice: { type: String, enum: ["couple", "family", "wedsy"], required: true },
    name: { type: String, default: "" },
    userId: { type: ObjectId, ref: "User", default: null },
    adminId: { type: ObjectId, ref: "Admin", default: null },
    kind: { type: String, enum: ["love", "pass"], required: true },
    note: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const LeadPlanSchema = new mongoose.Schema(
  {
    leadId: { type: ObjectId, ref: "Enquiry", required: true, unique: true, index: true },
    looks: {
      type: [
        {
          source: { type: String, enum: ["decor", "package", "upload"], required: true },
          decorId: { type: ObjectId, ref: "Decor", default: null },
          packageId: { type: ObjectId, ref: "DecorPackage", default: null },
          imageUrl: { type: String, default: "" },
          // Display snapshot at add — never re-read from the catalog.
          snapshot: {
            name: { type: String, default: "" },
            image: { type: String, default: "" },
            priceChip: { type: String, default: "" },
          },
          functionKey: { type: String, default: "" }, // sangeet | haldi | …
          categoryKey: { type: String, default: "" }, // stage | mandap | …
          round: { type: Number, default: 1 },
          talkingPoint: { type: String, default: "" },
          shortlisted: { type: Boolean, default: false },
          reactions: { type: [ReactionSchema], default: [] },
          addedBy: { type: ObjectId, ref: "Admin", default: null },
          addedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    moodReactions: {
      type: [
        {
          moodId: { type: String, required: true },
          kind: { type: String, enum: ["love", "pass"], required: true },
          note: { type: String, default: "" },
          voice: { type: String, enum: ["couple", "family", "wedsy"], required: true },
          name: { type: String, default: "" },
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    styleSignature: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.models.LeadPlan || mongoose.model("LeadPlan", LeadPlanSchema);
