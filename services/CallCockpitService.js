const mongoose = require("mongoose");
const EnquiryRepository = require("../repositories/EnquiryRepository");
const LeadInternalEventService = require("./LeadInternalEventService");
const { computeDiscovery } = require("./DiscoveryService");

const CALL_OUTCOMES = ["", "qualified", "busy", "unknown", "disqualified"];
const CALL_PURPOSES = ["", "discovery", "follow_up"];
const FOLLOW_UP_TYPES = ["meet", "call", "visit"];
// Attempt cadence (Lifecycle Slice C): day offsets from the FIRST unanswered
// attempt. Runtime values come from SettingsService (cadence.*) which defaults
// to exactly these constants.
const ATTEMPT_OFFSETS_DAYS = [0, 1, 3, 5];
const MAX_ATTEMPTS = 4;
const SettingsService = require("./SettingsService");

const cadenceConfig = async () => {
  const cfg = await SettingsService.getMany(["cadence.attemptOffsetsDays", "cadence.maxAttempts"]);
  return { offsets: cfg["cadence.attemptOffsetsDays"], maxAttempts: cfg["cadence.maxAttempts"] };
};
const UNANSWERED_OUTCOMES = ["busy", "unknown"];
// Whitelisted qualificationData fields a PUT may write (everything else is ignored).
const QUALIFICATION_STRING_FIELDS = [
  "groomName",
  "brideName",
  "weddingStyle",
  "venueStatus",
  "venueName",
  "venueTypeWanted",
  "venueArea",
  "venueBudget",
  "venueShortlistNote",
  "email",
  "whatsappNumber",
  // SEQ-3c — the intern-filled discovery exact date (free-form string).
  "eventDate",
  // Lead-schema foundation — free-form city set by the FE dropdown.
  "city",
  // Free-form qualifier notes captured during qualification (additive).
  "additionalNotes",
];
const QUALIFICATION_BOOLEAN_FIELDS = ["emailNotWilling", "whatsappSameNumber", "destinationWedding"];
// SEQ-3c — the discovery date's part-of-day companion (validated against the enum).
const EVENT_DATE_PARTS = ["", "morning", "afternoon", "evening"];
// Lead-schema foundation — coverage zones a lead spans.
const ZONES = ["north", "south", "east", "west", "central"];

// Earliest dated EventBuilder day → the canonical qualificationData.eventDate.
// Accepts an array of "YYYY-MM-DD" strings OR day objects with a `.date` string.
// Days flagged dateUnknown ("dates not finalised") are skipped; tentative
// (approximate) dates still count. Dateless days are ignored. Returns "" when no
// usable date exists. (ISO YYYY-MM-DD sorts chronologically as plain strings.)
const isIsoDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
const deriveCanonicalEventDate = (eventDays = []) => {
  if (!Array.isArray(eventDays)) {
    throw httpError(400, "Invalid eventDays (expected an array)");
  }
  const dates = eventDays
    .filter((d) => !(d && typeof d === "object" && d.dateUnknown === true))
    .map((d) => (typeof d === "string" ? d : d && typeof d === "object" ? d.date : null))
    .filter((s) => isIsoDate(s))
    .map((s) => s.trim());
  if (!dates.length) return "";
  return dates.reduce((earliest, d) => (d < earliest ? d : earliest));
};

// Lead-detail cockpit — coerce the cockpit's day/function draft to the schema
// shape so the stored doc stays clean, WITHOUT filtering: every day and every
// function is preserved (a function with a time but no venue MUST persist), so
// reopening the cockpit re-hydrates the draft exactly. Throws only if the
// top-level value is not an array.
const normalizeEventDays = (eventDays) => {
  if (!Array.isArray(eventDays)) {
    throw httpError(400, "Invalid eventDays (expected an array)");
  }
  const str = (v) => (typeof v === "string" ? v : "");
  return eventDays.map((day) => {
    const d = day && typeof day === "object" ? day : {};
    const functions = Array.isArray(d.functions) ? d.functions : [];
    return {
      date: str(d.date),
      tentative: d.tentative === true,
      dateUnknown: d.dateUnknown === true,
      functions: functions.map((fn) => {
        const f = fn && typeof fn === "object" ? fn : {};
        return {
          type: str(f.type),
          time: str(f.time),
          session: str(f.session),
          venue: str(f.venue),
          pax: str(f.pax),
          space: str(f.space),
        };
      }),
    };
  });
};

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const assertValidId = (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw httpError(400, "Invalid enquiry id");
  }
};

