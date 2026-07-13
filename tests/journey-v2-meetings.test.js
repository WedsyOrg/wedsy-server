/**
 * Journey v2 — V2: the meetings engine.
 *
 *   node tests/journey-v2-meetings.test.js
 *
 * Google mocked via GOOGLE_* env seams (same idiom as the Slice-8 e2e): create
 * with Google (attendee plumbing + title on the wire), create WITHOUT Google
 * (OS-only fallback, meetLink null), email persistence, huddle/mirror intact,
 * postpone/cancel + journey events + Google patch/cancel, MOM save → AI (return
 * only) → sent stamp (once), history rows.
 */
require("dotenv").config();
const http = require("http");

const mock = { calendarCalls: [], tokenCalls: 0, anthropic: [] };
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : {};
    if (req.url.startsWith("/token")) {
      mock.tokenCalls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ access_token: "at_mock" }));
    }
    if (req.url.startsWith("/cal/")) {
      mock.calendarCalls.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.method === "DELETE") return res.end(JSON.stringify({}));
      return res.end(JSON.stringify({ id: "gev_mock_1", hangoutLink: "https://meet.google.com/xby-pfza-krd" }));
    }
    if (req.url === "/v1/messages") {
      mock.anthropic.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: "m", content: [{ type: "text", text: "Hi Ananya! Lovely speaking today — recap." }], stop_reason: "end_turn" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({}));
  });
});

