const crypto = require('crypto');

// ───────────────────────────────────────────────────────────────────────────
// META `signed_request` VERIFICATION.
//
// Meta posts this to the deauthorize and data-deletion callbacks, which are
// UNAUTHENTICATED and act on real data — revoking an account, scheduling a
// deletion. There is no session, no bearer token and no IP allowlist behind
// them. THIS FUNCTION IS THE ENTIRE SECURITY BOUNDARY. Anything it does not
// reject is treated downstream as a genuine instruction from Meta.
//
// So it fails CLOSED, always: every malformed, mis-signed, wrongly-algorithmed
// or unparseable request returns null and the caller does nothing. There is no
// partial handling and no benefit of the doubt — a request we cannot prove came
// from Meta is a request from an attacker.
//
// FORMAT:  <base64url signature>.<base64url payload>
// The signature is HMAC-SHA256 over the payload SEGMENT AS RECEIVED — the raw
// base64url text, NOT the decoded JSON. Re-encoding the decoded object would
// produce different bytes (key order, whitespace) and never verify.
// ───────────────────────────────────────────────────────────────────────────

// WHICH SECRET. INSTAGRAM_APP_SECRET is the Instagram app's secret — the same
// one the OAuth code/token exchange uses in utils/instagram.js.
//
// NOTE THE DUPLICATION: INSTAGRAM_AGENT_APP_SECRET (used by the message webhook
// in controllers/instagramAgent.js for x-hub-signature-256) currently holds the
// SAME VALUE. Two env vars, one secret. That is pre-existing and not changed
// here, but it is a trap: if either is ever rotated independently, one of the
// two verification paths starts rejecting every request from Meta and the
// symptom (silent 403s) looks nothing like the cause. Consolidating them is a
// separate change. This file deliberately uses the OAuth one.
const appSecret = () => process.env.INSTAGRAM_APP_SECRET || '';

// base64url → Buffer. Node's 'base64url' encoding handles the -/_ alphabet and
// missing padding, which Meta omits.
const fromBase64Url = (segment) => Buffer.from(segment, 'base64url');

const verifySignedRequest = (signedRequest) => {
  try {
    if (typeof signedRequest !== 'string' || !signedRequest) return null;

    const secret = appSecret();
    // No secret configured is a REJECTION, not a bypass. Getting this backwards
    // would turn a missing env var into an open door.
    if (!secret) {
      console.error('[MetaSignedRequest] INSTAGRAM_APP_SECRET is not set — rejecting');
      return null;
    }

    // Exactly two segments. A third dot is not a JWT we should be lenient about.
    const parts = signedRequest.split('.');
    if (parts.length !== 2) return null;
    const [encodedSig, encodedPayload] = parts;
    if (!encodedSig || !encodedPayload) return null;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(encodedPayload) // the RAW segment, exactly as sent
      .digest();
    const provided = fromBase64Url(encodedSig);

    // Constant-time. timingSafeEqual throws on a length mismatch, so the length
    // is checked first — and a wrong length is itself a rejection.
    if (provided.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(provided, expected)) return null;

    // Only NOW is the payload trustworthy enough to parse.
    let payload;
    try {
      payload = JSON.parse(fromBase64Url(encodedPayload).toString('utf8'));
    } catch (_) {
      return null;
    }
    if (!payload || typeof payload !== 'object') return null;

    // Meta states the algorithm in the payload. Anything else is either a
    // different product or someone probing for a downgrade.
    if (payload.algorithm && String(payload.algorithm).toUpperCase() !== 'HMAC-SHA256') {
      return null;
    }
    // user_id is the whole point of both callbacks; without it there is nothing
    // to act on and we must not guess.
    if (!payload.user_id) return null;

    return payload;
  } catch (error) {
    // Never let a parsing surprise become an accepted request.
    console.error('[MetaSignedRequest] verification error — rejecting');
    return null;
  }
};

module.exports = { verifySignedRequest };
