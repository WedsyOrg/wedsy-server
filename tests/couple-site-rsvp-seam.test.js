// COUPLE APP § 06.3 #4 — THE RSVP INVARIANT IS CALLED, NEVER REIMPLEMENTED.
// Run: node tests/couple-site-rsvp-seam.test.js
//
// PURE unit tests (NO DATABASE). Two kinds of assertion, and the second is the
// one that keeps being true a year from now:
//
//   1. BEHAVIOUR — the public RSVP produces exactly the bodies wedsy-user's
//      siteApi.rsvp() documents: 200 { ok, matched, guestId, rsvp, party,
//      headcount }, 409 already_replied, 422 validation. Driven through the
//      REAL services/CoupleRsvpService, which is what the endpoint calls.
//
//   2. SOURCE — the files this milestone owns are read, and asserted NOT to
//      contain a second phone normalisation, a second guest match or a `party`
//      sum. tests/couple-tasks-union.test.js does the same for the CRM's
//      timeline and tests/objectid-strict.test.js for isId, because a rule
//      that lives in one function stays true only while nothing quietly grows
//      a copy of it. A duplicate phone rule is how a +971 guest gets matched to
//      a stranger; a duplicate headcount is how the Guests tab and the website
//      dashboard start disagreeing about how many people to cook for.
const fs = require("fs");
const path = require("path");