const parseDate = (value, fieldName) => {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) {
    throw httpError(400, `Invalid ${fieldName}`);
  }
  return d;
};

// Does the lead have at least one follow-up scheduled in the future?
const hasFutureFollowUp = (enquiry, now = new Date()) =>
  (enquiry.followUps || []).some(
    (f) => f.scheduledAt && new Date(f.scheduledAt) > now
  );

// SEQ-3b — the "no further action" marker (additive, fire-safe). Set when a call
// is SAVED with discovery still incomplete AND no scheduled next step, leaving
// the lead with nowhere to go; cleared the moment a next step is scheduled
// (addFollowUp, incl. the G-Meet path) or the lead is qualified (see
// LeadLifecycleService.qualifyLead). The save itself is NEVER blocked — this only
// sets/clears the flag, and a failure here must never break the save/schedule.
const setNoFurtherAction = async (enquiryId, flagged, actorId, reason) => {
  try {
    const fields = flagged
      ? {
          "noFurtherAction.flagged": true,
          "noFurtherAction.flaggedAt": new Date(),
          "noFurtherAction.flaggedReason":
            reason || "Saved without a next step (discovery incomplete)",
        }
      : {
          "noFurtherAction.flagged": false,
          "noFurtherAction.flaggedAt": null,
          "noFurtherAction.flaggedReason": "",
        };
    await EnquiryRepository.updateFieldsById(enquiryId, fields);
    if (flagged) {
      // TODO(escalation): notify sales lead + revenue head when their dashboards exist.
      await LeadInternalEventService.record({
        leadId: enquiryId,
        type: "no_further_action_flagged",
        actorId: actorId || null,
        payload: { reason: reason || "no_next_step" },
      });
    }
  } catch (e) {
    console.error("[setNoFurtherAction] failed:", e.message);
  }
};

// Attempt-cadence state for a lead's call log (Lifecycle Slice C). attempts =
// unanswered (busy/unknown) calls so far. Below MAX: suggest the next attempt per
// the 0/1/3/5-day rhythm anchored to the first unanswered attempt (clamped to
// tomorrow if the rhythm date already passed). At MAX: unresponsive — rep decides.
const cadenceFor = (callLog, now = new Date(), cfg = {}) => {
  const offsets = cfg.offsets || ATTEMPT_OFFSETS_DAYS;
  const maxAttempts = cfg.maxAttempts || MAX_ATTEMPTS;
  const unanswered = (callLog || []).filter((e) =>
    UNANSWERED_OUTCOMES.includes(e.outcome)
  );
  const attempts = unanswered.length;
  if (attempts === 0 || attempts >= maxAttempts) {
    return {
      attempts,
      maxAttempts,
      suggestedNextAttemptAt: null,
      unresponsive: attempts >= maxAttempts,
    };
  }
  const first = new Date(unanswered[0].startedAt);
  const offsetIdx = Math.min(attempts, offsets.length - 1);
  let suggested = new Date(
    first.getTime() + offsets[offsetIdx] * 24 * 60 * 60 * 1000
  );
  if (suggested <= now) {
    suggested = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }
  return {
    attempts,
    maxAttempts,
    suggestedNextAttemptAt: suggested,
    unresponsive: false,
  };
};

// Stamp unresponsiveFlaggedAt + event once attempts reach MAX (set-once on the flag).
const flagUnresponsiveIfNeeded = async (enquiryId, callLog, actorId, alreadyFlaggedAt) => {
  const cadence = cadenceFor(callLog, new Date(), await cadenceConfig());
  if (!cadence.unresponsive || alreadyFlaggedAt) return false;
  await EnquiryRepository.updateFieldsById(enquiryId, {
    unresponsiveFlaggedAt: new Date(),
  });
  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "unresponsive_flagged",
    actorId,
    payload: { attempts: cadence.attempts },
  });
  return true;
};

