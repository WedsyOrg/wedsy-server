// COUPLE APP § 06.4 — WHAT A STRANGER MAY BE GIVEN ON /registry/:slug.
// Run: node tests/couple-registry-withholding.test.js
//
// PURE unit tests (NO DATABASE). The guest registry is a page anybody with the
// link can open, so the thing that has to be right is not what it renders but
// what the server puts in the body. Asserted here:
//
//   • NO GUEST'S NAME, PHONE NUMBER OR NOTE ever reaches another guest, on any
//     branch, at any nesting depth — searched for as text in the whole payload
//   • the bcrypt password hash never crosses the wire, in any form
//   • a password-gated wedding withholds its gifts entirely until unlocked, and
//     `intro`, `items` and `funds` are ABSENT rather than empty
//   • an UNPUBLISHED website still serves its registry (§ 05.1: "works on its
//     own — no website needed") — the one place this deliberately differs from
//     CoupleWebsiteRules.publicPayload
//   • the progress bars still add up, because the total travels in place of
//     the rows the client would otherwise sum
const rules = require("../services/CoupleRegistryRules");
const websiteRules = require("../services/CoupleWebsiteRules");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);
/** Does this string appear ANYWHERE in the payload — key, value or nested? */
const mentions = (payload, needle) => JSON.stringify(payload).toLowerCase().indexOf(String(needle).toLowerCase()) !== -1;

const HASH = "$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV0123456789";

const website = (extra = {}) => ({
  _id: "s1",
  weddingId: "w1",
  slug: "ananya-karthik",
  paletteId: "p3",
  fontId: "f2",
  publishedAt: null,
  privacy: { linkOnly: true, password: "" },
  registry: { intro: "Your being there is the gift.", layout: "grid" },
  ...extra,
});

const event = {
  _id: "w1",
  brideName: "Ananya",
  groomName: "Karthik",
  eventDate: "2026-12-04",
  coupleApp: { city: "Bengaluru", partners: [{ name: "Ananya Rao", role: "bride" }, { name: "Karthik Menon", role: "groom" }] },
};

const items = [{ _id: "i1", title: "Copper cookware", image: "https://shop.example/x.jpg", price: 24000, funded: 9000, pinned: true }];
const funds = [{ _id: "f1", title: "Kyoto honeymoon", target: 80000, raised: 31000 }];

/* The rows the couple sees — every one of them carries a real person. */
const contributions = [
  { _id: "c1", item: "i1", guestName: "Meera Iyer", guestPhone: "+919845011223", guestPhoneNormalised: "+919845011223", note: "So happy for you both", amount: 9000, mode: "part", status: "settled", thanked: false, createdAt: "2026-09-01" },
  { _id: "c2", fund: "f1", guestName: "Rohan Das", guestPhone: "+919900112233", note: "For the ryokan", amount: 31000, mode: "part", status: "settled", thanked: true, createdAt: "2026-09-02" },
];

const build = (opts = {}) =>
  rules.publicRegistryPayload({
    website: opts.website || website(),
    event,
    items,
    funds,
    intro: (opts.website || website()).registry.intro,
    gated: Boolean(opts.gated),
    unlocked: Boolean(opts.unlocked),
    privacyOf: websiteRules.publicPrivacy,
    partnersOf: websiteRules.publicPartners,
  });

console.log("A guest's identity never reaches another guest:");
{
  const payload = build();
  ok(!mentions(payload, "Meera Iyer"), "no guest name in the body");
  ok(!mentions(payload, "Rohan Das"), "not the other one either");
  ok(!mentions(payload, "9845011223"), "NO PHONE NUMBER, in any formatting");
  ok(!mentions(payload, "9900112233"), "not the second one either");
  ok(!mentions(payload, "So happy for you both"), "no private note");
  ok(!mentions(payload, "For the ryokan"), "not the second one either");
  ok(!mentions(payload, "thanked"), "and not whether the couple has got round to thanking them");
  ok(!mentions(payload, "c1"), "not even a contribution id, which could be counted or correlated");

  // The couple's own payload, by contrast, is where those people live.
  const couple = rules.couplePayload({ website: website(), items, funds, contributions });
  ok(mentions(couple, "Meera Iyer"), "the COUPLE's payload does carry the giver");
  ok(mentions(couple, "9845011223"), "with the number they need to thank them on");
  eq(couple.thanked, 1, "and the thank-you counters");
  eq(couple.pending, 1, "both of them");
}

console.log("...and yet the progress bars still add up:");
{
  const payload = build();
  const item = payload.items[0];
  eq(item.funded, 9000, "the item's total is sent");
  // components/registry/GuestRegistry.js derives its bar this way, verbatim.
  const fundedOf = (row) => (row.contributions || []).reduce((n, c) => n + (Number(c.amount) || 0), 0);
  eq(fundedOf(item), 9000, "and the client's own derivation reaches the same number");
  eq(item.contributions.length, 1, "from ONE anonymous row, not one per giver");
  eq(Object.keys(item.contributions[0]).join(","), "amount", "and that row has exactly one key: the amount");
  eq(item.remaining, 15000, "so 'what is left' is right");
  eq(fundedOf(payload.funds[0]), 31000, "a fund's bar too");
  eq(payload.funds[0].target, 80000, "against its goal");
}

