// COUPLE APP § 05.2 / § 06.2 — THE GUEST QUERY AND THE GUEST BODY.
// Run: node tests/couple-guest-filter.test.js
//
// PURE unit tests (NO DATABASE). They assert the mongo filter that
// `GET /wedding/:id/guests ?side&rsvp&event&q` builds, and the validation every
// guest write goes through. What they cannot assert is how mongo EXECUTES that
// filter — that is what tests/couple-guests-tasks.int.test.js is for.
const rules = require("../services/CouplePeopleRules");
const { SIDE, RSVP_STATUS, EVENT_KEY } = require("../utils/coupleEnums");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
const has = (obj, key, label) => ok(Object.prototype.hasOwnProperty.call(obj, key), label);
const hasNot = (obj, key, label) => ok(!Object.prototype.hasOwnProperty.call(obj, key), label);

const W = "6512f0aa11bb22cc33dd44ee";

console.log("The filter, with no filters:");
{
  const f = rules.guestQuery(W, {});
  eq(Object.keys(f).length, 1, "an unfiltered read narrows on the wedding and nothing else");
  eq(f.weddingId, W, "always scoped to one wedding");
  eq(Object.keys(rules.guestQuery(W)).length, 1, "a missing query object is not a throw");
  eq(Object.keys(rules.guestQuery(W, null)).length, 1, "a null query object is not a throw");
}

console.log("side / rsvp / event:");
{
  eq(rules.guestQuery(W, { side: "bride" }).side, "bride", "side narrows");
  eq(rules.guestQuery(W, { side: "GROOM" }).side, "groom", "side is case-insensitive");
  eq(rules.guestQuery(W, { rsvp: "yes" }).rsvp, "yes", "rsvp narrows");
  eq(rules.guestQuery(W, { event: "sangeet" }).events, "sangeet",
     "event narrows on the array field — mongo equality on an array means 'contains'");
  SIDE.forEach((s) => eq(rules.guestQuery(W, { side: s }).side, s, `side "${s}" is a real filter`));
  RSVP_STATUS.forEach((r) => eq(rules.guestQuery(W, { rsvp: r }).rsvp, r, `rsvp "${r}" is a real filter`));
  EVENT_KEY.forEach((k) => eq(rules.guestQuery(W, { event: k }).events, k, `event "${k}" is a real filter`));
}

console.log("'all', blank and junk are NOT filters:");
{
  // The client sends "all" for "no filter". An unrecognised value narrows
  // nothing either: the guest list is the couple's single source of truth, and
  // a filter the server does not understand must never quietly remove people
  // from it. Narrowing to a value nothing matches renders as "you have no
  // guests", which is a lie about their own list.
  hasNot(rules.guestQuery(W, { side: "all" }), "side", "side=all narrows nothing");
  hasNot(rules.guestQuery(W, { rsvp: "all" }), "rsvp", "rsvp=all narrows nothing");
  hasNot(rules.guestQuery(W, { event: "all" }), "events", "event=all narrows nothing");
  hasNot(rules.guestQuery(W, { side: "" }), "side", "a blank side narrows nothing");
  hasNot(rules.guestQuery(W, { side: "maternal" }), "side", "an unknown side narrows nothing");
  hasNot(rules.guestQuery(W, { rsvp: "maybe" }), "rsvp", "an unknown rsvp narrows nothing");
  hasNot(rules.guestQuery(W, { event: "poolparty" }), "events", "an unknown function narrows nothing");
  hasNot(rules.guestQuery(W, { side: { $ne: null } }), "side", "an object where a string belongs narrows nothing");
  hasNot(rules.guestQuery(W, { colour: "red" }), "colour", "a query key nobody defined is not copied into the filter");
}

console.log("?q= — the search box:");
{
  const one = rules.guestQuery(W, { q: "Meera" });
  ok(Array.isArray(one.$or), "one word is an $or across the fields");
  eq(one.$or.length, 4, "name, surname, group and the raw number — no digits in 'Meera'");
  ok(one.$or[0].first instanceof RegExp && one.$or[0].first.flags.includes("i"), "case-insensitive");

  const two = rules.guestQuery(W, { q: "meera iy" });
  ok(Array.isArray(two.$and) && two.$and.length === 2, "two words is an $and of two $ors — 'meera iy' finds Meera Iyer");
  ok(two.$and.every((c) => Array.isArray(c.$or)), "each word may match any field");

  const digits = rules.guestQuery(W, { q: "98450" });
  eq(digits.$or.length, 5, "a run of digits also searches the normalised number");
  ok(digits.$or[4].phoneNormalised instanceof RegExp, "…as a regex on phoneNormalised");
  eq(rules.guestQuery(W, { q: "98" }).$or.length, 4, "two digits is too short to be a phone fragment");

  hasNot(rules.guestQuery(W, { q: "   " }), "$or", "a blank search is not a filter");
  hasNot(rules.guestQuery(W, { q: "" }), "$or", "an empty search is not a filter");
  eq(rules.guestQuery(W, { q: "Meera" }).weddingId, W, "a search never escapes the wedding scope");
}

