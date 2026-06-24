const mongoose = require("mongoose");
const CalendarEvent = require("../models/CalendarEvent");
const Enquiry = require("../models/Enquiry");
const Admin = require("../models/Admin");
const SettingsService = require("./SettingsService");
const LeadInternalEventService = require("./LeadInternalEventService");
const AdminNotificationService = require("./AdminNotificationService");

const httpError = (status, message) => Object.assign(new Error(message), { status });
const assertValidId = (id, label = "id") => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw httpError(400, `Invalid ${label}`);
};

const MEETING_TYPES = ["meeting", "gmeet", "visit"]; // types the meeting-notes gate applies to
const DEFAULT_MEET_MINUTES = 60;

// ── Live / unclosed meeting derivation ────────────────────────────────────────

// A meeting is LIVE while now ∈ [start, end] and it hasn't been closed.
const liveMeetingFilter = (now = new Date()) => ({
  type: { $in: MEETING_TYPES },
  status: "scheduled",
  start: { $lte: now },
  end: { $gte: now },
});

// Over but never closed with notes — pinned, and blocks the next meeting.
const unclosedMeetingFilter = (now = new Date()) => ({
  type: { $in: MEETING_TYPES },
  status: "scheduled",
  end: { $lt: now },
});

// Admin ids currently in a live meeting — feeds the in_meeting status (Slice 2 seam).
const liveMeetingAdminIds = async (now = new Date()) => {
  const rows = await CalendarEvent.find(liveMeetingFilter(now), { ownerId: 1 }).lean();
  return new Set(rows.map((r) => String(r.ownerId)));
};

// ── Follow-up mirror + huddle + handoff (hooked from addFollowUp) ─────────────

// Detect the intern class: ANY of the admin's roles (RBAC v2) is in the pool.
const isInternOwner = async (admin) => {
  const { roleIdsOf } = require("../middlewares/requirePermission");
  const ids = roleIdsOf(admin);
  if (!ids.length) return false;
  const Role = require("../models/Role");
  const roles = await Role.find({ _id: { $in: ids } }, { name: 1 }).lean();
  const poolRoles = (await SettingsService.get("assignment.poolRoles")) || [];
  return roles.some((r) => poolRoles.includes(r.name));
};

// HANDOFF RULE: a meet follow-up booked on an intern-owned lead auto-transfers
// the lead to the intern's reportingManager; the intern keeps permanent credit
// via the set-once qualifiedBy field. Both sides get notified.
const handoffIfInternOwned = async (lead, actorId) => {
  const owner = lead.assignedTo
    ? await Admin.findById(lead.assignedTo, { name: 1, roleId: 1, roleIds: 1, reportingManagerId: 1, status: 1 }).lean()
    : null;
  if (!owner || !owner.reportingManagerId) return { transferred: false, owner };
  if (!(await isInternOwner(owner))) return { transferred: false, owner };
  const manager = await Admin.findById(owner.reportingManagerId, { name: 1, status: 1 }).lean();
  if (!manager || manager.status !== "active") return { transferred: false, owner };

  await Enquiry.findByIdAndUpdate(lead._id, {
    $set: {
      assignedTo: manager._id,
      // Set-once credit: the intern who qualified the lead keeps it in their stats.
      ...(lead.qualifiedBy ? {} : { qualifiedBy: owner._id }),
    },
  });
  await LeadInternalEventService.record({
    leadId: lead._id,
    type: "transferred",
    actorId,
    payload: { from: String(owner._id), to: String(manager._id), toName: manager.name, reason: "meet_handoff" },
  });
  await LeadInternalEventService.record({
    leadId: lead._id,
    type: "meet_handoff",
    actorId,
    payload: {
      internId: String(owner._id),
      internName: owner.name,
      managerId: String(manager._id),
      managerName: manager.name,
    },
  });
  await AdminNotificationService.notify(owner._id, {
    type: "meet_handoff",
    title: `${lead.name} moved to ${manager.name} for the meet`,
    message: "You keep the qualification credit — great work getting them to a meeting.",
    leadId: lead._id,
  });
  await AdminNotificationService.notify(manager._id, {
    type: "meet_handoff",
    title: `${lead.name} handed to you — meet booked by ${owner.name}`,
    message: "Huddle pending: align the team before the meeting.",
    leadId: lead._id,
  });
  // MB7b Slice 3: the intern→sales-lead handoff is a qualification moment too —
  // ensure the (Haiku) Kiara summary exists for the manager picking it up. The
  // generator is fire-safe and a no-op if a summary already exists.
  await require("./KiaraSummaryService").generateForQualified(lead._id);
  return { transferred: true, owner, manager };
};

