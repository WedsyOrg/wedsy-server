// LEAD-COMMS NOTES ROUTING test. Run: node tests/leadcomms-notes-routing.test.js
// Covers: a legacy "[Lead comms] …" chat row surfaces in the merged note
// stream (prefix stripped, author + time intact, era-labelled) and is ABSENT
// from the chat rail read and its unread count; a note via the canonical
// POST /note path appears in the stream and never in chat; ordinary chat
// messages (including ones that merely MENTION "[Lead comms]" mid-body) are
// untouched.
require("dotenv").config();
const mongoose = require("mongoose");

const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const LeadChatMessage = require("../models/LeadChatMessage");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const NoteStreamService = require("../services/NoteStreamService");
const LeadChatService = require("../services/LeadChatService");
const LeadLifecycleService = require("../services/LeadLifecycleService");

const TAG = `leadcomms-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], leads: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const author = await Admin.create({ name: `${TAG}-author`, email: `${TAG}a@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    const reader = await Admin.create({ name: `${TAG}-reader`, email: `${TAG}r@x.com`, phone: `${TAG}r`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(author._id, reader._id);
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-p1`, verified: false, isInterested: false, isLost: false,
      stage: "qualified", source: "Default", lostStatus: "none", assignedTo: author._id,
      qualifiedAt: new Date("2026-06-01T10:00:00Z"),
    });
    created.leads.push(lead._id);

    // The misrouted legacy row (the bug) + two genuine chat messages.
    const misrouted = await LeadChatMessage.create({
      leadId: lead._id, authorId: author._id, kind: "message",
      body: "[Lead comms] budget call recap — bride wants pastel palette",
    });
    const genuine = await LeadChatMessage.create({
      leadId: lead._id, authorId: author._id, kind: "message",
      body: "team: proposal review at 5pm",
    });
    const lookalike = await LeadChatMessage.create({
      leadId: lead._id, authorId: author._id, kind: "message",
      body: "fyi the [Lead comms] strip is fixed now", // mid-body mention, NOT a prefix
    });

    // ── 2. read-time backfill into the note stream ──
    let stream = await NoteStreamService.listNotes(lead._id);
    const surfaced = stream.find((n) => n._id === String(misrouted._id));
    ok(!!surfaced, "legacy [Lead comms] chat row surfaces in the note stream");
    ok(surfaced && surfaced.text === "budget call recap — bride wants pastel palette",
      "the '[Lead comms] ' prefix is stripped");
    ok(surfaced && surfaced.authorName === `${TAG}-author` && surfaced.authorId === String(author._id),
      "author carried from the chat row");
    ok(surfaced && String(surfaced.at) === String(misrouted.createdAt) && surfaced.source === "post-qual",
      "timestamp intact; after qualifiedAt → post-qual");
    ok(!stream.some((n) => n._id === String(genuine._id)), "a genuine chat message does NOT leak into the stream");
    ok(!stream.some((n) => n._id === String(lookalike._id)), "mid-body '[Lead comms]' mention is not a note (prefix-only match)");

    // ── 3. strict separation: the chat rail hides the misrouted row ──
    const { messages } = await LeadChatService.listMessages(lead._id, reader._id, { limit: 50 });
    ok(!messages.some((m) => String(m._id) === String(misrouted._id)), "chat rail EXCLUDES the [Lead comms] row");
    ok(messages.some((m) => String(m._id) === String(genuine._id)), "ordinary chat message still shows");
    ok(messages.some((m) => String(m._id) === String(lookalike._id)), "mid-body mention still shows in chat (unaffected)");

    // unread count ignores hidden rows (fresh reader, nothing read yet)
    const fresh = await Admin.create({ name: `${TAG}-fresh`, email: `${TAG}f@x.com`, phone: `${TAG}f`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(fresh._id);
    const unread = await LeadChatService.unreadCountForLead(lead._id, fresh._id);
    ok(unread === 2, `unread count skips the hidden note (${unread} — genuine + lookalike only)`);

    // ── 4. the canonical write path: note in BOTH note surfaces, never chat ──
    await LeadLifecycleService.addNote(lead._id, "canonical note via /note", author._id);
    stream = await NoteStreamService.listNotes(lead._id);
    const canonical = stream.filter((n) => n.text === "canonical note via /note");
    ok(canonical.length === 1 && canonical[0].authorName === `${TAG}-author`,
      "a /note write appears ONCE in the stream, authored");
    const leadDoc = await Enquiry.findById(lead._id).lean();
    ok((leadDoc.updates.conversations || []).some((c) => c.text === "canonical note via /note"),
      "…and in updates.conversations (the comms tab view)");
    const chatAfter = await LeadChatService.listMessages(lead._id, reader._id, { limit: 50 });
    ok(!chatAfter.messages.some((m) => (m.body || "").includes("canonical note via /note")),
      "…and NEVER lands in chat");
    ok((await LeadChatMessage.countDocuments({ leadId: lead._id })) === 3,
      "no new LeadChatMessage rows were written by the note path");
  } catch (e) {
    fail++;
    console.error("UNEXPECTED ERROR:", e);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await LeadChatMessage.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await LeadInternalEvent.deleteMany({ leadId: { $in: created.leads } }).catch(() => {});
      await Enquiry.deleteMany({ _id: { $in: created.leads } }).catch(() => {});
      await Admin.deleteMany({ _id: { $in: created.admins } }).catch(() => {});
      await mongoose.disconnect();
    }
    console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