// POST /enquiry/:_id/call-log — append-only. Stamps firstCalledAt on the first
// call ever (set-once, via the SetFirstCall logic) and flips `qualified` when the
// outcome is "qualified".
const logCall = async (
  enquiryId,
  { startedAt, durationSeconds, connected, outcome, notes, purpose } = {},
  actorId
) => {
  assertValidId(enquiryId);
  const startedAtDate = parseDate(startedAt, "startedAt");
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration < 0) {
    throw httpError(400, "Invalid durationSeconds");
  }
  if (outcome !== undefined && !CALL_OUTCOMES.includes(outcome)) {
    throw httpError(400, `Invalid outcome (expected one of: ${CALL_OUTCOMES.filter(Boolean).join(", ")})`);
  }
  if (purpose !== undefined && !CALL_PURPOSES.includes(purpose)) {
    throw httpError(400, `Invalid purpose (expected one of: ${CALL_PURPOSES.filter(Boolean).join(", ")})`);
  }
  if (notes !== undefined && typeof notes !== "string") {
    throw httpError(400, "Invalid notes");
  }

  const enquiry = await EnquiryRepository.findById(enquiryId);
  if (!enquiry) {
    throw httpError(404, "Enquiry not found");
  }

  const entry = {
    startedAt: startedAtDate,
    durationSeconds: duration,
    connected: connected === true,
    outcome: outcome || "",
    purpose: purpose || "",
    notes: notes || "",
    loggedBy: actorId || null,
  };
  // MB9a: the qualified flip + journey + handoff + summary now all run through
  // LeadLifecycleService.qualifyLead (the single hinge) AFTER the call-log write
  // — so the cockpit and the Qualify button can never diverge. The call-log push
  // itself no longer sets `qualified`.
  const updated = await EnquiryRepository.pushCallLogById(enquiryId, entry, {});

  // First call on this lead → stamp the TAT anchor (no-op for later calls).
  const stamped = await EnquiryRepository.stampFirstCalledAt(enquiryId);
  // Signal spine: a call is a customer response AND employee activity.
  await EnquiryRepository.stampFirstRespondedAt(enquiryId, startedAtDate);
  await EnquiryRepository.touchLastActivity(enquiryId);
  // Signal Matrix Slice 7 — the logged call satisfies any DUE "call" next step,
  // so its mission row stops showing red. Fire-safe: never breaks the log.
  // (Inside completeFollowUp's call-shaped path the target row is already
  // completed before this runs, so only OTHER due call rows are swept.)
  try {
    await EnquiryRepository.completeDueCallFollowUps(
      enquiryId,
      actorId,
      entry.outcome || (entry.connected ? "connected" : "attempted")
    );
  } catch (e) {
    console.error("[logCall] due-call auto-complete failed:", e.message);
  }

  // Slice B3 — echo into the lead_comms lane when the lane engine is live on
  // this lead (fire-safe no-op otherwise).
  await require("./LeadLaneService").autoEntry(
    enquiryId,
    "lead_comms",
    "call_logged",
    `Call logged — ${entry.outcome || (entry.connected ? "connected" : "attempted")}`
  );

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "call_logged",
    actorId,
    payload: {
      outcome: entry.outcome,
      durationSeconds: entry.durationSeconds,
      connected: entry.connected,
    },
  });

  // A qualified call is the hinge: run the SINGLE qualify transition (marks
  // qualified, hands ownership to the sales lead, instantiates the journey ONCE,
  // triggers the Kiara summary). Idempotent + fire-safe — never breaks the log.
  let qualifyResult = null;
  if (outcome === "qualified") {
    try {
      qualifyResult = await require("./LeadLifecycleService").qualifyLead(enquiryId, actorId);
    } catch (e) {
      console.error("[logCall] qualifyLead failed:", e.message);
    }
  }

  // Cadence (Slice C): on an unanswered outcome, surface the suggested next attempt
  // (the scheduler pre-fills it) or flag the lead unresponsive at MAX attempts.
  const doc = stamped || updated;
  const leadObj = doc.toObject ? doc.toObject() : doc;
  // Reflect the qualify transition in the returned object (handoff may have moved
  // assignedTo) so the caller doesn't see a stale pre-qualify snapshot.
  if (qualifyResult && qualifyResult.lead) {
    leadObj.qualified = true;
    leadObj.assignedTo = qualifyResult.lead.assignedTo;
  }
  if (UNANSWERED_OUTCOMES.includes(entry.outcome)) {
    const cadCfg = await cadenceConfig();
    const flaggedNow = await flagUnresponsiveIfNeeded(
      enquiryId,
      leadObj.callLog,
      actorId,
      leadObj.unresponsiveFlaggedAt
    );
    leadObj.cadence = cadenceFor(leadObj.callLog, new Date(), cadCfg);
    if (flaggedNow) leadObj.unresponsiveFlaggedAt = new Date();
  }
  return leadObj;
};