// Called by CallCockpitService.addFollowUp AFTER the follow-up is appended.
// Fire-safe: a calendar/huddle/handoff failure must never break the booking.
const onFollowUpBooked = async (enquiryId, followUp, actorId) => {
  try {
    if (!["meet", "visit"].includes(followUp.type)) return null;
    const lead = await Enquiry.findById(enquiryId).lean();
    if (!lead) return null;

    // 1. Handoff first (meet only) so the mirror lands on the final owner.
    let ownerId = lead.assignedTo || actorId;
    let internId = null;
    if (followUp.type === "meet") {
      const result = await handoffIfInternOwned(lead, actorId);
      if (result.transferred) {
        ownerId = result.manager._id;
        internId = result.owner._id;
      }
    }

    // 2. Mirror the follow-up into the calendar.
    const start = new Date(followUp.scheduledAt);
    const end = new Date(start.getTime() + DEFAULT_MEET_MINUTES * 60 * 1000);
    const mirrored = await CalendarEvent.create({
      ownerId,
      type: followUp.type === "meet" ? "gmeet" : "visit",
      leadId: lead._id,
      title: `${followUp.type === "meet" ? "G-Meet" : "Visit"} — ${lead.name}`,
      start,
      end,
      participantIds: [ownerId, ...(internId ? [internId] : [])],
      followUpId: followUp._id || null,
    });

    // 3. Huddle (gmeet only): assigned to the lead's sales lead, due AT the meet.
    if (followUp.type === "meet") {
      await CalendarEvent.create({
        ownerId,
        type: "huddle",
        leadId: lead._id,
        title: `Huddle — ${lead.name}`,
        start,
        end: start,
        participantIds: [ownerId, ...(internId ? [internId] : [])],
      });
      await AdminNotificationService.notify(ownerId, {
        type: "huddle_due",
        title: `Team huddle needed before ${lead.name}'s meeting`,
        message: "Run the huddle: attendees, event-team assignments, notes.",
        leadId: lead._id,
      });
    }
    return mirrored;
  } catch (e) {
    console.error("CalendarEventService.onFollowUpBooked failed:", e.message);
    return null;
  }
};

// ── Manual events + the meeting-notes gate ────────────────────────────────────

const assertNoUnclosed = async (ownerId, now = new Date()) => {
  const unclosed = await CalendarEvent.findOne({ ownerId, ...unclosedMeetingFilter(now) }).lean();
  if (unclosed) {
    throw httpError(
      422,
      `You have an unclosed meeting ("${unclosed.title}") — close it with notes before starting the next one`
    );
  }
};

const createEvent = async (ownerId, { type, title, start, end, leadId, participantIds } = {}) => {
  if (!["meeting", "gmeet", "huddle", "visit", "block"].includes(type)) {
    throw httpError(400, "Invalid type");
  }
  if (!title || typeof title !== "string") throw httpError(400, "title is required");
  const s = new Date(start);
  const e = new Date(end || new Date(s.getTime() + DEFAULT_MEET_MINUTES * 60 * 1000));
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) {
    throw httpError(400, "Invalid start/end");
  }
  if (leadId) assertValidId(leadId, "leadId");
  // The gate: an unclosed past meeting blocks scheduling the next meeting.
  if (MEETING_TYPES.includes(type)) await assertNoUnclosed(ownerId);
  return await CalendarEvent.create({
    ownerId,
    type,
    title: title.trim(),
    start: s,
    end: e,
    leadId: leadId || null,
    participantIds: (participantIds || []).filter((p) => mongoose.Types.ObjectId.isValid(p)),
  });
};

