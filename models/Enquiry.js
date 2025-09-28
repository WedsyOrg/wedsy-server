const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// Lead/Enquiry Status:
// Fresh, New, Hot, Potential, Cold, Lost, Interested
// Fresh Lead: When its a new entry. (with 24 Hours)
// New Lead: When the lead has just come (within a week)
// Hot Lead: When event date is within 8 weeks.
// Potential Lead: When event date is between 8 weeks to 20 weeks.
// Cold Lead: Event is beyond 20 Weeks or not yet decided.
// Lost Lead: Waste Lead.
// Interested

// Note: When new field is added update it in get all enquiry api

const EnquirySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, default: "" },
    verified: { type: Boolean, default: false, required: true },
    isInterested: { type: Boolean, default: false, required: true },
    isLost: { type: Boolean, default: false, required: true },
    source: { type: String, required: true, default: "Default" },
    updates: {
      conversations: { type: [String], default: [] },
      notes: { type: String, default: "" },
      callSchedule: { type: Date, default: "" },
    },
    additionalInfo: { type: Object, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Enquiry", EnquirySchema);
