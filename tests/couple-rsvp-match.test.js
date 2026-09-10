// COUPLE APP INVARIANT 4 — WEBSITE RSVP → GUESTS.
// Run: node tests/couple-rsvp-match.test.js
// PURE unit tests (NO DATABASE). § 06.3: match on phone, create if unmatched,
// ALWAYS append an Activity, and recompute the headcount server-side so the
// Guests tab and the website dashboard render the same number.
//
// THE MATCH IS THE POINT. Stored guests look like "+91 98450 11223" and the
// public form posts "+919845011223". Comparing them raw creates a duplicate
// row, and a duplicate row is an extra party on the headcount, in the catering
// estimate and on the payment that feeds.
const rsvp = require("../services/CoupleRsvpService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

const GUESTS = [
  { _id: "g1", first: "Meera", last: "Iyer", phone: "+91 98450 11223", phoneNormalised: "919845011223", party: 4, rsvp: "pending", events: ["haldi", "wedding"] },
  { _id: "g2", first: "Rohan", last: "Iyer", phone: "+91 98450 33445", party: 2, rsvp: "pending", events: ["wedding"] },   // no denormalised column
  { _id: "g3", first: "Divya", last: "Shetty", phone: "+91 91230 44556", phoneNormalised: "919123044556", party: 1, rsvp: "no", events: ["wedding"], repliedAt: "2026-09-01" },
];

console.log("Normalising both sides:");
{
  eq(rsvp.normalise("+91 98450 11223"), "919845011223", "the couple's spaced form");
  eq(rsvp.normalise("+919845011223"), "919845011223", "the client's compact form");
  eq(rsvp.normalise("9845011223"), "919845011223", "a bare 10-digit number takes the default country code");
  eq(rsvp.normalise("09845011223"), "919845011223", "a trunk zero is not an eleventh digit");
  eq(rsvp.normalise("+971 50 123 4567"), "971501234567", "a +971 number keeps ITS country code — never re-derived to +91");
  eq(rsvp.normalise(""), null, "an empty phone is no phone");
  eq(rsvp.normalise("12345"), null, "too short is no phone, not a padded one");
}

console.log("Matching:");
{
  ok(rsvp.matchGuest(GUESTS, "+919845011223") === GUESTS[0], "the client's form matches the couple's spaced one");
  ok(rsvp.matchGuest(GUESTS, "9845011223") === GUESTS[0], "and so does a bare national number");
  ok(rsvp.matchGuest(GUESTS, "+919845033445") === GUESTS[1], "a row with NO denormalised column still matches on its raw phone");
  ok(rsvp.matchGuest(GUESTS, "+919999999999") === null, "an unknown number matches nobody");
  ok(rsvp.matchGuest(GUESTS, "") === null, "an empty number matches nobody — not the first row");
  ok(rsvp.matchGuest([], "+919845011223") === null, "an empty list matches nobody");
  ok(rsvp.matchGuest(GUESTS, "+971501234567") === null, "a foreign number does not collide with an Indian one");
}

console.log("A matched reply UPDATES:");
{
  const r = rsvp.applyRsvp({
    submission: { name: "Meera Iyer", phone: "+919845011223", attending: "yes", party: 4, events: ["haldi", "wedding"], note: "" },
    guests: GUESTS, weddingId: "w1", eventKeys: ["haldi", "sangeet", "wedding", "reception"],
  });
  ok(r.ok === true, "accepted");
  ok(r.matched === true, "matched");
  eq(r.guestId, "g1", "onto the existing guest");
  ok(r.create === null, "and creates NO second row");
  eq(r.update.$set.rsvp, "yes", "their rsvp is recorded");
  eq(r.response.headcount, 4 + 2, "the headcount is recomputed: 4 (yes) + 2 (pending) — the 'no' stays out");
  ok(Boolean(r.activity), "an Activity is appended");
  eq(r.activity.actorType, "guest", "attributed to the guest");
}

console.log("An unmatched reply CREATES:");
{
  const r = rsvp.applyRsvp({
    submission: { name: "Sunita Sharma", phone: "+919812345678", attending: "yes", party: 3, events: ["wedding"], note: "so happy" },
    guests: GUESTS, weddingId: "w1",
  });
  ok(r.matched === false, "no match");
  ok(r.update === null && Boolean(r.create), "a new guest row is created");
  eq(r.create.first, "Sunita", "first name");
  eq(r.create.last, "Sharma", "last name");
  eq(r.create.phoneNormalised, "919812345678", "with the match key written, so the NEXT reply matches this row");
  eq(r.create.source, "website", "marked as a website row, so the Guests tab knows to ask which side they are");
  eq(r.response.headcount, 4 + 2 + 3, "the headcount includes them immediately");
  ok(Boolean(r.activity), "an Activity is appended for a created guest too");
}

console.log("A reply of 'no':");
{
  const r = rsvp.applyRsvp({
    submission: { name: "Meera Iyer", phone: "+919845011223", attending: "no", party: 4 },
    guests: GUESTS, weddingId: "w1",
  });
  eq(r.update.$set.rsvp, "no", "recorded as a decline");
  eq(r.response.headcount, 2, "and their party leaves the headcount");
  ok(r.activity.summary.indexOf("cannot come") !== -1, "the activity says so in words the couple reads");
}

console.log("Replying twice:");
{
  const r = rsvp.applyRsvp({
    submission: { name: "Divya Shetty", phone: "+919123044556", attending: "yes", party: 1 },
    guests: GUESTS, weddingId: "w1",
  });
  ok(r.ok === false, "refused");
  eq(r.status, 409, "409");
  eq(r.body.error, "already_replied", "with the error the client renders");
  eq(r.body.rsvp, "no", "carrying what they said the first time");
  eq(r.body.name, "Divya Shetty", "and who they are");
}

console.log("Validation (the 422 contract):");
{
  const bad = rsvp.applyRsvp({ submission: { name: "", phone: "123", attending: "maybe", party: 0 }, guests: GUESTS, weddingId: "w1" });
  eq(bad.status, 422, "422");
  eq(bad.body.error, "validation", "validation");
  ok(Boolean(bad.body.fields.name), "name is named");
  ok(Boolean(bad.body.fields.phone), "phone is named");
  ok(Boolean(bad.body.fields.attending), "attending is named");
  ok(Boolean(bad.body.fields.party), "party is named");
  eq(rsvp.applyRsvp({ submission: { name: "A", phone: "+919812345678", attending: "yes", party: 1 }, guests: [], weddingId: "w1" }).ok, true, "a minimal valid reply is accepted");
}

console.log("Events the wedding does not have:");
{
  const r = rsvp.applyRsvp({
    submission: { name: "New Person", phone: "+919812345679", attending: "yes", party: 1, events: ["haldi", "boat-party"] },
    guests: [], weddingId: "w1", eventKeys: ["haldi", "wedding"],
  });
  eq(r.create.events.length, 1, "an invented function key is dropped");
  eq(r.create.events[0], "haldi", "the real one is kept");
}

console.log("An empty events list does not wipe an invitation:");
{
  const r = rsvp.applyRsvp({
    submission: { name: "Meera Iyer", phone: "+919845011223", attending: "yes", party: 4, events: [] },
    guests: GUESTS, weddingId: "w1",
  });
  ok(r.update.$set.events === undefined, "the couple's invitation survives a reply that named no functions");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
