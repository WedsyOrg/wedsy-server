const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// Team calendar (MB5 Slice 3). One row per scheduled item on an employee's
// calendar. Sources: meet/visit follow-ups mirror in automatically, manual
// blocks, huddles (auto-created when a gmeet follow-up is booked), and
// Google-created meets (googleEventId set, Slice 8).
//
// Meeting lifecycle: status stays "scheduled" while live/over; closing REQUIRES
// notes (the meeting-notes gate). A past-end meeting still "scheduled" is an
// UNCLOSED meeting — pinned on the owner's dashboard and blocking their next one.
const CalendarEventSchema = new mongoose.Schema(
  {
    ownerId: { type: ObjectId, ref: "Admin", required: true, index: true },
    type: {
      type: String,
      enum: ["meeting", "gmeet", "huddle", "visit", "block"],
      required: true,
    },
    leadId: { type: ObjectId, ref: "Enquiry", default: null, index: true },
    title: { type: String, required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    participantIds: { type: [{ type: ObjectId, ref: "Admin" }], default: [] },
    googleEventId: { type: String, default: "" },
    status: {
      type: String,
      enum: ["scheduled", "closed", "cancelled"],
      default: "scheduled",
    },
    // Mirror linkage: the followUp subdoc id this event was created from.
    followUpId: { type: ObjectId, default: null },
    // Meeting-mode notes (draft while live, mandatory at close).
    notes: { type: String, default: "" },
    closedAt: { type: Date, default: null },
    closedBy: { type: ObjectId, ref: "Admin", default: null },
    // Huddle completion payload (type "huddle" only).
    huddleOutcome: {
      attendeeIds: { type: [{ type: ObjectId, ref: "Admin" }], default: [] },
      eventTeam: {
        type: [
          {
            adminId: { type: ObjectId, ref: "Admin", required: true },
            label: { type: String, default: "" },
          },
        ],
        default: [],
      },
    },
  },
  { timestamps: true }
);

CalendarEventSchema.index({ ownerId: 1, start: 1 });
CalendarEventSchema.index({ leadId: 1, type: 1 });
CalendarEventSchema.index({ status: 1, end: 1 });

module.exports =
  mongoose.models.CalendarEvent || mongoose.model("CalendarEvent", CalendarEventSchema);
