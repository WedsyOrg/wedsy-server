const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// ── A receipt ────────────────────────────────────────────────────────────────
//
// Deliberately the SAME vocabulary as LeadChatMessage's AttachmentSchema —
// { type, url, name } — so a receipt is recognisably the same kind of thing as
// any other attachment, extended with what an audit needs and a chat message
// does not: what was actually filed, how big it was, when, and by whom.
const ReceiptSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["image", "pdf"], required: true },
    url: { type: String, required: true },
    name: { type: String, default: "" },          // the claimant's original filename
    contentType: { type: String, default: "" },   // SNIFFED, not the browser's claim
    sizeBytes: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: ObjectId, ref: "Admin", default: null },
  },
  { _id: false }
);

// Founder's ruling — a fixed list, not free text, so the payroll sheet can group.
const CATEGORIES = ["travel", "client_meeting", "materials", "food", "other"];

const ReimbursementSchema = new mongoose.Schema(
  {
    claimant: { type: ObjectId, ref: "Admin", required: true, index: true },

    // BOTH figures are kept, always. amountApproved differing from
    // amountClaimed is the whole point of the partial outcome: overwriting the
    // claimed figure would erase what the person actually asked for, which is
    // exactly the number they will query months later.
    amountClaimed: { type: Number, required: true, min: 0 },
    amountApproved: { type: Number, default: null },

    spentOn: { type: String, required: true },   // IST day key "YYYY-MM-DD"
    category: { type: String, enum: CATEGORIES, required: true },
    note: { type: String, default: "", trim: true },

    attachments: { type: [ReceiptSchema], default: [] },

    status: {
      type: String,
      enum: ["pending", "approved", "partial", "rejected"],
      default: "pending",
      index: true,
    },
    decisionReason: { type: String, default: "", trim: true },
    decidedBy: { type: ObjectId, ref: "Admin", default: null },
    decidedAt: { type: Date, default: null },

    // The payroll run that paid it. Null while unpaid; stamped at finalise so a
    // claim can never be paid by two runs.
    paidWithRun: { type: String, default: null, index: true },
  },
  { timestamps: true }
);

ReimbursementSchema.index({ claimant: 1, status: 1 });
ReimbursementSchema.index({ status: 1, paidWithRun: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// EVIDENCE IS IMMUTABLE ONCE THE CLAIM IS DECIDED.
//
// A founder approves ₹4,000 against three photographs. If those photographs can
// change afterwards, the approval no longer means anything — and the swap would
// leave no trace, because the decision fields would still read the same.
//
// Enforced with THROWING HOOKS on every write path rather than a check in one
// service, for the same reason DecorDraft does it: a check in a service is
// bypassed the moment someone writes a second service. Mongoose's own
// `immutable: true` strips silently on update and no-ops on save, which would
// hide exactly the bug worth catching — so these throw.
//
// A PENDING claim's attachments stay editable: adding a forgotten receipt or
// removing one uploaded by mistake is ordinary, and nothing has been decided
// against them yet.
const DECIDED = ["approved", "partial", "rejected"];

const guardUpdate = function (next) {
  const update = this.getUpdate() || {};
  const touchesAttachments = (obj) => {
    if (!obj || typeof obj !== "object") return false;
    return Object.keys(obj).some((k) =>
      k.startsWith("$") ? touchesAttachments(obj[k]) : k === "attachments" || k.startsWith("attachments.")
    );
  };
  if (!touchesAttachments(update)) return next();
  // Only block when the document being updated is ALREADY decided. The decision
  // write itself does not touch attachments, so it is unaffected.
  this.model
    .findOne(this.getQuery(), { status: 1 })
    .lean()
    .then((doc) => {
      if (doc && DECIDED.includes(doc.status)) {
        return next(
          new Error(
            `Reimbursement: attachments are immutable once the claim is ${doc.status} — ` +
              "the evidence a decision was made against cannot change."
          )
        );
      }
      next();
    })
    .catch(next);
};

for (const op of ["findOneAndUpdate", "updateOne", "updateMany", "replaceOne", "findOneAndReplace"]) {
  ReimbursementSchema.pre(op, guardUpdate);
}

ReimbursementSchema.pre("save", function (next) {
  if (this.isNew) return next();
  if (!this.isModified("attachments")) return next();
  // `status` here is the value being saved. A claim that is decided in the SAME
  // save as an attachment change is still a change to decided evidence.
  const wasDecided = DECIDED.includes(this.status);
  if (wasDecided) {
    return next(
      new Error(
        `Reimbursement: attachments are immutable once the claim is ${this.status} — ` +
          "the evidence a decision was made against cannot change."
      )
    );
  }
  next();
});

ReimbursementSchema.statics.CATEGORIES = CATEGORIES;
ReimbursementSchema.statics.DECIDED = DECIDED;

module.exports =
  mongoose.models.Reimbursement || mongoose.model("Reimbursement", ReimbursementSchema);
