// Journey v2 (V2) — meetings engine endpoints.
// Reads + MOM writes are ROSTER-AWARE (any current team member serves the
// meeting); create/postpone/cancel keep the owner/manager write gate at the
// route (LEADS_EDIT_SCOPED).
const MeetingService = require("../services/MeetingService");
const AIBriefService = require("../services/AIBriefService");
const CalendarEvent = require("../models/CalendarEvent");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const { assertInScopeOrRoster } = require("../utils/leadScope");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[meetings]", error);
  res.status(status).json({
    message: status === 500 ? "Something went wrong with this meeting — please retry." : error.message,
  });
};

// POST /enquiry/:_id/meetings
const Create = async (req, res) => {
  try {
    const result = await MeetingService.createMeeting(
      req.params._id,
      {
        title: req.body?.title,
        dateTime: req.body?.dateTime,
        clientEmails: req.body?.clientEmails || [],
        teamAdminIds: req.body?.teamAdminIds || [],
      },
      req.auth.user_id
    );
    res.status(201).json(result);
  } catch (error) {
    respond(res, error);
  }
};

// PATCH /enquiry/:_id/meetings/:eventId
const Update = async (req, res) => {
  try {
    const result = await MeetingService.updateMeeting(
      req.params._id,
      req.params.eventId,
      { action: req.body?.action, reason: req.body?.reason, newDateTime: req.body?.newDateTime },
      req.auth.user_id
    );
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

// GET /enquiry/:_id/meetings — roster-aware read.
const List = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id);
    res.status(200).json({ meetings: await MeetingService.listMeetings(req.params._id) });
  } catch (error) {
    respond(res, error);
  }
};

// PUT /enquiry/:_id/meetings/:eventId/mom — any roster member.
const SaveMom = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id);
    const result = await MeetingService.saveMom(
      req.params._id,
      req.params.eventId,
      req.body?.text,
      req.auth.user_id
    );
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

// POST /enquiry/:_id/meetings/:eventId/mom/ai — returns { text } for review;
// NEVER sends anything. Accepts a live draft (body.text) so meeting mode can
// draft before the MOM is saved; falls back to the stored MOM.
const AiClientBrief = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id);
    const lead = await EnquiryRepository.findById(req.params._id);
    if (!lead) return res.status(404).json({ message: "Enquiry not found" });
    let momText = String(req.body?.text || "").trim();
    if (!momText) {
      const event = await CalendarEvent.findOne(
        { _id: req.params.eventId, leadId: req.params._id },
        { mom: 1 }
      ).lean();
      momText = event && event.mom ? String(event.mom.text || "").trim() : "";
    }
    if (!momText) return res.status(400).json({ message: "No MOM text to draft from" });
    const result = await AIBriefService.clientBriefFromMOM(momText, lead);
    res.status(200).json(result); // { text } — review-then-send
  } catch (error) {
    respond(res, error);
  }
};

// PUT /enquiry/:_id/meetings/:eventId/mom/sent — the manual checkbox.
const MarkMomSent = async (req, res) => {
  try {
    await assertInScopeOrRoster(req.params._id, req.scopeFilter, req.auth.user_id);
    const result = await MeetingService.markMomSent(req.params._id, req.params.eventId, req.auth.user_id);
    res.status(200).json(result);
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { Create, Update, List, SaveMom, AiClientBrief, MarkMomSent };
