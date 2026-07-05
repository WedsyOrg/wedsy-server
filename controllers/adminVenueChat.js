/**
 * controllers/adminVenueChat.js — MB-V2 P2 (D4): Wedsy chat oversight.
 *
 * Admins watch every venue↔couple thread, intervene (senderType "wedsy",
 * targeted both|couple_only|venue_only), send structured offers, triage
 * keyword-flagged threads, and see the venue-silence SLA. The WhatsApp nudge
 * is a log-only trigger (never sends unless explicitly wired), matching the
 * existing reminder pattern.
 */
const mongoose = require("mongoose");
const VenueConversation = require("../models/VenueConversation");
const VenueMessage = require("../models/VenueMessage");
const Venue = require("../models/Venue");
const { slaHours, flagTerms } = require("../utils/venueChatFlags");
const { logActivity } = require("../utils/venueActivity");

const intParam = (v, def, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return max ? Math.min(n, max) : n;
};

// A thread breaches SLA when it's open, the couple has spoken, and the venue
// has been silent since — i.e. the last message is the couple's and it's older
// than the SLA window. (wedsy interventions don't count as a venue reply.)
const slaBreach = (conv, lastMsg, cutoff) => {
  if (conv.status !== "open") return false;
  if (!lastMsg || lastMsg.senderType !== "couple") return false;
  return new Date(lastMsg.createdAt).getTime() < cutoff;
};

