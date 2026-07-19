// L1 — LEAD ACTIVITY. Ingest (internal seam + in-repo producers), the
// newest-first read, and the WARMTH/PRESENCE decoration for the single-lead
// GET. Lead resolution when only a couple-side identity arrives: userId →
// User.phone → the newest matching Enquiry (the same phone bridge the
// intake/onboarding flow rides).
const mongoose = require("mongoose");
const LeadActivityEvent = require("../models/LeadActivityEvent");
const Enquiry = require("../models/Enquiry");
const User = require("../models/User");

const err = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const DAY_MS = 24 * 60 * 60 * 1000;

const KINDS = LeadActivityEvent.KINDS;

// Auto-composed display line when the producer sends no text.
const autoText = (kind, meta = {}) => {
  switch (kind) {
    case "login": return "Opened the app";
    case "heart": return meta.itemName ? `Hearted “${meta.itemName}”` : "Hearted a look";
    case "draft_view": return meta.draftName ? `Viewed draft “${meta.draftName}”` : "Viewed a draft";
    case "quote_sent": return meta.draftName ? `Sent “${meta.draftName}” for quote` : "Sent picks for quote";
    case "guest_change": return "Updated the guest list";
    case "rsvp": return meta.guestName ? `RSVP from ${meta.guestName}` : "An RSVP came in";
    case "registry": return "Registry activity";
    case "website_publish": return "Published the wedding website";
    case "payment": return meta.amount ? `Payment received · ₹${Number(meta.amount).toLocaleString("en-IN")}` : "Payment received";
    case "task": return meta.title ? `Task — ${meta.title}` : "Task activity";
    case "circle_change": return "Wedding circle updated";
    default: return "Activity";
  }
};

// userId/phone → the newest lead on that phone (any lifecycle state — the
// activity spine outlives stage churn).
const resolveLeadId = async ({ leadId, userId, phone }) => {
  if (leadId && isId(leadId)) {
    const hit = await Enquiry.findById(leadId, { _id: 1 }).lean();
    if (hit) return hit._id;
    throw err(404, "Lead not found");
  }
  let ph = String(phone || "").trim();
  if (!ph && userId && isId(userId)) {
    const user = await User.findById(userId, { phone: 1 }).lean();
    if (user) ph = String(user.phone || "").trim();
  }
  if (!ph) throw err(400, "Pass leadId, or a resolvable userId/phone.");
  const lead = await Enquiry.findOne({ phone: ph }).sort({ createdAt: -1 }).lean();
  if (!lead) throw err(404, "No lead matches that couple identity.");
  return lead._id;
};

// The ONE writer. voice defaults couple when a couple-side identity is the
// actor, wedsy otherwise.
const ingest = async ({ leadId, userId, phone, kind, text, meta, voice, at } = {}, { adminId = null } = {}) => {
  if (!KINDS.includes(kind)) throw err(400, `kind must be one of: ${KINDS.join(", ")}`);
  const resolvedLeadId = await resolveLeadId({ leadId, userId, phone });
  const v = voice === "couple" || voice === "wedsy" ? voice : userId ? "couple" : "wedsy";
  const when = at ? new Date(at) : new Date();
  if (Number.isNaN(when.getTime())) throw err(400, "Invalid at");
  const event = await LeadActivityEvent.create({
    leadId: resolvedLeadId,
    userId: userId && isId(userId) ? userId : null,
    adminId: adminId && isId(adminId) ? adminId : null,
    kind,
    text: String(text || "").trim().slice(0, 500) || autoText(kind, meta || {}),
    meta: meta && typeof meta === "object" ? meta : {},
    voice: v,
    at: when,
  });
  return event.toObject();
};

// GET /enquiry/:_id/activity — newest first, voice-filterable.
const list = async (leadId, { voice, limit } = {}) => {
  if (!isId(leadId)) throw err(400, "Invalid lead id");
  const q = { leadId };
  if (voice === "couple" || voice === "wedsy") q.voice = voice;
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const events = await LeadActivityEvent.find(q).sort({ at: -1 }).limit(lim).lean();
  return { events, count: events.length };
};

// WARMTH + PRESENCE — the single-lead GET decoration. Derived from couple-
// voice events, plus the linked User doc's lastActive when the auth heartbeat
// (wedsy-user side) stamps it — read defensively: the field is not in this
// repo's User schema yet, but lean() surfaces it when present.
const warmthFor = async (leadId, lead = null) => {
  const now = Date.now();
  const doc = lead || (await Enquiry.findById(leadId, { phone: 1 }).lean());
  if (!doc) return { presence: { lastActiveAt: null, tone: null }, warmth: { hot: false, quiet: false } };

  const [latestCouple, hotCount, linkedUser] = await Promise.all([
    LeadActivityEvent.findOne({ leadId, voice: "couple" }, { at: 1 }).sort({ at: -1 }).lean(),
    LeadActivityEvent.countDocuments({
      leadId,
      voice: "couple",
      kind: { $in: ["draft_view", "heart"] },
      at: { $gte: new Date(now - DAY_MS) },
    }),
    doc.phone ? User.findOne({ phone: doc.phone, deleted: { $ne: true } }).lean() : null,
  ]);

  const candidates = [
    latestCouple ? +new Date(latestCouple.at) : null,
    linkedUser && linkedUser.lastActive ? +new Date(linkedUser.lastActive) : null,
  ].filter((t) => t != null && !Number.isNaN(t));
  const lastActiveMs = candidates.length ? Math.max(...candidates) : null;

  // green <24h · gray 24h–14d · amber ≥14d · null when never seen.
  let tone = null;
  if (lastActiveMs != null) {
    const age = now - lastActiveMs;
    tone = age < DAY_MS ? "green" : age < 14 * DAY_MS ? "gray" : "amber";
  }

  return {
    presence: { lastActiveAt: lastActiveMs != null ? new Date(lastActiveMs) : null, tone },
    warmth: {
      hot: hotCount >= 3,
      quiet: !!linkedUser && (lastActiveMs == null || now - lastActiveMs >= 14 * DAY_MS),
    },
  };
};

module.exports = { ingest, list, warmthFor, resolveLeadId, autoText, KINDS };
