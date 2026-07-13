// Journey v2 (V2) — THE MEETINGS ENGINE. Create rides the EXISTING follow-up
// path (CallCockpitService.addFollowUp type "meet") so the deal-spine
// meeting_held station, the calendar mirror, the huddle auto-create and the
// intern→manager handoff all keep working untouched — then the mirrored
// CalendarEvent is stamped with the v2 fields (title, attendees, google
// linkage). Postpone/cancel/MOM act on the CalendarEvent directly.
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const CalendarEvent = require("../models/CalendarEvent");
const LeadInternalEventService = require("./LeadInternalEventService");
const GoogleWorkspaceService = require("./GoogleWorkspaceService");
const { findAssignable } = require("../utils/assignable");

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_MEET_MINUTES = 60;

const defaultTitle = (lead) => `${lead.name || "The couple"}'s wedding planning with Wedsy`;

// POST /enquiry/:_id/meetings
const createMeeting = async (leadId, { title, dateTime, clientEmails = [], teamAdminIds = [] } = {}, actorId) => {
  if (!isId(leadId)) throw httpError(400, "Invalid enquiry id");
  const start = new Date(dateTime);
  if (Number.isNaN(start.getTime())) throw httpError(400, "A valid dateTime is required");
  const end = new Date(start.getTime() + DEFAULT_MEET_MINUTES * 60 * 1000);

  const lead = await Enquiry.findById(leadId).lean();
  if (!lead) throw httpError(404, "Enquiry not found");

  // Client emails: default from the qualification data; the route accepts
  // additions and PERSISTS any new address back to additionalEmails.
  const knownEmails = [
    (lead.qualificationData && lead.qualificationData.email) || lead.email || "",
    ...((lead.qualificationData && lead.qualificationData.additionalEmails) || []),
  ].filter(Boolean).map((e) => e.trim().toLowerCase());
  const givenEmails = (clientEmails || []).map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);
  for (const e of givenEmails) {
    if (!EMAILISH.test(e)) throw httpError(400, `Invalid client email: ${e}`);
  }
  const allClientEmails = [...new Set([...knownEmails, ...givenEmails])];
  const newEmails = givenEmails.filter((e) => !knownEmails.includes(e));
  if (newEmails.length) {
    // Whitelisted persist — the meeting form is a legitimate email capture point.
    await Enquiry.updateOne(
      { _id: leadId },
      { $addToSet: { "qualificationData.additionalEmails": { $each: newEmails } } }
    );
  }

  // Team: every selected admin must pass the assignable predicate.
  const teamIds = (teamAdminIds || []).filter(isId);
  const team = teamIds.length
    ? await findAssignable({ _id: { $in: teamIds } }, { name: 1, email: 1 }).lean()
    : [];
  if (team.length !== [...new Set(teamIds.map(String))].length) {
    throw httpError(422, "One or more team members cannot attend (inactive or disabled)");
  }

  const meetingTitle = String(title || "").trim() || defaultTitle(lead);
  const attendees = [
    ...allClientEmails.map((email) => ({ email, name: "", adminId: null })),
    ...team.filter((a) => a.email).map((a) => ({ email: a.email, name: a.name, adminId: a._id })),
  ];

  // Google leg — arbitrary attendee list + title (fire-safe: OS-only fallback).
  let google = null;
  try {
    google = await GoogleWorkspaceService.createMeetEvent(lead, start, end, {
      title: meetingTitle,
      attendees,
    });
  } catch (e) {
    console.error("[Meetings] Google create failed — OS-only fallback:", e.message);
  }

  // The EXISTING booking path: journey event, calendar mirror, huddle, handoff.
  const CallCockpitService = require("./CallCockpitService");
  await CallCockpitService.addFollowUp(
    leadId,
    {
      type: "meet",
      scheduledAt: start.toISOString(),
      promiseNote: google && google.meetLink ? `G-Meet: ${google.meetLink}` : "",
    },
    actorId
  );

  // Stamp the mirrored event with the v2 fields (whitelisted).
  const mirrored = await CalendarEvent.findOne({ leadId, type: "gmeet", start })
    .sort({ createdAt: -1 })
    .lean();
  if (mirrored) {
    await CalendarEvent.updateOne(
      { _id: mirrored._id },
      {
        $set: {
          title: meetingTitle,
          end,
          attendees,
          ...(google
            ? {
                googleEventId: google.googleEventId,
                organizerAdminId: google.organizerAdminId,
                meetLink: google.meetLink || "",
              }
            : {}),
        },
      }
    );
  }

  return {
    eventId: mirrored ? mirrored._id : null,
    meetLink: google ? google.meetLink : null,
    title: meetingTitle,
    invited: attendees.map((a) => a.email),
    google: !!google,
  };
};

