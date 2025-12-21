const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const VendorPersonalLeadSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, required: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    notes: { type: String, default: "" },
    admin_notes: { type: String, default: "" },
    eventType: { type: String, default: "" },
    eventInfo: {
      type: [
        {
          date: {
            type: String,
            default: "",
          },
          time: {
            type: String,
            default: "",
          },
        },
      ],
      default: [],
    },
    tasks: {
      type: [
        {
          task: {
            type: String,
            default: "",
          },
          date: {
            type: String,
            default: "",
          },
          time: {
            type: String,
            default: "",
          },
        },
      ],
      default: [],
    },
    payment: {
      total: { type: Number, required: true, default: 0 },
      received: { type: Number, required: true, default: 0 },
      remindersSentCount: { type: Number, required: true, default: 0 },
      lastReminderAt: { type: Date, default: null },
      reminders: {
        type: [
          {
            sentAt: { type: Date, default: Date.now },
            channel: { type: String, default: "Whatsapp" },
            status: { type: String, default: "sent" }, // "sent" | "failed"
            notes: { type: String, default: "" },
          },
        ],
        default: [],
      },
      transactions: {
        type: [
          {
            amount: {
              type: Number,
              default: 0,
            },
            method: {
              type: String,
              default: "",
            },
            date: {
              type: String,
              default: "",
            },
            time: {
              type: String,
              default: "",
            },
          },
        ],
        default: [],
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("VendorPersonalLead", VendorPersonalLeadSchema);
