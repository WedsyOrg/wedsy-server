// COUPLE APP § 04 / § 04.10 — THE SLUG, THE SETTINGS PATCH AND THE THEME SWITCH.
// Run: node tests/couple-website-builder.test.js
//
// PURE unit tests (NO DATABASE). Three rules are proved here:
//
//  1. THE SLUG is normalised and validated in one place. Uniqueness is NOT
//     tested here and cannot be: it is the unique index on Website.slug, on
//     purpose (a read-then-write check is two couples racing to the same
//     address). What IS tested is that the address a couple types becomes a
//     legal one, and that the addresses wedsy.in already answers on cannot be
//     taken.
//
//  2. THE SETTINGS PATCH accepts the six theme/palette/font/section/slug/
//     privacy fields and nothing else — and STRUCTURALLY cannot emit `content`
//     or `photos`. That is what makes § 04.10's "switching themes carries the
//     couple's words and photos across" true by construction rather than by a
//     careful call site.
//
//  3. THE PASSWORD comes out of the patch as PLAINTEXT under its own key, so
//     no caller can write it to the document without hashing it first.
const rules = require("../services/CoupleWebsiteRules");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

console.log("Normalising a slug — what the couple types becomes an address:");
{
  eq(rules.normaliseSlug("Ananya & Vikram"), "ananya-vikram", "an ampersand and spaces become one hyphen");
  eq(rules.normaliseSlug("  Sharma  Wedding  "), "sharma-wedding", "leading and trailing space is dropped");
  eq(rules.normaliseSlug("ANANYA-VIKRAM"), "ananya-vikram", "lowercased");
  eq(rules.normaliseSlug("ananya---vikram"), "ananya-vikram", "a run of hyphens collapses to one");
  eq(rules.normaliseSlug("---ananya---"), "ananya", "the ends are trimmed");
  eq(rules.normaliseSlug("Mīra & Rāhul"), "mira-rahul", "diacritics fold rather than vanish");
  eq(rules.normaliseSlug("ananya.vikram_2026"), "ananya-vikram-2026", "dots and underscores are separators too");
  eq(rules.normaliseSlug("अनन्या"), "", "a script with no ASCII form yields nothing rather than mojibake");
  eq(rules.normaliseSlug(""), "", "nothing in, nothing out");
  eq(rules.normaliseSlug(null), "", "null is not the string 'null'");
  eq(rules.normaliseSlug(undefined), "", "and neither is undefined");
  eq(rules.normaliseSlug(12345), "12345", "a number is its digits");
  eq(rules.normaliseSlug("a".repeat(200)).length, 60, "a very long name is cut to the maximum");
  ok(!/-$/.test(rules.normaliseSlug(`${"a".repeat(59)}-bcd`)), "and the cut never leaves a trailing hyphen");
  eq(rules.normaliseSlug("../../etc/passwd"), "etc-passwd", "a path traversal is not a slug");
  eq(rules.normaliseSlug("<script>alert(1)</script>"), "script-alert-1-script", "and neither is a script tag");
}

console.log("Validating a slug:");
{
  const good = rules.validateSlug("Ananya & Vikram");
  ok(good.ok, "a real one is accepted");
  eq(good.slug, "ananya-vikram", "and comes back normalised, so the caller stores the normalised form");
  eq(good.reason, "", "with no reason to refuse");

  eq(rules.validateSlug("").reason, "empty", "an empty address is refused as empty");
  eq(rules.validateSlug("!!!").reason, "empty", "and so is one that normalises to nothing");
  eq(rules.validateSlug("av").reason, "too_short", "two characters is too short");
  eq(rules.validateSlug("ava").ok, true, "three is the minimum and is allowed");
  eq(rules.validateSlug("registry").reason, "reserved", "a route wedsy.in already answers on is reserved");
  eq(rules.validateSlug("Admin").reason, "reserved", "case does not smuggle a reserved word through");
  eq(rules.validateSlug("api").reason, "reserved", "nor does the API's own prefix");
  eq(rules.validateSlug("6512f0aa11bb22cc33dd44ee").reason, "reserved", "a 24-hex id would shadow every /:id route");
  eq(rules.validateSlug("6512f0aa11bb22cc33dd44e").ok, true, "23 hex characters is just a name");
  ok(rules.validateSlug("").message.length > 0, "every refusal carries something the screen can render");
  ok(rules.validateSlug("registry").message.length > 0, "including the reserved one");
}

console.log("The settings patch — the six fields, and only those:");
{
  const { patch, fields } = rules.settingsPatch({
    themeId: "tp4", paletteId: "p3", fontId: "f2",
    sections: { cover: true, registry: false },
    slug: "Ananya & Vikram",
    privacy: { linkOnly: false },
  });
  eq(Object.keys(fields).length, 0, "nothing was rejected");
  eq(patch.themeId, "tp4", "the theme");
  eq(patch.paletteId, "p3", "the palette");
  eq(patch.fontId, "f2", "the typeface");
  eq(patch["sections.cover"], true, "a section switch, as a dotted path so the others are untouched");
  eq(patch["sections.registry"], false, "including one switched off");
  eq(patch.slug, "ananya-vikram", "the slug, normalised");
  eq(patch["privacy.linkOnly"], false, "and link-only");
}

