/**
 * ENCRYPTING STORED THIRD-PARTY CREDENTIALS.
 *
 * Two live credentials sat in MongoDB as plain text: a per-admin Google refresh
 * token (calendar write) and the Instagram Graph access token for the business
 * account (DMs). A third — VenueSheetIntegration.refreshToken — was already
 * encrypted, so the scheme existed and simply was not reused.
 *
 * THE TRAP THIS SUITE EXISTS FOR. Promoting the helper while binding it to a
 * NEW env key would stop every existing Sheets row decrypting — silently, and
 * only for whoever next touched a sheet. So the KEY IS A PARAMETER. Each store
 * passes its own, and section 2 proves the isolation rather than asserting it.
 *
 *   1  round-trip, versioned format, plaintext passthrough
 *   2  KEY ISOLATION — A cannot read B, and a legacy Sheets row still decrypts
 *   3  a decrypt failure is LOUD, so a key mismatch shows up in minutes
 *   4  GoogleAccount.refreshToken is stored encrypted and migrates lazily
 *   5  ConnectedInstagramAccount.accessToken likewise
 *
 *   node tests/secret-box.test.js
 */
require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l}${g === w ? "" : `\n      expected ${JSON.stringify(w)}\n      got      ${JSON.stringify(g)}`}`);
const tryRequire = (p) => { try { return require(p); } catch { return null; } };

const box = tryRequire("../utils/secretBox");
const KEY_A = "key-alpha-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "key-bravo-bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHEETS_KEY = "sheets-key-cccccccccccccccccccccccc";
const GOOGLE_RT = "1//0gEXAMPLE-google-refresh-token-value";
const IG_TOKEN = "IGQVJXEXAMPLE-instagram-long-lived-token";

// The LEGACY Sheets format, reproduced independently here (iv:tag:ciphertext,
// no version prefix) so the compatibility assertion does not depend on the code
// under test to build its own fixture.
const legacyEncrypt = (plain, secret) => {
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
};

const created = { admins: [], google: [], ig: [] };
const SAVED = {};
const save = (k) => { SAVED[k] = process.env[k]; };
const restore = () => Object.entries(SAVED).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });

(async () => {
  try {
    ok(!!box, "utils/secretBox exists");
    if (!box) throw new Error("helper not built yet — remaining assertions cannot run");
    const { encryptSecret, decryptSecret } = box;
    ok(typeof encryptSecret === "function" && typeof decryptSecret === "function",
      "it exports encryptSecret / decryptSecret");

    console.log("\n1. ROUND TRIP, VERSIONED, AND PLAINTEXT PASSES THROUGH");
    {
      const blob = encryptSecret(GOOGLE_RT, KEY_A);
      ok(blob.startsWith("v1.gcm:"), `the stored value carries its own version marker (${blob.slice(0, 12)}…)`);
      ok(!blob.includes(GOOGLE_RT), "…and the plaintext is nowhere in it");
      eq(decryptSecret(blob, KEY_A), GOOGLE_RT, "…and it round-trips");

      // Two encryptions of the same value must differ — a fresh IV each time.
      ok(encryptSecret(GOOGLE_RT, KEY_A) !== encryptSecret(GOOGLE_RT, KEY_A),
        "each encryption uses a fresh IV, so identical inputs differ on disk");

      // A row written before this shipped has no prefix and IS the secret.
      eq(decryptSecret(GOOGLE_RT, KEY_A), GOOGLE_RT,
        "an UNPREFIXED value is treated as plaintext and returned as-is");
      eq(decryptSecret("", KEY_A), "", "an empty value stays empty");
      eq(decryptSecret(null, KEY_A), "", "a null value does not throw");
    }

    console.log("\n2. KEY ISOLATION — THE TRAP");
    {
      // The whole reason the key is a parameter. If the promoted helper had
      // baked in one module-level key, this is the case that would have failed
      // in production and nowhere else.
      const underA = encryptSecret(GOOGLE_RT, KEY_A);
      let wrong = null;
      try { wrong = decryptSecret(underA, KEY_B); } catch (e) { wrong = `THREW: ${e.message}`; }
      ok(wrong !== GOOGLE_RT, `a value encrypted under key A does NOT decrypt under key B (got ${JSON.stringify(String(wrong)).slice(0, 40)}…)`);
      eq(decryptSecret(underA, KEY_A), GOOGLE_RT, "…while key A still reads it");

      // The compatibility requirement: an EXISTING Sheets row, in the old
      // unversioned format, must still decrypt through the promoted helper when
      // given the Sheets key.
      const legacyRow = legacyEncrypt("sheets-refresh-token", SHEETS_KEY);
      ok(!legacyRow.startsWith("v1."), "a legacy Sheets row has no version prefix (fixture sanity)");
      eq(decryptSecret(legacyRow, SHEETS_KEY, { legacy: true }), "sheets-refresh-token",
        "…and the promoted helper still decrypts it with the SHEETS key");
      ok(decryptSecret(legacyRow, KEY_A, { legacy: true }) !== "sheets-refresh-token",
        "…but not with a different key");
    }

    console.log("\n3. A DECRYPT FAILURE IS LOUD");
    {
      const logs = [];
      const realLog = console.log;
      console.log = (...a) => { logs.push(a.join(" ")); realLog(...a); };
      try {
        const underA = encryptSecret(GOOGLE_RT, KEY_A);
        try { decryptSecret(underA, KEY_B, { label: "GoogleAccount", ref: "admin123" }); } catch (_) { /* may throw */ }
        const line = logs.find((l) => l.includes("[secretbox]"));
        ok(!!line, "a failed decrypt logs a [secretbox] line");
        ok(line && /DECRYPT FAILED/i.test(line), "…saying DECRYPT FAILED");
        ok(line && line.includes("admin123"), "…naming the row, so it can be chased");
        ok(line && !line.includes(GOOGLE_RT), "…without echoing the secret");
        ok(line && !line.includes(KEY_A) && !line.includes(KEY_B), "…and without echoing either key");
      } finally { console.log = realLog; }
    }

    // ── The two stores ──────────────────────────────────────────────────────
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    ["CREDENTIAL_ENC_KEY", "SHEETS_TOKEN_ENC_KEY"].forEach(save);
    process.env.CREDENTIAL_ENC_KEY = KEY_A;

    const GoogleAccount = require("../models/GoogleAccount");
    const ConnectedInstagramAccount = require("../models/ConnectedInstagramAccount");
    const TAG = `sbox-${Date.now()}`;

    console.log("\n4. GoogleAccount.refreshToken");
    {
      const svc = require("../services/GoogleWorkspaceService");
      ok(typeof svc.storedRefreshToken === "function",
        "the service exposes the read that resolves a stored token");

      const adminId = new mongoose.Types.ObjectId();
      // A row written the NEW way.
      const encRow = await GoogleAccount.create({
        adminId, email: `${TAG}-enc@wedsy.in`,
        refreshToken: svc.sealRefreshToken(GOOGLE_RT),
      });
      created.google.push(encRow._id);
      const rawEnc = await GoogleAccount.findById(encRow._id).lean();
      ok(rawEnc.refreshToken.startsWith("v1.gcm:"), "a newly linked account stores CIPHERTEXT");
      ok(!rawEnc.refreshToken.includes(GOOGLE_RT), "…the plaintext is not on disk");
      eq(svc.storedRefreshToken(rawEnc), GOOGLE_RT, "…and reads back as the original token");

      // A row written BEFORE this shipped: plaintext, no prefix.
      const legacyRow = await GoogleAccount.create({
        adminId: new mongoose.Types.ObjectId(), email: `${TAG}-plain@wedsy.in`,
        refreshToken: GOOGLE_RT,
      });
      created.google.push(legacyRow._id);
      const rawPlain = await GoogleAccount.findById(legacyRow._id).lean();
      eq(svc.storedRefreshToken(rawPlain), GOOGLE_RT,
        "an EXISTING plaintext row still resolves — lazy migration, not a break");
    }

    console.log("\n5. ConnectedInstagramAccount.accessToken");
    {
      const ig = require("../services/ConnectedInstagramAccountService");
      ok(ig && typeof ig.storedAccessToken === "function" && typeof ig.sealAccessToken === "function",
        "the Instagram store exposes the same seal/resolve pair");
      if (ig && ig.sealAccessToken) {
        const row = await ConnectedInstagramAccount.create({
          instagramUserId: `${TAG}-1`, username: `${TAG}`,
          accessToken: ig.sealAccessToken(IG_TOKEN),
          tokenExpiresAt: new Date(Date.now() + 60 * 864e5),
        });
        created.ig.push(row._id);
        const raw = await ConnectedInstagramAccount.findById(row._id).lean();
        ok(raw.accessToken.startsWith("v1.gcm:"), "a connected account stores CIPHERTEXT");
        ok(!raw.accessToken.includes(IG_TOKEN), "…the plaintext is not on disk");
        eq(ig.storedAccessToken(raw), IG_TOKEN, "…and reads back as the original token");

        const plain = await ConnectedInstagramAccount.create({
          instagramUserId: `${TAG}-2`, username: `${TAG}b`,
          accessToken: IG_TOKEN, tokenExpiresAt: new Date(Date.now() + 60 * 864e5),
        });
        created.ig.push(plain._id);
        eq(ig.storedAccessToken(await ConnectedInstagramAccount.findById(plain._id).lean()), IG_TOKEN,
          "an EXISTING plaintext row still resolves");
      }
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite stopped:", e && e.message ? e.message : e);
    fail++;
  } finally {
    restore();
    if (mongoose.connection.readyState === 1) {
      const GA = mongoose.models.GoogleAccount;
      const CIA = mongoose.models.ConnectedInstagramAccount;
      if (GA && created.google.length) await GA.deleteMany({ _id: { $in: created.google } });
      if (CIA && created.ig.length) await CIA.deleteMany({ _id: { $in: created.ig } });
      await mongoose.disconnect();
    }
    process.exit(fail === 0 ? 0 : 1);
  }
})();