// Save draft notes while the meeting is live (the dashboard capture pane).
const saveNotes = async (eventId, actorId, notes) => {
  assertValidId(eventId, "eventId");
  if (typeof notes !== "string") throw httpError(400, "notes must be a string");
  const event = await CalendarEvent.findOneAndUpdate(
    { _id: eventId, ownerId: actorId, status: "scheduled" },
    { $set: { notes } },
    { new: true }
  );
  if (!event) throw httpError(404, "Open meeting not found on your calendar");
  return event;
};

// Close a meeting — NOTES ARE MANDATORY (founder rule: no meeting closes silent).
//
// MB7b Slice 4 extends the gate: for a lead-linked gmeet/meeting, the close
// carries the "WhatsApp group created with the couple?" answer. true → nurture
// switches on (clock + first task); false → a red flag is raised on the file +
// dashboard. The answer is tolerated as optional here (a missing answer is a
// no-op) so the MB5+6 close path stays backward-compatible — the mandatory
// Yes/No lives in the close UI; an unanswered lead simply has no group on file.
const closeMeeting = async (eventId, actorId, { notes, whatsappGroupCreated } = {}) => {
  assertValidId(eventId, "eventId");
  const event = await CalendarEvent.findOne({ _id: eventId, status: "scheduled" });
  if (!event) throw httpError(404, "Open meeting not found");
  if (String(event.ownerId) !== String(actorId)) {
    throw httpError(403, "Only the meeting owner can close it");
  }
  const finalNotes = (typeof notes === "string" && notes.trim()) || (event.notes || "").trim();
  if (!finalNotes) {
    throw httpError(422, "A meeting cannot be closed without notes");
  }
  event.notes = finalNotes;
  event.status = "closed";
  event.closedAt = new Date();
  event.closedBy = actorId;
  await event.save();
  if (event.leadId) {
    await LeadInternalEventService.record({
      leadId: event.leadId,
      type: "meeting_closed",
      actorId,
      payload: { eventId: String(event._id), title: event.title, notes: finalNotes.slice(0, 500) },
    });
    // WhatsApp-group gate (gmeet/meeting only). Fire-safe: a nurture hiccup must
    // never block closing the meeting.
    if (["gmeet", "meeting"].includes(event.type) && typeof whatsappGroupCreated === "boolean") {
      try {
        await require("./NurtureService").applyGroupAnswer(event.leadId, whatsappGroupCreated, actorId);
      } catch (e) {
        console.error("[CalendarEvent] WhatsApp-group gate failed:", e.message);
      }
    }
  }
  return event;
};

// ── Huddles ───────────────────────────────────────────────────────────────────

// Huddle state for a lead's upcoming gmeet — drives the countdown chip.
const huddleForLead = async (leadId, now = new Date()) => {
  assertValidId(leadId, "leadId");
  const huddle = await CalendarEvent.findOne({
    leadId,
    type: "huddle",
    status: { $in: ["scheduled", "closed"] },
  })
    .sort({ start: -1 })
    .lean();
  if (!huddle) return null;
  const msToMeet = new Date(huddle.start).getTime() - now.getTime();
  return {
    ...huddle,
    pending: huddle.status === "scheduled",
    msToMeet,
    overdue: huddle.status === "scheduled" && msToMeet <= 0,
  };
};

