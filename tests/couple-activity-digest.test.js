// COUPLE APP § 06.3 — THE ACTIVITY FEED. Run: node tests/couple-activity-digest.test.js
// PURE unit tests (NO DATABASE). Home's "While you were away" is a query on
// ActivityLog filtered by `!readBy.includes(me)`. This asserts the mapping onto
// the existing model — in particular that a partner's or a guest's id NEVER
// lands in ActivityLog.actorId, which is `ref: "Admin"` and would populate to
// nothing.
const a = require("../services/CoupleActivityService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

console.log("Building a log row:");
{
  const team = a.buildLog({ weddingId: "w1", actorType: "team", actor: { adminId: "adm1", name: "Ravi Menon", avatar: "/x.webp" }, action: "venue.shortlisted", summary: "shortlisted 5 venues for 14 December" });
  eq(team.entityType, "wedding", "scoped as a wedding row");
  eq(team.entityId, "w1", "on this wedding");
  eq(team.actorId, "adm1", "a TEAM actor is an Admin and belongs in actorId");
  eq(team.meta.actorType, "team", "and is typed");

  const couple = a.buildLog({ weddingId: "w1", actorType: "couple", actor: { id: "u2", name: "Karthik Reddy" }, action: "guest.added", summary: "added 12 names to the guest list" });
  eq(couple.actorId, null, "a PARTNER is not an Admin — actorId stays null rather than becoming a ref that resolves to nothing");
  eq(couple.meta.actor.id, "u2", "their identity rides in meta");
  eq(couple.meta.actor.name, "Karthik Reddy", "with their name for the card");

  const guest = a.buildLog({ weddingId: "w1", actorType: "guest", actor: { name: "Meera Iyer" }, action: "guest.rsvp", summary: "replied yes for 4 people" });
  eq(guest.actorId, null, "nor is a guest");
  eq(guest.meta.readBy.length, 0, "a new row is unread by everyone");

  eq(a.buildLog({ weddingId: "w1", actorType: "pirate", action: "x" }).meta.actorType, "system", "an unrecognised actor type falls back to system rather than being stored");
}

console.log("The digest:");
{
  const logs = [
    { _id: "a1", summary: "shortlisted 5 venues", createdAt: "2026-09-08", meta: { actorType: "team", actor: { id: "t1", name: "Ravi Menon", avatar: "/r.webp" }, readBy: [] } },
    { _id: "a2", summary: "priced your mandap", createdAt: "2026-09-07", meta: { actorType: "team", actor: { id: "t2", name: "Meera Nair" }, readBy: ["u1"] } },
    { _id: "a3", summary: "added 12 names", createdAt: "2026-09-07", meta: { actorType: "couple", actor: { id: "u2", name: "Karthik Reddy" }, readBy: [] } },
    { _id: "a4", summary: "confirmed your trial", createdAt: "2026-09-05", meta: { actorType: "team", actor: { id: "t3", name: "Aisha Khan" }, readBy: ["u1", "u2"] } },
    { _id: "a5", summary: "older still", createdAt: "2026-09-01", meta: { actorType: "team", actor: {}, readBy: [] } },
  ];
  const digest = a.toDigest(logs, "u1");
  eq(digest.length, 4, "§ 03.1 — the most recent four");
  eq(digest[0].actorName, "Ravi Menon", "shaped for the card");
  eq(digest[0].actorType, "team", "with the actor type the avatar reads");
  ok(digest[0].unread === true, "unseen rows are unread");
  ok(digest[1].unread === false, "a row this viewer has seen is not");
  ok(digest[3].unread === false, "…and readBy is per person, not global");

  const other = a.toDigest(logs, "u2");
  ok(other[1].unread === true, "the other partner has NOT seen a2 — the feed is per person");
  eq(a.unreadCount(logs, "u1"), 3, "the bell's dot counts every unread row, not just the four shown");
  eq(a.unreadCount(logs, "u2"), 4, "and a different viewer has a different count — u2 has only seen a4");
  eq(a.toDigest([], "u1").length, 0, "an empty feed is empty");
  eq(a.toDigest(null, "u1").length, 0, "a missing feed is empty, not a throw");
  ok(a.toDigest(logs, "")[1].unread === true, "with no viewer, everything reads as unread rather than as seen");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
