const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// MB6 Slice 8 — one linked Google account per admin (OAuth offline access).
// The refresh token is the durable credential; access tokens are minted on
// demand and never stored.
const GoogleAccountSchema = new mongoose.Schema(
  {
    adminId: { type: ObjectId, ref: "Admin", required: true, unique: true },
    email: { type: String, required: true },
    refreshToken: { type: String, required: true },
    scopes: { type: [String], default: [] },
    linkedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.GoogleAccount || mongoose.model("GoogleAccount", GoogleAccountSchema);