// POST /enquiry/:_id/follow-up
const addFollowUp = async (
  enquiryId,
  { type, scheduledAt, promiseNote } = {},
  actorId
) => {
  assertValidId(enquiryId);
  if (!FOLLOW_UP_TYPES.includes(type)) {
    throw httpError(400, `Invalid type (expected one of: ${FOLLOW_UP_TYPES.join(", ")})`);
  }
  const scheduledAtDate = parseDate(scheduledAt, "scheduledAt");
  if (promiseNote !== undefined && typeof promiseNote !== "string") {
    throw httpError(400, "Invalid promiseNote");
  }

  const enquiry = await EnquiryRepository.findById(enquiryId);
  if (!enquiry) {
    throw httpError(404, "Enquiry not found");
  }

  const updated = await EnquiryRepository.pushFollowUpById(enquiryId, {
    type,
    scheduledAt: scheduledAtDate,
    promiseNote: promiseNote || "",
    createdBy: actorId || null,
  });

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "follow_up_scheduled",
    actorId,
    payload: { followUpType: type, scheduledAt: scheduledAtDate, promiseNote: promiseNote || "" },
  });

  // MB5 Slice 3 (fire-safe inside): meet/visit mirror into the team calendar,
  // gmeet huddle auto-create, intern→manager handoff with qualifiedBy credit.
  const justAdded = (updated.followUps || [])
    .filter((f) => f.type === type)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  const CalendarEventService = require("./CalendarEventService");
  await CalendarEventService.onFollowUpBooked(
    enquiryId,
    { _id: justAdded ? justAdded._id : null, type, scheduledAt: scheduledAtDate },
    actorId
  );

  // SEQ-3b — a scheduled next step (this covers busy/unknown, the locked next
  // step, AND the G-Meet finale, which books through this same path) clears any
  // "no further action" flag set by an earlier no-next-step save.
  await setNoFurtherAction(enquiryId, false, actorId);

  // Signal spine: booking a next step is employee activity (not a response).
  await EnquiryRepository.touchLastActivity(enquiryId);

  return updated;
};

// PUT /enquiry/:_id/qualification — partial update; only whitelisted fields are
// written (dot-path $set so omitted fields are never clobbered).
const updateQualification = async (enquiryId, body = {}, actorId) => {
  assertValidId(enquiryId);

  const set = {};
  for (const field of QUALIFICATION_STRING_FIELDS) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== "string") {
        throw httpError(400, `Invalid ${field}`);
      }
      set[`qualificationData.${field}`] = body[field];
    }
  }
  for (const field of QUALIFICATION_BOOLEAN_FIELDS) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== "boolean") {
        throw httpError(400, `Invalid ${field}`);
      }
      set[`qualificationData.${field}`] = body[field];
    }
  }
  // SEQ-3c — the discovery date's part-of-day (enum-validated). Independent of
  // the exact eventDate above: writing one never clobbers the other (each is a
  // separate $set key, and omitted fields are left untouched).
  if (body.eventDatePart !== undefined) {
    if (typeof body.eventDatePart !== "string" || !EVENT_DATE_PARTS.includes(body.eventDatePart)) {
      throw httpError(400, `Invalid eventDatePart (expected one of: ${EVENT_DATE_PARTS.filter(Boolean).join(", ")})`);
    }
    set["qualificationData.eventDatePart"] = body.eventDatePart;
  }
  // MB6 Slice 6 — Cockpit v2 fields.
  if (body.servicesRequired !== undefined) {
    if (!Array.isArray(body.servicesRequired) || body.servicesRequired.some((s) => typeof s !== "string")) {
      throw httpError(400, "Invalid servicesRequired (expected an array of strings)");
    }
    set["qualificationData.servicesRequired"] = [...new Set(body.servicesRequired.map((s) => s.trim()).filter(Boolean))];
  }
  if (body.budgetAmount !== undefined) {
    if (body.budgetAmount !== null && (typeof body.budgetAmount !== "number" || !Number.isFinite(body.budgetAmount) || body.budgetAmount < 0)) {
      throw httpError(400, "Invalid budgetAmount (expected a non-negative number or null)");
    }
    set["qualificationData.budgetAmount"] = body.budgetAmount;
  }
  if (body.budgetNote !== undefined) {
    if (typeof body.budgetNote !== "string" || body.budgetNote.length > 1000) {
      throw httpError(400, "Invalid budgetNote");
    }
    set["qualificationData.budgetNote"] = body.budgetNote;
  }
  if (body.additionalEmails !== undefined) {
    const emailish = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (
      !Array.isArray(body.additionalEmails) ||
      body.additionalEmails.some((e) => typeof e !== "string" || (e.trim() && !emailish.test(e.trim())))
    ) {
      throw httpError(400, "Invalid additionalEmails (expected an array of email addresses)");
    }
    set["qualificationData.additionalEmails"] = [
      ...new Set(body.additionalEmails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
    ];
  }
  // Lead-schema foundation — coverage zones (enum-validated array).
  if (body.zones !== undefined) {
    if (!Array.isArray(body.zones) || body.zones.some((z) => typeof z !== "string" || !ZONES.includes(z))) {
      throw httpError(400, `Invalid zones (expected an array of: ${ZONES.join(", ")})`);
    }
    set["qualificationData.zones"] = [...new Set(body.zones)];
  }
  // Lead-detail cockpit — persist the FULL day/function draft verbatim (no
  // filtering) AND sync the canonical eventDate. The earliest dated, non-
  // dateUnknown day becomes qualificationData.eventDate (the single field the
  // gate + brief read); empty when no day carries a usable date. This runs AFTER
  // the string-field loop so the days are canonical over any raw eventDate also
  // sent in the same payload. No formal Event is created here — that happens only
  // at qualification (see LeadLifecycleService.qualifyLead).
  if (body.eventDays !== undefined) {
    const days = normalizeEventDays(body.eventDays);
    set["qualificationData.eventDays"] = days;
    set["qualificationData.eventDate"] = deriveCanonicalEventDate(days);
  }

  if (Object.keys(set).length === 0) {
    throw httpError(400, "No valid qualification fields provided");
  }

  const updated = await EnquiryRepository.updateFieldsById(enquiryId, set);
  if (!updated) {
    throw httpError(404, "Enquiry not found");
  }

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "qualification_updated",
    actorId,
    payload: { fields: Object.keys(set).map((k) => k.replace("qualificationData.", "")) },
  });

  return updated;
};

