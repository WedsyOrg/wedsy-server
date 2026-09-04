const NotificationFailureLog = require('../models/NotificationFailureLog');

// Mock seam (MB6 Slice 7) — same idiom as META_GRAPH_BASE_URL in utils/whatsapp.
const IG_GRAPH_BASE_URL = process.env.INSTAGRAM_GRAPH_BASE_URL || 'https://graph.instagram.com/v25.0';
// The OAuth token endpoints are UNVERSIONED (graph.instagram.com/access_token,
// not /v25.0/access_token), so they need their own root — reusing the versioned
// base above 404s. Same test-seam idiom.
const IG_GRAPH_ROOT_URL = process.env.INSTAGRAM_GRAPH_ROOT_URL || 'https://graph.instagram.com';
const IG_API_BASE_URL = process.env.INSTAGRAM_API_BASE_URL || 'https://api.instagram.com';
const IG_AUTHORIZE_BASE_URL = process.env.INSTAGRAM_AUTHORIZE_BASE_URL || 'https://www.instagram.com';

// Instagram Login scopes for the Tech Provider model (Meta app review).
const OAUTH_SCOPES = 'instagram_business_basic,instagram_business_manage_messages';

// ───────────────────────────────────────────────────────────────────────────
// SECRET REDACTION — read this before touching any error path below.
//
// The refresh call is  GET .../refresh_access_token?access_token=<LIVE TOKEN>.
// The token travels in the URL, so it lands in the error object: axios copies
// the full URL onto config.url and usually into .message, and undici/fetch can
// surface it via .cause. The house pattern —
//   NotificationFailureLog.create({ error: error.message })
// — would therefore write a LIVE ACCESS TOKEN into MongoDB in plaintext on
// every single failure, where it sits until someone notices. The same is true
// of the two OAuth exchange calls, which carry the APP SECRET.
//
// So nothing derived from an error reaches a log, a notification or a console
// line except through sanitizeError() below. Two independent defences, because
// either one alone has a hole:
//   1. exact-match on the credentials we know (catches a short/odd-shaped one)
//   2. shape-based redaction (catches a credential we were never handed —
//      including the NEW token inside a response body)
// Query strings are stripped wholesale: nothing we need to debug lives there,
// and everything we must not persist does.
// ───────────────────────────────────────────────────────────────────────────
const REDACTED = '[redacted]';
// Long unbroken run of URL-safe chars = credential-shaped. IG tokens (IGAA…,
// ~150+ chars) and the 32-char hex app secret both match; ordinary words,
// numeric ids and HTTP status codes do not.
const TOKEN_SHAPED = /[A-Za-z0-9_-]{32,}/g;
// A run this long agreeing with a known secret is that secret, truncated. Set
// to match the standard the leak tests assert (no 12-character window of a
// credential may survive), so the two cannot drift apart.
const FRAGMENT_MIN = 12;

// Redact any leading-or-inner fragment of `secret` that appears in `text`,
// extending each match as far as it keeps agreeing with the secret. Cheap: it
// only scans when a FRAGMENT_MIN-length window of the secret is actually
// present, which for ordinary log text is never.
const redactFragments = (text, secret) => {
  if (!secret || secret.length < FRAGMENT_MIN) return text;
  let out = text;
  for (let start = 0; start + FRAGMENT_MIN <= secret.length; start++) {
    const probe = secret.slice(start, start + FRAGMENT_MIN);
    let idx = out.indexOf(probe);
    while (idx !== -1) {
      // Extend the match rightwards for as long as it tracks the secret.
      let len = FRAGMENT_MIN;
      while (
        start + len < secret.length &&
        idx + len < out.length &&
        out[idx + len] === secret[start + len]
      ) len++;
      out = out.slice(0, idx) + REDACTED + out.slice(idx + len);
      idx = out.indexOf(probe, idx + REDACTED.length);
    }
  }
  return out;
};