// Huddle completion: attendees + event-team assignments + notes. Writes the
// lightweight eventTeam[] onto the Enquiry and flips the chip.
const completeHuddle = async (huddleId, actorId, { attendeeIds = [], eventTeam = [], notes } = {}) => {
  assertValidId(huddleId, "huddleId");
  if (!notes || !String(notes).trim()) throw httpError(422, "Huddle notes are required");
  const huddle = await CalendarEvent.findOne({ _id: huddleId, type: "huddle", status: "scheduled" });
  if (!huddle) throw httpError(404, "Pending huddle not found");

  const cleanAttendees = (attendeeIds || []).filter((a) => mongoose.Types.ObjectId.isValid(a));
  const cleanTeam = (eventTeam || [])
    .filter((t) => t && mongoose.Types.ObjectId.isValid(t.adminId))
    .map((t) => ({ adminId: t.adminId, label: String(t.label || "").slice(0, 60) }));

  huddle.status = "closed";
  huddle.closedAt = new Date();
  huddle.closedBy = actorId;
  huddle.notes = String(notes).trim();
  huddle.huddleOutcome = { attendeeIds: cleanAttendees, eventTeam: cleanTeam };
  await huddle.save();

  if (huddle.leadId) {
    if (cleanTeam.length) {
      await Enquiry.findByIdAndUpdate(huddle.leadId, { $set: { eventTeam: cleanTeam } });
    }
    await LeadInternalEventService.record({
      leadId: huddle.leadId,
      type: "huddle_completed",
      actorId,
      payload: {
        attendeeIds: cleanAttendees.map(String),
        eventTeam: cleanTeam.map((t) => ({ adminId: String(t.adminId), label: t.label })),
        notes: huddle.notes.slice(0, 500),
      },
    });
  }
  return huddle;
};

// ── Views ─────────────────────────────────────────────────────────────────────

// Visible admin ids under a lead-scope filter keyed on ownerId (same trick as attendance).
const visibleAdminIds = async (scopeFilter = {}) => {
  if (!scopeFilter || Object.keys(scopeFilter).length === 0) {
    const all = await Admin.find({ status: "active" }, { _id: 1 }).lean();
    return all.map((a) => a._id);
  }
  const v = scopeFilter.ownerId;
  if (v && v.$in) return v.$in;
  return v ? [v] : [];
};

