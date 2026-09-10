/**
 * COUPLE APP § 04 — THE WEBSITE BUILDER, AGAINST A REAL DATABASE.
 *
 * ⚠ NEEDS A DEV DATABASE. This test connects with process.env.DATABASE_URL and
 * writes real documents (all tagged and removed in the finally block). It was
 * NOT run when it was written — there is no MongoDB in the build container and
 * none on the machine this milestone was built on — so treat it as unverified
 * until someone runs it against a dev database.
 * NEVER point DATABASE_URL at production to run it (repo rule 7).
 *
 *   node tests/couple-website-builder.int.test.js
 *
 * What it proves that the pure tests cannot:
 *   • that SLUG UNIQUENESS is the INDEX and not a read-then-write check — two
 *     weddings are made to want the same address and the second write is
 *     refused by mongo with E11000, which the endpoint turns into 409
 *     slug_taken. This is the assertion the whole design of applySettings
 *     rests on and it cannot be made without a real index;
 *   • that a wedding may hold an UNNAMED draft website — the sparse half of
 *     that index — and that many weddings may hold one at once;
 *   • that the stored `privacy.password` really is a bcrypt hash and really is
 *     `select: false`, so an ordinary find() cannot serialise it by accident;
 *   • that a THEME SWITCH leaves the stored `content` and `photos` documents
 *     byte-for-byte identical (§ 04.10), read back out of mongo rather than
 *     out of a return value;
 *   • that GET /wedding/:id/website CREATES the document on first read, and
 *     that reading it twice does not create two.
 *
 * POST /wedding/:id/website/photos is deliberately NOT exercised here: it
 * writes to S3, and a test that needs AWS credentials is a test nobody runs.
 * Point AWS_S3_ENDPOINT at a MinIO or an S3 stub (utils/s3Upload supports it,
 * and says why) to drive it by hand.
 */
require("dotenv").config();
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const User = require("../models/User");
const Event = require("../models/Event");
const Website = require("../models/Website");
const SharedMember = require("../models/SharedMember");
const ActivityLog = require("../models/ActivityLog");

