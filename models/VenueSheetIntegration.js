const mongoose = require("mongoose");

// One Google Sheets integration per venue (Venue-Booking-owned). MVP is one-way
// (sheet → leads). The refreshToken is stored ENCRYPTED (see utils/googleSheets.js).
const VenueSheetIntegrationSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true, unique: true },
    refreshToken: { type: String, default: "" }, // AES-256-GCM ciphertext, never plaintext
    spreadsheetId: { type: String, default: "" },
    sheetName: { type: String, default: "" },
    // columnMap: { <leadField>: <sheet column header> }
    columnMap: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastSyncAt: { type: Date },
    status: {
      type: String,
      enum: ["disconnected", "connected", "error"],
      default: "disconnected",
    },
    // ── DEFERRED seam: two-way write-back (lead stage → sheet row). Not built in MVP.
    //   When implemented, add e.g. writeBackEnabled:Boolean + a row-id column mapping
    //   here, and a writeBackLeadToSheet() in controllers/venueSheetsSync.js.
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.VenueSheetIntegration ||
  mongoose.model("VenueSheetIntegration", VenueSheetIntegrationSchema);
