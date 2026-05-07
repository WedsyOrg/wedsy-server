const mongoose = require('mongoose');

const WAAgentMessageSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('WAAgentMessage', WAAgentMessageSchema);
