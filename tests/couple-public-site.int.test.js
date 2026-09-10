/**
 * COUPLE APP § 06.2 / § 06.4 — THE PUBLIC SITE, ITS GATE AND ITS RSVP,
 * AGAINST A REAL DATABASE AND OVER REAL HTTP.
 *
 * ⚠ NEEDS A DEV DATABASE. This test connects with process.env.DATABASE_URL and
 * writes real documents (all tagged and removed in the finally block). It was
 * NOT run when it was written — there is no MongoDB in the build container and
 * none on the machine this milestone was built on — so treat it as unverified
 * until someone runs it against a dev database.
 * NEVER point DATABASE_URL at production to run it (repo rule 7).
 *
 *   node tests/couple-public-site.int.test.js
 *
 * What it proves that the pure tests cannot:
 *   • THE WITHHOLDING RULE OVER THE WIRE. tests/couple-site-withholding.test.js
 *     asserts the keys are absent from the object publicPayload returns; this
 *     asserts they are absent from the RAW HTTP BODY a stranger receives, which
 *     is the thing that actually matters. It parses the response text as well
 *     as the JSON, so a key that survived as a string would still be caught;
 *   • that the whole unlock loop works: gated → shell → POST the password →
 *     token and cookie → GET again with the token → the full site;
 *   • that a WRONG password is a 401 and leaves the site shut;
 *   • that the RSVP really lands on the Guest collection through
 *     CoupleRsvpService — one row per phone however the number was typed, a
 *     409 on a second reply, an ActivityLog row every time, and a headcount
 *     that equals what GET /wedding/:id/guests/headcount says;
 *   • that an unknown slug is a 404 and an unpublished one is a 200 carrying
 *     `publishedAt: null` and no content — two different states, as the client
 *     renders them.
 *
 * The rate limiters are NOT exercised: their windows are an hour and ten
 * minutes, and a test that either waits or reaches into the limiter's private
 * store proves something about the test rather than about the endpoint. Their
 * keying is asserted structurally in tests/couple-website-permissions.test.js
 * (every public route mounts exactly one limiter and one handler).
 */
require("dotenv").config();
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const User = require("../models/User");
const Event = require("../models/Event");
const Guest = require("../models/Guest");
const Website = require("../models/Website");
const ActivityLog = require("../models/ActivityLog");
const headcountService = require("../services/CoupleHeadcountService");

const TAG = `couplepublic-${Date.now()}`;
const SLUG = `${TAG}-ananya-vikram`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const created = { users: [], events: [] };

const app = express();
app.use(express.json());
app.use("/wedding", require("../routes/coupleApp"));
app.use("/", require("../routes/coupleApp-website").itemRoutes);
app.use("/", require("../routes/coupleApp-people").itemRoutes);

let base = "";
const token = (id) => jwt.sign({ _id: String(id) }, process.env.JWT_SECRET);