// PATCH /enquiry/:_id/meetings/:eventId { action, reason?, newDateTime? }
const updateMeeting = async (leadId, eventId, { action, reason, newDateTime } = {}, actorId) => {
  if (!isId(leadId) || !isId(eventId)) throw httpError(400, "Invalid id");
  if (!["postpone", "cancel"].includes(action)) throw httpError(400, 'action must be "postpone" or "cancel"');
  const event = await CalendarEvent.findOne({ _id: eventId, leadId }).lean();
  if (!event) throw httpError(404, "Meeting not found");
  if (event.status === "closed") throw httpError(409, "This meeting is already held/closed");

  const cleanReason = String(reason || "").trim().slice(0, 500);
  const set = { statusReason: cleanReason };
  let newStart = null;

  if (action === "cancel") {
    set.status = "cancelled";
  } else if (newDateTime) {
    // Postpone WITH a new date = the meeting moves and stays live (Upcoming).
    newStart = new Date(newDateTime);
    if (Number.isNaN(newStart.getTime())) throw httpError(400, "Invalid newDateTime");
    set.status = "scheduled";
    set.start = newStart;
    set.end = new Date(newStart.getTime() + DEFAULT_MEET_MINUTES * 60 * 1000);
  } else {
    // Postpone with no date yet = parked; leaves the unclosed-meeting gate.
    set.status = "postponed";
  }

  await CalendarEvent.updateOne({ _id: event._id }, { $set: set });

  await LeadInternalEventService.record({
    leadId,
    type: action === "cancel" ? "meeting_cancelled" : "meeting_postponed",
    actorId: actorId || null,
    payload: {
      eventId: String(event._id),
      title: event.title,
      reason: cleanReason,
      ...(newStart ? { newDateTime: newStart } : {}),
    },
  });
  // Lane echo (fire-safe no-op without the lane engine).
  await require("./LeadLaneService").autoEntry(
    leadId,
    "lead_comms",
    "meeting_updated",
    action === "cancel"
      ? `Meeting cancelled${cleanReason ? ` — ${cleanReason}` : ""}`
      : `Meeting postponed${newStart ? ` to ${newStart.toLocaleString()}` : ""}${cleanReason ? ` — ${cleanReason}` : ""}`
  );

  // Google side — fire-safe.
  try {
    if (event.googleEventId && event.organizerAdminId) {
      if (action === "cancel") {
        await GoogleWorkspaceService.cancelGoogleEvent(event.organizerAdminId, event.googleEventId);
      } else if (newStart) {
        await GoogleWorkspaceService.patchGoogleEvent(event.organizerAdminId, event.googleEventId, {
          start: newStart,
          end: set.end,
        });
      } else {
        await GoogleWorkspaceService.cancelGoogleEvent(event.organizerAdminId, event.googleEventId);
      }
    }
  } catch (e) {
    console.error("[Meetings] Google update failed (OS state already saved):", e.message);
  }

  return { eventId: String(event._id), status: set.status, statusReason: cleanReason };
};

// PUT .../mom { text } — any roster member (gated at the controller).
const saveMom = async (leadId, eventId, text, actorId) => {
  if (!isId(leadId) || !isId(eventId)) throw httpError(400, "Invalid id");
  const clean = String(text || "").trim();
  if (!clean) throw httpError(400, "MOM needs text");
  if (clean.length > 8000) throw httpError(400, "MOM is capped at 8000 characters");
  const event = await CalendarEvent.findOne({ _id: eventId, leadId }).lean();
  if (!event) throw httpError(404, "Meeting not found");
  const mom = { text: clean, savedBy: actorId || null, savedAt: new Date() };
  await CalendarEvent.updateOne({ _id: event._id }, { $set: { mom } });
  await LeadInternalEventService.record({
    leadId,
    type: "mom_saved",
    actorId: actorId || null,
    payload: { eventId: String(event._id), length: clean.length },
  });
  return { mom };
};

