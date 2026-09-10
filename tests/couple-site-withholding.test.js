// COUPLE APP § 06.4 / § 04.10 — THE GATED SITE WITHHOLDING RULE.
// Run: node tests/couple-site-withholding.test.js
//
// PURE unit tests (NO DATABASE). This is the security-critical piece of the
// wedding website, so the assertions are written the strict way round: not
// "content is empty" but **the key is absent from the response body**. A
// `content: {}` would pass a sloppy test and still tell a stranger that the
// couple has a story section; an absent key tells them nothing.
//
// § 06.4 and the ⛏ STUB in wedsy-user's lib/plan/api-public.js: when a site is
// password-protected and the request carries no valid unlock, GET /site/:slug
// returns ONLY
//
//     slug, publishedAt, themeId, paletteId, fontId, privacy, wedding.partners
//
// and withholds `content`, `photos`, `events` and `registry` ENTIRELY. The SSR
// route in wedsy-user strips them from its props too — that is a convenience.
// This is the control.
//
// The other half of the rule is the hash: `privacy.password` is a bcrypt hash
// and NEVER crosses the wire, in any response, locked or unlocked.
const rules = require("../services/CoupleWebsiteRules");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

/** Every key, at every depth, as a dotted path — so nothing can hide in a nested object. */
const deepKeys = (value, prefix = "") => {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((entry, i) => deepKeys(entry, `${prefix}[${i}]`));
  return Object.keys(value).flatMap((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...deepKeys(value[key], path)];
  });
};

/** Does this body mention the string anywhere — key or value, at any depth? */
const mentions = (body, needle) => JSON.stringify(body).indexOf(needle) !== -1;

const EVENT = {
  _id: "e1",
  brideName: "Ananya Sharma",
  groomName: "Vikram Reddy",
  eventDate: "2026-12-11",
  coupleApp: {
    city: "Bengaluru",
    muhurthamTime: "07:40",
    coverPhoto: "/uploads/cover.webp",
    partners: [
      { user: "u1", name: "Ananya Sharma", role: "bride", phone: "+919845011223", email: "ananya@example.com", avatar: "/a.webp" },
      { user: "u2", name: "Vikram Reddy", role: "groom", phone: "+919845099887", email: "vikram@example.com", avatar: "/v.webp" },
    ],
  },
  eventDays: [
    { _id: "d1", name: "Haldi", date: "2026-12-09", time: "10:00", venue: "Home" },
    { _id: "d2", name: "Wedding", date: "2026-12-11", time: "07:40", venue: "The Tamarind Tree" },
  ],
};

const CONTENT = { "cover.names": "Ananya & Vikram", "story.body": "We met in a queue for dosas." };
const PHOTOS = { cover: "/uploads/cover.webp", "gallery-1": { url: "/uploads/g1.webp", mediaId: "m1" } };
const REGISTRY = [{ id: "r1", name: "The copper pans", price: 8400 }];

const site = (over = {}) => ({
  _id: "w1",
  weddingId: "e1",
  slug: "ananya-vikram",
  themeId: "tp4",
  paletteId: "p3",
  fontId: "f2",
  sections: { cover: true, story: true, events: true, gallery: true, registry: true, rsvp: true },
  content: CONTENT,
  photos: PHOTOS,
  privacy: { linkOnly: true, password: "" },
  publishedAt: "2026-09-08T10:00:00.000Z",
  registry: { intro: "No gifts needed, only you.", layout: "grid" },
  ...over,
});

const GATED = site({ privacy: { linkOnly: true, password: "$2b$10$abcdefghijklmnopqrstuvREALLOOKINGHASHvalue123456" } });