console.log("The password hash never crosses the wire:");
{
  const gated = build({ website: website({ privacy: { linkOnly: true, password: HASH } }), gated: true, unlocked: true });
  ok(!mentions(gated, "$2b$"), "no bcrypt prefix anywhere in an UNLOCKED payload");
  ok(!mentions(gated, HASH), "and not the hash itself");
  eq(gated.privacy.passwordRequired, true, "the guest is told a password EXISTS");
  ok(!Object.prototype.hasOwnProperty.call(gated.privacy, "password"), "and never given it");
}

console.log("A gated registry withholds the gifts until it is unlocked:");
{
  const locked = build({ website: website({ privacy: { linkOnly: true, password: HASH } }), gated: true, unlocked: false });
  ok(!Object.prototype.hasOwnProperty.call(locked, "items"), "no `items` key — absent, not empty");
  ok(!Object.prototype.hasOwnProperty.call(locked, "funds"), "no `funds` key");
  ok(!Object.prototype.hasOwnProperty.call(locked, "intro"), "not even the couple's note");
  ok(!mentions(locked, "Copper cookware"), "and nothing of what they asked for");
  ok(!mentions(locked, "Kyoto"), "or where they are going");
  eq(Object.keys(locked).sort().join(","), "fontId,paletteId,privacy,slug,wedding", "exactly the five keys a gate needs to be drawn");
  eq(locked.wedding.partners.length, 2, "under the couple's own names");
  ok(!mentions(locked, "24000"), "no prices");

  const unlocked = build({ website: website({ privacy: { linkOnly: true, password: HASH } }), gated: true, unlocked: true });
  eq(unlocked.items.length, 1, "and once unlocked the gifts are there");
  eq(unlocked.intro, "Your being there is the gift.", "with the note");
}

console.log("An UNPUBLISHED website still serves its registry (§ 05.1):");
{
  const draft = build({ website: website({ publishedAt: null }) });
  eq(draft.items.length, 1, "publishedAt: null does not withhold — the registry works on its own");
  eq(draft.funds.length, 1, "funds too");
  ok(!Object.prototype.hasOwnProperty.call(draft, "publishedAt"), "and publishedAt is not even in the body — it is not the guest's business here");

  // The site route, on the same document, does withhold. The two rules differ
  // on purpose, and this asserts they still do.
  const site = websiteRules.publicPayload({ website: website({ publishedAt: null }), event, registry: [], unlocked: true });
  ok(!Object.prototype.hasOwnProperty.call(site, "content"), "GET /site/:slug still withholds an unpublished site");
}

console.log("What is in the shell, and what is not:");
{
  const payload = build();
  eq(payload.slug, "ananya-karthik", "the slug");
  eq(payload.paletteId, "p3", "the couple's palette, so the page is theirs");
  eq(payload.fontId, "f2", "and their typeface");
  eq(payload.privacy.linkOnly, true, "linkOnly, so the page can emit noindex");
  eq(payload.wedding.city, "Bengaluru", "the city");
  eq(payload.wedding.partners[0].name, "Ananya Rao", "and the two names");
  ok(!mentions(payload, "weddingId"), "no internal wedding id");
  ok(!Object.prototype.hasOwnProperty.call(payload, "sections"), "no website section switches");
  ok(!Object.prototype.hasOwnProperty.call(payload, "content"), "no website copy");
  ok(!Object.prototype.hasOwnProperty.call(payload, "photos"), "no website photographs");
  ok(!mentions(payload, "balance"), "and not one word about the couple's wallet");

  // Partners fall back to the CRM's two names when coupleApp has none.
  const bare = rules.publicRegistryPayload({
    website: website(), event: { brideName: "Ananya", groomName: "Karthik" }, items: [], funds: [],
    privacyOf: websiteRules.publicPrivacy, partnersOf: websiteRules.publicPartners,
  });
  eq(bare.wedding.partners.length, 2, "a wedding with no coupleApp partners still names the couple");
}

console.log("Nothing throws on a half-empty wedding:");
{
  const nothing = rules.publicRegistryPayload({});
  eq(nothing.slug, "", "no website at all is an empty shell, not a crash");
  eq(nothing.paletteId, "p1", "with the default palette");
  eq(Array.isArray(nothing.items), true, "and an items array");
  eq(rules.publicItem({}).price, 0, "an item with no price is 0, not NaN");
  eq(rules.publicItem({}).contributions[0].amount, 0, "and its anonymous row is 0");
  eq(rules.publicFund({}).remaining, 0, "a fund with no target has nothing remaining");
  eq(rules.couplePayload({}).intro, "", "the couple's payload survives a missing website too");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
