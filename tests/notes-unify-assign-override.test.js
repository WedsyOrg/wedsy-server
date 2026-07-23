// NOTES UNIFY + ASSIGN OVERRIDE test (N1–N3). Run: node tests/notes-unify-assign-override.test.js
// Covers: the merged note stream returns every store (legacy conversations,
// qualifier strings, discovery notes, the blob, canonical events) with correct
// authorship + ordering; a note written from EITHER surface (comms tab
// AddConversation / Notes-tab addNote) appears in BOTH reads exactly once with
// author + timestamp; conversation edit/delete tracks through the stream;
// explicit assignedTo on create WINS and skips round-robin; a disabled target
// is rejected pre-create; no assignedTo → auto-assign unchanged.
// Mutates the GLOBAL assignment settings — snapshots + restores in finally.
require("dotenv").config();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const Admin = require("../models/Admin");
const Role = require("../models/Role");
const Department = require("../models/Department");
const Enquiry = require("../models/Enquiry");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const AdminNotification = require("../models/AdminNotification");
const SettingsService = require("../services/SettingsService");
const NoteStreamService = require("../services/NoteStreamService");
const LeadLifecycleService = require("../services/LeadLifecycleService");
const LeadIntakeService = require("../services/LeadIntakeService");
const enquiryController = require("../controllers/enquiry");

