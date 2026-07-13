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
    // Journey v2 addendum: the Meet link, persisted at creation so the history
    // list renders it without re-deriving from Google.
    meetLink: { type: String, default: "" },
    // Journey v2 (V2): who the Google event was created AS (their linked
    // account patches/cancels it later). Null on OS-only meetings.
    organizerAdminId: { type: ObjectId, ref: "Admin", default: null },
    // Journey v2 (V2): the FULL invitee list (client emails + team). adminId
    // set for internal attendees; email-only rows are clients/externals.
    attendees: {
      type: [
        {
          email: { type: String, required: true },
          name: { type: String, default: "" },
          adminId: { type: ObjectId, ref: "Admin", default: null },
        },
      ],
      default: [],
    },
    status: {
      type: String,
      // "postponed" (Journey v2): parked without a new date — leaves the
      // unclosed-meeting gate and the deal clock exactly like cancelled.
      enum: ["scheduled", "closed", "cancelled", "postponed"],
      default: "scheduled",
    },
    // Journey v2 (V2): why a meeting was postponed/cancelled.
    statusReason: { type: String, default: "" },
    // Journey v2 (V2): minutes of meeting — saved deliberately at meeting end.
    mom: {
      type: new mongoose.Schema(
        {
          text: { type: String, default: "" },
          savedBy: { type: ObjectId, ref: "Admin", default: null },
          savedAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    // Journey v2 (V2): the manual "sent to client" tick — a deliberate human
    // act AFTER actually sending; never stamped automatically.
    momSentToClient: {
      type: new mongoose.Schema(
        {
          at: { type: Date, default: null },
          by: { type: ObjectId, ref: "Admin", default: null },
        },
        { _id: false }
      ),
      default: null,
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