const redactSecrets = (input, extraSecrets = []) => {
  let text = typeof input === 'string' ? input : String(input == null ? '' : input);

  // 1. Exact known credentials first — a short or unusually shaped secret would
  //    slip past the shape rule below, so it is removed by literal match.
  const secrets = [
    process.env.INSTAGRAM_APP_SECRET,
    process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN,
    ...(Array.isArray(extraSecrets) ? extraSecrets : [extraSecrets]),
  ];
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue; // too short to redact safely
    text = text.split(secret).join(REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) text = text.split(encoded).join(REDACTED);
    // 1b. TRUNCATED FRAGMENTS of a known secret. A caller that slices a message
    //     containing a token can leave a partial one behind: too short for the
    //     shape rule below, not equal to the secret so the exact rule misses it.
    //     Anything that agrees with a known secret for FRAGMENT_MIN characters
    //     is treated as that secret and redacted along its whole matching run.
    text = redactFragments(text, secret);
  }

  // 2. Every query string, whole. This is the one that actually catches
  //    ?access_token=… / ?client_secret=… on a URL we did not anticipate.
  text = text.replace(/\?[^\s"'`\\]*/g, `?${REDACTED}`);

  // 3. Anything still credential-shaped anywhere else — a header echo, a JSON
  //    body containing the rotated token, a Meta error quoting the input.
  text = text.replace(TOKEN_SHAPED, REDACTED);

  return text;
};

// Build the ONE string any Instagram failure is allowed to persist or print.
// Pulls from every place a URL or body is known to hide (axios config/response,
// fetch cause) and pushes the lot through redactSecrets. Pass the live token as
// an extra secret whenever the call carried one.
const sanitizeError = (error, extraSecrets = []) => {
  const parts = [];
  if (error && error.message) parts.push(String(error.message));
  if (error && error.config && error.config.url) parts.push(`url=${error.config.url}`);
  if (error && error.response && error.response.data !== undefined) {
    try {
      const data = error.response.data;
      parts.push(`body=${typeof data === 'string' ? data : JSON.stringify(data)}`);
    } catch (_) { /* unserialisable body — the message above still stands */ }
  }
  if (error && error.cause && error.cause.message) parts.push(`cause=${error.cause.message}`);
  if (!parts.length) parts.push(String(error));
  // Capped: a redacted Meta HTML error page is still useless at 40kB.
  return redactSecrets(parts.join(' | '), extraSecrets).slice(0, 1000);
};

// ───────────────────────────────────────────────────────────────────────────
// TOKEN RESOLUTION
//
// ConnectedInstagramAccount is the token of record. The env var is a BOOTSTRAP
// FALLBACK for exactly one deploy: it keeps production sending DMs in the
// window between this shipping and the first OAuth connect (or the seed
// script) writing a row. Once an active row exists the env var is never read.
// Delete INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN from the EC2 .env after the first
// successful connect and this fallback becomes dead code.
//
// Multi-account note: with more than one active row this picks the most
// recently connected. Routing an outbound DM to the account that owns the
// conversation is a separate change (the webhook already carries the recipient
// account id) — today Wedsy runs exactly one connected account.
// ───────────────────────────────────────────────────────────────────────────
const resolveAccessToken = async (instagramUserId = null) => {
  try {
    const ConnectedInstagramAccount = require('../models/ConnectedInstagramAccount');
    const filter = instagramUserId
      ? { instagramUserId: String(instagramUserId), status: 'active' }
      : { status: 'active' };
    const account = await ConnectedInstagramAccount.findOne(filter)
      .sort({ updatedAt: -1 })
      .lean();
    if (account && account.accessToken) return account.accessToken;
  } catch (error) {
    // A DB hiccup must not take the inbox down while the fallback still exists.
    console.error('[Instagram] token lookup failed, falling back to env:', sanitizeError(error));
  }
  return process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN || null;
};

const sendInstagramDM = async (recipientId, message) => {
  const MAX_RETRIES = 2;
  let attempt = 0;

  const token = await resolveAccessToken();
  if (!token) {
    // Three round trips and 4s of backoff cannot rescue a request with no
    // credential — but the failure must still be VISIBLE, because "no token"
    // is exactly the outage this whole change exists to prevent.
    console.error('[Instagram] no access token available — DM not sent');
    try {
      await NotificationFailureLog.create({
        service: 'Instagram',
        phone: recipientId,
        error: 'No Instagram access token: no active ConnectedInstagramAccount and no env fallback',
        attempts: 0,
        createdAt: new Date(),
      });
    } catch (logErr) {
      console.error('[Instagram] Failed to log failure:', sanitizeError(logErr));
    }
    return null;
  }

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await fetch(
        `${IG_GRAPH_BASE_URL}/me/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text: message }
          })
        }
      );
      if (!response.ok) {
        // Surface Meta's actual error body instead of a bare status. A 400 here
        // is almost always diagnosable ONLY from the body — e.g. the standard
        // access limitation (the app may message only users with a role on it
        // until instagram_business_manage_messages is approved), an expired
        // 24-hour window, or an unknown recipient id. Without this, every
        // distinct cause logs the same useless "Instagram API error: 400".
        // Mirrors the same fix already in utils/whatsapp.js.
        // REDACT BEFORE TRUNCATING — the order matters and is the whole fix.
        // Slicing first can CUT a token so that fewer than TOKEN_SHAPED's 32
        // characters survive: the fragment then matches neither the exact-secret
        // rule (it is not the whole token) nor the shape rule (too short), and a
        // leading fragment of a live token reaches the log in plaintext.
        // Redacting the FULL body first means the exact rule sees the whole
        // token, and only redacted text is ever truncated.
        const errBody = redactSecrets(await response.text().catch(() => ''), token);
        throw new Error(`Instagram API error: ${response.status} ${errBody.slice(0, 300)}`);
      }
      return await response.json();
    } catch (error) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        const safe = sanitizeError(error, token);
        try {
          await NotificationFailureLog.create({
            service: 'Instagram',
            phone: recipientId,
            error: safe,
            attempts: attempt,
            createdAt: new Date()
          });
        } catch (logErr) {
          console.error('[Instagram] Failed to log failure:', sanitizeError(logErr, token));
        }
        console.error(`[Instagram] Failed after ${attempt} attempts:`, safe);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

// Fetch an Instagram user's display name/username via the Graph API. The IG
// message webhook carries only the scoped user id (no name), unlike WhatsApp —
// so the name needs this separate lookup. Mirrors sendInstagramDM (same base
// URL + token source + INSTAGRAM_GRAPH_BASE_URL test seam). Fire-safe: returns
// "" on any failure so the inbound flow never breaks on a missing name.
const fetchInstagramProfile = async (igsid) => {
  try {
    // No early return on a missing token, deliberately: this function is
    // fire-safe by contract and a missing token already lands on the `!ok`
    // branch below. Guarding here would change behaviour for callers that only
    // want a display name.
    const token = await resolveAccessToken();
    const response = await fetch(
      `${IG_GRAPH_BASE_URL}/${igsid}?fields=name,username`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) return "";
    const data = await response.json();
    return (data && (data.name || data.username)) || "";
  } catch (error) {
    console.error("[Instagram] profile fetch failed:", sanitizeError(error));
    return "";
  }
};

// The connected Instagram professional account's own profile (Meta app review:
// the inbox must render "username, profile pic or other profile information" of
// the connected account, so the reviewer sees the permission doing visible work).
//
// This base URL is graph.instagram.com (Instagram Login surface), so /me IS the
// Instagram account — but its `id` is app-scoped; `user_id` is the real
// Instagram account id, so that is what callers get as `id`.
//
// profile_picture_url is a short-lived Meta CDN URL: callers must NOT persist
// it (it silently expires — during Meta's review, not ours). Re-fetch per call.
// Same idiom as sendInstagramDM: 2 retries, failure to NotificationFailureLog.
//
// The token now comes from ConnectedInstagramAccount (env fallback only until
// the first connect) — behaviour is otherwise unchanged: 2 retries, failure log
// on final attempt, returns null rather than throwing.
const fetchConnectedInstagramAccount = async () => {
  const token = await resolveAccessToken();
  if (!token) return null; // unconfigured — no network call, no retry, no log spam

  const MAX_RETRIES = 2;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await fetch(
        `${IG_GRAPH_BASE_URL}/me?fields=user_id,username,profile_picture_url`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!response.ok) {
        // Same reasoning as sendInstagramDM: an expired or revoked token and a
        // malformed request both surface as a bare 400 otherwise, and this is
        // the call behind the connected-account panel.
        // Redact BEFORE truncating — see the note in sendInstagramDM. Slicing a
        // raw body can leave a sub-32-character token fragment that both
        // redaction rules miss.
        const errBody = redactSecrets(await response.text().catch(() => ''), token);
        throw new Error(`Instagram API error: ${response.status} ${errBody.slice(0, 300)}`);
      }
      const data = await response.json();
      if (!data || !data.username) throw new Error('Instagram API error: no username in /me response');
      return {
        id: String(data.user_id || data.id || ''),
        username: data.username,
        profilePictureUrl: data.profile_picture_url || '',
      };
    } catch (error) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        const safe = sanitizeError(error, token);
        try {
          await NotificationFailureLog.create({
            service: 'Instagram',
            template: 'connected-account',
            error: safe,
            attempts: attempt,
            createdAt: new Date()
          });
        } catch (logErr) {
          console.error('[Instagram] Failed to log failure:', sanitizeError(logErr, token));
        }
        console.error(`[Instagram] connected-account fetch failed after ${attempt} attempts:`, safe);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

// ───────────────────────────────────────────────────────────────────────────
// OAUTH — Instagram Login (NOT Facebook Login). Every Meta HTTP call in the
// connect/refresh flow lives here; controllers and the cron job never reach the
// network themselves.
// ───────────────────────────────────────────────────────────────────────────

// A 4xx from Meta is an answer, not a blip: a spent authorisation code, a wrong
// redirect_uri, an expired token. Re-asking twice cannot change it and, for the
// single-use code exchange, only widens the window for something odd. Retry
// transport failures and 5xx; surface 4xx immediately.
class InstagramHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'InstagramHttpError';
    this.status = status;
    this.permanent = typeof status === 'number' && status >= 400 && status < 500;
  }
}

// Shared retry wrapper: 2 retries, one sanitised NotificationFailureLog row on
// final failure, then rethrow so the caller can pick its own reason code.
// `secrets` are the live credentials this particular call carried.
const igRequest = async (label, doFetch, { secrets = [], template, params = null } = {}) => {
  const MAX_RETRIES = 2;
  let attempt = 0;

  while (true) {
    try {
      return await doFetch();
    } catch (error) {
      attempt++;
      const permanent = error && error.permanent;
      if (permanent || attempt > MAX_RETRIES) {
        const safe = sanitizeError(error, secrets);
        try {
          await NotificationFailureLog.create({
            service: 'Instagram',
            template: template || label,
            error: safe,
            params,
            attempts: attempt,
            createdAt: new Date(),
          });
        } catch (logErr) {
          console.error('[Instagram] Failed to log failure:', sanitizeError(logErr, secrets));
        }
        console.error(`[Instagram] ${label} failed after ${attempt} attempt(s):`, safe);
        throw new InstagramHttpError(safe, error && error.status);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
};

// Parse a Meta token response. Meta answers 200-with-an-error-body often enough
// that status alone is not proof of success.
const readJson = async (response, label) => {
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* handled below */ }
  if (!response.ok) {
    // The body may quote the token back at us — redactSecrets runs over it in
    // sanitizeError before anything is persisted, but keep it short here too.
    const detail = data && data.error && data.error.message ? `: ${data.error.message}` : '';
    throw new InstagramHttpError(`${label} error: ${response.status}${detail}`, response.status);
  }
  if (!data) throw new InstagramHttpError(`${label} error: unparseable response body`, response.status);
  if (data.error) throw new InstagramHttpError(`${label} error: ${data.error.message || 'unknown'}`, response.status);
  return data;
};

// Step 1 — the URL the admin's browser is sent to. No secret in it: client_id
// is public, and `state` is the CSRF guard (see models/InstagramOAuthState).
const buildAuthorizeUrl = (state) => {
  const clientId = process.env.INSTAGRAM_APP_ID;
  const redirectUri = process.env.INSTAGRAM_OAUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    state,
  });
  return `${IG_AUTHORIZE_BASE_URL}/oauth/authorize?${params.toString()}`;
};

// Step 2 — authorization code → SHORT-lived token. Carries the app secret in
// the POST body (not the URL), but the error path is sanitised regardless.
const exchangeCodeForShortLivedToken = async (code) => {
  const clientId = process.env.INSTAGRAM_APP_ID;
  const clientSecret = process.env.INSTAGRAM_APP_SECRET;
  const redirectUri = process.env.INSTAGRAM_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new InstagramHttpError('Instagram OAuth is not configured', 500);
  }
  return await igRequest(
    'oauth-code-exchange',
    async () => {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      });
      const response = await fetch(`${IG_API_BASE_URL}/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const data = await readJson(response, 'oauth-code-exchange');
      if (!data.access_token) throw new InstagramHttpError('oauth-code-exchange error: no access_token in response', response.status);
      return { accessToken: data.access_token, userId: data.user_id ? String(data.user_id) : null };
    },
    { secrets: [clientSecret, code], template: 'oauth-code-exchange' }
  );
};