console.log("An unknown value is refused rather than stored:");
{
  const { patch, fields } = rules.settingsPatch({ themeId: "tp99", paletteId: "purple", fontId: 7 });
  eq(patch.themeId, undefined, "an invented theme is not written");
  eq(patch.paletteId, undefined, "nor an invented palette");
  eq(patch.fontId, undefined, "nor a typeface that is a number");
  ok(fields.themeId && fields.paletteId && fields.fontId, "and each is named in the 422's fields map");
}

console.log("A seventh section has nowhere to go:");
{
  const { patch } = rules.settingsPatch({ sections: { cover: true, livestream: true } });
  eq(patch["sections.cover"], true, "the real one is kept");
  eq(patch["sections.livestream"], undefined, "the invented one is dropped, not silently stored");
}

console.log("§ 04.10 — A THEME SWITCH CANNOT TOUCH THE COUPLE'S WORDS OR PHOTOGRAPHS:");
{
  // The builder's pickTheme posts exactly this.
  const { patch } = rules.settingsPatch({ themeId: "tp4", paletteId: "p6", fontId: "f3" });
  ok(!("content" in patch), "the patch has no `content` key");
  ok(!("photos" in patch), "the patch has no `photos` key");
  ok(Object.keys(patch).every((key) => key.indexOf("content") === -1 && key.indexOf("photos") === -1),
    "and no dotted path into either");

  // Even when a caller tries to smuggle them through the settings door.
  const smuggled = rules.settingsPatch({
    themeId: "tp1",
    content: { "cover.names": "Somebody Else" },
    photos: { cover: "/somewhere-else.webp" },
  });
  ok(!("content" in smuggled.patch), "content sent to PUT /website is ignored");
  ok(!("photos" in smuggled.patch), "photos sent to PUT /website are ignored");
  eq(smuggled.patch.themeId, "tp1", "the theme it really was asked for still lands");

  // The carry, end to end: the stored document keeps every blockId and slotId.
  const stored = {
    themeId: "tp1",
    content: { "cover.names": "Ananya & Vikram", "story.body": "We met in a queue for dosas." },
    photos: { cover: "/c.webp", "gallery-1": { url: "/g1.webp", mediaId: "m1" } },
  };
  const after = { ...stored, ...rules.settingsPatch({ themeId: "tp4", paletteId: "p6", fontId: "f3" }).patch };
  eq(after.themeId, "tp4", "the theme changed");
  eq(JSON.stringify(after.content), JSON.stringify(stored.content), "and CONTENT is byte-for-byte what it was, keyed by blockId");
  eq(JSON.stringify(after.photos), JSON.stringify(stored.photos), "and PHOTOS likewise, keyed by slotId");
  eq(rules.couplePayload(after).content["story.body"], "We met in a queue for dosas.",
    "so the words the couple typed under tp1 render under tp4");
  eq(rules.couplePayload(after).photos["gallery-1"].mediaId, "m1", "and their photographs keep their media ids");
}

console.log("The password leaves the patch as PLAINTEXT under its own key, never as privacy.password:");
{
  const { patch, passwordPlain } = rules.settingsPatch({ privacy: { password: "december" } });
  eq(passwordPlain, "december", "the plaintext is handed back for hashing");
  ok(!("privacy.password" in patch), "and is NOT in the patch — the caller cannot write it unhashed by accident");
  ok(Object.keys(patch).every((key) => key.indexOf("password") === -1), "no key in the patch mentions a password at all");

  const cleared = rules.settingsPatch({ privacy: { password: "" } });
  eq(cleared.passwordPlain, "", "an empty string is the couple removing the gate — different from the key being absent");

  const absent = rules.settingsPatch({ privacy: { linkOnly: true } });
  eq(absent.passwordPlain, undefined, "a patch that does not mention a password leaves the existing one alone");

  eq(rules.settingsPatch({ privacy: { password: "abc" } }).fields.password !== undefined, true, "three characters is refused");
  eq(rules.settingsPatch({ privacy: { password: "x".repeat(400) } }).fields.password !== undefined, true, "and so is a 400-character one");
  eq(rules.settingsPatch({ privacy: { password: 12345 } }).fields.password !== undefined, true, "a number is not a password");
}

console.log("Junk bodies do not throw and do not write:");
{
  [null, undefined, "a string", 42, []].forEach((body) => {
    const r = rules.settingsPatch(body);
    ok(r && typeof r.patch === "object", `${JSON.stringify(body)} returns a patch object`);
    eq(Object.keys(r.patch).length, 0, `${JSON.stringify(body)} writes nothing`);
  });
  ok(rules.settingsPatch({ sections: "all" }).fields.sections !== undefined, "sections as a string is a validation error");
  ok(rules.settingsPatch({ privacy: [] }).fields.privacy !== undefined, "privacy as an array is a validation error");
}