// POST /enquiry/:_id/call-complete — server-side mirror of the UI gate:
// a qualified lead CANNOT be saved as complete without a future follow-up locked.
// An explicit incomplete=true bypasses, with the acknowledged gaps recorded on the lead.
const completeCall = async (enquiryId, { incomplete, gaps } = {}, actorId) => {
  assertValidId(enquiryId);

  const enquiry = await EnquiryRepository.findById(enquiryId);
  if (!enquiry) {
    throw httpError(404, "Enquiry not found");
  }

  const isIncomplete = incomplete === true;
  if (isIncomplete) {
    if (
      gaps !== undefined &&
      (!Array.isArray(gaps) || gaps.some((g) => typeof g !== "string"))
    ) {
      throw httpError(400, "Invalid gaps (expected an array of strings)");
    }
  } else if (enquiry.qualified && !hasFutureFollowUp(enquiry)) {
    throw httpError(
      400,
      "Cannot complete: a qualified call must end with a future follow-up locked. Lock the next step, or save with incomplete=true to record the gap."
    );
  }

  const updated = await EnquiryRepository.updateFieldsById(enquiryId, {
    "callCompletion.status": isIncomplete ? "incomplete" : "complete",
    "callCompletion.gaps": isIncomplete ? gaps || [] : [],
    "callCompletion.completedAt": new Date(),
    "callCompletion.completedBy": actorId || null,
  });

  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "call_completed",
    actorId,
    payload: { incomplete: isIncomplete, gaps: isIncomplete ? gaps || [] : [] },
  });

  // SEQ-3b — the save is NEVER blocked (Slice 1). But a save that leaves the lead
  // with no path forward — discovery STILL incomplete (the same 4-core rule the
  // GET computes) AND no future follow-up/meet locked — gets the "no further
  // action" marker so the intern's view surfaces it. Otherwise (discovery
  // complete, or a next step exists) we clear it. computeDiscovery runs on the
  // lead doc exactly as the GET does (no events join either side), so the two
  // never drift.
  const leadObj = enquiry.toObject ? enquiry.toObject() : enquiry;
  const { discoveryComplete } = computeDiscovery(leadObj);
  const hasNextStep = hasFutureFollowUp(enquiry);
  await setNoFurtherAction(enquiryId, !discoveryComplete && !hasNextStep, actorId);

  return updated;
};

