const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// Key-value platform settings (Settings Suite). Every key has a hardcoded default
// in SettingsService — an empty collection means zero behavior change.
const SettingSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true },
    value: { type: mongoose.Schema.Types.Mixed },
    updatedBy: { type: ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Setting || mongoose.model("Setting", SettingSchema);