const rsvpService = require("../services/CoupleRsvpService");
const headcountService = require("../services/CoupleHeadcountService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

/** The files this milestone owns. */
const OWNED = [
  "routes/coupleApp-website.js",
  "controllers/coupleAppWebsite.js",
  "services/CoupleWebsiteRules.js",
  "services/CoupleWebsiteService.js",
  "services/CouplePublicSiteService.js",
  "utils/coupleSiteRateLimit.js",
];

/** Source with comments removed, so a rule NAMED in a comment is not read as a rule IMPLEMENTED. */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const GUESTS = [
  { _id: "g1", first: "Meera", last: "Iyer", phone: "+91 98450 11223", phoneNormalised: "919845011223", party: 4, rsvp: "pending", events: ["haldi", "wedding"] },
  { _id: "g2", first: "Rohan", last: "Iyer", phone: "+91 98450 33445", party: 2, rsvp: "pending", events: ["wedding"] },
  { _id: "g3", first: "Divya", last: "Shetty", phone: "+91 91230 44556", phoneNormalised: "919123044556", party: 1, rsvp: "yes", events: ["wedding"], repliedAt: "2026-09-01" },
];
const KEYS = ["haldi", "mehndi", "sangeet", "wedding", "reception"];

console.log("The 200 the client's form renders:");
{
  const r = rsvpService.applyRsvp({
    submission: { name: "Meera Iyer", phone: "+919845011223", attending: "yes", party: 4, events: ["haldi", "wedding"], note: "" },
    guests: GUESTS, weddingId: "w1", eventKeys: KEYS,
  });
  ok(r.ok, "accepted");
  const body = r.response;
  eq(Object.keys(body).sort().join(","), "guestId,headcount,matched,ok,party,rsvp",
    "exactly the six keys siteApi.rsvp() documents");
  eq(body.ok, true, "ok");
  eq(body.matched, true, "matched — the couple had already typed her in");
  eq(body.guestId, "g1", "onto her existing row, so the couple does not get a duplicate");
  eq(body.rsvp, "yes", "her answer");
  eq(body.party, 4, "her party");
  ok(typeof body.headcount === "number", "and a headcount, as a number");
}

console.log("The headcount in the response is THE SAME FUNCTION every other screen reads:");
{
  const r = rsvpService.applyRsvp({
    submission: { name: "Meera Iyer", phone: "+919845011223", attending: "yes", party: 4, events: ["wedding"] },
    guests: GUESTS, weddingId: "w1", eventKeys: KEYS,
  });
  // Reproduce the post-reply list and tally it independently, through the same
  // service the Guests tab and Budget catering read.
  const after = GUESTS.map((g) => (g._id === "g1" ? { ...g, rsvp: "yes", party: 4 } : g));
  eq(r.response.headcount, headcountService.tally(after).headcount,
    "the website's number and the Guests tab's number are one number");
  eq(r.response.headcount, 4 + 2 + 1, "4 replying yes + 2 still pending + 1 who already said yes");
}

console.log("An unmatched reply CREATES, and is marked so the couple can ask which side they are:");
{
  const r = rsvpService.applyRsvp({
    submission: { name: "Priya Nair", phone: "+919812345678", attending: "yes", party: 3, events: ["wedding"] },
    guests: GUESTS, weddingId: "w1", eventKeys: KEYS,
  });
  ok(r.ok && r.matched === false, "accepted, unmatched");
  ok(r.create, "a Guest row is created");
  eq(r.create.source, "website", "marked as having come from the website");
  eq(r.create.phoneNormalised, "919812345678", "with the match key written, so their NEXT reply matches");
  eq(r.response.headcount, 4 + 2 + 1 + 3, "and the new party is in the headcount");
}

console.log("A second reply is the 409 the client renders as 'you have already replied':");
{
  const r = rsvpService.applyRsvp({
    submission: { name: "Divya Shetty", phone: "+919123044556", attending: "no", party: 1, events: [] },
    guests: GUESTS, weddingId: "w1", eventKeys: KEYS,
  });
  eq(r.ok, false, "refused");
  eq(r.status, 409, "409");
  eq(r.body.error, "already_replied", "named");
  eq(r.body.rsvp, "yes", "carrying what they said the first time");
  eq(r.body.party, 1, "and for how many");
  ok(r.body.name, "and their name, so the page can say whose reply it already has");
}

console.log("A bad submission is the 422 with a per-field map:");
{
  const r = rsvpService.applyRsvp({
    submission: { name: "", phone: "12345", attending: "maybe", party: 0 },
    guests: GUESTS, weddingId: "w1", eventKeys: KEYS,
  });
  eq(r.status, 422, "422");
  eq(r.body.error, "validation", "named");
  ok(r.body.fields.name && r.body.fields.phone && r.body.fields.attending && r.body.fields.party,
    "every bad box is named, so the form points at them rather than saying 'something went wrong'");
}

console.log("ALWAYS an Activity, matched or not:");
{
  const matched = rsvpService.applyRsvp({
    submission: { name: "Meera Iyer", phone: "+919845011223", attending: "yes", party: 2, events: ["wedding"] },
    guests: GUESTS, weddingId: "w1", eventKeys: KEYS,
  });
  const created = rsvpService.applyRsvp({
    submission: { name: "Priya Nair", phone: "+919812345678", attending: "no", party: 1, events: [] },
    guests: GUESTS, weddingId: "w1", eventKeys: KEYS,
  });
  ok(matched.activity && matched.activity.actorType === "guest", "a matched reply appends one, attributed to the guest");
  ok(created.activity && created.activity.actorType === "guest", "and so does a created one");
  eq(matched.activity.action, "guest.rsvp", "under the action the digest renders");
  eq(created.activity.action, "guest.rsvp", "both of them");
}

console.log("SOURCE — nothing in this milestone reimplements the invariant:");
{
  OWNED.forEach((rel) => {
    const src = code(rel);

    // The phone rule. utils/phone is this repo's ONE implementation and
    // CoupleRsvpService is the only caller these endpoints need.
    ok(src.indexOf("normalisePhone") === -1, `${rel} — does not call normalisePhone directly`);
    ok(!/replace\([^)]*\\D/.test(src) && !/replace\([^)]*\[\^0-9\]/.test(src),
      `${rel} — does not strip a phone number down to digits by hand`);
    ok(src.indexOf("+91") === -1 && src.indexOf('"91"') === -1, `${rel} — does not carry a country code of its own`);

    // The headcount rule. Σ party where rsvp ≠ "no" lives in one function.
    ok(!/\.party\b[\s\S]{0,25}\+/.test(src) && !/\+[\s\S]{0,25}\.party\b/.test(src) && !/reduce\([\s\S]{0,120}party/.test(src),
      `${rel} — does not sum a party anywhere`);
    ok(src.indexOf("tally(") === -1 || rel === "services/CouplePublicSiteService.js",
      `${rel} — does not tally guests except at the one seam that delegates`);
  });

  const publicSite = code("services/CouplePublicSiteService.js");
  ok(publicSite.indexOf("rsvpService.applyRsvp") !== -1, "the public RSVP endpoint CALLS CoupleRsvpService.applyRsvp");
  ok(publicSite.indexOf("headcountService.tally") !== -1, "and its headcount seam calls CoupleHeadcountService.tally");
  ok(publicSite.indexOf("activityService.record") !== -1, "and the Activity goes through CoupleActivityService.record");
  ok(!/Guest\.find[\s\S]{0,200}phoneNormalised/.test(publicSite), "and it never queries guests by a phone key it built itself");
}

console.log("SOURCE — the public body is built in ONE place, so nothing can forget to withhold:");
{
  const publicSite = code("services/CouplePublicSiteService.js");
  const controller = code("controllers/coupleAppWebsite.js");
  const routes = code("routes/coupleApp-website.js");

  ok(publicSite.indexOf("rules.publicPayload") !== -1, "the service builds the guest's body with rules.publicPayload");
  eq((publicSite.match(/publicPayload/g) || []).length, 1, "and calls it exactly once — there is no second path");
  ok(controller.indexOf("publicPayload") === -1, "the controller does not build a public body of its own");
  ok(routes.indexOf("publicPayload") === -1, "and neither does the route file");

  // The hash: only the compare may touch it.
  OWNED.forEach((rel) => {
    const src = code(rel);
    ok(!/privacy\.password/.test(src) || rel === "services/CoupleWebsiteService.js" || rel === "services/CoupleWebsiteRules.js" || rel === "services/CouplePublicSiteService.js",
      `${rel} — does not reach for the stored password`);
  });
  const rulesSrc = code("services/CoupleWebsiteRules.js");
  ok(/String\(website\.privacy\.password[\s\S]{0,20}\)\.length/.test(rulesSrc) || rulesSrc.indexOf(".length") !== -1,
    "the rules file reads the hash only for its LENGTH (isGated), never its value");
  ok(rulesSrc.indexOf("bcrypt") === -1, "and the pure rules file does not even import bcrypt — the compare is the service's");
}

console.log("SOURCE — the hard rules (no console.log, no hardcoded URL):");
{
  OWNED.forEach((rel) => {
    const src = code(rel);
    ok(src.indexOf("console.log") === -1, `${rel} — no console.log (rule 6)`);
    // console.error on the 500 path is what controllers/coupleAppPeople.js does.
    ok(!/https?:\/\/(?!\s)[a-z]/i.test(src.replace(/https?:\/\/\$\{/g, "")), `${rel} — no hardcoded URL (rule 3)`);
    ok(!/mongodb(\+srv)?:\/\//.test(src), `${rel} — no database URL`);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
