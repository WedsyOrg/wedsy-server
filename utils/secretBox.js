/* SECRET BOX — authenticated encryption for third-party credentials at rest.
 *
 * Live credentials belonging to other people's accounts sat in MongoDB as plain
 * text: a per-admin Google refresh token (calendar write) and the Instagram
 * Graph token for the business account (DMs). Both are re-obtainable by a
 * consent flow, so the stakes are inconvenience rather than destruction — but
 * both also travel into every nightly mongodump, which lands somewhere with
 * different access control from the database.
 *
 * ── THE KEY IS A PARAMETER, AND THAT IS THE POINT ─────────────────────────
 *
 * This scheme already existed in utils/googleSheets.js, bound to a
 * module-level SHEETS_TOKEN_ENC_KEY. Promoting it while binding it to a NEW
 * env key would have stopped every existing VenueSheetIntegration row
 * decrypting — silently, and only for whoever next touched a sheet.
 *
 * So no key is baked in here. Every caller passes its own, and stores stay
 * independent: rotating one cannot break another. tests/secret-box.test.js
 * proves the isolation rather than asserting it.
 *
 * ── THE STORED FORMAT ─────────────────────────────────────────────────────
 *
 *   v1.gcm:<iv b64>:<tag b64>:<ciphertext b64>
 *
 * The version prefix is what makes three things possible without guessing at
 * what a given row is: telling ciphertext from plaintext during migration,
 * reverting the code without data loss, and changing algorithm later.
 *
 * A value WITHOUT the prefix is plaintext, and is returned as-is. That single
 * rule IS the lazy migration and IS the rollback story — see DEPLOY.md.
 *
 * ── LEGACY ────────────────────────────────────────────────────────────────
 *
 * VenueSheetIntegration rows predate the prefix and are stored as bare
 * <iv>:<tag>:<ciphertext>. That shape is indistinguishable from plaintext by
 * inspection, so it is NOT sniffed: a caller that holds such rows opts in with
 * { legacy: true }. Only the Sheets integration does, which keeps the fact
 * documented where the data actually lives instead of as a global guess.
 */
const crypto = require("crypto");

const V1 = "v1.gcm:";

// 32 bytes from whatever passphrase the caller holds. Same derivation the
// Sheets implementation has always used, so existing rows keep working.
const deriveKey = (secret) => crypto.createHash("sha256").update(String(secret)).digest();

const isSealed = (value) => typeof value === "string" && value.startsWith(V1);

/**
 * Encrypt a secret for storage.
 *
 * @param {string} plain   the credential
 * @param {string} keySecret  the passphrase for THIS store
 * @returns {string} v1.gcm:iv:tag:ciphertext
 */
function encryptSecret(plain, keySecret) {
  if (!keySecret) throw new Error("secretBox: no key supplied");
  const key = deriveKey(keySecret);
  // A fresh IV per encryption. Reusing one under GCM is catastrophic — it leaks
  // the XOR of the plaintexts and forges the authenticator — so it is generated
  // here rather than derived from anything.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [V1.slice(0, -1), iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

const gcmOpen = (key, ivB, tagB, dataB) => {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
  d.setAuthTag(Buffer.from(tagB, "base64"));
  // final() throws unless the tag authenticates — this is what makes a wrong
  // key a loud failure instead of silent garbage.
  return Buffer.concat([d.update(Buffer.from(dataB, "base64")), d.final()]).toString("utf8");
};

/**
 * Resolve a stored value to its secret.
 *
 * NEVER THROWS on a bad key. A credential that cannot be decrypted is a
 * reconnect, not an outage, and the caller decides what to do — so this
 * returns "" and LOGS, loudly, with the row's identity and never the secret or
 * the key. A key mismatch after a deploy shows up in the logs in minutes
 * rather than as a user complaint days later.
 *
 * @param {string} stored
 * @param {string} keySecret
 * @param {object} [opts]
 * @param {boolean} [opts.legacy]  accept bare iv:tag:ciphertext (Sheets only)
 * @param {string}  [opts.label]   which store, for the log
 * @param {string}  [opts.ref]     which row, for the log
 * @returns {string} the secret, or "" when it cannot be resolved
 */
function decryptSecret(stored, keySecret, opts = {}) {
  const value = stored == null ? "" : String(stored);
  if (!value) return "";
  const { legacy = false, label = "secret", ref = "" } = opts;
  const where = `${label}${ref ? ` ref=${ref}` : ""}`;

  const fail = (why) => {
    console.log(`[secretbox] DECRYPT FAILED ${where} — ${why}. The credential cannot be used; reconnecting re-issues it.`);
    return "";
  };

  if (isSealed(value)) {
    const [, ivB, tagB, dataB] = value.split(":");
    if (!ivB || !tagB || !dataB) return fail("malformed v1 payload");
    if (!keySecret) return fail("no key configured");
    try {
      return gcmOpen(deriveKey(keySecret), ivB, tagB, dataB);
    } catch (_) {
      // Authentication failed: wrong key, or the row was tampered with. Both
      // are the same remedy and neither is distinguishable from here.
      return fail("wrong key or tampered value");
    }
  }

  if (legacy) {
    const parts = value.split(":");
    if (parts.length === 3 && parts.every(Boolean)) {
      if (!keySecret) return fail("no key configured (legacy row)");
      try {
        return gcmOpen(deriveKey(keySecret), parts[0], parts[1], parts[2]);
      } catch (_) {
        return fail("wrong key or tampered value (legacy row)");
      }
    }
  }

  // No prefix, and not a legacy row: it is plaintext, from before this shipped.
  // Returned as-is, which is what makes the migration lazy and the rollback
  // survivable.
  return value;
}

module.exports = { encryptSecret, decryptSecret, isSealed, deriveKey, V1 };
