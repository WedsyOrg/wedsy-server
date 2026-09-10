const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// COUPLE APP § 06.1 — THE COUPLE'S OWN REMINDER ("Share the website draft with
// Karthik"). Distinct from the two task models already here, and deliberately
// not a widening of either:
//
//   models/Task.js            an admin task, category + deadline, no wedding
//                             scope at all — it cannot answer "whose?".
//   models/WeddingMilestone   the AI/planner-authored wedding TIMELINE for an
//                             Event, already rendered inside the CRM lead page
//                             (routes → leadPageV3.ListClientTasks). Its rows
//                             are the team's plan for the couple; its `source`
//                             enum is ["AI","Custom"] and it has no notion of a
//                             personal reminder or of who on the couple's side
//                             wrote it.
//
// GET /wedding/:id/tasks is specified in docs/couple-app-api.md as the UNION of
// the two — a milestone the planner set and a note the couple wrote both belong
// on the couple's Tasks screen — while every couple-app WRITE lands here. That
// keeps the CRM's timeline exactly as it is.
const CoupleTaskSchema = new mongoose.Schema(
  {
    weddingId: { type: ObjectId, ref: "Event", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    dueDate: { type: Date, default: null },
    done: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },

    // § 05.4 — "remind me". A TRIGGER FLAG ONLY. Nothing in this milestone
    // sends anything: when the reminder ships it goes through
    // services/NotificationService.js like every other notification in this
    // repo (trigger name proposed in docs/couple-app-api.md).
    remind: { type: Boolean, default: false },
    remindAt: { type: Date, default: null },

    // Who asked for it, for the "Ravi Menon" / "you" line on the card. A
    // display name because the author may be an Admin, a partner or a shared
    // member, and the card only ever renders the name.
    createdByName: { type: String, default: "", maxlength: 120 },
    createdBy: { type: ObjectId, ref: "User", default: null },
    createdByMember: { type: ObjectId, ref: "SharedMember", default: null },
  },
  { timestamps: true }
);

// The Tasks screen: one wedding, open first, by due date.
CoupleTaskSchema.index({ weddingId: 1, done: 1, dueDate: 1 });

module.exports = mongoose.models.CoupleTask || mongoose.model("CoupleTask", CoupleTaskSchema);
