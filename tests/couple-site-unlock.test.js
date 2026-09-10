// COUPLE APP § 04.10 — THE GUEST PASSWORD'S UNLOCK TOKEN AND ITS COOKIE.
// Run: node tests/couple-site-unlock.test.js
//
// PURE unit tests (NO DATABASE). bcrypt is exercised here too, because it runs
// in-process and needs no database — the compare that decides an unlock is the
// one thing in this feature that must not be taken on trust.
//
// THE SHAPE OF THE PROBLEM. POST /site/:slug/unlock proves the password ONCE.
// GET /site/:slug has to be told about it on every later request, and a guest
// has no account to remember it in. So the unlock becomes a short signed token:
// `<expiry>.<hmac(slug.expiry)>`. It is not the password, it names the slug it
// was minted for, and it expires. What is asserted below is that each of those
// three properties actually holds — a token that unlocked ANY wedding would be
// worse than no gate at all, because the couple would believe in it.
const bcrypt = require("bcrypt");
const rules = require("../services/CoupleWebsiteRules");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };
const eq = (got, want, label) => ok(got === want, `${label} (${JSON.stringify(got)} vs ${JSON.stringify(want)})`);

const SECRET = "a-per-deploy-secret-at-least-32-bytes-long";
const OTHER_SECRET = "a-different-deploys-secret-entirely-here!!";
const NOW = 1_800_000_000_000;

