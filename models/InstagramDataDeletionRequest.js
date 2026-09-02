const mongoose = require("mongoose");

// One row per data-deletion request Meta forwards to us.
//
// It exists because the callback must answer IMMEDIATELY with a confirmation
// code and a status URL, while the deletion itself is not instant. The row is
// what makes that promise checkable: a person visits the status page, quotes
// the code, and is told the truth about where their request stands.
//
// THE ROW IS THE RECEIPT. Meta's contract is that the code we hand back can be
// looked up later, so this must be written BEFORE the response is sent — an
// unrecorded code is a broken promise to a regulator-facing flow.
const InstagramDataDeletionRequestSchema = new mongoose.Schema(
  {
    // What the person quotes on the status page. Random, not derived from the
    // user id: it appears in URLs and must not itself disclose whose request
    // it is. Indexed because the status page's only query is by this.
    confirmationCode: { type: String, required: true, unique: true, index: true },

    // The Instagram account id from the verified signed_request payload.
    instagramUserId: { type: String, required: true, index: true },

    // ── Status ──────────────────────────────────────────────────────────────
    // 'received'  — recorded, deletion not yet carried out.
    // 'completed' — everything in scope has been deleted.
    // 'failed'    — a step errored; see NotificationFailureLog.
    //
    // SCOPE IS SETTLED (2026-09-03): the connection only. The full reasoning
    // lives at the deletion handler in controllers/instagramPrivacy.js — read it
    // there before widening this. Because the scope is one delete, a request
    // reaches 'completed' within the same request that created it, and
    // 'received' now exists only as the initial value and the honest answer if
    // the process dies mid-flight.
    //
    // A deletion that removed 0 rows is still 'completed': Meta says to
    // disregard ids absent from our records, and "we hold nothing about you" is
    // a finished answer. What must never happen is the reverse — reporting
    // 'completed' on a page whose whole purpose is to tell someone the truth
    // about their data, while something in scope is still pending.
    status: {
      type: String,
      enum: ["received", "completed", "failed"],
      default: "received",
      index: true,
    },

    // What we actually did, recorded as it happens. This is the audit trail if
    // anyone ever asks us to prove a deletion — including us.
    actions: {
      type: [
        {
          step: { type: String, required: true },
          result: { type: String, default: "" },
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    // Set once the scope question is answered and the full deletion runs.
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.InstagramDataDeletionRequest ||
  mongoose.model("InstagramDataDeletionRequest", InstagramDataDeletionRequestSchema);