// Team calendar grid: events in [from,to] for visible admins + live status dots.
const teamCalendar = async ({ from, to } = {}, scopeFilter = {}) => {
  const f = from ? new Date(from) : new Date();
  const t = to ? new Date(to) : new Date(f.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw httpError(400, "Invalid from/to");
  const ids = await visibleAdminIds(scopeFilter);
  const AttendanceService = require("./AttendanceService");
  const [admins, events, liveIds] = await Promise.all([
    Admin.find({ _id: { $in: ids }, status: "active" }, { name: 1 }).lean(),
    CalendarEvent.find({
      ownerId: { $in: ids },
      status: { $ne: "cancelled" },
      start: { $lt: t },
      end: { $gte: f },
    })
      .sort({ start: 1 })
      .lean(),
    liveMeetingAdminIds(),
  ]);
  const Attendance = require("../models/Attendance");
  const day = AttendanceService.dayKey();
  const attRows = await Attendance.find({ adminId: { $in: ids }, date: day }).lean();
  const attByAdmin = new Map(attRows.map((r) => [String(r.adminId), r]));
  const now = new Date();

  // Lead names for event chips (one query).
  const leadIds = [...new Set(events.map((e) => e.leadId).filter(Boolean).map(String))];
  const leads = leadIds.length
    ? await Enquiry.find({ _id: { $in: leadIds } }, { name: 1, stage: 1 }).lean()
    : [];
  const leadById = new Map(leads.map((l) => [String(l._id), l]));

  return {
    from: f,
    to: t,
    rows: admins
      .map((a) => ({
        adminId: a._id,
        name: a.name,
        status: AttendanceService.statusOf(attByAdmin.get(String(a._id)) || null, now, liveIds),
        events: events
          .filter((e) => String(e.ownerId) === String(a._id))
          .map((e) => ({
            ...e,
            lead: e.leadId ? leadById.get(String(e.leadId)) || null : null,
            live: e.status === "scheduled" && e.start <= now && e.end >= now && MEETING_TYPES.includes(e.type),
            unclosed: e.status === "scheduled" && e.end < now && MEETING_TYPES.includes(e.type),
            huddlePending:
              e.type === "gmeet" &&
              e.status === "scheduled" &&
              events.some(
                (h) =>
                  h.type === "huddle" &&
                  h.status === "scheduled" &&
                  String(h.leadId || "") === String(e.leadId || "x")
              ),
          })),
      }))
      .sort((x, y) => x.name.localeCompare(y.name)),
  };
};

// Meeting-mode state for ONE admin: the live meeting (banner), unclosed pile
// (pinned + blocking), pending huddles with countdowns.
const meetingMode = async (adminId, now = new Date()) => {
  const [live, unclosed, huddles] = await Promise.all([
    CalendarEvent.findOne({ ownerId: adminId, ...liveMeetingFilter(now) }).sort({ start: 1 }).lean(),
    CalendarEvent.find({ ownerId: adminId, ...unclosedMeetingFilter(now) }).sort({ end: 1 }).lean(),
    CalendarEvent.find({ ownerId: adminId, type: "huddle", status: "scheduled" }).sort({ start: 1 }).lean(),
  ]);
  const leadIds = [
    ...new Set(
      [live, ...unclosed, ...huddles].filter(Boolean).map((e) => e.leadId).filter(Boolean).map(String)
    ),
  ];
  const leads = leadIds.length
    ? await Enquiry.find({ _id: { $in: leadIds } }, { name: 1, stage: 1, phone: 1 }).lean()
    : [];
  const leadById = new Map(leads.map((l) => [String(l._id), l]));
  const withLead = (e) => (e ? { ...e, lead: e.leadId ? leadById.get(String(e.leadId)) || null : null } : null);
  return {
    live: withLead(live),
    unclosed: unclosed.map(withLead),
    blocked: unclosed.length > 0,
    pendingHuddles: huddles.map((h) => ({
      ...withLead(h),
      msToMeet: new Date(h.start).getTime() - now.getTime(),
      overdue: new Date(h.start).getTime() <= now.getTime(),
    })),
  };
};

// Unclosed meetings across the caller's scope — the Revenue Head list.
const unclosedList = async (scopeFilter = {}, now = new Date()) => {
  const ids = await visibleAdminIds(scopeFilter);
  const rows = await CalendarEvent.find({ ownerId: { $in: ids }, ...unclosedMeetingFilter(now) })
    .sort({ end: 1 })
    .lean();
  const adminIds = [...new Set(rows.map((r) => String(r.ownerId)))];
  const admins = adminIds.length ? await Admin.find({ _id: { $in: adminIds } }, { name: 1 }).lean() : [];
  const byId = new Map(admins.map((a) => [String(a._id), a.name]));
  const leadIds = [...new Set(rows.map((r) => r.leadId).filter(Boolean).map(String))];
  const leads = leadIds.length ? await Enquiry.find({ _id: { $in: leadIds } }, { name: 1 }).lean() : [];
  const leadById = new Map(leads.map((l) => [String(l._id), l]));
  return rows.map((r) => ({
    ...r,
    ownerName: byId.get(String(r.ownerId)) || null,
    lead: r.leadId ? leadById.get(String(r.leadId)) || null : null,
  }));
};

// Calendar items for one lead (Client File: huddle chip + meet state).
const leadEvents = async (leadId) => {
  assertValidId(leadId, "leadId");
  const events = await CalendarEvent.find({ leadId, status: { $ne: "cancelled" } })
    .sort({ start: 1 })
    .lean();
  const huddle = await huddleForLead(leadId);
  return { events, huddle };
};

module.exports = {
  MEETING_TYPES,
  liveMeetingAdminIds,
  onFollowUpBooked,
  createEvent,
  saveNotes,
  closeMeeting,
  completeHuddle,
  huddleForLead,
  teamCalendar,
  meetingMode,
  unclosedList,
  leadEvents,
};