const listInternalEvents = async (enquiryId) => {
  assertValidId(enquiryId);
  return await LeadInternalEventService.listForLead(enquiryId);
};

// MB6 Slice 6 — meet-refuser: the lead won't take a meeting. Tags 'no-meet',
// escalates to the owner's sales lead, notifies the Revenue Head, journey event.
const meetRefused = async (enquiryId, actorId) => {
  assertValidId(enquiryId);
  const enquiry = await EnquiryRepository.findById(enquiryId);
  if (!enquiry) throw httpError(404, "Enquiry not found");

  const Enquiry = require("../models/Enquiry");
  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const AdminNotificationService = require("./AdminNotificationService");

  await Enquiry.findByIdAndUpdate(enquiryId, { $addToSet: { tags: "no-meet" } });
  await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "meet_refused",
    actorId,
    payload: {},
  });

  // Escalate to the owner's sales lead (reportingManager).
  const owner = enquiry.assignedTo
    ? await Admin.findById(enquiry.assignedTo, { name: 1, reportingManagerId: 1 }).lean()
    : null;
  if (owner && owner.reportingManagerId) {
    await AdminNotificationService.notify(owner.reportingManagerId, {
      type: "meet_refused",
      title: `${enquiry.name} is refusing a meeting`,
      message: `Tagged no-meet by ${owner.name} — step in or coach the close.`,
      leadId: enquiryId,
    });
  }
  // Notify the Revenue Head(s).
  const rhRole = await Role.findOne({ name: "Revenue Head", deletedAt: null }, { _id: 1 }).lean();
  if (rhRole) {
    const heads = await Admin.find({ roleId: rhRole._id, status: "active" }, { _id: 1 }).lean();
    await AdminNotificationService.notify(
      heads.map((h) => h._id),
      {
        type: "meet_refused",
        title: `Meet-refuser: ${enquiry.name}`,
        message: "Lead is dodging the meeting — tagged no-meet.",
        leadId: enquiryId,
      }
    );
  }
  return await EnquiryRepository.findById(enquiryId);
};

// POST /enquiry/:_id/whatsapp-activity — log the cockpit/lead "WhatsApp" press
// (a wa.me deep link that otherwise hits no server) as EMPLOYEE activity so it
// shows in the timeline and clears the "contacted but silent" dashboard flag.
// Deliberately does NOT stamp firstCalledAt or push to callLog: a call is still
// owed, and all TAT/funnel metrics stay call-only. It DOES stamp the signal
// spine (firstRespondedAt/lastActivityAt): per the Signal Matrix decision, an
// any-channel response satisfies the respond-now queue (the cadence engine
// keeps nagging for the actual call).
const logWhatsappActivity = async (enquiryId, { message } = {}, actorId) => {
  assertValidId(enquiryId);
  const lead = await EnquiryRepository.findById(enquiryId);
  if (!lead) throw httpError(404, "Enquiry not found");

  // Optional pre-typed template text — stored for the timeline (length-capped).
  const note =
    typeof message === "string" && message.trim()
      ? message.trim().slice(0, 2000)
      : "";

  const event = await LeadInternalEventService.record({
    leadId: enquiryId,
    type: "whatsapp_outbound",
    actorId: actorId || null,
    payload: note ? { message: note } : {},
  });
  // Signal spine: a WhatsApp press IS an any-channel customer response (clears
  // the respond-now queue once Slice 5 repoints it) and employee activity —
  // while firstCalledAt/callLog stay untouched: the call is still owed.
  await EnquiryRepository.stampFirstRespondedAt(enquiryId);
  await EnquiryRepository.touchLastActivity(enquiryId);
  return event || { ok: true };
};

module.exports = {
  logCall,
  logWhatsappActivity,
  addFollowUp,
  meetRefused,
  updateQualification,
  completeCall,
  listInternalEvents,
  // SEQ-3c — exported so the lead-page follow-up route (FollowupService.create)
  // clears the flag through the SAME helper, no duplicated logic.
  setNoFurtherAction,
  hasFutureFollowUp,
  cadenceFor,
  cadenceConfig,
  flagUnresponsiveIfNeeded,
  deriveCanonicalEventDate,
  ATTEMPT_OFFSETS_DAYS,
  MAX_ATTEMPTS,
  UNANSWERED_OUTCOMES,
  ZONES,
};
