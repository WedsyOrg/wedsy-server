/**
 * COUPLE APP § 05.5 / § 06.4 — FAMILY SHARING, AGAINST A REAL DATABASE.
 *
 * ⚠ NEEDS A DEV DATABASE. This test connects with process.env.DATABASE_URL and
 * writes real documents (all tagged and removed in the finally block). It was
 * NOT run when it was written — there is no MongoDB in the build container —
 * so treat it as unverified until someone runs it against a dev database.
 * NEVER point DATABASE_URL at production to run it (repo rule 7).
 *
 *   node tests/couple-members-sharing.int.test.js
 *
 * What it proves that the pure tests cannot: THE WHOLE LOOP. A partner grants
 * a relative two sections; that relative's own token is then let into exactly
 * those two and refused the rest; the partner narrows the map and the refusal
 * follows on the very next request; the partner revokes them and they stop
 * resolving at all — with the row still there, so the Activity feed does not
 * develop holes.
 */
require("dotenv").config();
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const User = require("../models/User");
const Event = require("../models/Event");
const SharedMember = require("../models/SharedMember");
const ActivityLog = require("../models/ActivityLog");
const { RELATIONS } = require("../utils/coupleEnums");

const TAG = `couplemembers-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const created = { users: [], events: [], members: [] };

const app = express();
app.use(express.json());
app.use("/wedding", require("../routes/coupleApp"));
// The client's own paths (`PATCH /members/:id`). See docs/couple-app-api.md § People.
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
    const groom = await User.create({ name: `${TAG}-groom`, phone: `${TAG}-g` });
    const mother = await User.create({ name: `${TAG}-mother`, phone: `${TAG}-m` });
    created.users.push(bride._id, groom._id, mother._id);

    const event = await Event.create({
      user: bride._id, name: `${TAG} wedding`,
      brideName: "Ananya", groomName: "Karthik", eventDate: "2026-12-14",
      coupleApp: { partners: [
        { user: bride._id, name: "Ananya Sharma", role: "bride" },
        { user: groom._id, name: "Karthik Reddy", role: "groom" },
      ] },
    });
    created.events.push(event._id);
    const id = String(event._id);

    const AS_BRIDE = token(bride._id);
    const AS_GROOM = token(groom._id);
    const AS_MOTHER = token(mother._id);

    console.log("POST /wedding/:id/members — the § 05.5 invite form:");
    {
      const res = await call("POST", `/wedding/${id}/members`, {
        as: AS_BRIDE,
        body: { name: "Sunita Sharma", relation: "Bride's mother",
                access: { guests: "edit", website: "view", decor: "none", registry: "none", payments: "none", tasks: "view" } },
      });
      eq(res.status, 201, "created");
      created.members.push(res.data.id);
      eq(res.data.name, "Sunita Sharma", "the row the screen renders");
      eq(res.data.relation, "Bride's mother", "one of the seventeen");
      eq(res.data.acceptedAt, null, "'Not shared with them yet' until they open the invite");
      eq(Object.keys(res.data.access).length, 6, "six sections, exactly");
      eq(res.data.inviteTokenHash, undefined, "the invite credential never crosses the wire");

      const bad = await call("POST", `/wedding/${id}/members`, {
        as: AS_BRIDE, body: { name: "Neighbour Bob", relation: "Neighbour", access: {} } });
      eq(bad.status, 422, "a relation outside the seventeen is refused");
      eq(bad.data.error, "validation", "…as a validation error");
      ok(bad.data.fields && bad.data.fields.relation, "…naming the field, so the form can point at it");

      const nameless = await call("POST", `/wedding/${id}/members`, { as: AS_BRIDE, body: { relation: "Cousin" } });
      eq(nameless.status, 422, "a member with no name is refused");

      const defaults = await call("POST", `/wedding/${id}/members`, { as: AS_BRIDE, body: { name: "Vikram Reddy", relation: "Groom's brother" } });
      eq(defaults.status, 201, "an invitation with no access map is allowed");
      created.members.push(defaults.data.id);
      eq(defaults.data.access.guests, "view", "…and gets the § 05.5 default: guest list at View");
      eq(Object.values(defaults.data.access).filter((l) => l !== "none").length, 1, "…everything else None");

      const sneaky = await call("POST", `/wedding/${id}/members`, {
        as: AS_BRIDE,
        body: { name: "Ambitious Cousin", relation: "Cousin",
                access: { guests: "edit", website: "edit", decor: "edit", registry: "edit", payments: "edit", tasks: "edit", payouts: "edit", members: "edit" } },
      });
      eq(sneaky.status, 201, "a map with a seventh key is not an error…");
      created.members.push(sneaky.data.id);
      eq(sneaky.data.access.payouts, undefined, "…the key simply has nowhere to go");
      const storedAccess = (await SharedMember.findById(sneaky.data.id).lean()).access;
      eq(Object.keys(storedAccess).length, 6, "and the STORED document has six keys too");
      eq(storedAccess.payouts, undefined, "…with no seventh anywhere in it");
    }

    console.log("GET /wedding/:id/members:");
    {
      const res = await call("GET", `/wedding/${id}/members`, { as: AS_BRIDE });
      eq(res.status, 200, "200");
      ok(Array.isArray(res.data), "a bare array — what lib/plan/api.js's `members()` expects");
      eq(res.data.length, 3, "the three who were invited");
      ok(res.data.every((m) => m.inviteTokenHash === undefined && m.user === undefined),
         "no internals: not the credential, not the account it will bind to");
      eq((await call("GET", `/wedding/${id}/members`, { as: AS_GROOM })).status, 200,
         "BOTH partners manage sharing — neither is more equal (§ 06.4)");
    }

    console.log("THE LOOP — a granted section is a door that really opens:");
    {
      // The invite has no accept endpoint in this milestone, so the binding a
      // real invite link would do is done here directly.
      await SharedMember.updateOne({ _id: created.members[0] }, { $set: { user: mother._id, acceptedAt: new Date() } });

      eq((await call("GET", `/wedding/${id}/guests`, { as: AS_MOTHER })).status, 200, "guests: edit — she can read");
      const write = await call("POST", `/wedding/${id}/guests`, {
        as: AS_MOTHER, body: { first: "Lakshmi", side: "bride", party: 3, events: [] } });
      eq(write.status, 201, "…and write");
      eq((await call("GET", `/wedding/${id}/tasks`, { as: AS_MOTHER })).status, 200, "tasks: view — she can read");
      const task = await call("POST", `/wedding/${id}/tasks`, { as: AS_MOTHER, body: { title: "nope" } });
      eq(task.status, 403, "…and not write");
      eq(task.data.held, "view", "…told exactly what she holds");
    }

    console.log("MEMBERS MANAGEMENT IS PARTNER-ONLY — structurally:");
    {
      await SharedMember.updateOne({ _id: created.members[0] }, {
        $set: { access: { guests: "edit", website: "edit", decor: "edit", registry: "edit", payments: "edit", tasks: "edit" } },
      });
      const read = await call("GET", `/wedding/${id}/members`, { as: AS_MOTHER });
      eq(read.status, 403, "all six sections at edit, and she still cannot see who else is in");
      eq(read.data.error, "forbidden", "the foundation's refusal shape");
      eq(read.data.section, "members", "naming members management");
      eq(read.data.required, "partner", "…and that only a partner holds it");
      const invite = await call("POST", `/wedding/${id}/members`, {
        as: AS_MOTHER, body: { name: "A friend of mine", relation: "Friend" } });
      eq(invite.status, 403, "she cannot invite anybody");
      const escalate = await call("PATCH", `/members/${created.members[0]}`, {
        as: AS_MOTHER, body: { access: { guests: "edit", website: "edit", decor: "edit", registry: "edit", payments: "edit", tasks: "edit" } } });
      eq(escalate.status, 403, "she cannot edit her own access map");
      const revenge = await call("DELETE", `/members/${created.members[1]}`, { as: AS_MOTHER });
      eq(revenge.status, 403, "and she cannot revoke anybody else");
      eq(await SharedMember.countDocuments({ weddingId: event._id, revokedAt: null }), 3, "nothing moved");
    }

    console.log("PATCH /members/:id — narrowing takes effect on the NEXT request:");
    {
      const res = await call("PATCH", `/members/${created.members[0]}`, {
        as: AS_BRIDE,
        body: { name: "Sunita Sharma", relation: "Bride's mother",
                access: { guests: "view", website: "none", decor: "none", registry: "none", payments: "none", tasks: "none" } },
      });
      eq(res.status, 200, "200");
      eq(res.data.access.guests, "view", "narrowed to view");
      eq((await call("GET", `/wedding/${id}/guests`, { as: AS_MOTHER })).status, 200, "she can still read the list");
      const write = await call("POST", `/wedding/${id}/guests`, {
        as: AS_MOTHER, body: { first: "Nope", side: "bride", party: 1, events: [] } });
      eq(write.status, 403, "and can no longer add to it — immediately, not at her next sign-in");
      eq((await call("GET", `/wedding/${id}/tasks`, { as: AS_MOTHER })).status, 403, "tasks closed behind her too");
    }

    console.log("DELETE /members/:id — revoke, never a hard delete:");
    {
      const res = await call("DELETE", `/members/${created.members[0]}`, { as: AS_BRIDE });
      eq(res.status, 200, "200");
      const row = await SharedMember.findById(created.members[0]).lean();
      ok(row, "THE ROW IS STILL THERE — her Activity rows still name her");
      ok(row.revokedAt, "…stamped revoked");
      eq((await call("GET", `/wedding/${id}/guests`, { as: AS_MOTHER })).status, 403,
         "and she stops resolving on the wedding at all, immediately");
      const list = await call("GET", `/wedding/${id}/members`, { as: AS_BRIDE });
      eq(list.data.length, 2, "she is off the couple's list");
      const again = await call("PATCH", `/members/${created.members[0]}`, { as: AS_BRIDE, body: { name: "Back please" } });
      eq(again.status, 404, "a revoked member cannot be edited back in through the patch");
    }

    console.log("Activity — § 06.3:");
    {
      const logs = await ActivityLog.find({ entityType: "wedding", entityId: id }).lean();
      ok(logs.some((l) => l.action === "member.invited"), "inviting somebody is in the feed");
      ok(logs.some((l) => l.action === "member.access"), "so is changing what they can see");
      ok(logs.some((l) => l.action === "member.removed"), "so is removing them");
      ok(logs.every((l) => l.actorId === null), "a partner is never written into actorId — that field is `ref: Admin`");
    }

    console.log("The relation presets are the shared contract:");
    {
      eq(RELATIONS.length, 17, "seventeen, the same seventeen wedsy-user's lib/plan/seed/members.js renders");
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (error) {
    console.error(error);
    fail += 1;
  } finally {
    await Promise.all([
      SharedMember.deleteMany({ weddingId: { $in: created.events } }),
      ActivityLog.deleteMany({ entityType: "wedding", entityId: { $in: created.events.map(String) } }),
      require("../models/Guest").deleteMany({ weddingId: { $in: created.events } }),
      require("../models/CoupleTask").deleteMany({ weddingId: { $in: created.events } }),
      Event.deleteMany({ _id: { $in: created.events } }),
      User.deleteMany({ _id: { $in: created.users } }),
    ]).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    if (server) server.close();
    process.exit(fail ? 1 : 0);
  }
})();