console.log("A LOCKED site (password set, no unlock) is sent the shell and NOTHING else:");
{
  const body = rules.publicPayload({ website: GATED, event: EVENT, registry: REGISTRY, unlocked: false });
  const keys = Object.keys(body).sort();

  eq(keys.join(","), ["slug", "publishedAt", "themeId", "paletteId", "fontId", "privacy", "wedding"].sort().join(","),
    "exactly the seven keys the contract names");

  // THE ASSERTION THAT MATTERS: absent, not empty.
  ["content", "photos", "events", "registry", "sections"].forEach((key) => {
    ok(!(key in body), `\`${key}\` is ABSENT from the body — not empty, not null, not sent`);
  });

  // And nothing of theirs leaked through a nested path either.
  const all = deepKeys(body);
  ok(all.indexOf("content") === -1 && all.indexOf("photos") === -1, "no nested content/photos path exists");
  ok(!mentions(body, "dosas"), "not a word the couple wrote appears anywhere in the body");
  ok(!mentions(body, "gallery-1"), "not a photo slot appears anywhere in the body");
  ok(!mentions(body, "Tamarind"), "not a venue appears anywhere in the body");
  ok(!mentions(body, "copper pans"), "not a gift appears anywhere in the body");
  ok(!mentions(body, "Haldi"), "not a function's name appears anywhere in the body");
  ok(!mentions(body, "2026-12-11"), "not even the wedding date — the gate does not need it");

  // The shell is genuinely enough to draw the gate in the couple's own palette.
  eq(body.themeId, "tp4", "the theme comes through, so the gate is in their theme");
  eq(body.paletteId, "p3", "and the palette");
  eq(body.fontId, "f2", "and the typeface");
  eq(body.privacy.passwordRequired, true, "the client is told a password is required");
  eq(body.privacy.linkOnly, true, "and that the page is link-only, so it can noindex");
  eq(body.wedding.partners.length, 2, "both partners' names, so the gate can be addressed to them");
  eq(body.wedding.partners[0].name, "Ananya Sharma", "by name");
  eq(body.wedding.partners[0].role, "bride", "with their role");
}

console.log("The password hash NEVER crosses the wire — locked or unlocked:");
{
  const locked = rules.publicPayload({ website: GATED, event: EVENT, registry: REGISTRY, unlocked: false });
  const unlocked = rules.publicPayload({ website: GATED, event: EVENT, registry: REGISTRY, unlocked: true });
  const couple = rules.couplePayload(GATED);

  [["locked public", locked], ["unlocked public", unlocked], ["the couple's own read", couple]].forEach(([label, body]) => {
    ok(!mentions(body, "$2b$"), `${label}: no bcrypt hash anywhere in the body`);
    ok(!mentions(body, "REALLOOKINGHASH"), `${label}: not the hash's bytes either`);
    ok(deepKeys(body).indexOf("privacy.password") === -1, `${label}: there is no privacy.password key`);
    eq(body.privacy.passwordRequired, true, `${label}: only the boolean`);
    eq(Object.keys(body.privacy).sort().join(","), "linkOnly,passwordRequired", `${label}: privacy has exactly two keys`);
  });
}

console.log("A LOCKED site tells a stranger nothing about the couple beyond their names:");
{
  const body = rules.publicPayload({ website: GATED, event: EVENT, registry: REGISTRY, unlocked: false });
  ok(!mentions(body, "+9198450"), "no phone number");
  ok(!mentions(body, "@example.com"), "no email address");
  ok(!mentions(body, "u1"), "no user id");
  ok(!mentions(body, "Bengaluru"), "not even the city");
  eq(Object.keys(body.wedding).join(","), "partners", "wedding carries partners and nothing else");
  eq(Object.keys(body.wedding.partners[0]).sort().join(","), "name,role", "a partner is a name and a role — no id, phone, email or avatar");
}