(async () => {
  console.log("A minted token verifies for its own slug:");
  {
    const token = rules.mintUnlockToken("ananya-vikram", SECRET, NOW);
    ok(token.length > 20, "a token is minted");
    ok(token.indexOf(".") > 0, "and carries its expiry before the signature");
    ok(rules.verifyUnlockToken("ananya-vikram", token, SECRET, NOW + 1000), "it verifies a moment later");
    ok(rules.verifyUnlockToken("ananya-vikram", token, SECRET, NOW + rules.TOKEN_TTL_MS - 1000), "and still does a day before it expires");
  }

  console.log("UNLOCKING ONE WEDDING NEVER UNLOCKS ANOTHER:");
  {
    const mine = rules.mintUnlockToken("ananya-vikram", SECRET, NOW);
    ok(!rules.verifyUnlockToken("meera-rohan", mine, SECRET, NOW + 1000), "a token minted for one slug is refused on another");
    ok(!rules.verifyUnlockToken("ananya-vikra", mine, SECRET, NOW + 1000), "including one character off");
    ok(!rules.verifyUnlockToken("", mine, SECRET, NOW + 1000), "and on no slug at all");
  }

  console.log("It expires, and expiry is not something the holder can edit:");
  {
    const token = rules.mintUnlockToken("ananya-vikram", SECRET, NOW);
    ok(!rules.verifyUnlockToken("ananya-vikram", token, SECRET, NOW + rules.TOKEN_TTL_MS + 1), "a token past its expiry is refused");

    // The expiry is inside the signed payload, so pushing it forward breaks it.
    const forged = `${NOW + rules.TOKEN_TTL_MS * 10}.${token.split(".")[1]}`;
    ok(!rules.verifyUnlockToken("ananya-vikram", forged, SECRET, NOW), "an expiry edited forward does not verify — it is signed, not declared");
  }

  console.log("The signature is a signature:");
  {
    const token = rules.mintUnlockToken("ananya-vikram", SECRET, NOW);
    ok(!rules.verifyUnlockToken("ananya-vikram", token, OTHER_SECRET, NOW), "another deploy's secret does not verify this one's token");
    ok(!rules.verifyUnlockToken("ananya-vikram", `${token}x`, SECRET, NOW), "a token with a character appended is refused");
    ok(!rules.verifyUnlockToken("ananya-vikram", token.slice(0, -1), SECRET, NOW), "and one with a character removed");
    ok(!rules.verifyUnlockToken("ananya-vikram", `${NOW + 1000}.`, SECRET, NOW), "an empty signature is refused, not treated as a match");
  }

  console.log("FAIL CLOSED — no secret configured means nothing verifies:");
  {
    eq(rules.mintUnlockToken("ananya-vikram", "", NOW), "", "with no secret, no token is minted");
    ok(!rules.verifyUnlockToken("ananya-vikram", "anything", "", NOW), "and none verifies");
    const real = rules.mintUnlockToken("ananya-vikram", SECRET, NOW);
    ok(!rules.verifyUnlockToken("ananya-vikram", real, "", NOW), "not even a genuine one — a misconfigured deploy stays SHUT, it does not open");
    ok(!rules.verifyUnlockToken("ananya-vikram", real, null, NOW), "null is not a secret either");
  }

  console.log("Junk is refused without throwing:");
  {
    [null, undefined, "", 42, {}, [], "no-dot-here", ".", "..", "abc.def"].forEach((token) => {
      let threw = false;
      let result = true;
      try { result = rules.verifyUnlockToken("ananya-vikram", token, SECRET, NOW); } catch (error) { threw = true; }
      ok(!threw && result === false, `${JSON.stringify(token)} is refused, not thrown on`);
    });
  }

  console.log("Where an unlock proof may arrive — three doors, one reader:");
  {
    const token = rules.mintUnlockToken("ananya-vikram", SECRET, NOW);
    const name = rules.unlockCookieName("ananya-vikram");

    eq(rules.unlockTokenFrom({ headers: { "x-site-unlock": token } }, "ananya-vikram"), token, "the header an SSR render forwards");
    eq(rules.unlockTokenFrom({ headers: {}, query: { unlock: token } }, "ananya-vikram"), token, "the query a link carries");
    eq(rules.unlockTokenFrom({ headers: { cookie: `${name}=${token}` } }, "ananya-vikram"), token, "the cookie a returning browser sends");
    eq(rules.unlockTokenFrom({ headers: {} }, "ananya-vikram"), "", "and nothing at all reads as no proof");
    eq(rules.unlockTokenFrom({}, "ananya-vikram"), "", "a request with no headers object does not throw");
    eq(rules.unlockTokenFrom({ headers: { cookie: `other=1; ${name}=${token}; another=2` } }, "ananya-vikram"), token,
      "the cookie is found among others");
    eq(rules.unlockTokenFrom({ headers: { cookie: `wedsy_unlock_meera-rohan=${token}` } }, "ananya-vikram"), "",
      "and ANOTHER wedding's cookie is not read as this one's");
  }

  console.log("The cookie is scoped, httpOnly and time-limited:");
  {
    const token = rules.mintUnlockToken("ananya-vikram", SECRET, NOW);
    const header = rules.unlockCookieHeader("ananya-vikram", token, { secure: true });
    ok(header.indexOf("HttpOnly") !== -1, "HttpOnly — a script on the page cannot read it");
    ok(header.indexOf("SameSite=Lax") !== -1, "SameSite=Lax");
    ok(header.indexOf("Secure") !== -1, "Secure, in a deploy that says so");
    ok(header.indexOf("Max-Age=") !== -1, "with a Max-Age, so it does not outlive the token");
    ok(header.indexOf(rules.unlockCookieName("ananya-vikram")) === 0, "named for this wedding and no other");
    ok(rules.unlockCookieHeader("ananya-vikram", token, { secure: false }).indexOf("Secure") === -1,
      "and plain over http where the deploy is local");
    ok(rules.unlockCookieName("../../evil").indexOf("/") === -1, "a cookie name is stripped of anything that is not a name");
  }

  console.log("Reading one cookie out of a raw header:");
  {
    eq(rules.readCookie("a=1; b=2", "b"), "2", "finds it");
    eq(rules.readCookie("a=1; b=2", "c"), null, "and says null when it is not there");
    eq(rules.readCookie("", "a"), null, "an empty header is null");
    eq(rules.readCookie(null, "a"), null, "and so is no header");
    eq(rules.readCookie("a=hello%20there", "a"), "hello there", "a percent-encoded value is decoded");
    eq(rules.readCookie("a=%E0%A4", "a"), "%E0%A4", "a malformed encoding comes back raw rather than throwing");
  }

  console.log("bcrypt is what decides an unlock — the real compare, in process:");
  {
    const hash = await bcrypt.hash("december", 10);
    ok(hash.indexOf("$2") === 0, "a bcrypt hash is stored, not the password");
    ok(hash.indexOf("december") === -1, "and the password is not recoverable from it by reading");
    ok(await bcrypt.compare("december", hash), "the right password compares true");
    ok(!(await bcrypt.compare("December", hash)), "a different case does not");
    ok(!(await bcrypt.compare("december ", hash)), "nor a trailing space");
    ok(!(await bcrypt.compare("", hash)), "nor an empty string");
    ok(!(await bcrypt.compare("wrong", hash)), "nor a wrong one");

    // The same plaintext hashed twice is two different hashes (a per-hash salt),
    // which is why a stored hash cannot be compared by equality anywhere.
    const again = await bcrypt.hash("december", 10);
    ok(again !== hash, "the same password hashes differently every time — so equality is never the test");
    ok(await bcrypt.compare("december", again), "and both verify");
  }

  console.log("A gated site's shell and its unlocked body differ only by what was withheld:");
  {
    const website = {
      slug: "ananya-vikram", themeId: "tp4", paletteId: "p3", fontId: "f1",
      sections: { cover: true }, content: { "cover.names": "Ananya & Vikram" }, photos: { cover: "/c.webp" },
      privacy: { linkOnly: true, password: "$2b$10$whatever" }, publishedAt: "2026-09-08T10:00:00.000Z",
    };
    const event = { _id: "e1", eventDays: [{ _id: "d1", name: "Wedding" }], coupleApp: { partners: [{ name: "Ananya", role: "bride" }] } };
    const locked = rules.publicPayload({ website, event, unlocked: false });
    const open = rules.publicPayload({ website, event, unlocked: true, keyOf: () => "wedding" });

    eq(locked.slug, open.slug, "the same address");
    eq(locked.paletteId, open.paletteId, "the same palette");
    eq(locked.privacy.passwordRequired, open.privacy.passwordRequired, "and both say a password is required");
    ok(!("content" in locked) && "content" in open, "the only difference is that the locked one has no content");
    eq(Object.keys(locked).length, 7, "seven keys locked");
    ok(Object.keys(open).length > 7, "and more once the password is proved");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
