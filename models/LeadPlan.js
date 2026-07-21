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
    // A4 (additive) — how the reaction was captured: "default" = the actor's
    // own tap (couple app / OS); "live_marked" = Meera marking in present mode
    // on the couple's behalf ("marked live by Meera"). One merged pool.
    source: { type: String, enum: ["default", "live_marked"], default: "default" },
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
          // A2 (additive) — theme + provenance: where this product came from.
          // themeId null = the products-direct path. themeName is a display
          // SNAPSHOT (provenance survives theme renames). provenance:
          //   "theme"        — picked from the browsed theme's own options
          //   "cross_theme"  — picked while browsing ANOTHER theme
          //   "more_options" — added answering a show-more request
          //   "direct"       — product-direct add (our extension; the locked
          //                    doc enumerates the first three)
          themeId: { type: ObjectId, ref: "DecorTheme", default: null },
          themeName: { type: String, default: "" },
          provenance: { type: String, enum: ["theme", "cross_theme", "more_options", "direct"], default: "direct" },
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
          source: { type: String, enum: ["default", "live_marked"], default: "default" },
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    styleSignature: { type: String, default: "" },
    // Addendum (locked flow) — the PERSISTENT per-event theme selection
    // ("Your Haldi · Sunshine Yellow" header, both sides). Changeable anytime.
    selectedThemes: {
      type: [
        {
          functionKey: { type: String, required: true },
          themeId: { type: ObjectId, ref: "DecorTheme", required: true },
          themeName: { type: String, default: "" },
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    // A5 — the planner-set whole-wedding "selection complete" flag (the
    // finalise gate's human override; readiness is judgment, not machinery).
    selectionComplete: { type: Boolean, default: false },
    // A8 — the log-work watermark.
    lastLoggedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.LeadPlan || mongoose.model("LeadPlan", LeadPlanSchema);
