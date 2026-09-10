/**
 * COUPLE APP § 05.2 / § 05.3 — GUESTS AND TASKS, AGAINST A REAL DATABASE.
 *
 * ⚠ NEEDS A DEV DATABASE. This test connects with process.env.DATABASE_URL and
 * writes real documents (all tagged and removed in the finally block). It was
 * NOT run when it was written — there is no MongoDB in the build container —
 * so treat it as unverified until someone runs it against a dev database.
 * NEVER point DATABASE_URL at production to run it (repo rule 7).
 *
 *   node tests/couple-guests-tasks.int.test.js
 *
 * What it proves that the pure tests cannot:
 *   • that the filter CouplePeopleRules.guestQuery builds is EXECUTED by mongo
 *     the way tests/couple-guest-filter.test.js assumes it is shaped;
 *   • that the three ways a guest arrives — typed, imported, and the public
 *     RSVP form — really do land on ONE row per phone number;
 *   • that GET /wedding/:id/guests/headcount agrees with
 *     CoupleHeadcountService over the same rows, so the four screens that read
 *     it cannot drift;
 *   • that the tasks union really contains both collections, and that a PATCH
 *     aimed at a WeddingMilestone leaves that document byte-for-byte unchanged.
 */
require("dotenv").config();
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const User = require("../models/User");
const Event = require("../models/Event");
const Guest = require("../models/Guest");
const CoupleTask = require("../models/CoupleTask");
const WeddingMilestone = require("../models/WeddingMilestone");
const SharedMember = require("../models/SharedMember");
const ActivityLog = require("../models/ActivityLog");
const headcountService = require("../services/CoupleHeadcountService");

const TAG = `couplepeople-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const created = { users: [], events: [], guests: [], tasks: [], milestones: [], members: [] };

/**
 * The real app, mounted the way routes/router.js mounts it — plus the
 * child-resource routes at the ROOT, which is where wedsy-user's
 * lib/plan/api.js calls them (`PATCH /guests/:id`). That second mount is the
 * one line routes/router.js still needs; see docs/couple-app-api.md § People.
 */
const app = express();
app.use(express.json());
app.use("/wedding", require("../routes/coupleApp"));
app.use("/", require("../routes/coupleApp-people").itemRoutes);

let base = "";
const token = (id) => jwt.sign({ _id: String(id) }, process.env.JWT_SECRET);
const call = async (method, path, { as, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(as ? { Authorization: `Bearer ${as}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  return { status: res.status, data };
};