console.log("The content write — the builder's envelope REPLACES, so a cleared slot is really cleared:");
{
  const existing = { content: { "cover.names": "Old", "story.body": "Old story" }, photos: { cover: "/c.webp", "gallery-1": "/g1.webp" } };
  const r = rules.mergeContent(existing, { content: { "cover.names": "Ananya & Vikram" }, photos: { cover: "/c.webp" } });
  ok(r.ok, "accepted");
  eq(r.content["cover.names"], "Ananya & Vikram", "the new words land");
  eq(r.content["story.body"], undefined, "and a block the builder no longer holds is gone — a merge could never clear one");
  eq(r.photos["gallery-1"], undefined, "a photograph the couple removed is really removed");
  eq(r.photos.cover, "/c.webp", "the one they kept is kept");
}

console.log("The bare { blockId: value } write MERGES, and an explicit null deletes:");
{
  const existing = { content: { "cover.names": "Old", "story.body": "Keep me" }, photos: { cover: "/c.webp" } };
  const r = rules.mergeContent(existing, { "cover.names": "New" });
  ok(r.ok, "accepted");
  eq(r.content["cover.names"], "New", "the block written lands");
  eq(r.content["story.body"], "Keep me", "and the blocks not mentioned survive");
  eq(r.photos.cover, "/c.webp", "photos are untouched by a words-only write");

  const deleted = rules.mergeContent(existing, { "story.body": null });
  eq(deleted.content["story.body"], undefined, "an explicit null deletes the block");
  eq(deleted.content["cover.names"], "Old", "leaving the rest");
}

console.log("A photo slot holds a URL string or a { url, mediaId } record — the two the client reads:");
{
  const r = rules.mergeContent({}, { photos: { cover: "/c.webp", "gallery-1": { url: "/g1.webp", mediaId: "m1", original: "/g1-orig.jpg" } } });
  ok(r.ok, "both shapes accepted");
  eq(r.photos.cover, "/c.webp", "the string survives as a string");
  eq(r.photos["gallery-1"].mediaId, "m1", "and the record keeps its media id");
  eq(r.photos["gallery-1"].original, "/g1-orig.jpg", "and its original, for a re-crop when the theme changes");

  const bad = rules.mergeContent({}, { photos: { cover: { mediaId: "m1" } } });
  ok(!bad.ok, "a record with no url is refused");
  const worse = rules.mergeContent({}, { photos: { "../../etc/passwd": "/x.webp" } });
  ok(!worse.ok, "and a slot id that is a path is not a slot id");
}

console.log("Content validation:");
{
  ok(!rules.mergeContent({}, { "cover.names": 42 }).ok, "a block is text, not a number");
  ok(!rules.mergeContent({}, { "cover.names": "x".repeat(5000) }).ok, "a 5000-character block is a paste accident, not a website");
  ok(!rules.mergeContent({}, { "<script>": "x" }).ok, "a block id that is markup is not a block id");
  ok(rules.mergeContent({}, { "cover.names": "x".repeat(4000) }).ok, "exactly 4000 characters is still a block");
  ok(rules.mergeContent({}, {}).ok, "an empty write is a no-op, not an error");
  ok(rules.mergeContent({}, { content: "words" }).ok === false, "content as a string is a validation error");
  ok(rules.isKey("gallery-1") && rules.isKey("cover.names") && rules.isKey("story_2"), "hyphens, dots and underscores are all real slot spellings");
  ok(!rules.isKey("") && !rules.isKey("a b") && !rules.isKey("../x"), "a blank, a space and a traversal are not");
}

console.log("The couple's own read carries what the builder needs and nothing dangerous:");
{
  const payload = rules.couplePayload({
    slug: "ananya-vikram", themeId: "tp2", paletteId: "p1", fontId: "f1",
    sections: { registry: true }, content: { a: "b" }, photos: { cover: "/c.webp" },
    privacy: { linkOnly: true, password: "$2b$10$hash" },
    publishedAt: "2026-09-08T10:00:00.000Z",
    registry: { intro: "No gifts needed.", layout: "list" },
  });
  eq(payload.slug, "ananya-vikram", "the address");
  eq(payload.themeId, "tp2", "the theme");
  eq(payload.sections.registry, true, "the switch they set");
  eq(payload.sections.cover, true, "and an unset switch defaults on rather than vanishing");
  eq(payload.privacy.passwordRequired, true, "they are told a password is set");
  ok(JSON.stringify(payload).indexOf("$2b$") === -1, "and never given it back");
  eq(payload.registry.intro, "No gifts needed.", "their note above the gifts");
  eq(payload.registry.layout, "list", "and the layout they chose");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