console.log("An UNLOCKED gated site gets everything:");
{
  const body = rules.publicPayload({ website: GATED, event: EVENT, registry: REGISTRY, unlocked: true, keyOf: () => "wedding" });
  ok("content" in body, "content is sent");
  ok("photos" in body, "photos are sent");
  ok("events" in body, "events are sent");
  ok("registry" in body, "the registry is sent");
  ok("sections" in body, "the section switches are sent");
  eq(body.content["story.body"], "We met in a queue for dosas.", "the couple's words, verbatim");
  eq(body.events.length, 2, "both functions");
  eq(body.events[0].name, "Haldi", "named");
  eq(body.wedding.city, "Bengaluru", "the city the guest needs to travel to");
  eq(body.registry.length, 1, "the gift list");
}

console.log("An OPEN site (no password) is unlocked without proving anything:");
{
  const body = rules.publicPayload({ website: site(), event: EVENT, registry: REGISTRY, unlocked: true, keyOf: () => "" });
  ok("content" in body && "photos" in body && "events" in body, "content, photos and events are all sent");
  eq(body.privacy.passwordRequired, false, "and the client is told there is no password");
}

console.log("An UNPUBLISHED site is withheld too — a draft is not a public page:");
{
  const draft = site({ publishedAt: null });
  const body = rules.publicPayload({ website: draft, event: EVENT, registry: REGISTRY, unlocked: true });
  eq(Object.keys(body).sort().join(","), ["slug", "publishedAt", "themeId", "paletteId", "fontId", "privacy", "wedding"].sort().join(","),
    "the same seven keys");
  ["content", "photos", "events", "registry", "sections"].forEach((key) => {
    ok(!(key in body), `\`${key}\` is absent from an unpublished site's body`);
  });
  eq(body.publishedAt, null, "publishedAt is null — the client's own 'not out yet' state, distinct from a 404");
  ok(!mentions(body, "dosas"), "a draft the couple has not sent out is not readable by whoever guessed the address");
}

console.log("A site that is BOTH unpublished and gated stays shut on both counts:");
{
  const body = rules.publicPayload({ website: site({ publishedAt: null, privacy: { linkOnly: false, password: "$2b$10$x" } }), event: EVENT, unlocked: false });
  ok(!("content" in body), "content withheld");
  eq(body.publishedAt, null, "and it reads as unpublished");
  eq(body.privacy.passwordRequired, true, "and as gated");
}

console.log("The withholding does not depend on the caller passing a registry:");
{
  // The service only QUERIES the registry when it is going to be sent; if a
  // caller passed one anyway, a locked body must still not carry it.
  const body = rules.publicPayload({ website: GATED, event: EVENT, registry: REGISTRY, unlocked: false });
  ok(!mentions(body, "r1"), "a registry handed in is still not sent to a locked visitor");
}

console.log("`registry` is only sent when the couple switched the section on:");
{
  const off = site({ sections: { cover: true, story: true, events: true, gallery: true, registry: false, rsvp: true } });
  const body = rules.publicPayload({ website: off, event: EVENT, registry: REGISTRY, unlocked: true });
  eq(body.registry.length, 0, "the section is off, so the gift list is empty");
  eq(body.sections.registry, false, "and the switch says so");
}

console.log("isGated is the one definition of 'behind a password':");
{
  ok(rules.isGated({ privacy: { password: "$2b$10$x" } }) === true, "a stored hash is a gate");
  ok(rules.isGated({ privacy: { password: "" } }) === false, "an empty string is not");
  ok(rules.isGated({ privacy: {} }) === false, "a missing password is not");
  ok(rules.isGated({}) === false, "a website with no privacy block is not");
  ok(rules.isGated(null) === false, "and neither is nothing at all");
}

console.log("A wedding with no coupleApp.partners still names the couple (an older CRM record):");
{
  const legacy = { _id: "e2", brideName: "Meera", groomName: "Rohan", eventDays: [] };
  const body = rules.publicPayload({ website: GATED, event: legacy, unlocked: false });
  eq(body.wedding.partners.length, 2, "the CRM's two names are rendered");
  eq(body.wedding.partners[0].name, "Meera", "the bride");
  eq(body.wedding.partners[1].role, "groom", "and the groom");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
