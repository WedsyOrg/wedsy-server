// NOTES STREAM PURITY test. Run: node tests/notes-stream-purity.test.js
// Covers: the auto-composed cockpit call-result line never appears (neither
// as its commented event nor via its conversations/blob mirrors), the legacy
// updates.notes blob never appears, a blob-ONLY orphan is REPORTED by the
// audit script (not silently dropped), and the four kept sources all surface
// with correct authorship and newest-first ordering.
require("dotenv").config();
const mongoose = require("mongoose");
const { execFileSync } = require("child_process");

const Admin = require("../models/Admin");
const Enquiry = require("../models/Enquiry");
const LeadChatMessage = require("../models/LeadChatMessage");
const LeadInternalEvent = require("../models/LeadInternalEvent");
const NoteStreamService = require("../services/NoteStreamService");
const LeadLifecycleService = require("../services/LeadLifecycleService");

const TAG = `purity-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

const created = { admins: [], leads: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    const author = await Admin.create({ name: `${TAG}-author`, email: `${TAG}a@x.com`, phone: `${TAG}a`, password: "x", roles: ["sales"], status: "active" });
    created.admins.push(author._id);
    const ORPHAN = `orphan-only-in-blob ${TAG}`;
    const lead = await Enquiry.create({
      name: `${TAG}-lead`, phone: `${TAG}-p1`, verified: false, isInterested: false, isLost: false,
      stage: "qualified", source: "Default", lostStatus: "none", assignedTo: author._id,
      qualifiedAt: new Date("2026-06-01T10:00:00Z"),
      qualifierNotes: `${TAG} wants poolside mandap`,
      qualificationData: { additionalNotes: `${TAG} groom side decides decor` },
      updates: {
        notes: `[9 Jul 2026] ${ORPHAN}`,
        conversations: [{ text: `${TAG} legacy pre-qual call note`, createdAt: new Date("2026-05-20T09:00:00Z") }],
      },
    });
    created.leads.push(lead._id);
    await LeadChatMessage.create({
      leadId: lead._id, authorId: author._id, kind: "message",
      body: `[Lead comms] ${TAG} misrouted comms note`,
    });
    // human quick note + the cockpit's auto stamp, both through the SAME
    // /note path (so the stamp also lands in the conversations + blob mirrors)
    await LeadLifecycleService.addNote(lead._id, `${TAG} typed quick note`, author._id);
    await LeadLifecycleService.addNote(lead._id, "Discovery call — result: Answered & available", author._id);

    const stream = await NoteStreamService.listNotes(lead._id);

    // ── the four kept sources all surface, authored + labelled ──
    ok(stream.some((n) => n.text === `${TAG} legacy pre-qual call note` && n.source === "pre-qual" && n.authorId === null),
      "conversations[] entry surfaces (pre-qual, honest null author)");
    ok(stream.some((n) => n.text === `${TAG} typed quick note` && n.authorName === `${TAG}-author` && n.source === "post-qual"),
      "commented quick note surfaces, authored");
    ok(stream.some((n) => n.text === `${TAG} misrouted comms note` && n.authorName === `${TAG}-author`),
      "[Lead comms] chat row surfaces, prefix-stripped + authored");
    ok(stream.some((n) => n.text === `${TAG} wants poolside mandap` && n.source === "qualifier"),
      "qualifierNotes surfaces as qualifier");
    ok(stream.some((n) => n.text === `${TAG} groom side decides decor` && n.source === "qualifier"),
      "additionalNotes surfaces as qualifier");
    ok(stream.every((n, i) => i === 0 || !n.at || !stream[i - 1].at || +new Date(stream[i - 1].at) >= +new Date(n.at)),
      "newest-first ordering holds");

    // ── exclusions ──
    ok(!stream.some((n) => n.text.startsWith("Discovery call — result:")),
      "the auto call-result stamp NEVER appears (event + all mirrors filtered)");
    // Blob ORPHANS surface as their own rows; mirror segments never do.
    const orphanRows = stream.filter((n) => n.text === ORPHAN);
    ok(orphanRows.length === 1, "the blob-only orphan surfaces exactly ONCE");
    ok(orphanRows[0] && orphanRows[0].authorId === null && orphanRows[0].authorName === null,
      "orphan row has null author (the blob never held authorship)");
    ok(orphanRows[0] && orphanRows[0].at && +orphanRows[0].at === +new Date("9 Jul 2026")
      && orphanRows[0].source === "post-qual",
      "'[9 Jul 2026] ' prefix parsed into the row's date (local midnight); source by date");
    ok(stream.filter((n) => n.text === `${TAG} typed quick note`).length === 1,
      "the addNote mirror segment inside the blob does NOT duplicate the note");
    ok(stream.length === 6, `the 5 typed notes + 1 orphan, nothing else (${stream.length})`);

    // the stamp is still IN the stores (read-time exclusion, no migration)
    const stampEvent = await LeadInternalEvent.findOne({ leadId: lead._id, type: "commented", "payload.text": /^Discovery call/ });
    ok(!!stampEvent, "the stamp still exists in its store (excluded at read, not deleted)");

    // ── the three blob cases: pure mirror / lone orphan / mixed ──
    const NoteStream = NoteStreamService;
    // pure-mirror blob → contributes NOTHING
    const pureLead = await Enquiry.create({
      name: `${TAG}-pure`, phone: `${TAG}-p2`, verified: false, isInterested: false, isLost: false,
      stage: "contacted", source: "Default", lostStatus: "none", assignedTo: author._id,
      updates: {
        notes: `[1 Jan 2026] ${TAG} mirrored alpha`,
        conversations: [{ text: `${TAG} mirrored alpha`, createdAt: new Date("2026-01-01T09:00:00Z") }],
      },
    });
    created.leads.push(pureLead._id);
    const pureStream = await NoteStream.listNotes(pureLead._id);
    ok(pureStream.length === 1 && pureStream[0].text === `${TAG} mirrored alpha`,
      "a pure-mirror blob contributes NOTHING (only the real note renders)");

    // lone undated orphan → exactly one row, undated, pre-qual, sorted LAST
    const loneLead = await Enquiry.create({
      name: `${TAG}-lone`, phone: `${TAG}-p3`, verified: false, isInterested: false, isLost: false,
      stage: "contacted", source: "Default", lostStatus: "none", assignedTo: author._id,
      updates: {
        notes: `${TAG} undated lone orphan`,
        conversations: [{ text: `${TAG} a dated real note`, createdAt: new Date("2026-05-01T09:00:00Z") }],
      },
    });
    created.leads.push(loneLead._id);
    const loneStream = await NoteStream.listNotes(loneLead._id);
    const lone = loneStream.filter((n) => n.text === `${TAG} undated lone orphan`);
    ok(lone.length === 1 && lone[0].at === null && lone[0].source === "pre-qual",
      "an unparseable-prefix orphan stays verbatim, undated, source pre-qual");
    ok(loneStream[loneStream.length - 1].text === `${TAG} undated lone orphan`,
      "undated orphan sorts LAST (below every dated note)");

    // mixed blob → only the orphan segment surfaces
    const mixedLead = await Enquiry.create({
      name: `${TAG}-mixed`, phone: `${TAG}-p4`, verified: false, isInterested: false, isLost: false,
      stage: "contacted", source: "Default", lostStatus: "none", assignedTo: author._id,
      updates: {
        notes: `[2 Jun 2026] ${TAG} mirrored beta\n\n[3 Jun 2026] ${TAG} mixed orphan gamma`,
        conversations: [{ text: `${TAG} mirrored beta`, createdAt: new Date("2026-06-02T09:00:00Z") }],
      },
    });
    created.leads.push(mixedLead._id);
    const mixedStream = await NoteStream.listNotes(mixedLead._id);
    ok(mixedStream.filter((n) => n.text === `${TAG} mirrored beta`).length === 1,
      "mixed blob: the mirror segment does not duplicate its note");
    const gamma = mixedStream.filter((n) => n.text === `${TAG} mixed orphan gamma`);
    ok(gamma.length === 1 && gamma[0].at && +gamma[0].at === +new Date("3 Jun 2026"),
      "mixed blob: ONLY the orphan segment surfaces, date parsed from its prefix");
    ok(mixedStream.length === 2, `mixed blob stream = real note + orphan only (${mixedStream.length})`);

    // ── blob-only orphan is also REPORTED by the census script ──
    const out = execFileSync("node", ["scripts/audit-notes-blob-orphans.js"], {
      cwd: `${__dirname}/..`, encoding: "utf8", timeout: 240000,
    });
    ok(out.includes(ORPHAN.slice(0, 60)), "the audit script reports the blob-only orphan text");
    ok(out.includes(String(lead._id)), "…attributed to the right lead");
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