// PUT .../mom/sent — the manual "sent to client" checkbox. Idempotent: the
// FIRST stamp wins (a deliberate act is recorded once).
const markMomSent = async (leadId, eventId, actorId) => {
  if (!isId(leadId) || !isId(eventId)) throw httpError(400, "Invalid id");
  const event = await CalendarEvent.findOne({ _id: eventId, leadId }).lean();
  if (!event) throw httpError(404, "Meeting not found");
  if (!event.mom || !event.mom.text) throw httpError(409, "Save the MOM before marking it sent");
  if (event.momSentToClient && event.momSentToClient.at) {
    return { momSentToClient: event.momSentToClient, alreadyStamped: true };
  }
  const momSentToClient = { at: new Date(), by: actorId || null };
  await CalendarEvent.updateOne(
    { _id: event._id, "momSentToClient.at": { $exists: false } },
    { $set: { momSentToClient } }
  );
  // A concurrent stamp may have won — read back the truth.
  const fresh = await CalendarEvent.findById(event._id, { momSentToClient: 1 }).lean();
  await LeadInternalEventService.record({
    leadId,
    type: "mom_sent_to_client",
    actorId: actorId || null,
    payload: { eventId: String(event._id) },
  });
  return { momSentToClient: fresh.momSentToClient || momSentToClient };
};

// GET /enquiry/:_id/meetings — the history list (mock rows). The route's
// roster gate covers the whole payload, so the saved MOM rides each row
// (roster callers only, by construction).
const STATUS_LABEL = { closed: "Held", scheduled: "Upcoming", postponed: "Postponed", cancelled: "Cancelled" };
const MEET_LINK_RE = /G-Meet:\s*(\S+)/;
const listMeetings = async (leadId) => {
  if (!isId(leadId)) throw httpError(400, "Invalid enquiry id");
  const [events, lead] = await Promise.all([
    CalendarEvent.find(
      { leadId, type: { $in: ["gmeet", "meeting"] } },
      { title: 1, start: 1, end: 1, status: 1, statusReason: 1, attendees: 1, mom: 1, momSentToClient: 1, googleEventId: 1, meetLink: 1, followUpId: 1 }
    )
      .sort({ start: -1 })
      .lean(),
    // Best-effort meetLink recovery for PRE-addendum events: the booking flow
    // stored "G-Meet: <link>" on the mirrored follow-up's promiseNote.
    Enquiry.findById(leadId, { followUps: 1 }).lean(),
  ]);
  const linkByFollowUp = new Map();
  for (const f of (lead && lead.followUps) || []) {
    const m = f && f.promiseNote ? String(f.promiseNote).match(MEET_LINK_RE) : null;
    if (m && f._id) linkByFollowUp.set(String(f._id), m[1]);
  }
  return events.map((e) => ({
    eventId: String(e._id),
    title: e.title,
    when: e.start,
    status: STATUS_LABEL[e.status] || "Upcoming",
    statusReason: e.statusReason || "",
    attendees: (e.attendees || []).map((a) => ({
      email: a.email,
      name: a.name || "",
      adminId: a.adminId ? String(a.adminId) : null,
    })),
    hasMom: !!(e.mom && e.mom.text),
    mom: e.mom && e.mom.text ? e.mom : null,
    momSentToClient: e.momSentToClient && e.momSentToClient.at ? e.momSentToClient : null,
    hasGoogle: !!e.googleEventId,
    meetLink:
      e.meetLink ||
      (e.followUpId ? linkByFollowUp.get(String(e.followUpId)) : null) ||
      null,
  }));
};

module.exports = { createMeeting, updateMeeting, saveMom, markMomSent, listMeetings, defaultTitle };
