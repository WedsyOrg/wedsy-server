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
    // ── Two-way write-back support (lead stage → sheet row) ──
    // Captured at sync time so a later stage change can locate the right cell
    // WITHOUT mutating the shared VenueEnquiry model (chosen over adding
    // sheetRowIndex to VenueEnquiry, which is the more invasive option).
    //   rowMap:      { <couplePhoneDigits>: <1-based sheet row number> }
    //   stageColumn: A1 column letter of the mapped stage column (e.g. "H")
    rowMap: { type: mongoose.Schema.Types.Mixed, default: {} },
    stageColumn: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.VenueSheetIntegration ||
  mongoose.model("VenueSheetIntegration", VenueSheetIntegrationSchema);
