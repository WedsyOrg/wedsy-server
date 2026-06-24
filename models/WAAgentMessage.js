const mongoose = require('mongoose');

const WAAgentMessageSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  message: { type: String, required: true },
  // Additive (Kiara ↔ Wedsy OS): set when a human admin sends from the CRM,
  // null for Kiara's own replies and customer messages.
  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('WAAgentMessage', WAAgentMessageSchema);