const TAG = `couplesite-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const created = { users: [], events: [], members: [] };

/** The real app, mounted the way routes/router.js mounts it. */
const app = express();
app.use(express.json());
app.use("/wedding", require("../routes/coupleApp"));
app.use("/", require("../routes/coupleApp-website").itemRoutes);

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
  return { status: res.status, data, headers: res.headers };
};

(async () => {
  let server;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    // The unique index is the control being tested, so make sure it is built
    // before anything relies on it.
    await Website.syncIndexes();

    server = http.createServer(app).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;

    const bride = await User.create({ name: `${TAG}-bride`, phone: `${TAG}-b` });
    const other = await User.create({ name: `${TAG}-other`, phone: `${TAG}-o` });
    const cousin = await User.create({ name: `${TAG}-cousin`, phone: `${TAG}-c` });
    created.users.push(bride._id, other._id, cousin._id);

    const mine = await Event.create({
      user: bride._id, name: `${TAG} wedding`,
      brideName: "Ananya", groomName: "Vikram", eventDate: "2026-12-11",
      // name, date, time and venue are all required on an eventDay.
      eventDays: [
        { name: "Haldi", date: "2026-12-12", time: "10:00", venue: "Home, Jayanagar" },
        { name: "Wedding", date: "2026-12-14", time: "07:40", venue: "The Tamarind Tree" },
      ],
      coupleApp: { city: "Bengaluru", partners: [{ user: bride._id, name: "Ananya Sharma", role: "bride" }] },
    });
    const theirs = await Event.create({
      user: other._id, name: `${TAG} other wedding`,
      brideName: "Meera", groomName: "Rohan", eventDate: "2027-01-20",
      coupleApp: { partners: [{ user: other._id, name: "Meera Iyer", role: "bride" }] },
    });
    created.events.push(mine._id, theirs._id);
    const id = String(mine._id);
    const otherId = String(theirs._id);

    // A member who may LOOK at the website and not save it.
    const viewer = await SharedMember.create({
      weddingId: mine._id, user: cousin._id, name: "Priya Nair", relation: "Cousin",
      acceptedAt: new Date(),
      access: { guests: "none", website: "view", decor: "none", registry: "none", payments: "none", tasks: "none" },
    });
    created.members.push(viewer._id);

    const AS_BRIDE = token(bride._id);
    const AS_OTHER = token(other._id);
    const AS_VIEWER = token(cousin._id);

    console.log("GET /wedding/:id/website creates the document on first read:");
    {
      eq(await Website.countDocuments({ weddingId: mine._id }), 0, "no website exists yet");
      const res = await call("GET", `/wedding/${id}/website`, { as: AS_BRIDE });
      eq(res.status, 200, "200");
      eq(res.data.slug, "", "with NO slug — a draft has no public address until the couple chooses one");
      eq(res.data.themeId, "tp1", "the model's default theme");
      eq(res.data.privacy.passwordRequired, false, "no password");
      ok(!("password" in res.data.privacy), "and no password key at all");
      eq(await Website.countDocuments({ weddingId: mine._id }), 1, "one document was created");

      await call("GET", `/wedding/${id}/website`, { as: AS_BRIDE });
      eq(await Website.countDocuments({ weddingId: mine._id }), 1, "reading it twice does not create two");
    }

    console.log("TWO UNNAMED DRAFTS COEXIST — the sparse half of the unique index:");
    {
      await call("GET", `/wedding/${otherId}/website`, { as: AS_OTHER });
      eq(await Website.countDocuments({ slug: { $in: [null, undefined] } }) >= 2, true,
        "two weddings both hold a website with no slug, which a plain unique index would have refused");
    }

    console.log("PUT /wedding/:id/website — settings save:");
    {
      const res = await call("PUT", `/wedding/${id}/website`, {
        as: AS_BRIDE,
        body: { themeId: "tp4", paletteId: "p3", fontId: "f2", sections: { registry: true }, slug: "Ananya & Vikram" },
      });
      eq(res.status, 200, "200");
      eq(res.data.themeId, "tp4", "the theme");
      eq(res.data.slug, "ananya-vikram", "and the slug, normalised on the way in");
      const stored = await Website.findOne({ weddingId: mine._id }).lean();
      eq(stored.slug, "ananya-vikram", "stored normalised, so the public route resolves on the same string");
      eq(stored.sections.registry, true, "the switch landed");
      eq(stored.sections.cover, true, "and the switches it did not mention are untouched");
    }

    console.log("SLUG UNIQUENESS IS THE INDEX — the whole point of not read-then-writing:");
    {
      const clash = await call("PUT", `/wedding/${otherId}/website`, { as: AS_OTHER, body: { slug: "ananya-vikram" } });
      eq(clash.status, 409, "the second wedding is refused");
      eq(clash.data.error, "slug_taken", "…by name, so the screen can say so");
      const stored = await Website.findOne({ weddingId: theirs._id }).lean();
      ok(!stored.slug, "and nothing was written to the loser's document");

      // The couple keeping their own slug is not a clash with themselves.
      const same = await call("PUT", `/wedding/${id}/website`, { as: AS_BRIDE, body: { slug: "ananya-vikram" } });
      eq(same.status, 200, "re-saving your own address is not a clash");
    }

    console.log("GET /wedding/:id/website/slug/check:");
    {
      const taken = await call("GET", `/wedding/${otherId}/website/slug/check?slug=ananya-vikram`, { as: AS_OTHER });
      eq(taken.data.available, false, "an address another wedding holds reads as taken");
      eq(taken.data.reason, "taken", "…by name");
      const free = await call("GET", `/wedding/${otherId}/website/slug/check?slug=Meera and Rohan`, { as: AS_OTHER });
      eq(free.data.available, true, "a free one is free");
      eq(free.data.slug, "meera-and-rohan", "and comes back normalised, so the couple sees the real address");
      const reserved = await call("GET", `/wedding/${otherId}/website/slug/check?slug=registry`, { as: AS_OTHER });
      eq(reserved.data.available, false, "a route wedsy.in already answers on is not available");
      const mineAgain = await call("GET", `/wedding/${id}/website/slug/check?slug=ananya-vikram`, { as: AS_BRIDE });
      eq(mineAgain.data.available, true, "your own address is available to you");
      eq(mineAgain.data.reason, "yours", "…and says why");
    }

    console.log("§ 04.10 — A THEME SWITCH CARRIES THE COUPLE'S WORDS AND PHOTOGRAPHS:");
    {
      const content = { "cover.names": "Ananya & Vikram", "story.body": "We met in a queue for dosas." };
      const photos = { cover: "/uploads/cover.webp", "gallery-1": { url: "/uploads/g1.webp", mediaId: "m1" } };
      const saved = await call("PUT", `/wedding/${id}/website/content`, { as: AS_BRIDE, body: { content, photos } });
      eq(saved.status, 200, "the debounced save lands");

      const before = await Website.findOne({ weddingId: mine._id }).lean();
      const beforeJson = JSON.stringify({ content: before.content, photos: before.photos });

      const switched = await call("PUT", `/wedding/${id}/website`, { as: AS_BRIDE, body: { themeId: "tp6", paletteId: "p1", fontId: "f4" } });
      eq(switched.status, 200, "the theme switch lands");
      eq(switched.data.themeId, "tp6", "the theme changed");

      const after = await Website.findOne({ weddingId: mine._id }).lean();
      eq(JSON.stringify({ content: after.content, photos: after.photos }), beforeJson,
        "and the STORED content and photos are byte-for-byte what they were — keyed by blockId and slotId, never by theme");
      eq(after.content["story.body"], "We met in a queue for dosas.", "the words survive");
      eq(after.photos["gallery-1"].mediaId, "m1", "and the photographs keep their media ids");
    }

    console.log("The content envelope REPLACES, so clearing a photograph really clears it:");
    {
      await call("PUT", `/wedding/${id}/website/content`, {
        as: AS_BRIDE,
        body: { content: { "cover.names": "Ananya & Vikram" }, photos: { cover: "/uploads/cover.webp" } },
      });
      const stored = await Website.findOne({ weddingId: mine._id }).lean();
      eq(stored.photos["gallery-1"], undefined, "the slot the builder no longer holds is gone");
      eq(stored.content["story.body"], undefined, "and so is the block it no longer holds");
      eq(stored.photos.cover, "/uploads/cover.webp", "the ones it kept are kept");
    }

    console.log("THE PASSWORD IS A BCRYPT HASH, AND IS select: false:");
    {
      const res = await call("PUT", `/wedding/${id}/website`, { as: AS_BRIDE, body: { privacy: { password: "december" } } });
      eq(res.status, 200, "saved");
      eq(res.data.privacy.passwordRequired, true, "the couple is told a password is set");
      ok(JSON.stringify(res.data).indexOf("$2") === -1, "and is never given the hash back");

      const plain = await Website.findOne({ weddingId: mine._id }).lean();
      eq(plain.privacy.password, undefined, "an ORDINARY find() does not even load it — select: false");

      const withHash = await Website.findOne({ weddingId: mine._id }).select("+privacy.password").lean();
      ok(withHash.privacy.password.indexOf("$2") === 0, "the stored value is a bcrypt hash");
      ok(withHash.privacy.password.indexOf("december") === -1, "and not the password");
      ok(await bcrypt.compare("december", withHash.privacy.password), "which the real password verifies against");
      ok(!(await bcrypt.compare("november", withHash.privacy.password)), "and a wrong one does not");

      const cleared = await call("PUT", `/wedding/${id}/website`, { as: AS_BRIDE, body: { privacy: { password: "" } } });
      eq(cleared.data.privacy.passwordRequired, false, "an empty string removes the gate");
      const after = await Website.findOne({ weddingId: mine._id }).select("+privacy.password").lean();
      eq(after.privacy.password, "", "and the hash is really gone from the document");
    }

    console.log("POST /wedding/:id/website/publish:");
    {
      const res = await call("POST", `/wedding/${id}/website/publish`, { as: AS_BRIDE });
      eq(res.status, 200, "200");
      ok(res.data.publishedAt, "publishedAt is stamped");
      eq(res.data.alreadyPublished, false, "and it was the first time");
      const first = res.data.publishedAt;

      const again = await call("POST", `/wedding/${id}/website/publish`, { as: AS_BRIDE });
      eq(again.status, 200, "publishing twice is not an error");
      eq(again.data.alreadyPublished, true, "it says so");
      eq(again.data.publishedAt, first, "and the date does not move — the second answer equals the first");

      const logs = await ActivityLog.find({ entityType: "wedding", entityId: id, action: "website.published" }).lean();
      eq(logs.length, 1, "one Activity, not two");

      const noSlug = await call("POST", `/wedding/${otherId}/website/publish`, { as: AS_OTHER });
      eq(noSlug.status, 422, "a website with no address cannot be published");
      eq(noSlug.data.error, "no_slug", "…by name");
    }

    console.log("§ 06.4 — a member with website: view may look and may not save:");
    {
      eq((await call("GET", `/wedding/${id}/website`, { as: AS_VIEWER })).status, 200, "she can open the builder");
      eq((await call("GET", `/wedding/${id}/website/slug/check?slug=x-y-z`, { as: AS_VIEWER })).status, 200, "and check an address");

      const write = await call("PUT", `/wedding/${id}/website`, { as: AS_VIEWER, body: { themeId: "tp2" } });
      eq(write.status, 403, "and cannot save a setting");
      eq(write.data.section, "website", "the refusal names the section");
      eq(write.data.held, "view", "and what she holds");

      eq((await call("PUT", `/wedding/${id}/website/content`, { as: AS_VIEWER, body: { "cover.names": "x" } })).status, 403, "nor a word");
      eq((await call("POST", `/wedding/${id}/website/publish`, { as: AS_VIEWER })).status, 403, "nor publish it");

      const stored = await Website.findOne({ weddingId: mine._id }).lean();
      eq(stored.themeId, "tp6", "and nothing she tried actually changed");
    }

    console.log("A stranger is refused on the wedding itself:");
    {
      const stranger = token(other._id);
      eq((await call("GET", `/wedding/${id}/website`, { as: stranger })).status, 403, "403 on someone else's wedding");
      eq((await call("GET", `/wedding/${id}/website`)).status, 401, "and 401 with no token at all");
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (error) {
    console.error(error);
    fail += 1;
  } finally {
    await Promise.all([
      Website.deleteMany({ weddingId: { $in: created.events } }),
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