const listThreads = async (req, res) => {
  try {
    const { view, slug } = req.query;
    if (view && !["all", "flagged", "triage"].includes(view)) {
      return res.status(400).json({ message: "view must be all, flagged or triage" });
    }
    const filter = {};
    if (slug) {
      const venue = await Venue.findOne({ slug: String(slug) }).select("_id").lean();
      if (!venue) return res.status(404).json({ message: "Venue not found" });
      filter.venueId = venue._id;
    }
    if (view === "flagged" || view === "triage") filter.flagged = true;

    const limit = intParam(req.query.limit, 50, 200);
    const skip = intParam(req.query.skip, 0);
    const conversations = await VenueConversation.find(filter)
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "name phone")
      .populate("venueId", "name slug zone")
      .populate("enquiryId", "eventDate guestCount coupleName")
      .lean();
    const total = await VenueConversation.countDocuments(filter);

    const ids = conversations.map((c) => c._id);
    const lastMsgs = await VenueMessage.aggregate([
      { $match: { conversationId: { $in: ids } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$conversationId", m: { $first: "$$ROOT" } } },
    ]);
    const lastMap = Object.fromEntries(lastMsgs.map((e) => [String(e._id), e.m]));

    const cutoff = Date.now() - slaHours() * 3600 * 1000;
    let rows = conversations.map((c) => {
      const last = lastMap[String(c._id)] || null;
      const breach = slaBreach(c, last, cutoff);
      const coupleAt = c.lastCoupleMessageAt || null;
      return {
        _id: c._id,
        venue: c.venueId,
        couple: c.userId,
        coupleName: (c.enquiryId && c.enquiryId.coupleName) || (c.userId && c.userId.name) || "",
        eventDate: c.enquiryId && c.enquiryId.eventDate,
        status: c.status,
        flagged: !!c.flagged,
        flaggedTerms: c.flaggedTerms || [],
        unreadCountVenue: c.unreadCountVenue || 0,
        lastMessage: last
          ? { senderType: last.senderType, text: last.content && last.content.text, messageType: last.messageType, createdAt: last.createdAt }
          : null,
        lastMessageAt: c.lastMessageAt,
        slaBreached: breach,
        hoursSinceCouple: coupleAt ? Math.floor((Date.now() - new Date(coupleAt).getTime()) / 3600000) : null,
      };
    });
    // "triage" = the actionable subset: flagged OR SLA-breached, breaches first.
    if (view === "triage") {
      rows = rows
        .filter((r) => r.flagged || r.slaBreached)
        .sort((a, b) => Number(b.slaBreached) - Number(a.slaBreached));
    }
    return res.status(200).json({
      threads: rows,
      total: view === "triage" ? rows.length : total,
      slaHours: slaHours(),
      flagTerms: flagTerms(),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const getThread = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.conversationId)) {
      return res.status(400).json({ message: "Invalid conversation id" });
    }
    const conversation = await VenueConversation.findById(req.params.conversationId)
      .populate("userId", "name phone")
      .populate("venueId", "name slug zone")
      .populate("enquiryId", "eventDate guestCount coupleName couplePhone")
      .lean();
    if (!conversation) return res.status(404).json({ message: "Conversation not found" });
    // Admin sees EVERYTHING — both targeting halves included.
    const messages = await VenueMessage.find({ conversationId: conversation._id })
      .sort({ createdAt: 1 })
      .lean();
    return res.status(200).json({ conversation, messages, total: messages.length });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const VALID_TARGETS = ["both", "couple_only", "venue_only"];

const sendIntervention = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.conversationId)) {
      return res.status(400).json({ message: "Invalid conversation id" });
    }
    const conversation = await VenueConversation.findById(req.params.conversationId);
    if (!conversation) return res.status(404).json({ message: "Conversation not found" });

    const body = req.body || {};
    const target = body.target || "both";
    if (!VALID_TARGETS.includes(target)) {
      return res.status(400).json({ message: "target must be both, couple_only or venue_only" });
    }
    const kind = body.kind === "offer" ? "offer" : "text";

    let messageType = "text";
    let text = "";
    let offer;
    if (kind === "offer") {
      messageType = "offer";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const offerBody = typeof body.body === "string" ? body.body.trim() : "";
      if (!title) return res.status(400).json({ message: "offer title is required" });
      if (title.length > 200) return res.status(400).json({ message: "offer title too long" });
      if (offerBody.length > 2000) return res.status(400).json({ message: "offer body too long" });
      let validUntil;
      if (body.validUntil !== undefined && body.validUntil !== "") {
        validUntil = new Date(body.validUntil);
        if (Number.isNaN(validUntil.getTime())) return res.status(400).json({ message: "validUntil is not a valid date" });
      }
      offer = { title, body: offerBody, validUntil };
      text = title; // a text mirror so list previews and legacy renderers show something
    } else {
      if (typeof body.text !== "string" || !body.text.trim()) {
        return res.status(400).json({ message: "text is required" });
      }
      if (body.text.length > 4000) return res.status(400).json({ message: "text too long" });
      text = body.text.trim();
    }

    const message = await VenueMessage.create({
      conversationId: conversation._id,
      senderId: req.auth.user_id,
      senderType: "wedsy",
      messageType,
      content: { text },
      target,
      ...(offer ? { offer } : {}),
      isRead: false,
    });

    conversation.lastMessageAt = new Date();
    // Bump the unread count only for the side(s) the intervention is aimed at.
    if (target === "both" || target === "couple_only") {
      conversation.unreadCountCouple = (conversation.unreadCountCouple || 0) + 1;
    }
    if (target === "both" || target === "venue_only") {
      conversation.unreadCountVenue = (conversation.unreadCountVenue || 0) + 1;
    }
    await conversation.save();

    logActivity({
      venue: conversation.venueId,
      actorType: "wedsy_team",
      actorId: req.auth.user_id,
      actorName: (req.auth.user && req.auth.user.name) || "Wedsy admin",
      action: kind === "offer" ? "chat_offer_sent" : "chat_intervention_sent",
      entity: "conversation",
      field: "chat.intervention",
      new: JSON.stringify({ target, kind }),
      severity: "normal",
    });

    return res.status(201).json({ message: message.toObject() });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Log-only WhatsApp nudge (never sends unless explicitly wired). Mirrors the
// REMINDERS_LOG_ONLY convention: default is log-only; a future integration can
// gate real sends behind an env flag.
const nudgeVenue = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.conversationId)) {
      return res.status(400).json({ message: "Invalid conversation id" });
    }
    const conversation = await VenueConversation.findById(req.params.conversationId)
      .populate("venueId", "name slug contact")
      .lean();
    if (!conversation) return res.status(404).json({ message: "Conversation not found" });

    const logOnly = process.env.VENUE_CHAT_NUDGE_LOG_ONLY !== "false"; // default true
    const phone = conversation.venueId && conversation.venueId.contact && conversation.venueId.contact.primaryPhone;
    console.log(`[chatNudge]${logOnly ? " (log-only)" : ""} venue=${conversation.venueId && conversation.venueId.slug} phone=${phone || "n/a"} conversation=${conversation._id}`);

    logActivity({
      venue: conversation.venueId && conversation.venueId._id,
      actorType: "wedsy_team",
      actorId: req.auth.user_id,
      actorName: (req.auth.user && req.auth.user.name) || "Wedsy admin",
      action: "chat_venue_nudged",
      entity: "conversation",
      field: "chat.nudge",
      new: JSON.stringify({ logOnly }),
      severity: "normal",
    });
    return res.status(200).json({ success: true, logOnly });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { listThreads, getThread, sendIntervention, nudgeVenue };
