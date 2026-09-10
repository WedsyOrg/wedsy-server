// COUPLE APP INVARIANT 1 — HEADCOUNT. Run: node tests/couple-headcount.test.js
// PURE unit tests (NO DATABASE). Asserts the § 06.3 rule the Budget, Home, the
// website tally and Payments all read:
//     headcount = Σ guest.party where rsvp ≠ "no"
// and that "invited" counts invitations while "headcount" counts people — the
// two numbers the Guests header shows side by side and must not swap.
const headcount = require("../services/CoupleHeadcountService");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${got} vs ${want})`);

// The seed wedding's own numbers (wedsy-user lib/plan/seed.js): 16 rows,
// 8 yes, 2 no, 6 pending, headcount 35. If this service disagrees with the
// fixtures the screens were built against, the screens are wrong.
const SEED = [
  { rsvp: "yes", party: 4 }, { rsvp: "yes", party: 2 }, { rsvp: "pending", party: 3 },
  { rsvp: "yes", party: 1 }, { rsvp: "pending", party: 2 }, { rsvp: "no", party: 1 },
  { rsvp: "pending", party: 1 }, { rsvp: "yes", party: 5 }, { rsvp: "yes", party: 5 },
  { rsvp: "yes", party: 2 }, { rsvp: "yes", party: 2 }, { rsvp: "pending", party: 1 },
  { rsvp: "pending", party: 2 }, { rsvp: "no", party: 1 }, { rsvp: "yes", party: 3 },
  { rsvp: "pending", party: 2 },
];

console.log("Headcount — the seed wedding:");
{
  const t = headcount.tally(SEED);
  eq(t.invited, 16, "invited counts invitations, not people");
  eq(t.yes, 8, "yes");
  eq(t.no, 2, "no");
  eq(t.pending, 6, "pending");
  eq(t.headcount, 35, "headcount matches the seed the screens were built against");
}

console.log("The rule itself:");
{
  eq(headcount.headcount([{ rsvp: "no", party: 9 }]), 0, "a 'no' contributes nothing, whatever its party");
  eq(headcount.headcount([{ rsvp: "pending", party: 3 }]), 3, "a PENDING guest still counts — they have not declined");
  eq(headcount.headcount([{ rsvp: "yes", party: 3 }]), 3, "a yes counts");
  eq(headcount.headcount([]), 0, "an empty list is 0, not NaN");
  eq(headcount.headcount(null), 0, "a missing list is 0, not a throw");
  eq(headcount.tally(undefined).invited, 0, "undefined tallies to zeroes");
}

console.log("Party sizes that are not numbers:");
{
  eq(headcount.headcount([{ rsvp: "yes" }]), 1, "a missing party is one person, not zero");
  eq(headcount.headcount([{ rsvp: "yes", party: "4" }]), 4, "a numeric string still counts");
  eq(headcount.headcount([{ rsvp: "yes", party: "" }]), 1, "an empty party is one person");
  eq(headcount.headcount([{ rsvp: "yes", party: -3 }]), 0, "a negative party never SUBTRACTS from the room");
  eq(headcount.headcount([{ rsvp: "yes", party: 2.7 }]), 2, "a fractional party floors — there is no 0.7 of a guest");
  eq(headcount.headcount([{ rsvp: "yes", party: 0 }]), 0, "a deliberate 0 is respected");
  eq(headcount.headcount([null, { rsvp: "yes", party: 2 }]), 2, "a null row is skipped, not counted");
}

console.log("An unknown rsvp value:");
{
  // Anything that is not "no" counts. A row whose rsvp got corrupted must
  // over-count rather than quietly remove people from the catering order.
  eq(headcount.headcount([{ rsvp: "maybe", party: 2 }]), 2, "an unrecognised rsvp counts (fails toward feeding people)");
  eq(headcount.tally([{ rsvp: "maybe", party: 2 }]).pending, 1, "and is reported as pending, not as yes");
}

console.log("Per-function narrowing (§ 06.3 Events):");
{
  const guests = [
    { rsvp: "yes", party: 4, events: ["haldi", "wedding"] },
    { rsvp: "yes", party: 2, events: ["wedding"] },
    { rsvp: "no", party: 5, events: ["haldi", "wedding"] },
    { rsvp: "pending", party: 3, events: ["sangeet"] },
  ];
  eq(headcount.tallyForEvent(guests, "haldi").headcount, 4, "haldi counts only its invitees, minus the declines");
  eq(headcount.tallyForEvent(guests, "wedding").headcount, 6, "the wedding day");
  eq(headcount.tallyForEvent(guests, "sangeet").headcount, 3, "a pending invitee still counts for the sangeet");
  eq(headcount.tallyForEvent(guests, "reception").headcount, 0, "a function nobody is invited to is 0");
  eq(headcount.tallyForEvent(guests, "haldi").invited, 2, "invited-to counts rows including the decline");
  eq(headcount.tallyForEvent([{ rsvp: "yes", party: 2 }], "haldi").headcount, 0, "a guest with no events list is not silently invited to everything");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
