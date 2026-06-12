const mongoose = require("mongoose");

/**
 * VenueMessageTemplate — reusable message bodies a venue owner can apply when
 * sending bulk WhatsApp messages to leads. Scoped per venue.
 */
const VenueMessageTemplateSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true },
    name: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "VenueOwner" },
  },
  { timestamps: true }
);

VenueMessageTemplateSchema.index({ venue: 1, createdAt: -1 });

module.exports =
  mongoose.models.VenueMessageTemplate ||
  mongoose.model("VenueMessageTemplate", VenueMessageTemplateSchema);
