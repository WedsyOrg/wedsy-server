const mongoose = require('mongoose');

const NotificationFailureLogSchema = new mongoose.Schema({
  service: {
    type: String,
    enum: ['WhatsApp', 'SMS', 'Email', 'Razorpay', 'S3', 'Anthropic', 'GoogleSheets', 'Instagram'],
    required: true
  },
  template: {
    type: String,
    default: null
  },
  phone: {
    type: String,
    default: null
  },
  email: {
    type: String,
    default: null
  },
  error: {
    type: String,
    required: true
  },
  params: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  attempts: {
    type: Number,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('NotificationFailureLog', NotificationFailureLogSchema);
