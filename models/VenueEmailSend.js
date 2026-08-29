/**
 * models/VenueEmailSend.js — ONE ROW PER EMAIL SENT to a couple from a venue.
 *
 * This is the dispute record for "what did you send them, when, and did it
 * arrive". The quote round holds only the LATEST terms verdict, which is
 * enough for a pill and not enough to reopen an email six weeks later; this
 * row is what the "Emails sent" panel opens.
 *
 * THE RENDERED BODY IS STORED, NOT RE-RENDERED. A template edited in Mailjet
 * next month must not change what a past email appears to have said, so the
 * HTML is captured at send time from the template as it stood (fetched from
 * Mailjet when reachable — `renderedFrom: "mailjet"` — else compiled from the
 * repo's starting point, `renderedFrom: "repo"`) with the variables that were
 * actually sent. The row is immutable once the verdict is written.
 *
 * `delivered` is Mailjet's answer, never "we called send()". A row is inserted
 * BEFORE the transport call with `delivered:false` and "in flight" as the
 * error, then updated with the verdict — so a process death mid-send leaves an
 * honest row rather than nothing.
 */
const mongoose = require("mongoose");

const VenueEmailSendSchema = new mongoose.Schema(
  {
    venue: { type: mongoose.Schema.Types.ObjectId, ref: "Venue", required: true, index: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: "VenueEnquiry", required: true, index: true },

    // What was sent. `document` is the VenueLeadDocument row when there is one;
    // the legacy generated-terms path has no stored artefact, so it carries
    // kind + filename only and `document` stays null.
    document: { type: mongoose.Schema.Types.ObjectId, ref: "VenueLeadDocument" },
    documentKind: { type: String, required: true },
    documentVersion: { type: Number },

    // The email as addressed.
    subject: { type: String, default: "" },
    to: {
      email: { type: String, required: true },
      name: { type: String, default: "" },
    },
    from: {
      email: { type: String, default: "" },
      name: { type: String, default: "" },
    },

    // The owner's words (the one editable region) and the whole body as sent.
    message: { type: String, default: "" },
    renderedHtml: { type: String, default: "" },
    renderedText: { type: String, default: "" },
    renderedFrom: { type: String, enum: ["mailjet", "repo", ""], default: "" },
    templateId: { type: Number },
    templateUpdatedAt: { type: Date },
    variables: { type: mongoose.Schema.Types.Mixed, default: {} },

    attachment: {
      url: { type: String, default: "" },
      filename: { type: String, default: "" },
      sizeBytes: { type: Number },
    },

    // The verdict.
    delivered: { type: Boolean, default: false },
    deliveryError: { type: String, default: "" },
    messageId: { type: String, default: "" },
    sentAt: { type: Date, default: Date.now },
    deliveredAt: { type: Date },

    // Who pressed send. Name as well as id — the id stops resolving the day
    // that member leaves, and "sent by someone who has since left" is still
    // useful provenance.
    triggeredBy: { type: mongoose.Schema.Types.ObjectId },
    triggeredByName: { type: String, default: "" },
  },
  { timestamps: true }
);

VenueEmailSendSchema.index({ enquiry: 1, sentAt: -1 });

// Immutable once the verdict is in: the only writes allowed are the two the
// send path makes (insert, then the verdict). Anything after is refused.
VenueEmailSendSchema.pre("save", function (next) {
  if (!this.isNew && this.$locals && this.$locals.allowVerdict) return next();
  if (!this.isNew) return next(new Error("VenueEmailSend rows are immutable once written"));
  return next();
});

module.exports = mongoose.model("VenueEmailSend", VenueEmailSendSchema);
