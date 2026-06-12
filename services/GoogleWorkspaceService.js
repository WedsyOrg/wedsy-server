const jwt = require("jsonwebtoken");
const GoogleAccount = require("../models/GoogleAccount");
const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Enquiry = require("../models/Enquiry");
const CalendarEvent = require("../models/CalendarEvent");
const SettingsService = require("./SettingsService");

// MB6 Slice 8 — Google Workspace, built fully behind env seams (the
// ANTHROPIC_API_URL pattern): every Google URL is overridable so the e2e
// suite drives a local mock. When GOOGLE_CLIENT_ID/SECRET are unset the whole
// feature is DORMANT: status reports configured:false, booking falls back to
// the OS-only flow, the UI shows a tidy "not configured yet" state.

const httpError = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });

// The PINNED production redirect URI (env override for local/test).
const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || "https://prod.server.wedsy.in/google/oauth/callback";

const AUTH_URL = process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const USERINFO_URL = process.env.GOOGLE_USERINFO_URL || "https://openidconnect.googleapis.com/v1/userinfo";
const CALENDAR_URL = process.env.GOOGLE_CALENDAR_URL || "https://www.googleapis.com/calendar/v3";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "openid",
  "email",
];

const isConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

// ── OAuth ─────────────────────────────────────────────────────────────────────

// Consent URL with a signed state (the adminId rides through Google and back).
const startUrl = (adminId) => {
  if (!isConfigured()) throw httpError(409, "Google is not configured yet");
  const state = jwt.sign({ g: String(adminId) }, process.env.JWT_SECRET, { expiresIn: "15m" });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
};

const exchangeCode = async (code) => {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) throw httpError(502, `Google token exchange failed (${res.status})`);
  return await res.json();
};

