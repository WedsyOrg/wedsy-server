/* THE INSTAGRAM ACCESS TOKEN, AT REST.
 *
 * ConnectedInstagramAccount.accessToken is a long-lived (~60 day) Instagram
 * Graph token for the BUSINESS account — it reads and sends DMs. One row
 * compromising the company's Instagram inbox is a wider blast radius than one
 * person's calendar, which is why this store was done alongside GoogleAccount
 * rather than after it.
 *
 * The token is rotated in place by utils/instagramTokenRefreshJob.js, so a
 * stolen copy stays valid until the next rotation.
 *
 * ONE HOME FOR THE SEAL AND THE RESOLVE. Four sites touch this field — the
 * OAuth write, the refresh job's read and its rotated write, and the resolver
 * in utils/instagram.js. Each of them calling secretBox directly would be four
 * chances to pass the wrong key or forget the label; this module is the single
 * place that knows how the field is stored.
 *
 * The key is CREDENTIAL_ENC_KEY, the same one GoogleAccount uses and NOT the
 * Sheets key — see utils/secretBox.js for why the key is a parameter.
 */
const { encryptSecret, decryptSecret } = require("../utils/secretBox");

const credentialKey = () => process.env.CREDENTIAL_ENC_KEY || "";

/**
 * Seal a token for storage.
 *
 * AN UNSET KEY IS NOT A FAILURE — it is exactly today's behaviour. Deploying
 * this before the key is set must not break connecting an account or rotating
 * a token, so it degrades to storing plain text and says so loudly. The log is
 * what stops "we will set it later" becoming permanent.
 */
const sealAccessToken = (plain) => {
  if (!plain) return "";
  if (!credentialKey()) {
    console.log(
      "[secretbox] NO KEY ConnectedInstagramAccount — CREDENTIAL_ENC_KEY is unset, so the access token " +
        "is stored in PLAIN TEXT (unchanged from before). Set it to encrypt at rest."
    );
    return String(plain);
  }
  return encryptSecret(String(plain), credentialKey());
};

/**
 * Resolve a stored row to its token.
 *
 * Returns "" when it cannot be resolved. Callers treat that as "no token",
 * which is the honest outcome and the correct remedy — reconnecting the
 * account re-issues one. A row written before this shipped is plain text and
 * passes straight through, which is what makes the migration lazy.
 */
const storedAccessToken = (account) =>
  decryptSecret(account && account.accessToken, credentialKey(), {
    label: "ConnectedInstagramAccount",
    ref: account && account.instagramUserId ? String(account.instagramUserId) : "",
  });

module.exports = { sealAccessToken, storedAccessToken };
