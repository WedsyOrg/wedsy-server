/**
 * COUPLE APP § 06.4 — AUTH AND MEMBERSHIP, AGAINST A REAL DATABASE.
 *
 * ⚠ NEEDS A DEV DATABASE. This test connects with process.env.DATABASE_URL and
 * writes real documents (all tagged and removed in the finally block). It was
 * NOT run when it was written — there is no MongoDB in the build container —
 * so treat it as unverified until someone runs it against a dev database.
 * NEVER point DATABASE_URL at production to run it (repo rule 7).
 *
 *   node tests/couple-auth-membership.int.test.js
 *
 * What it proves that the pure tests cannot: that weddingId really resolves to
 * an Event._id, that BOTH partners get in, that a SharedMember's row is found
 * and honoured, and that a signed-in stranger who guesses a wedding id is
 * refused with a 403 rather than being handed somebody's wedding.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const User = require("../models/User");
const Event = require("../models/Event");
const SharedMember = require("../models/SharedMember");
const { CoupleAuth, RequireSection, RequirePayout, resolveMembership } = require("../middlewares/coupleAuth");

const TAG = `coupleauth-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

// Minimal express stand-ins, the same shape tests/client-tasks.test.js uses.
const run = (middleware, { params = {}, headers = {}, couple } = {}) =>
  new Promise((resolve) => {
    let statusCode = 200, payload = null, nexted = false;
    const req = { params, headers, couple };
    const res = {
      status(c) { statusCode = c; return this; },
      send(p) { payload = p; resolve({ statusCode, payload, nexted, req }); return this; },
      json(p) { return this.send(p); },
    };
    Promise.resolve(middleware(req, res, () => { nexted = true; resolve({ statusCode, payload, nexted, req }); }));
  });

const bearer = (payload) => ({ authorization: `Bearer ${jwt.sign(payload, process.env.JWT_SECRET)}` });

const created = { users: [], events: [], members: [] };

(async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });

    const bride = await User.create({ name: `${TAG}-bride`, phone: `${TAG}-b` });
    const groom = await User.create({ name: `${TAG}-groom`, phone: `${TAG}-g` });
    const mother = await User.create({ name: `${TAG}-mother`, phone: `${TAG}-m` });
    const stranger = await User.create({ name: `${TAG}-stranger`, phone: `${TAG}-s` });
    created.users.push(bride._id, groom._id, mother._id, stranger._id);

    const event = await Event.create({
      user: bride._id,
      name: `${TAG} wedding`,
      brideName: "Ananya", groomName: "Karthik", eventDate: "2026-12-14",
      coupleApp: { partners: [{ user: bride._id, name: "Ananya", role: "bride" }, { user: groom._id, name: "Karthik", role: "groom" }] },
    });
    created.events.push(event._id);
    const weddingId = String(event._id);

    const member = await SharedMember.create({
      weddingId: event._id, user: mother._id, name: "Sunita Sharma", relation: "Bride's mother",
      acceptedAt: new Date(),
      access: { guests: "edit", website: "view", decor: "edit", registry: "view", payments: "none", tasks: "view" },
    });
    const pending = await SharedMember.create({
      weddingId: event._id, user: stranger._id, name: "Not yet in", relation: "Cousin", acceptedAt: null,
    });
    created.members.push(member._id, pending._id);

    console.log("weddingId resolves to an Event._id:");
    {
      const r = await resolveMembership(weddingId, bride._id);
      ok(r.ok === true, "the wedding resolves");
      eq(String(r.couple.event._id), weddingId, "…to the Event document itself");
      eq(r.couple.role, "partner", "and the account holder is a partner");
    }

    console.log("Both partners are full (§ 06.4):");
    {
      const b = await run(CoupleAuth, { params: { id: weddingId }, headers: bearer({ _id: String(bride._id) }) });
      ok(b.nexted, "the bride is let in");
      eq(b.req.couple.role, "partner", "as a partner");
      const g = await run(CoupleAuth, { params: { id: weddingId }, headers: bearer({ _id: String(groom._id) }) });
      ok(g.nexted, "the groom is let in — he is on coupleApp.partners, not Event.user");
      eq(g.req.couple.role, "partner", "as a partner too");
    }

    console.log("A shared member:");
    {
      const m = await run(CoupleAuth, { params: { id: weddingId }, headers: bearer({ _id: String(mother._id) }) });
      ok(m.nexted, "an accepted member is let in");
      eq(m.req.couple.role, "member", "as a member");
      const guests = await run(RequireSection("guests", "edit"), { couple: m.req.couple });
      ok(guests.nexted, "and may edit the guest list her access grants");
      const payments = await run(RequireSection("payments", "view"), { couple: m.req.couple });
      eq(payments.statusCode, 403, "but is refused payments — 403");
      eq(payments.payload.error, "forbidden", "with a body the client can render");
      eq(payments.payload.section, "payments", "naming the section");
      const payout = await run(RequirePayout, { couple: m.req.couple });
      eq(payout.statusCode, 403, "and cannot initiate a payout");
      eq(payout.payload.error, "forbidden_payout", "with the payout refusal");
    }

    console.log("A member with payments EDIT still cannot pay (§ 06.4):");
    {
      await SharedMember.updateOne({ _id: member._id }, { $set: { "access.payments": "edit" } });
      const m = await run(CoupleAuth, { params: { id: weddingId }, headers: bearer({ _id: String(mother._id) }) });
      const view = await run(RequireSection("payments", "edit"), { couple: m.req.couple });
      ok(view.nexted, "she may now annotate and reschedule payments");
      const payout = await run(RequirePayout, { couple: m.req.couple });
      eq(payout.statusCode, 403, "and STILL cannot move money");
    }

    console.log("Refusals:");
    {
      const invited = await run(CoupleAuth, { params: { id: weddingId }, headers: bearer({ _id: String(stranger._id) }) });
      eq(invited.statusCode, 403, "an invitation never accepted is refused — 403, not a wedding");
      const none = await run(CoupleAuth, { params: { id: weddingId } });
      eq(none.statusCode, 401, "no token is 401");
      const bad = await run(CoupleAuth, { params: { id: weddingId }, headers: { authorization: "Bearer nonsense" } });
      eq(bad.statusCode, 401, "a token that does not verify is 401");
      const admin = await run(CoupleAuth, { params: { id: weddingId }, headers: bearer({ _id: String(bride._id), isAdmin: true }) });
      eq(admin.statusCode, 401, "an ADMIN token is not a couple's session, even for a real id");
      const ghost = await run(CoupleAuth, { params: { id: String(new mongoose.Types.ObjectId()) }, headers: bearer({ _id: String(bride._id) }) });
      eq(ghost.statusCode, 404, "a wedding that does not exist is 404");
      const junk = await run(CoupleAuth, { params: { id: "not-an-id" }, headers: bearer({ _id: String(bride._id) }) });
      eq(junk.statusCode, 400, "a malformed id is 400, never a cast throw");
      const revoked = await SharedMember.findByIdAndUpdate(member._id, { $set: { revokedAt: new Date() } }, { new: true });
      const gone = await run(CoupleAuth, { params: { id: weddingId }, headers: bearer({ _id: String(revoked.user) }) });
      eq(gone.statusCode, 403, "a revoked member stops resolving immediately");
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (error) {
    console.error(error);
    fail += 1;
  } finally {
    await Promise.all([
      SharedMember.deleteMany({ _id: { $in: created.members } }),
      Event.deleteMany({ _id: { $in: created.events } }),
      User.deleteMany({ _id: { $in: created.users } }),
    ]).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
