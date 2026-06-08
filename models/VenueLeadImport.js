const mongoose = require("mongoose");

// One record per CSV/Excel lead import run (Venue-Booking-owned).
const VenueLeadImportSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    importedBy: { type: mongoose.Schema.Types.ObjectId, ref: "VenueOwner" },
    fileName: { type: String, default: "" },
    total: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
  },
  { timestamps: true } // createdAt / updatedAt
);

VenueLeadImportSchema.index({ venue: 1, createdAt: -1 });

module.exports =
  mongoose.models.VenueLeadImport || mongoose.model("VenueLeadImport", VenueLeadImportSchema);