const handleCallback = async (code, state) => {
  if (!isConfigured()) throw httpError(409, "Google is not configured yet");
  let adminId;
  try {
    adminId = jwt.verify(state, process.env.JWT_SECRET).g;
  } catch (_) {
    throw httpError(403, "Invalid or expired state");
  }
  const tokens = await exchangeCode(code);
  if (!tokens.refresh_token) {
    throw httpError(502, "Google did not return a refresh token — retry with consent");
  }
  // Who linked? userinfo via the fresh access token.
  let email = "";
  try {
    const ui = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (ui.ok) email = (await ui.json()).email || "";
  } catch (_) { /* email is display-only */ }

  const account = await GoogleAccount.findOneAndUpdate(
    { adminId },
    {
      $set: {
        email,
        refreshToken: tokens.refresh_token,
        scopes: String(tokens.scope || "").split(" ").filter(Boolean),
        linkedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return account;
};

const accessTokenFor = async (account) => {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: account.refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) throw httpError(502, `Google token refresh failed (${res.status})`);
  return (await res.json()).access_token;
};

const status = async (adminId) => {
  const account = await GoogleAccount.findOne({ adminId }).lean();
  return {
    configured: isConfigured(),
    linked: !!account,
    email: account ? account.email : null,
    linkedAt: account ? account.linkedAt : null,
  };
};

const disconnect = async (adminId) => {
  await GoogleAccount.deleteMany({ adminId });
  return { ok: true };
};

// ── Booking flow support ──────────────────────────────────────────────────────

// The two internal attendees of every G-Meet: the lead's sales lead (interns
// book on their reporting manager's calendar) and the Revenue-Head admin.
const meetingAttendees = async (lead) => {
  let salesLeadAdmin = lead.assignedTo
    ? await Admin.findById(lead.assignedTo, { name: 1, email: 1, roleId: 1, reportingManagerId: 1 }).lean()
    : null;
  if (salesLeadAdmin && salesLeadAdmin.roleId && salesLeadAdmin.reportingManagerId) {
    const poolRoles = (await SettingsService.get("assignment.poolRoles")) || [];
    const role = await Role.findById(salesLeadAdmin.roleId, { name: 1 }).lean();
    if (role && poolRoles.includes(role.name)) {
      // Intern-owned lead: the meet lives on the sales lead's calendar.
      const manager = await Admin.findById(salesLeadAdmin.reportingManagerId, { name: 1, email: 1 }).lean();
      if (manager) salesLeadAdmin = manager;
    }
  }
  let revenueHead = null;
  const rhRole = await Role.findOne({ name: "Revenue Head", deletedAt: null }, { _id: 1 }).lean();
  if (rhRole) {
    revenueHead = await Admin.findOne({ roleId: rhRole._id, status: "active" }, { name: 1, email: 1 }).lean();
  }
  return { salesLeadAdmin, revenueHead };
};

const googleBusy = async (account, from, to) => {
  const token = await accessTokenFor(account);
  const res = await fetch(`${CALENDAR_URL}/freeBusy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      items: [{ id: "primary" }],
    }),
  });
  if (!res.ok) throw httpError(502, `Google freeBusy failed (${res.status})`);
  const data = await res.json();
  const cal = data.calendars && data.calendars.primary;
  return (cal && cal.busy ? cal.busy : []).map((b) => ({ start: b.start, end: b.end, source: "google" }));
};

// Merged availability for the lead's meet: Google free/busy (linked admins)
// + OS CalendarEvents for BOTH attendees. Returns the busy blocks + 1h slot
// suggestions inside working hours.
const availability = async (leadId, { from, days = 5 } = {}) => {
  const lead = await Enquiry.findById(leadId).lean();
  if (!lead) throw httpError(404, "Lead not found");
  const start = from ? new Date(from) : new Date();
  if (Number.isNaN(start.getTime())) throw httpError(400, "Invalid from");
  const end = new Date(start.getTime() + days * 24 * 3600 * 1000);

  const { salesLeadAdmin, revenueHead } = await meetingAttendees(lead);
  const attendeeAdmins = [salesLeadAdmin, revenueHead].filter(Boolean);
  const attendeeIds = attendeeAdmins.map((a) => a._id);

  const busy = [];
  // OS calendar events of both attendees.
  const osEvents = await CalendarEvent.find({
    ownerId: { $in: attendeeIds },
    status: "scheduled",
    start: { $lt: end },
    end: { $gte: start },
  }).lean();
  for (const e of osEvents) busy.push({ start: e.start.toISOString(), end: e.end.toISOString(), source: "os" });

  // Google free/busy where linked (and configured).
  let googleUsed = false;
  if (isConfigured()) {
    for (const adminId of attendeeIds) {
      const account = await GoogleAccount.findOne({ adminId }).lean();
      if (!account) continue;
      try {
        busy.push(...(await googleBusy(account, start, end)));
        googleUsed = true;
      } catch (e) {
        console.error("[Google] freeBusy failed:", e.message);
      }
    }
  }

  // 1-hour slot suggestions inside working hours, skipping busy overlaps.
  const cfg = await SettingsService.getMany(["golden.workStartHour", "golden.workEndHour"]);
  const IST_OFFSET_MS = 330 * 60 * 1000;
  const slots = [];
  for (let d = 0; d < days; d++) {
    for (let h = cfg["golden.workStartHour"]; h < cfg["golden.workEndHour"]; h++) {
      const istDay = new Date(start.getTime() + IST_OFFSET_MS);
      const slotStart = new Date(
        Date.UTC(istDay.getUTCFullYear(), istDay.getUTCMonth(), istDay.getUTCDate() + d, h, 0) - IST_OFFSET_MS
      );
      const slotEnd = new Date(slotStart.getTime() + 3600 * 1000);
      if (slotStart < new Date()) continue;
      const clash = busy.some(
        (b) => new Date(b.start) < slotEnd && new Date(b.end) > slotStart
      );
      if (!clash) slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
    }
  }

  return {
    configured: isConfigured(),
    googleUsed,
    attendees: attendeeAdmins.map((a) => ({ _id: a._id, name: a.name })),
    busy,
    slots: slots.slice(0, 40),
  };
};

// Create the Google Calendar event WITH a Meet link, client + internal
// attendees invited. Returns { googleEventId, meetLink } or null when no
// linked organizer exists (the caller falls back to OS-only).
const createMeetEvent = async (lead, start, end) => {
  if (!isConfigured()) return null;
  const { salesLeadAdmin, revenueHead } = await meetingAttendees(lead);
  // Organizer preference: the sales lead's linked account, else the Revenue Head's.
  let organizer = null;
  let account = null;
  for (const candidate of [salesLeadAdmin, revenueHead].filter(Boolean)) {
    const acc = await GoogleAccount.findOne({ adminId: candidate._id }).lean();
    if (acc) {
      organizer = candidate;
      account = acc;
      break;
    }
  }
  if (!account) return null;

  const clientEmails = [
    (lead.qualificationData && lead.qualificationData.email) || lead.email || "",
    ...((lead.qualificationData && lead.qualificationData.additionalEmails) || []),
  ].filter(Boolean);
  const internalEmails = [salesLeadAdmin, revenueHead]
    .filter(Boolean)
    .map((a) => a.email)
    .filter(Boolean);
  const attendees = [...new Set([...clientEmails, ...internalEmails])].map((email) => ({ email }));

  const token = await accessTokenFor(account);
  const res = await fetch(`${CALENDAR_URL}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: `Wedsy — ${lead.name}'s wedding meet`,
      description: "Scheduled from Wedsy OS.",
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(end).toISOString() },
      attendees,
      conferenceData: {
        createRequest: { requestId: `wedsy-${lead._id}-${new Date(start).getTime()}`, conferenceSolutionKey: { type: "hangoutsMeet" } },
      },
    }),
  });
  if (!res.ok) throw httpError(502, `Google event create failed (${res.status})`);
  const event = await res.json();
  return {
    googleEventId: event.id,
    meetLink: event.hangoutLink || "",
    organizerAdminId: organizer._id,
    invited: attendees.map((a) => a.email),
  };
};