const TAG = `notesuni-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], roles: [], depts: [], leads: [] };
const SETTING_KEYS = ["assignment.autoAssignEnabled", "assignment.mode", "assignment.poolRoles", "assignment.overflowRoles", "assignment.excludedAdminIds"];
let saved = {};

// Promise-resolving res stub for the legacy promise-chain controllers.
const call = (fn, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      send(body) { resolve({ status: this.statusCode, body }); },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    fn(req, res);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    saved = await SettingsService.getMany(SETTING_KEYS);

    const dept = await Department.create({ name: `${TAG}-dept`, slug: `${TAG}-d` });
    created.depts.push(dept._id);
    const role = await Role.create({ name: `${TAG}-pool`, departmentId: dept._id, permissions: ["leads:view:own"] });
    created.roles.push(role._id);
    const mk = (s, extra = {}) =>
      Admin.create({ name: `${TAG}-${s}`, email: `${TAG}${s}@x.com`, phone: `${TAG}${s}`, password: "x", roles: ["sales"], status: "active", roleId: role._id, ...extra });
    const author = await mk("author", { lastAssignedAt: new Date("2026-03-01") });
    const target = await mk("target", { lastAssignedAt: new Date("2026-03-02") });
    const poolA = await mk("poolA", { lastAssignedAt: new Date("2026-01-01") }); // round-robin front
    const disabled = await mk("disabled", { isDisabled: true });
    created.admins.push(author._id, target._id, poolA._id, disabled._id);

    // ═══ N1 — every store surfaces, verbatim, labelled ═══
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-p1`, verified: false, isInterested: false, isLost: false,
      stage: "qualified", source: "Default", lostStatus: "none", assignedTo: author._id,
      qualifiedAt: new Date("2026-06-01T10:00:00Z"),
      qualifierNotes: "Budget flexible, wants poolside mandap",
      qualificationData: { additionalNotes: "Groom side handles decor decisions" },
      updates: {
        notes: "old blob content",
        conversations: [{ text: "legacy pre-qual call note", createdAt: new Date("2026-05-20T09:00:00Z") }],
      },
    });
    created.leads.push(lead._id);
    // a legacy addNote-era commented event (no conversationId link)
    await LeadInternalEvent.create({
      leadId: lead._id, type: "commented", actorId: author._id,
      payload: { text: "unlinked canonical note", at: new Date("2026-06-10T12:00:00Z") },
    });

    let stream = await NoteStreamService.listNotes(lead._id);
    const bySrc = (s) => stream.filter((n) => n.source === s);
    ok(stream.some((n) => n.text === "legacy pre-qual call note" && n.source === "pre-qual" && n.authorId === null),
      "legacy conversation row surfaces — source pre-qual, honest null author");
    ok(stream.some((n) => n.text === "Budget flexible, wants poolside mandap" && n.source === "qualifier"),
      "qualifierNotes string surfaces as source qualifier");
    ok(stream.some((n) => n.text === "Groom side handles decor decisions" && n.source === "qualifier"),
      "qualificationData.additionalNotes surfaces as source qualifier");
    // Stream-purity ruling: only blob ORPHANS surface (this seeded blob text
    // exists nowhere else, so it renders as one authorless orphan row).
    ok(stream.filter((n) => n.text === "old blob content" && n.authorId === null).length === 1,
      "a blob-only orphan surfaces as one authorless row (purity ruling)");
    const unlinked = stream.find((n) => n.text === "unlinked canonical note");
    ok(!!unlinked && unlinked.authorName === `${TAG}-author` && unlinked.source === "post-qual",
      "pre-mirror commented event surfaces with author name; after qualifiedAt → post-qual");

    // ═══ N2 — write once (comms tab), visible everywhere ═══
    const r1 = await call(enquiryController.AddConversation, {
      params: { _id: String(lead._id) },
      body: { conversation: "note from the comms tab" },
      auth: { user_id: String(author._id) },
    });
    ok(r1.status === 200, "AddConversation succeeds");
    stream = await NoteStreamService.listNotes(lead._id);
    const commsRows = stream.filter((n) => n.text === "note from the comms tab");
    ok(commsRows.length === 1, "comms-tab note appears in the stream exactly ONCE (no double via the mirror)");
    ok(commsRows[0] && commsRows[0].authorName === `${TAG}-author` && commsRows[0].at,
      "comms-tab note carries author + timestamp automatically");
    let leadDoc = await Enquiry.findById(lead._id).lean();
    ok(leadDoc.updates.conversations.some((c) => c.text === "note from the comms tab"),
      "comms-tab note is in updates.conversations (legacy tab still sees it)");

    // ═══ N2 — write once (Notes tab addNote), visible everywhere ═══
    await LeadLifecycleService.addNote(lead._id, "note from the Notes tab", author._id);
    stream = await NoteStreamService.listNotes(lead._id);
    const noteRows = stream.filter((n) => n.text === "note from the Notes tab");
    ok(noteRows.length === 1 && noteRows[0].authorName === `${TAG}-author`,
      "Notes-tab note appears ONCE in the stream, authored");
    leadDoc = await Enquiry.findById(lead._id).lean();
    ok(leadDoc.updates.conversations.some((c) => c.text === "note from the Notes tab"),
      "Notes-tab note mirrored into updates.conversations (comms tab sees it too)");
    ok(stream.every((n, i) => i === 0 || !n.at || !stream[i - 1].at || +new Date(stream[i - 1].at) >= +new Date(n.at)),
      "stream is newest-first (undated entries sink)");

    // edit tracks through the stream; author survives
    const convRow = leadDoc.updates.conversations.find((c) => c.text === "note from the comms tab");
    const r2 = await call(enquiryController.UpdateConversation, {
      params: { _id: String(lead._id), conversationId: String(convRow._id) },
      body: { text: "note from the comms tab (edited)" },
    });
    ok(r2.status === 200, "UpdateConversation succeeds");
    stream = await NoteStreamService.listNotes(lead._id);
    const edited = stream.find((n) => n._id === String(convRow._id));
    ok(!!edited && edited.text === "note from the comms tab (edited)" && edited.authorName === `${TAG}-author`,
      "edited text surfaces in the stream — authorship intact, no stale copy");
    ok(!stream.some((n) => n.text === "note from the comms tab"), "the pre-edit text is gone from the stream");

    // delete removes it from every view
    await call(enquiryController.DeleteConversation, {
      params: { _id: String(lead._id), conversationId: String(convRow._id) },
    });
    stream = await NoteStreamService.listNotes(lead._id);
    ok(!stream.some((n) => n._id === String(convRow._id)), "deleted conversation note is gone from the stream");

    // ═══ N3 — explicit assignedTo override ═══
    await SettingsService.set("assignment.autoAssignEnabled", true, null);
    await SettingsService.set("assignment.mode", "auto", null);
    await SettingsService.set("assignment.poolRoles", [`${TAG}-pool`], null);
    await SettingsService.set("assignment.overflowRoles", [`${TAG}-pool`], null);
    await SettingsService.set("assignment.excludedAdminIds", [], null);
    const poolAStampBefore = (await Admin.findById(poolA._id).lean()).lastAssignedAt;

    const adminToken = jwt.sign({ _id: String(author._id), isAdmin: true }, process.env.JWT_SECRET);
    const r3 = await call(enquiryController.CreateNew, {
      params: {}, headers: { authorization: `Bearer ${adminToken}` },
      body: { name: `${TAG}-ovr`, phone: `${TAG}-p2`, verified: false, source: "Default", assignedTo: String(target._id) },
    });
    ok(r3.status === 201 || r3.status === 200, `create with assignedTo accepted (${r3.status})`);
    await sleep(700); // afterCreate is fire-and-forget
    const ovrLead = await Enquiry.findOne({ phone: `${TAG}-p2` }).lean();
    if (ovrLead) created.leads.push(ovrLead._id);
    ok(!!ovrLead && String(ovrLead.assignedTo) === String(target._id),
      "explicit assignedTo WINS — lead lands on the named admin");
    const manualEv = await LeadInternalEvent.findOne({ leadId: ovrLead._id, type: "manual_assigned" }).lean();
    const autoEv = await LeadInternalEvent.findOne({ leadId: ovrLead._id, type: "auto_assigned" }).lean();
    ok(!!manualEv && String(manualEv.actorId) === String(author._id) && manualEv.payload.via === "create_override",
      "manual_assigned event recorded with the creating admin as actor");
    ok(!autoEv, "NO auto_assigned event — round-robin fully skipped");
    const poolAStampAfter = (await Admin.findById(poolA._id).lean()).lastAssignedAt;
    ok(String(poolAStampBefore) === String(poolAStampAfter),
      "the round-robin front-runner's rotation stamp untouched (pool not consumed)");

    // disabled target → rejected BEFORE any lead exists
    const r4 = await call(enquiryController.CreateNew, {
      params: {}, headers: { authorization: `Bearer ${adminToken}` },
      body: { name: `${TAG}-bad`, phone: `${TAG}-p3`, verified: false, source: "Default", assignedTo: String(disabled._id) },
    });
    ok(r4.status === 422 && /can't receive leads/.test(r4.body.message),
      `disabled target rejected with a clear message (${r4.status})`);
    ok(!(await Enquiry.findOne({ phone: `${TAG}-p3` })), "rejected create leaves NO lead behind");

    // assignedTo without an admin bearer → 403 (public-route hardening)
    const r5 = await call(enquiryController.CreateNew, {
      params: {}, headers: {},
      body: { name: `${TAG}-anon`, phone: `${TAG}-p4`, verified: false, source: "Default", assignedTo: String(target._id) },
    });
    ok(r5.status === 403, "assignedTo from an anonymous caller is refused (admin-only knob)");
    ok(!(await Enquiry.findOne({ phone: `${TAG}-p4` })), "refused create leaves NO lead behind");

    // no assignedTo → existing auto-assign path untouched
    const r6 = await call(enquiryController.CreateNew, {
      params: {}, headers: {},
      body: { name: `${TAG}-auto`, phone: `${TAG}-p5`, verified: false, source: "Default" },
    });
    ok(r6.status === 201 || r6.status === 200, `plain create still works (${r6.status})`);
    await sleep(700);
    const autoLead = await Enquiry.findOne({ phone: `${TAG}-p5` }).lean();
    if (autoLead) created.leads.push(autoLead._id);
    ok(!!autoLead && String(autoLead.assignedTo) === String(poolA._id),
      "no assignedTo → round-robin picks the least-recently-assigned as before");
    ok(!!(await LeadInternalEvent.findOne({ leadId: autoLead._id, type: "auto_assigned" })),
      "auto_assigned event recorded on the auto path (unchanged)");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (mongoose.connection.readyState === 1) {
      for (const [k, v] of Object.entries(saved)) {
        await SettingsService.set(k, v, null).catch(() => {});
      }
      await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await AdminNotification.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
      await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
      await Role.deleteMany({ _id: { $in: created.roles } }).catch(() => {});
      await Department.deleteMany({ _id: { $in: created.depts } }).catch(() => {});
      await mongoose.disconnect();
    }
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