const TAG = `jv2meet-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.GOOGLE_TOKEN_URL = `${base}/token`;
  process.env.GOOGLE_CALENDAR_URL = `${base}/cal`;
  process.env.ANTHROPIC_API_URL = `${base}/v1/messages`;

  const mongoose = require("mongoose");
  const Enquiry = require("../models/Enquiry");
  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const Department = require("../models/Department");
  const GoogleAccount = require("../models/GoogleAccount");
  const CalendarEvent = require("../models/CalendarEvent");
  const LeadInternalEvent = require("../models/LeadInternalEvent");
  const MeetingService = require("../services/MeetingService");
  const meetingController = require("../controllers/meeting");

  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  const created = { leads: [], admins: [], roles: [], depts: [] };
  const mockRes = () => ({
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
  });

  try {
    const dept = await Department.create({ name: `${TAG}-dept` });
    created.depts.push(dept._id);
    const owner = await Admin.create({
      name: `${TAG}-varsha`, email: `${TAG}-v@wedsy.in`, phone: `${TAG}v`, password: "x",
      roles: ["sales"], status: "active", departmentId: dept._id,
    });
    const teammate = await Admin.create({
      name: `${TAG}-meera`, email: `${TAG}-m@wedsy.in`, phone: `${TAG}m`, password: "x",
      roles: ["sales"], status: "active", departmentId: dept._id,
    });
    const disabledAdmin = await Admin.create({
      name: `${TAG}-dis`, email: `${TAG}-d@wedsy.in`, phone: `${TAG}d`, password: "x",
      roles: ["sales"], status: "active", isDisabled: true, departmentId: dept._id,
    });
    created.admins.push(owner._id, teammate._id, disabledAdmin._id);
    // Linked Google account for the organizer path (owner = the sales lead).
    await GoogleAccount.create({ adminId: owner._id, email: `${TAG}-v@wedsy.in`, refreshToken: "rt_mock" });

    const lead = await Enquiry.create({
      name: "Ananya & Karthik", phone: `${TAG}-ph`, verified: false, isInterested: false,
      isLost: false, stage: "contacted", source: "Default", lostStatus: "none",
      assignedTo: owner._id, qualified: true, qualifiedAt: new Date(),
      qualificationData: { email: "ananya@example.com", additionalEmails: [] },
    });
    created.leads.push(lead._id);

    // ── 1. Create WITH Google ────────────────────────────────────────────────
    const start = new Date(Date.now() + 24 * 3600 * 1000);
    const r1 = await MeetingService.createMeeting(
      String(lead._id),
      { dateTime: start.toISOString(), clientEmails: ["karthik@example.com"], teamAdminIds: [String(teammate._id)] },
      owner._id
    );
    ok(r1.meetLink === "https://meet.google.com/xby-pfza-krd" && r1.eventId, "create returns { meetLink, eventId }");
    ok(r1.title === "Ananya & Karthik's wedding planning with Wedsy", "title defaults to \"{couple}'s wedding planning with Wedsy\"");
    const gCreate = mock.calendarCalls.find((c) => c.method === "POST");
    const gEmails = (gCreate.body.attendees || []).map((a) => a.email).sort();
    ok(gEmails.includes("ananya@example.com") && gEmails.includes("karthik@example.com") &&
       gEmails.includes(`${TAG}-m@wedsy.in`),
      `arbitrary attendees on the Google wire (got ${gEmails.join(", ")})`);
    ok(gCreate.body.summary === r1.title, "custom/default title plumbed into the Google event");
    const leadAfter = await Enquiry.findById(lead._id).lean();
    ok((leadAfter.qualificationData.additionalEmails || []).includes("karthik@example.com"),
      "NEW client email persisted back to additionalEmails");
    const ev1 = await CalendarEvent.findById(r1.eventId).lean();
    ok(ev1 && ev1.googleEventId === "gev_mock_1" && String(ev1.organizerAdminId) === String(owner._id),
      "mirrored CalendarEvent stamped with googleEventId + organizer");
    ok(ev1.attendees.length === 3 && ev1.attendees.some((a) => String(a.adminId || "") === String(teammate._id)),
      "attendees persisted on the event (team rows carry adminId)");
    ok(await CalendarEvent.exists({ leadId: lead._id, type: "huddle" }), "huddle machinery untouched (auto-created)");

    // Disabled team member → 422.
    let e422 = false;
    try {
      await MeetingService.createMeeting(String(lead._id), { dateTime: start.toISOString(), teamAdminIds: [String(disabledAdmin._id)] }, owner._id);
    } catch (e) { e422 = e.status === 422; }
    ok(e422, "disabled team member → 422 (assignable predicate)");

    // ── 2. Create WITHOUT Google (unlink) ────────────────────────────────────
    await GoogleAccount.deleteMany({ adminId: owner._id });
    const r2 = await MeetingService.createMeeting(
      String(lead._id),
      { title: "Venue walkthrough", dateTime: new Date(Date.now() + 48 * 3600 * 1000).toISOString() },
      owner._id
    );
    ok(r2.meetLink === null && r2.eventId, "OS-only fallback: meetLink null, event still created");
    ok(r2.title === "Venue walkthrough", "explicit title wins over the default");

    // ── 3. Postpone / cancel ─────────────────────────────────────────────────
    const p1 = await MeetingService.updateMeeting(
      String(lead._id), String(r2.eventId),
      { action: "postpone", reason: "family travel" }, owner._id
    );
    ok(p1.status === "postponed", "postpone without a date parks the meeting");
    ok(await LeadInternalEvent.exists({ leadId: lead._id, type: "meeting_postponed" }), "journey event meeting_postponed");
    const newDt = new Date(Date.now() + 72 * 3600 * 1000);
    const p2 = await MeetingService.updateMeeting(
      String(lead._id), String(r2.eventId),
      { action: "postpone", newDateTime: newDt.toISOString(), reason: "new slot" }, owner._id
    );
    ok(p2.status === "scheduled" && +(await CalendarEvent.findById(r2.eventId).lean()).start === +newDt,
      "postpone WITH a new date moves the meeting back to Upcoming");

    mock.calendarCalls.length = 0;
    await GoogleAccount.create({ adminId: owner._id, email: `${TAG}-v@wedsy.in`, refreshToken: "rt_mock" });
    const c1 = await MeetingService.updateMeeting(String(lead._id), String(r1.eventId), { action: "cancel", reason: "client asked" }, owner._id);
    ok(c1.status === "cancelled" && (await CalendarEvent.findById(r1.eventId).lean()).statusReason === "client asked",
      "cancel sets status + statusReason");
    ok(mock.calendarCalls.some((c) => c.method === "DELETE"), "linked Google event cancelled on the wire");
    ok(await LeadInternalEvent.exists({ leadId: lead._id, type: "meeting_cancelled" }), "journey event meeting_cancelled");

    // ── 4. MOM ritual ────────────────────────────────────────────────────────
    const momText = "— Bride confirmed boho-luxe garden direction.\n— Next: lock venue by Sat.";
    const m1 = await MeetingService.saveMom(String(lead._id), String(r2.eventId), momText, teammate._id);
    ok(m1.mom.text === momText && String(m1.mom.savedBy) === String(teammate._id), "MOM saved { text, savedBy, savedAt }");

    const resAi = mockRes();
    await meetingController.AiClientBrief(
      { params: { _id: String(lead._id), eventId: String(r2.eventId) }, body: {}, scopeFilter: {}, auth: { user_id: String(teammate._id) } },
      resAi
    );
    ok(resAi.statusCode === 200 && /Hi Ananya/.test(resAi.body.text), "MOM AI endpoint returns { text }");
    const evAfterAi = await CalendarEvent.findById(r2.eventId).lean();
    ok(!evAfterAi.momSentToClient, "AI endpoint never stamps sent (review-then-send)");
    ok(/boho-luxe/.test(JSON.stringify(mock.anthropic[mock.anthropic.length - 1])), "AI input carries the MOM text");

    const s1 = await MeetingService.markMomSent(String(lead._id), String(r2.eventId), owner._id);
    ok(s1.momSentToClient && s1.momSentToClient.at, "manual sent checkbox stamps { at, by }");
    const s2 = await MeetingService.markMomSent(String(lead._id), String(r2.eventId), teammate._id);
    ok(s2.alreadyStamped && +new Date(s2.momSentToClient.at) === +new Date(s1.momSentToClient.at),
      "second stamp is a no-op (first deliberate act wins)");

    // Un-MOM'd meeting can't be marked sent.
    const r3 = await MeetingService.createMeeting(String(lead._id), { dateTime: new Date(Date.now() + 96 * 3600 * 1000).toISOString() }, owner._id);
    ok(await throws409(() => MeetingService.markMomSent(String(lead._id), String(r3.eventId), owner._id)),
      "mom/sent without a saved MOM → 409");

    // ── 5. History rows ──────────────────────────────────────────────────────
    const rows = await MeetingService.listMeetings(String(lead._id));
    const byId = new Map(rows.map((r) => [r.eventId, r]));
    ok(byId.get(String(r1.eventId)).status === "Cancelled", "history derives Cancelled");
    ok(byId.get(String(r2.eventId)).status === "Upcoming" && byId.get(String(r2.eventId)).hasMom === true &&
       !!byId.get(String(r2.eventId)).momSentToClient,
      "history row: Upcoming + hasMom + momSentToClient");
    await CalendarEvent.updateOne({ _id: r3.eventId }, { $set: { status: "closed" } });
    const rows2 = await MeetingService.listMeetings(String(lead._id));
    ok(rows2.find((r) => r.eventId === String(r3.eventId)).status === "Held", "closed derives Held");

    // ── Addendum: meetLink persisted + on rows; mom object on rows ───────────
    const ev1Fresh = await CalendarEvent.findById(r1.eventId).lean();
    ok(ev1Fresh.meetLink === "https://meet.google.com/xby-pfza-krd", "meetLink PERSISTED on the event at create");
    const rowsA = await MeetingService.listMeetings(String(lead._id));
    ok(rowsA.find((r) => r.eventId === String(r1.eventId)).meetLink === "https://meet.google.com/xby-pfza-krd",
      "Google-created row carries meetLink");
    // r2 was created while the Google account was UNLINKED (r3 came after the
    // relink, so it legitimately carries a link).
    ok(rowsA.find((r) => r.eventId === String(r2.eventId)).meetLink === null,
      "OS-only row carries meetLink null");
    const momRow = rowsA.find((r) => r.eventId === String(r2.eventId));
    ok(momRow.mom && momRow.mom.text === momText && String(momRow.mom.savedBy) === String(teammate._id),
      "rows include mom { text, savedBy, savedAt } when saved");
    ok(rowsA.find((r) => r.eventId === String(r3.eventId)).mom === null, "un-MOM'd rows carry mom:null");
    // Pre-addendum recovery: wipe the stored link; the follow-up promiseNote
    // ("G-Meet: <link>") recovers it via the event's followUpId linkage.
    await CalendarEvent.updateOne({ _id: r1.eventId }, { $set: { meetLink: "" } });
    const legacyEv = await CalendarEvent.findById(r1.eventId).lean();
    const rowsB = await MeetingService.listMeetings(String(lead._id));
    const recovered = rowsB.find((r) => r.eventId === String(r1.eventId)).meetLink;
    ok(legacyEv.followUpId ? recovered === "https://meet.google.com/xby-pfza-krd" : recovered === null,
      `pre-existing event link recovered from promiseNote (followUpId ${legacyEv.followUpId ? "linked" : "absent"} → ${recovered})`);

    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    const mongoose = require("mongoose");
    const Enquiry = require("../models/Enquiry");
    const Admin = require("../models/Admin");
    const Department = require("../models/Department");
    const GoogleAccount = require("../models/GoogleAccount");
    const CalendarEvent = require("../models/CalendarEvent");
    const LeadInternalEvent = require("../models/LeadInternalEvent");
    const AdminNotification = require("../models/AdminNotification");
    const LeadLane = require("../models/LeadLane");
    const LaneEntry = require("../models/LaneEntry");
    await CalendarEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LaneEntry.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await LeadLane.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
    await GoogleAccount.deleteMany({ adminId: { $in: created.admins } }).catch(() => {});
    await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
    await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
    await Department.deleteMany({ _id: { $in: created.depts } }).catch(() => {});
    await mongoose.disconnect();
    server.close();
    process.exit(fail ? 1 : 0);
  }

  async function throws409(fn) { try { await fn(); return false; } catch (e) { return e.status === 409; } }
})();