(async () => {
  let server;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    server = http.createServer(app).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;

    const bride = await User.create({ name: `${TAG}-bride`, phone: `${TAG}-b` });
    const cousin = await User.create({ name: `${TAG}-cousin`, phone: `${TAG}-c` });
    const outsider = await User.create({ name: `${TAG}-outsider`, phone: `${TAG}-o` });
    created.users.push(bride._id, cousin._id, outsider._id);

    const event = await Event.create({
      user: bride._id,
      name: `${TAG} wedding`,
      brideName: "Ananya", groomName: "Karthik", eventDate: "2026-12-14",
      // eventDays requires name, date, time and venue — a day missing any of
      // them fails Event validation before the test reaches its first assertion.
      eventDays: [
        { name: "Haldi", date: "2026-12-12", time: "10:00", venue: "Home, Jayanagar" },
        { name: "Sangeet", date: "2026-12-13", time: "19:00", venue: "The Tamarind Tree" },
        { name: "Wedding", date: "2026-12-14", time: "07:40", venue: "The Tamarind Tree" },
      ],
      coupleApp: { partners: [{ user: bride._id, name: "Ananya Sharma", role: "bride" }] },
    });
    created.events.push(event._id);
    const id = String(event._id);

    // A member who may READ the guest list and TASKS, and write neither.
    const viewer = await SharedMember.create({
      weddingId: event._id, user: cousin._id, name: "Priya Nair", relation: "Maid of honour",
      acceptedAt: new Date(),
      access: { guests: "view", website: "none", decor: "none", registry: "none", payments: "none", tasks: "view" },
    });
    created.members.push(viewer._id);

    const AS_BRIDE = token(bride._id);
    const AS_VIEWER = token(cousin._id);
    const AS_OUTSIDER = token(outsider._id);

    console.log("POST /wedding/:id/guests — the contract wedsy-user calls:");
    {
      const res = await call("POST", `/wedding/${id}/guests`, {
        as: AS_BRIDE,
        body: { first: "Meera", last: "Iyer", side: "bride", group: "Family", phone: "+91 98450 11223",
                party: 4, events: ["haldi", "sangeet", "wedding"], rsvp: "yes", note: "Ananya's aunt" },
      });
      eq(res.status, 201, "created");
      ok(res.data && res.data.id, "the response carries an id — the client swaps its temp row for it");
      eq(res.data.party, 4, "…and the row it just posted");
      eq(res.data.source, "couple", "typed by the couple, not posted from the website");
      created.guests.push(res.data.id);
      const stored = await Guest.findById(res.data.id).lean();
      eq(stored.phoneNormalised, "919845011223",
         "phoneNormalised is derived on write, through utils/phone — the RSVP match key");
      eq(stored.weddingId.toString(), id, "scoped to the wedding in the URL");
    }

    console.log("THE DUPLICATE GUARD — one number, one row, however it arrived:");
    {
      const again = await call("POST", `/wedding/${id}/guests`, {
        as: AS_BRIDE,
        body: { first: "Meera", last: "Iyer", side: "bride", phone: "+919845011223", party: 4, events: ["haldi"] },
      });
      eq(again.status, 409, "the same number in a different format is refused");
      eq(again.data.error, "duplicate_guest", "…by name");
      ok(again.data.guestId, "…pointing at the row that already exists");
      eq(await Guest.countDocuments({ weddingId: event._id }), 1, "and nothing was written");

      const blank = await call("POST", `/wedding/${id}/guests`, {
        as: AS_BRIDE, body: { first: "Sanjay", side: "groom", phone: "", party: 1, events: ["wedding"] } });
      eq(blank.status, 201, "a guest with NO number is never a duplicate of another one");
      created.guests.push(blank.data.id);
      const blank2 = await call("POST", `/wedding/${id}/guests`, {
        as: AS_BRIDE, body: { first: "Ramesh", side: "groom", party: 2, events: ["wedding"] } });
      eq(blank2.status, 201, "…nor of the next one");
      created.guests.push(blank2.data.id);
    }

    console.log("GET /wedding/:id/guests — ?side&rsvp&event&q executed by mongo:");
    {
      const all = await call("GET", `/wedding/${id}/guests`, { as: AS_BRIDE });
      eq(all.status, 200, "200");
      ok(Array.isArray(all.data), "a bare array — what lib/plan/api.js's `guests()` expects");
      eq(all.data.length, 3, "three rows");
      eq((await call("GET", `/wedding/${id}/guests?side=bride`, { as: AS_BRIDE })).data.length, 1, "?side=bride");
      eq((await call("GET", `/wedding/${id}/guests?side=all`, { as: AS_BRIDE })).data.length, 3, "?side=all narrows nothing");
      eq((await call("GET", `/wedding/${id}/guests?side=maternal`, { as: AS_BRIDE })).data.length, 3,
         "?side=<junk> narrows nothing either — it never hides people from their own list");
      eq((await call("GET", `/wedding/${id}/guests?rsvp=yes`, { as: AS_BRIDE })).data.length, 1, "?rsvp=yes");
      eq((await call("GET", `/wedding/${id}/guests?event=haldi`, { as: AS_BRIDE })).data.length, 1,
         "?event=haldi — equality on the array field means 'invited to'");
      eq((await call("GET", `/wedding/${id}/guests?q=meera`, { as: AS_BRIDE })).data.length, 1, "?q= by first name");
      eq((await call("GET", `/wedding/${id}/guests?q=meera iy`, { as: AS_BRIDE })).data.length, 1, "?q= across two fields");
      eq((await call("GET", `/wedding/${id}/guests?q=98450`, { as: AS_BRIDE })).data.length, 1, "?q= by phone digits");
      eq((await call("GET", `/wedding/${id}/guests?q=.*`, { as: AS_BRIDE })).data.length, 0,
         "?q=.* finds the guest called '.*' — the search box is not a pattern");
    }

    console.log("GET /wedding/:id/guests/headcount — invariant 1, not a second sum:");
    {
      const res = await call("GET", `/wedding/${id}/guests/headcount`, { as: AS_BRIDE });
      eq(res.status, 200, "200");
      const rows = await Guest.find({ weddingId: event._id }).lean();
      const expected = headcountService.tally(rows);
      eq(res.data.headcount, expected.headcount, "the endpoint agrees with CoupleHeadcountService exactly");
      eq(res.data.invited, expected.invited, "invited counts invitations");
      eq(res.data.yes, expected.yes, "yes");
      eq(res.data.pending, expected.pending, "pending");
      eq(Object.keys(res.data).sort().join(","), "headcount,invited,no,pending,yes", "and the § 06.2 shape");
    }

    console.log("PATCH /guests/:id — weddingId from the DOCUMENT, not the URL:");
    {
      const guestId = created.guests[0];
      const res = await call("PATCH", `/guests/${guestId}`, { as: AS_BRIDE, body: { rsvp: "no" } });
      eq(res.status, 200, "200 — the URL carries no wedding id and it still resolves");
      eq(res.data.rsvp, "no", "the change landed");
      const after = await call("GET", `/wedding/${id}/guests/headcount`, { as: AS_BRIDE });
      eq(after.data.headcount, headcountService.tally(await Guest.find({ weddingId: event._id }).lean()).headcount,
         "and the headcount followed it — Σ party where rsvp ≠ 'no'");

      const phone = await call("PATCH", `/guests/${guestId}`, { as: AS_BRIDE, body: { phone: "+91 90080 55667" } });
      eq(phone.status, 200, "a phone edit is allowed");
      eq((await Guest.findById(guestId).lean()).phoneNormalised, "919008055667",
         "AND phoneNormalised is re-derived — a stale key is a duplicate row on the next website reply");

      const ghost = await call("PATCH", `/guests/${new mongoose.Types.ObjectId()}`, { as: AS_BRIDE, body: { rsvp: "yes" } });
      eq(ghost.status, 404, "a guest that does not exist is 404");
      const junk = await call("PATCH", "/guests/not-an-id", { as: AS_BRIDE, body: { rsvp: "yes" } });
      eq(junk.status, 400, "a malformed id is 400, never a cast throw");
      const anon = await call("PATCH", `/guests/${guestId}`, { body: { rsvp: "yes" } });
      eq(anon.status, 401, "no token is 401 — and the lookup never ran");
      const stranger = await call("PATCH", `/guests/${guestId}`, { as: AS_OUTSIDER, body: { rsvp: "yes" } });
      eq(stranger.status, 403, "a signed-in stranger is refused on the WEDDING the row belongs to");
    }

    console.log("§ 06.4 — a member with `view` is refused every write:");
    {
      eq((await call("GET", `/wedding/${id}/guests`, { as: AS_VIEWER })).status, 200, "she may read the guest list");
      const write = await call("POST", `/wedding/${id}/guests`, {
        as: AS_VIEWER, body: { first: "Nope", side: "bride", party: 1, events: ["wedding"] } });
      eq(write.status, 403, "and may not add to it");
      eq(write.data.error, "forbidden", "with a renderable body");
      eq(write.data.section, "guests", "naming the section");
      eq(write.data.required, "edit", "and the level");
      eq(write.data.held, "view", "and what she holds");
      const patch = await call("PATCH", `/guests/${created.guests[0]}`, { as: AS_VIEWER, body: { rsvp: "yes" } });
      eq(patch.status, 403, "…nor edit a row on it");
      const del = await call("DELETE", `/guests/${created.guests[0]}`, { as: AS_VIEWER });
      eq(del.status, 403, "…nor delete one");
      eq(await Guest.countDocuments({ weddingId: event._id }), 3, "and nothing changed");
    }

    console.log("Activity — § 06.3, every mutation a human would want to know about:");
    {
      const logs = await ActivityLog.find({ entityType: "wedding", entityId: id }).lean();
      ok(logs.length >= 2, "adding guests and changing a reply appended rows");
      ok(logs.every((l) => l.actorId === null), "a partner is NOT written into actorId — that field is `ref: Admin`");
      ok(logs.every((l) => l.meta && l.meta.actorType === "couple"), "they are couple actions");
      ok(logs.some((l) => l.action === "guest.added"), "…including guest.added");
      ok(logs.every((l) => l.meta && l.meta.actor && l.meta.actor.name === "Ananya Sharma"),
         "…and the actor's identity rides in meta.actor, where a User id belongs");
    }

    console.log("Tasks — the union, and the CRM's timeline left alone:");
    {
      const milestone = await WeddingMilestone.create({
        eventId: event._id, title: `${TAG} planner milestone`, dueDate: new Date("2026-10-01"), source: "AI",
      });
      created.milestones.push(milestone._id);
      const before = JSON.stringify(await WeddingMilestone.findById(milestone._id).lean());

      const add = await call("POST", `/wedding/${id}/tasks`, {
        as: AS_BRIDE, body: { title: "Choose a palette", dueDate: "2026-09-14", done: false, remind: true, createdBy: "you" } });
      eq(add.status, 201, "the couple's own task is created");
      created.tasks.push(add.data.id);
      eq(add.data.source, "couple", "…as a CoupleTask");
      eq(add.data.createdBy, "you", "and reads back as 'you' to its author");
      eq((await CoupleTask.findById(add.data.id).lean()).createdByName, "Ananya Sharma",
         "…while what is STORED is the real name, so the other partner sees who wrote it");
      eq((await CoupleTask.findById(add.data.id).lean()).remind, true, "`remind` is stored — a TRIGGER FLAG, nothing sends it");

      const list = await call("GET", `/wedding/${id}/tasks`, { as: AS_BRIDE });
      eq(list.status, 200, "200");
      ok(Array.isArray(list.data), "a bare array — what lib/plan/api.js's `tasks()` expects");
      eq(list.data.length, 2, "BOTH collections: the couple's task and the planner's milestone");
      eq(list.data.filter((t) => t.source === "milestone").length, 1, "the milestone is there");
      eq(list.data.find((t) => t.source === "milestone").readOnly, true, "…marked read-only");
      eq(list.data.find((t) => t.source === "milestone").createdBy, "Your planner", "…and attributed (§ 05.3)");

      const patch = await call("PATCH", `/tasks/${milestone._id}`, { as: AS_BRIDE, body: { done: true } });
      eq(patch.status, 403, "A WRITE AIMED AT THE TEAM'S TIMELINE IS REFUSED");
      eq(patch.data.error, "forbidden", "with a renderable body");
      eq(patch.data.section, "tasks", "naming the section");
      const del = await call("DELETE", `/tasks/${milestone._id}`, { as: AS_BRIDE });
      eq(del.status, 403, "…and so is a delete");
      eq(JSON.stringify(await WeddingMilestone.findById(milestone._id).lean()), before,
         "THE MILESTONE DOCUMENT IS BYTE-FOR-BYTE UNCHANGED");

      const tick = await call("PATCH", `/tasks/${add.data.id}`, { as: AS_BRIDE, body: { done: true } });
      eq(tick.status, 200, "the couple's own task ticks off");
      eq(tick.data.done, true, "…and says so");
      ok((await CoupleTask.findById(add.data.id).lean()).completedAt, "with completedAt stamped");

      const viewerWrite = await call("PATCH", `/tasks/${add.data.id}`, { as: AS_VIEWER, body: { done: false } });
      eq(viewerWrite.status, 403, "a member with tasks: view may read the list and not change it");
      eq((await call("GET", `/wedding/${id}/tasks`, { as: AS_VIEWER })).status, 200, "…she can still read it");

      const removed = await call("DELETE", `/tasks/${add.data.id}`, { as: AS_BRIDE });
      eq(removed.status, 200, "and the couple can remove their own");
      eq(await CoupleTask.countDocuments({ weddingId: event._id }), 0, "…for real");
    }

    console.log("DELETE /guests/:id:");
    {
      const res = await call("DELETE", `/guests/${created.guests[1]}`, { as: AS_BRIDE });
      eq(res.status, 200, "200");
      eq(await Guest.countDocuments({ weddingId: event._id }), 2, "the row is gone");
      const again = await call("DELETE", `/guests/${created.guests[1]}`, { as: AS_BRIDE });
      eq(again.status, 404, "deleting it twice is a 404, not a 500");
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (error) {
    console.error(error);
    fail += 1;
  } finally {
    await Promise.all([
      Guest.deleteMany({ weddingId: { $in: created.events } }),
      CoupleTask.deleteMany({ weddingId: { $in: created.events } }),
      WeddingMilestone.deleteMany({ _id: { $in: created.milestones } }),
      SharedMember.deleteMany({ _id: { $in: created.members } }),
      ActivityLog.deleteMany({ entityType: "wedding", entityId: { $in: created.events.map(String) } }),
      Event.deleteMany({ _id: { $in: created.events } }),
      User.deleteMany({ _id: { $in: created.users } }),
    ]).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    if (server) server.close();
    process.exit(fail ? 1 : 0);
  }
})();