/** Returns the RAW TEXT as well as the parsed body — the withholding is asserted on both. */
const call = async (method, path, { as, body, headers = {} } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(as ? { Authorization: `Bearer ${as}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  return { status: res.status, data, text, headers: res.headers };
};

(async () => {
  let server;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    await Website.syncIndexes();

    server = http.createServer(app).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;

    const bride = await User.create({ name: `${TAG}-bride`, phone: `${TAG}-b` });
    created.users.push(bride._id);

    const event = await Event.create({
      user: bride._id, name: `${TAG} wedding`,
      brideName: "Ananya", groomName: "Vikram", eventDate: "2026-12-11",
      eventDays: [
        { name: "Haldi", date: "2026-12-09", time: "10:00", venue: "Home" },
        { name: "Wedding", date: "2026-12-11", time: "07:40", venue: "The Tamarind Tree" },
      ],
      coupleApp: {
        city: "Bengaluru", muhurthamTime: "07:40",
        partners: [
          { user: bride._id, name: "Ananya Sharma", role: "bride" },
          { name: "Vikram Reddy", role: "groom" },
        ],
      },
    });
    created.events.push(event._id);
    const id = String(event._id);
    const AS_BRIDE = token(bride._id);

    // A guest the couple typed in, so the RSVP has something to MATCH against.
    await Guest.create({
      weddingId: event._id, first: "Meera", last: "Iyer", side: "bride",
      phone: "+91 98450 11223", phoneNormalised: "919845011223", party: 4,
      events: ["haldi", "wedding"], rsvp: "pending", source: "couple",
    });

    console.log("An unknown slug is a real 404:");
    {
      const res = await call("GET", `/site/${TAG}-nobody-lives-here`);
      eq(res.status, 404, "404");
      eq(res.data.error, "not_found", "named");
    }

    console.log("A slug that exists but is NOT PUBLISHED is a 200 with publishedAt: null and no content:");
    {
      await call("GET", `/wedding/${id}/website`, { as: AS_BRIDE });
      await call("PUT", `/wedding/${id}/website`, { as: AS_BRIDE, body: { slug: SLUG, themeId: "tp4", paletteId: "p3", fontId: "f2" } });
      await call("PUT", `/wedding/${id}/website/content`, {
        as: AS_BRIDE,
        body: { content: { "cover.names": "Ananya & Vikram", "story.body": "We met in a queue for dosas." }, photos: { cover: "/uploads/c.webp" } },
      });

      const res = await call("GET", `/site/${SLUG}`);
      eq(res.status, 200, "200 — a different state from a 404, and the client renders it as one");
      eq(res.data.publishedAt, null, "publishedAt is null");
      ok(!("content" in res.data), "and the draft's content is NOT sent to whoever guessed the address");
      ok(res.text.indexOf("dosas") === -1, "not even in the raw body");
      eq(res.headers.get("x-robots-tag"), "noindex, nofollow", "and the server itself says noindex");
    }

    console.log("PUBLISHED and OPEN — the full site:");
    {
      await call("POST", `/wedding/${id}/website/publish`, { as: AS_BRIDE });
      const res = await call("GET", `/site/${SLUG}`);
      eq(res.status, 200, "200");
      ok(res.data.publishedAt, "publishedAt is stamped");
      eq(res.data.themeId, "tp4", "the theme");
      eq(res.data.content["story.body"], "We met in a queue for dosas.", "the couple's words");
      eq(res.data.events.length, 2, "both functions");
      eq(res.data.events[1].key, "wedding", "with the key derived from the day's name");
      eq(res.data.wedding.city, "Bengaluru", "the city");
      eq(res.data.wedding.partners.length, 2, "and both partners");
      eq(res.data.privacy.passwordRequired, false, "no password required");
      ok(!("password" in res.data.privacy), "and no password key");
      ok(res.data.events.every((day) => !("expectedGuests" in day)),
        "a public function card carries NO expectedGuests — that is the couple's number, not a guest's");
    }

    console.log("linkOnly drives the server's own noindex:");
    {
      const res = await call("GET", `/site/${SLUG}`);
      eq(res.data.privacy.linkOnly, true, "the model defaults to link-only");
      eq(res.headers.get("x-robots-tag"), "noindex, nofollow", "so the server sends noindex — not left to the page");

      await call("PUT", `/wedding/${id}/website`, { as: AS_BRIDE, body: { privacy: { linkOnly: false } } });
      const open = await call("GET", `/site/${SLUG}`);
      eq(open.data.privacy.linkOnly, false, "switched off");
      eq(open.headers.get("x-robots-tag"), null, "and the header disappears — its presence IS the test");
      ok(String(open.headers.get("cache-control")).indexOf("s-maxage") !== -1, "an open site may be held briefly at the edge");
      await call("PUT", `/wedding/${id}/website`, { as: AS_BRIDE, body: { privacy: { linkOnly: true } } });
    }

    console.log("GATED — the withholding rule, over the wire:");
    {
      await call("PUT", `/wedding/${id}/website`, { as: AS_BRIDE, body: { privacy: { password: "december" } } });

      const res = await call("GET", `/site/${SLUG}`);
      eq(res.status, 200, "200 — the gate is a page, not an error");
      eq(Object.keys(res.data).sort().join(","), "fontId,paletteId,privacy,publishedAt,slug,themeId,wedding",
        "EXACTLY the seven keys the contract names");

      ["content", "photos", "events", "registry", "sections"].forEach((key) => {
        ok(!(key in res.data), `\`${key}\` is ABSENT from the parsed body`);
        ok(res.text.indexOf(`"${key}"`) === -1, `…and the string "${key}" is absent from the RAW body`);
      });
      ok(res.text.indexOf("dosas") === -1, "not a word the couple wrote is on the wire");
      ok(res.text.indexOf("Tamarind") === -1, "not a venue");
      ok(res.text.indexOf("Bengaluru") === -1, "not even the city");
      ok(res.text.indexOf("$2") === -1, "and not one byte of the bcrypt hash");

      eq(res.data.privacy.passwordRequired, true, "the client is told a password is required");
      eq(res.data.paletteId, "p3", "and given the palette, so the gate is in the couple's own colours");
      eq(res.data.wedding.partners[0].name, "Ananya Sharma", "and their names, so it can be addressed to them");
      eq(Object.keys(res.data.wedding).join(","), "partners", "wedding carries partners and nothing else");
      eq(res.headers.get("cache-control"), "private, no-store, must-revalidate",
        "a gated page is never held anywhere shared — one guest's unlock must not become everybody's");
    }

    console.log("A WRONG password is a 401 and the site stays shut:");
    {
      const res = await call("POST", `/site/${SLUG}/unlock`, { body: { password: "november" } });
      eq(res.status, 401, "401");
      eq(res.data.ok, false, "ok: false — the shape lib/plan/site-gate.js reads");
      ok(!res.data.unlockToken, "and no token is handed out");
      ok(!res.headers.get("set-cookie"), "and no cookie is set");

      const empty = await call("POST", `/site/${SLUG}/unlock`, { body: {} });
      eq(empty.status, 401, "no password at all is also a 401, not a 500");
    }

    console.log("THE UNLOCK LOOP, end to end:");
    {
      const unlocked = await call("POST", `/site/${SLUG}/unlock`, { body: { password: "december" } });
      eq(unlocked.status, 200, "200");
      eq(unlocked.data.ok, true, "ok: true");
      ok(unlocked.data.unlockToken, "a token is minted");
      const cookie = unlocked.headers.get("set-cookie") || "";
      ok(cookie.indexOf("HttpOnly") !== -1, "and set as an httpOnly cookie");
      ok(cookie.indexOf(`wedsy_unlock_${SLUG}`) !== -1, "named for this wedding");

      const withHeader = await call("GET", `/site/${SLUG}`, { headers: { "X-Site-Unlock": unlocked.data.unlockToken } });
      eq(withHeader.status, 200, "the token opens the site");
      ok("content" in withHeader.data, "content is sent now");
      eq(withHeader.data.content["story.body"], "We met in a queue for dosas.", "the couple's words arrive");
      eq(withHeader.data.events.length, 2, "and their functions");

      const withQuery = await call("GET", `/site/${SLUG}?unlock=${encodeURIComponent(unlocked.data.unlockToken)}`);
      ok("content" in withQuery.data, "the token works in the query too, for a link a guest was given");

      const withCookie = await call("GET", `/site/${SLUG}`, { headers: { Cookie: cookie.split(";")[0] } });
      ok("content" in withCookie.data, "and as the cookie a returning browser sends");

      const forged = await call("GET", `/site/${SLUG}`, { headers: { "X-Site-Unlock": "999999999999999.notasignature" } });
      ok(!("content" in forged.data), "a forged token opens nothing");
    }

    console.log("An unlock for ONE wedding does not open ANOTHER:");
    {
      const other = await Event.create({
        user: bride._id, name: `${TAG} other`, brideName: "Meera", groomName: "Rohan", eventDate: "2027-02-02",
        coupleApp: { partners: [{ user: bride._id, name: "Meera Iyer", role: "bride" }] },
      });
      created.events.push(other._id);
      const otherSlug = `${SLUG}-two`.slice(0, 60);
      await call("GET", `/wedding/${other._id}/website`, { as: AS_BRIDE });
      await call("PUT", `/wedding/${other._id}/website`, { as: AS_BRIDE, body: { slug: otherSlug, privacy: { password: "december" } } });
      await call("POST", `/wedding/${other._id}/website/publish`, { as: AS_BRIDE });

      const mine = await call("POST", `/site/${SLUG}/unlock`, { body: { password: "december" } });
      const cross = await call("GET", `/site/${otherSlug}`, { headers: { "X-Site-Unlock": mine.data.unlockToken } });
      ok(!("content" in cross.data), "the same password, a valid token — and the other wedding stays shut");
    }

    console.log("THE RSVP — § 06.3 invariant 4, through CoupleRsvpService:");
    {
      // Take the gate off so the reply form is the thing being tested.
      await call("PUT", `/wedding/${id}/website`, { as: AS_BRIDE, body: { privacy: { password: "" } } });

      const matched = await call("POST", `/site/${SLUG}/rsvp`, {
        body: { name: "Meera Iyer", phone: "+919845011223", attending: "yes", events: ["haldi", "wedding"], party: 4, note: "" },
      });
      eq(matched.status, 200, "200");
      eq(matched.data.ok, true, "ok");
      eq(matched.data.matched, true, "MATCHED — '+919845011223' found '+91 98450 11223', both sides normalised");
      ok(matched.data.guestId, "onto the existing row");
      eq(await Guest.countDocuments({ weddingId: event._id }), 1, "and NO duplicate row was created");

      const stored = await Guest.findById(matched.data.guestId).lean();
      eq(stored.rsvp, "yes", "the stored row carries her answer");
      eq(stored.party, 4, "and her party");
      ok(stored.repliedAt, "and when she replied");

      const again = await call("POST", `/site/${SLUG}/rsvp`, {
        body: { name: "Meera Iyer", phone: "9845011223", attending: "no", events: [], party: 1 },
      });
      eq(again.status, 409, "a second reply is a 409");
      eq(again.data.error, "already_replied", "named");
      eq(again.data.rsvp, "yes", "carrying what she said the first time");
      eq((await Guest.findById(matched.data.guestId).lean()).party, 4,
        "and a stranger with a guessed number has not edited her party size");

      const created2 = await call("POST", `/site/${SLUG}/rsvp`, {
        body: { name: "Priya Nair", phone: "+919812345678", attending: "yes", events: ["wedding"], party: 3, note: "Vegetarian" },
      });
      eq(created2.status, 200, "an unmatched reply is accepted");
      eq(created2.data.matched, false, "and says it created a row");
      const fresh = await Guest.findById(created2.data.guestId).lean();
      eq(fresh.source, "website", "marked as having come from the website, so the Guests tab knows to ask which side");
      eq(fresh.phoneNormalised, "919812345678", "with the match key written, so their NEXT reply matches");

      console.log("  …and the headcount is ONE number across the two screens:");
      const guests = await Guest.find({ weddingId: event._id }).lean();
      eq(created2.data.headcount, headcountService.tally(guests).headcount,
        "the website's response and CoupleHeadcountService agree over the same rows");
      const tab = await call("GET", `/wedding/${id}/guests/headcount`, { as: AS_BRIDE });
      eq(tab.data.headcount, created2.data.headcount, "and so does the couple's own Guests tab");
      eq(created2.data.headcount, 4 + 3, "4 + 3");

      console.log("  …and every reply appended an Activity:");
      const logs = await ActivityLog.find({ entityType: "wedding", entityId: id, action: "guest.rsvp" }).lean();
      eq(logs.length, 2, "one for the matched reply and one for the created one");
      eq(logs[0].meta.actorType, "guest", "attributed to the guest");
      eq(logs[0].actorId, null, "and NOT to an Admin — ActivityLog.actorId is an Admin ref and a guest is not one");
    }

    console.log("A bad reply is a 422 with a per-field map:");
    {
      const res = await call("POST", `/site/${SLUG}/rsvp`, { body: { name: "", phone: "123", attending: "maybe", party: 0 } });
      eq(res.status, 422, "422");
      eq(res.data.error, "validation", "named");
      ok(res.data.fields && res.data.fields.phone, "and every bad box is named");
    }

    console.log("An RSVP to an unknown or unpublished website is a 404:");
    {
      eq((await call("POST", `/site/${TAG}-nobody/rsvp`, { body: { name: "X", phone: "+919812345670", attending: "yes", party: 1 } })).status,
        404, "an unknown slug");
      const draft = await Event.create({
        user: bride._id, name: `${TAG} draft`, brideName: "A", groomName: "B", eventDate: "2027-03-03",
        coupleApp: { partners: [{ user: bride._id, name: "A", role: "bride" }] },
      });
      created.events.push(draft._id);
      const draftSlug = `${SLUG}-draft`.slice(0, 60);
      await call("GET", `/wedding/${draft._id}/website`, { as: AS_BRIDE });
      await call("PUT", `/wedding/${draft._id}/website`, { as: AS_BRIDE, body: { slug: draftSlug } });
      eq((await call("POST", `/site/${draftSlug}/rsvp`, { body: { name: "X", phone: "+919812345671", attending: "yes", party: 1 } })).status,
        404, "and one that exists but has not been published");
    }

    console.log("The public routes take no token and give nothing extra to one:");
    {
      const anonymous = await call("GET", `/site/${SLUG}`);
      const signedIn = await call("GET", `/site/${SLUG}`, { as: AS_BRIDE });
      eq(JSON.stringify(anonymous.data), JSON.stringify(signedIn.data),
        "the couple's own token changes nothing on the public route — it is the guests' page");
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (error) {
    console.error(error);
    fail += 1;
  } finally {
    await Promise.all([
      Guest.deleteMany({ weddingId: { $in: created.events } }),
      Website.deleteMany({ weddingId: { $in: created.events } }),
      ActivityLog.deleteMany({ entityType: "wedding", entityId: { $in: created.events.map(String) } }),
      Event.deleteMany({ _id: { $in: created.events } }),
      User.deleteMany({ _id: { $in: created.users } }),
    ]).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    if (server) server.close();
    process.exit(fail ? 1 : 0);
  }
})();
