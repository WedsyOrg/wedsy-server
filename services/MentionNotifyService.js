const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const AdminNotificationService = require("./AdminNotificationService");

// ───────────────────────────────────────────────────────────────────────────
// THE ONE PLACE chat_mention IS FIRED.
//
// Being @-tagged means the same thing wherever it happens — on a step note, a
// chat message, or a lead note — so it is one notification built in one place.
// It was previously constructed inline in LeadStepService and LeadChatService,
// and the lead-note route was about to become a third copy. Three copies of a
// notification drift: someone fixes the wording in one and the other two keep
// saying the old thing.
//
// This is a TRIGGER, not a new path: same type, same title shape, same
// recipients rule. Nothing here decides whether to notify — callers decide that
// by passing mentions; this decides only what the notification says.
// ───────────────────────────────────────────────────────────────────────────

// NOT a bare ObjectId.isValid(): that returns TRUE for numbers (isValid(123) is
// true), so a numeric id sails past the filter and only fails later, at the
// database, inside the fire-and-safe catch — where nobody sees it. Require a
// real id: a 24-character hex string, or an actual ObjectId instance.
const isId = (v) =>
  v instanceof mongoose.Types.ObjectId ||
  (typeof v === "string" && /^[a-f0-9]{24}$/i.test(v));

// The filtering every caller needs and must not each reinvent: real ids only,
// no duplicates, and never the author — being told you mentioned yourself is
// noise, and LeadStepService already worked this way.
const cleanMentions = (mentions, authorId) =>
  Array.isArray(mentions)
    ? [...new Set(
        mentions
          .filter((m) => isId(m) && String(m) !== String(authorId))
          .map(String)
      )]
    : [];

// Fire-and-safe, like every other notification path here: a failed ping must
// never break the note that caused it.
const notifyMentions = async (leadId, authorId, mentions, text, payload = {}) => {
  try {
    const ments = cleanMentions(mentions, authorId);
    if (!ments.length) return [];
    const [author, lead] = await Promise.all([
      Admin.findById(authorId, { name: 1 }).lean(),
      Enquiry.findById(leadId, { name: 1 }).lean(),
    ]);
    const authorName = author ? author.name : "Someone";
    return await AdminNotificationService.notify(ments, {
      type: "chat_mention",
      title: `${authorName} mentioned you on ${lead ? lead.name : "a lead"}`,
      message: String(text || "").slice(0, 160),
      leadId,
      payload,
    });
  } catch (e) {
    console.error("MentionNotifyService.notifyMentions failed:", e.message);
    return [];
  }
};

module.exports = { notifyMentions, cleanMentions };
