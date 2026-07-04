const mongoose = require('mongoose');

const NotificationFailureLogSchema = new mongoose.Schema({
  service: {
    type: String,
    // NOTE (kiara-ig-fixes): 'KiaraCrmSync' was already referenced by the
    // WhatsApp/Instagram agents but was MISSING from this enum — so CRM-sync
    // failure logs silently failed validation and never persisted (a swallowed
    // error). Added here, alongside the new IG lead-link / extractor-parse
    // surfaces, so these failures are actually recorded.
    enum: ['WhatsApp', 'SMS', 'Email', 'Razorpay', 'S3', 'Anthropic', 'GoogleSheets', 'Instagram', 'QualifiedLeadDB', 'KiaraCrmSync', 'IgLeadLink', 'IgExtractorParse'],
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
