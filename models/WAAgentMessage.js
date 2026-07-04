const mongoose = require('mongoose');

const WAAgentMessageSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  message: { type: String, required: true },
  // Additive (Kiara ↔ Wedsy OS): set when a human admin sends from the CRM,
  // null for Kiara's own replies and customer messages.
  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  // Additive (inbound media): all null/absent on existing text rows. Populated
  // when a couple sends an image/document/video/audio/sticker. `mediaUrl` is OUR
  // permanent S3 URL after download — never Meta's expiring URL. When the
  // download/store fails it stays null (flag-don't-fake): the row still records
  // with mediaType set so the frontend can show a "media unavailable" state.
  mediaType: { type: String, default: null },        // image | document | video | audio | sticker
  mediaUrl: { type: String, default: null },          // our permanent S3 URL (null if store failed)
  mediaMimeType: { type: String, default: null },
  mediaFilename: { type: String, default: null },     // document filename when present
  mediaCaption: { type: String, default: null },      // Meta/IG caption if any
  mediaSize: { type: Number, default: null },          // bytes, if available
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('WAAgentMessage', WAAgentMessageSchema);
