const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// A1 — DECOR THEME (Settings → Planner → Themes). A whole-EVENT aesthetic
// direction ("Sunshine Yellow" for a Haldi) spanning ALL categories inside it
// — NOT per-category (Beat 2 correction). Founder/RH-managed; planners USE
// them mid-lead. taggedDecorIds is THE LEARNING LOOP: every product added to
// a plan under this theme tags back here, so the theme gets smarter every
// wedding — an additive suggestion signal, never a hiding filter.
const DecorThemeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    eventType: {
      type: String,
      enum: ["haldi", "sangeet", "wedding", "reception", "custom"],
      required: true,
      index: true,
    },
    // The couple-facing cover identity (Canva/PDF/image upload).
    backgroundImageUrl: { type: String, default: "" },
    active: { type: Boolean, default: true },
    taggedDecorIds: { type: [ObjectId], ref: "Decor", default: [] },
    createdBy: { type: ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);
DecorThemeSchema.index({ eventType: 1, active: 1 });

module.exports = mongoose.models.DecorTheme || mongoose.model("DecorTheme", DecorThemeSchema);
