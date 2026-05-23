const mongoose = require('mongoose');

const QualifiedLeadSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  eventType: { type: String, default: '' },
  city: { type: String, default: '' },
  eventDate: { type: String, default: '' },
  numberOfEvents: { type: String, default: '' },
  venueStatus: { type: String, default: '' },
  venueName: { type: String, default: '' },
  servicesRequired: { type: String, default: '' },
  budget: { type: String, default: '' },
  source: { type: String, default: 'WhatsApp' },
  qualifiedAt: { type: Date, default: Date.now },
  googleSheetSynced: { type: Boolean, default: false }
});

module.exports = mongoose.model('QualifiedLead', QualifiedLeadSchema);