console.log("A typed search string is not a pattern:");
{
  // ".*" from a search box must find the guest called ".*", not every guest.
  const f = rules.guestQuery(W, { q: "a.c" });
  eq(f.$or[0].first.source, "a\\.c", "the dot is escaped");
  const nasty = "(a)[b]{c}|d*e+f?^g$h.i";
  ok(new RegExp(rules.escapeRegex(nasty)).test(nasty), "an escaped string matches itself literally");
  ok(!new RegExp(rules.escapeRegex(".*")).test("Meera"), "a search for '.*' finds the guest called '.*', not everybody");
  const many = rules.guestQuery(W, { q: "a b c d e f g h i" });
  eq(many.$and.length, 6, "a pathological search is capped at six words, not unbounded");
}

console.log("The guest body — creating:");
{
  const good = rules.guestFields(
    { first: " Meera ", last: "Iyer", side: "bride", group: "Family", phone: "+91 98450 11223",
      party: "4", events: ["haldi", "wedding", "poolparty"], rsvp: "yes", note: "Ananya's aunt" },
    { eventKeys: ["haldi", "sangeet", "wedding"] }
  );
  eq(Object.keys(good.errors).length, 0, "a good body has no errors");
  eq(good.fields.first, "Meera", "names are trimmed");
  eq(good.fields.party, 4, "a numeric string is a number");
  eq(good.fields.events.length, 2, "a function this wedding does not have is dropped, not stored");
  eq(good.fields.events.indexOf("poolparty"), -1, "…specifically that one");
  eq(good.fields.phone, "+91 98450 11223", "the raw phone is kept as the couple typed it");
  ok(!Object.prototype.hasOwnProperty.call(good.fields, "phoneNormalised"),
     "the match key is NOT derived here — utils/phone via CoupleRsvpService is the one implementation");

  eq(rules.guestFields({ side: "bride" }).errors.first !== undefined, true, "a guest with no first name is refused");
  eq(rules.guestFields({ first: "  " , side: "bride" }).errors.first !== undefined, true, "…whitespace is not a name");
  eq(rules.guestFields({ first: "Meera" }).errors.side !== undefined, true, "whose guest they are is not guessed");
  eq(rules.guestFields({ first: "Meera", side: "maternal" }).errors.side !== undefined, true, "…and not invented");
  eq(rules.guestFields({ first: "Meera", side: "bride" }).fields.rsvp, "pending", "a new guest has not replied");
  eq(rules.guestFields({ first: "M", side: "bride", rsvp: "maybe" }).errors.rsvp !== undefined, true, "an unknown reply is refused");
  eq(rules.guestFields({ first: "M", side: "bride", events: "haldi" }).errors.events !== undefined, true, "events must be a list");
}

console.log("Party sizes on the way in:");
{
  const p = (party) => rules.guestFields({ first: "M", side: "bride", party });
  eq(p(undefined).fields.party, 1, "a missing party is one person — an invitation covers the person invited");
  eq(p("").fields.party, 1, "an empty form field is 'they did not say', not 'nobody'");
  eq(p(null).fields.party, 1, "null is the same");
  eq(p(2.7).fields.party, 2, "a fractional party floors");
  eq(p(0).fields.party, 0, "a deliberate 0 is respected");
  ok(p(-1).errors.party !== undefined, "a negative party is refused at the door");
  ok(p("abc").errors.party !== undefined, "…so is a party that is not a number");
}

console.log("The guest body — patching (PATCH /guests/:id):");
{
  const patch = rules.guestFields({ rsvp: "yes" }, { partial: true });
  eq(Object.keys(patch.errors).length, 0, "a one-field patch is valid");
  eq(Object.keys(patch.fields).join(","), "rsvp", "…and touches exactly that one field");
  eq(rules.guestFields({ party: 3 }, { partial: true }).fields.party, 3, "party alone");
  eq(Object.keys(rules.guestFields({}, { partial: true }).fields).length, 0, "an empty patch changes nothing");
  ok(rules.guestFields({ first: "" }, { partial: true }).errors.first !== undefined, "a patch cannot blank a name");
  ok(rules.guestFields({ side: "nope" }, { partial: true }).errors.side !== undefined, "a patch cannot corrupt the side");
  has(rules.guestFields({ phone: "9845011223" }, { partial: true }).fields, "phone", "a phone edit is a real change");
}

console.log("The row the screen renders:");
{
  const shaped = rules.shapeGuest({
    _id: "abc", first: "Meera", last: "Iyer", side: "bride", group: "Family",
    phone: "+91 98450 11223", phoneNormalised: "919845011223", party: 4,
    events: ["haldi"], rsvp: "yes", note: "n", source: "website",
    createdBy: "u1", weddingId: W,
  });
  eq(Object.keys(shaped).sort().join(","), "events,first,group,id,last,note,party,phone,rsvp,side,source",
     "§ 05.2's data contract exactly — and no internals");
  hasNot(shaped, "phoneNormalised", "the derived match key is not part of the contract");
  hasNot(shaped, "weddingId", "nor the scope it was already read under");
  eq(shaped.id, "abc", "_id becomes id");
  eq(rules.shapeGuest({}).party, 0, "a row with nothing on it still shapes");
  eq(rules.shapeGuest(null).rsvp, "pending", "…so does no row at all");
  const source = { _id: "x", events: ["haldi"] };
  rules.shapeGuest(source).events.push("wedding");
  eq(source.events.length, 1, "the shaped events array is a copy — a caller cannot edit the document through it");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