// Step 3 — short-lived → LONG-lived (~60 days). App secret AND token both ride
// in the query string here, which is exactly the leak sanitizeError exists for.
const exchangeForLongLivedToken = async (shortLivedToken) => {
  const clientSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!clientSecret) throw new InstagramHttpError('Instagram OAuth is not configured', 500);
  return await igRequest(
    'oauth-long-lived-exchange',
    async () => {
      const params = new URLSearchParams({
        grant_type: 'ig_exchange_token',
        client_secret: clientSecret,
        access_token: shortLivedToken,
      });
      const response = await fetch(`${IG_GRAPH_ROOT_URL}/access_token?${params.toString()}`);
      const data = await readJson(response, 'oauth-long-lived-exchange');
      if (!data.access_token || !data.expires_in) {
        throw new InstagramHttpError('oauth-long-lived-exchange error: incomplete token response', response.status);
      }
      return { accessToken: data.access_token, expiresIn: Number(data.expires_in) };
    },
    { secrets: [clientSecret, shortLivedToken], template: 'oauth-long-lived-exchange' }
  );
};

// Step 4 — who did we just connect? Explicit-token variant of
// fetchConnectedInstagramAccount: at callback time there is no stored row yet,
// so the token cannot be resolved from the DB.
const fetchProfileWithToken = async (token) => {
  return await igRequest(
    'oauth-profile',
    async () => {
      const response = await fetch(
        `${IG_GRAPH_BASE_URL}/me?fields=user_id,username,profile_picture_url`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await readJson(response, 'oauth-profile');
      if (!data.username) throw new InstagramHttpError('oauth-profile error: no username in /me response', response.status);
      return {
        instagramUserId: String(data.user_id || data.id || ''),
        username: data.username,
        profilePictureUrl: data.profile_picture_url || '',
      };
    },
    { secrets: [token], template: 'oauth-profile' }
  );
};

// Step 5 (weekly, forever) — rotate a long-lived token.
//
// THE RESPONSE CONTAINS A NEW TOKEN AND THE OLD ONE IS NOW WORTHLESS. The
// caller MUST persist the returned token as its very next statement — see the
// contract spelled out in utils/instagramTokenRefreshJob.js. Nothing is logged
// or notified from here on the success path.
//
// Two constraints from Meta that bite:
//   • the token must be at least 24 HOURS OLD to be refreshable (younger ones
//     are skipped by the job, not sent here);
//   • a token unused for 60 days expires regardless of refresh — this call
//     itself counts as use, which is half the reason the job runs weekly.
const refreshLongLivedToken = async (currentToken, { logParams = null } = {}) => {
  return await igRequest(
    'token-refresh',
    async () => {
      const params = new URLSearchParams({
        grant_type: 'ig_refresh_token',
        access_token: currentToken,
      });
      const response = await fetch(`${IG_GRAPH_ROOT_URL}/refresh_access_token?${params.toString()}`);
      const data = await readJson(response, 'token-refresh');
      if (!data.access_token || !data.expires_in) {
        throw new InstagramHttpError('token-refresh error: incomplete token response', response.status);
      }
      return { accessToken: data.access_token, expiresIn: Number(data.expires_in) };
    },
    { secrets: [currentToken], template: 'token-refresh', params: logParams }
  );
};

module.exports = {
  sendInstagramDM,
  fetchInstagramProfile,
  fetchConnectedInstagramAccount,
  // OAuth + refresh
  resolveAccessToken,
  buildAuthorizeUrl,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  fetchProfileWithToken,
  refreshLongLivedToken,
  // Exported for the refresh job, the controllers and the leak test.
  sanitizeError,
  redactSecrets,
  InstagramHttpError,
  OAUTH_SCOPES,
};