// The cockpit finale's one-call booking: Google event (when wired) + the meet
// follow-up exactly as today (which mirrors the OS CalendarEvent, runs the
// huddle auto-create and the intern handoff). The mirrored event is then
// stamped with the googleEventId.
const bookMeet = async (leadId, { start, end }, actorId) => {
  const lead = await Enquiry.findById(leadId).lean();
  if (!lead) throw httpError(404, "Lead not found");
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) throw httpError(400, "Invalid start");
  const e = end ? new Date(end) : new Date(s.getTime() + 3600 * 1000);

  let google = null;
  try {
    google = await createMeetEvent(lead, s, e);
  } catch (err) {
    console.error("[Google] meet create failed — falling back to OS-only:", err.message);
  }

  // The follow-up books exactly as today (journey, mirror, huddle, handoff).
  const CallCockpitService = require("./CallCockpitService");
  await CallCockpitService.addFollowUp(
    leadId,
    { type: "meet", scheduledAt: s.toISOString(), promiseNote: google && google.meetLink ? `G-Meet: ${google.meetLink}` : "" },
    actorId
  );

  // Stamp the mirrored OS event with the Google linkage.
  const mirrored = await CalendarEvent.findOne({ leadId, type: "gmeet", start: s })
    .sort({ createdAt: -1 })
    .lean();
  if (mirrored && google) {
    await CalendarEvent.findByIdAndUpdate(mirrored._id, {
      $set: { googleEventId: google.googleEventId, end: e },
    });
  }

  return {
    google: !!google,
    meetLink: google ? google.meetLink : "",
    googleEventId: google ? google.googleEventId : "",
    invited: google ? google.invited : [],
    osEventId: mirrored ? mirrored._id : null,
  };
};

module.exports = {
  isConfigured,
  startUrl,
  handleCallback,
  status,
  disconnect,
  availability,
  bookMeet,
  meetingAttendees,
  REDIRECT_URI,
};
