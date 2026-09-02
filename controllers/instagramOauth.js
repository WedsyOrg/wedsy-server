const crypto = require("crypto");
const ConnectedInstagramAccount = require("../models/ConnectedInstagramAccount");
const InstagramOAuthState = require("../models/InstagramOAuthState");
const {
  buildAuthorizeUrl,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  fetchProfileWithToken,
  sanitizeError,
} = require("../utils/instagram");

// ───────────────────────────────────────────────────────────────────────────
// Instagram Login OAuth — the connect flow Meta's app review needs to see, and
// the reason Wedsy stops depending on a token minted by hand in the dashboard.
//
// Two halves with very different trust:
//   • /connect is authed. It knows who is asking and stamps them on the state.
//   • /callback is NOT authed and cannot be. Meta redirects the user's browser
//     to it cross-site, so no session cookie arrives. `state` is the CSRF guard
//     (single-use, TTL'd — see models/InstagramOAuthState), and the acting
//     admin is read back off that record rather than from a session.
// ───────────────────────────────────────────────────────────────────────────

// A Meta reviewer may well be watching this redirect. Every failure exit is a
// short opaque code on a normal-looking page — never a stack trace, never a
// Meta error string (which can quote our own credentials back at us).
const REASONS = {
  NOT_CONFIGURED: "not_configured",
  DENIED: "denied",
  MISSING_CODE: "missing_code",
  INVALID_STATE: "invalid_state",
  EXCHANGE_FAILED: "exchange_failed",
  PROFILE_FAILED: "profile_failed",
  SAVE_FAILED: "save_failed",
  SERVER_ERROR: "server_error",
};

const appOrigin = () => (process.env.OS_APP_ORIGIN || "").replace(/\/+$/, "");

// WHO is connecting, and FOR WHICH VENUE — read at /connect time, while the
// request still has an identity on it. /callback is unauthenticated and cannot
// re-derive any of this, so it is stamped on the state record and read back.
//
// Three request shapes, because the guard on these routes is expected to
// change: CheckAdminLogin puts the admin on req.auth today, while
// middlewares/adminOrVenueOwnerAuth (the guard the owner portal will need —
// see the routes file) puts an admin on req.admin and a venue identity on
// req.venueOwner. Handling all three now means swapping the guard is a
// one-line change rather than a rewrite of this function.
//
// An admin connecting from the OS inbox gets venue: null — Wedsy's own account.
const resolveActor = (req) => {
  // Venue owner or team member, via adminOrVenueOwnerAuth.
  const vo = req.venueOwner;
  if (vo && vo.venueId) {
    return {
      connectedBy: vo.venueOwnerId || vo.memberId || null,
      connectedByType: vo.venueOwnerId ? "venueOwner" : "venueMember",
      venue: vo.venueId,
    };
  }
  // Admin, either guard.
  const adminId = (req.auth && req.auth.user_id) || (req.admin && req.admin._id) || null;
  return { connectedBy: adminId, connectedByType: adminId ? "admin" : null, venue: null };
};

const redirectToInbox = (res, { ok, reason }) => {
  const base = `${appOrigin()}/instagram`;
  const query = ok
    ? "instagram_connected=1"
    : `instagram_connected=0&reason=${encodeURIComponent(reason || REASONS.SERVER_ERROR)}`;
  return res.redirect(`${base}?${query}`);
};

// GET /instagram-agent/connect  (CheckAdminLogin)
// Returns the URL for the frontend to send the browser to. Deliberately does
// NOT redirect: the caller is an XHR from the CRM, and a 302 on an XHR would be
// followed by fetch and never reach Instagram's consent screen in a top-level
// window.
const Connect = async (req, res) => {
  try {
    if (!process.env.INSTAGRAM_APP_ID || !process.env.INSTAGRAM_OAUTH_REDIRECT_URI) {
      return res.status(500).json({
        message: "Instagram OAuth is not configured on this server.",
        reason: REASONS.NOT_CONFIGURED,
      });
    }

    // 32 bytes of CSPRNG — this value is the only thing proving the callback
    // belongs to a flow we started.
    const state = crypto.randomBytes(32).toString("hex");
    const actor = resolveActor(req);
    await InstagramOAuthState.create({
      state,
      // Stamped HERE, while the request is still authenticated. /callback has
      // no other way to learn who connected the account, or for which venue.
      adminId: actor.connectedBy,
      connectedByType: actor.connectedByType,
      venue: actor.venue,
    });

    const authorizeUrl = buildAuthorizeUrl(state);
    if (!authorizeUrl) {
      return res.status(500).json({
        message: "Instagram OAuth is not configured on this server.",
        reason: REASONS.NOT_CONFIGURED,
      });
    }
    return res.status(200).json({ authorizeUrl });
  } catch (error) {
    console.error("[InstagramOAuth] connect failed:", sanitizeError(error));
    return res.status(500).json({ message: "Could not start Instagram authorisation." });
  }
};

// GET /instagram-agent/callback  (NO AUTH — Meta redirects the browser here)
const Callback = async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query || {};

    // The user pressed Cancel on Instagram's consent screen. Not a fault.
    if (oauthError) {
      return redirectToInbox(res, { ok: false, reason: REASONS.DENIED });
    }
    if (!code) {
      return redirectToInbox(res, { ok: false, reason: REASONS.MISSING_CODE });
    }
    if (!state) {
      return redirectToInbox(res, { ok: false, reason: REASONS.INVALID_STATE });
    }

    // SINGLE-USE STATE, consumed atomically. findOneAndUpdate matching
    // consumedAt:null is the whole guard — a replayed callback matches nothing
    // and gets the same answer as a forged one. Missing, unknown, expired (TTL)
    // and already-used are deliberately indistinguishable to the caller.
    const stateRecord = await InstagramOAuthState.findOneAndUpdate(
      { state, consumedAt: null },
      { $set: { consumedAt: new Date() } },
      { new: true }
    );
    if (!stateRecord) {
      console.warn("[InstagramOAuth] callback rejected: missing, unknown or reused state");
      return redirectToInbox(res, { ok: false, reason: REASONS.INVALID_STATE });
    }

    // Short-lived, then long-lived (~60d). Both calls live in utils/instagram.
    let longLived;
    try {
      const shortLived = await exchangeCodeForShortLivedToken(code);
      longLived = await exchangeForLongLivedToken(shortLived.accessToken);
    } catch (error) {
      // Already logged, already sanitised, inside utils/instagram.
      return redirectToInbox(res, { ok: false, reason: REASONS.EXCHANGE_FAILED });
    }

    let profile;
    try {
      profile = await fetchProfileWithToken(longLived.accessToken);
    } catch (error) {
      return redirectToInbox(res, { ok: false, reason: REASONS.PROFILE_FAILED });
    }
    if (!profile.instagramUserId) {
      return redirectToInbox(res, { ok: false, reason: REASONS.PROFILE_FAILED });
    }

    try {
      // UPSERT on instagramUserId: reconnecting the same account refreshes its
      // row (and un-revokes it); a DIFFERENT account gets its own row and does
      // not displace the first. That is the whole multi-account story.
      await ConnectedInstagramAccount.findOneAndUpdate(
        { instagramUserId: profile.instagramUserId },
        {
          $set: {
            username: profile.username,
            accessToken: longLived.accessToken,
            tokenExpiresAt: new Date(Date.now() + longLived.expiresIn * 1000),
            lastRefreshedAt: new Date(),
            status: "active",
            connectedBy: stateRecord.adminId || null,
            connectedByType: stateRecord.connectedByType || null,
            // null = Wedsy's own account. Nothing resolves tokens by venue yet
            // (see the model) — this only records the association.
            venue: stateRecord.venue || null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (error) {
      console.error("[InstagramOAuth] could not persist connected account:", sanitizeError(error, longLived.accessToken));
      return redirectToInbox(res, { ok: false, reason: REASONS.SAVE_FAILED });
    }

    console.log(`[InstagramOAuth] connected @${profile.username} (${profile.instagramUserId})`);
    return redirectToInbox(res, { ok: true });
  } catch (error) {
    console.error("[InstagramOAuth] callback failed:", sanitizeError(error));
    return redirectToInbox(res, { ok: false, reason: REASONS.SERVER_ERROR });
  }
};

// POST /instagram-agent/disconnect  (CheckAdminLogin)
// Marks the row revoked rather than deleting it: the audit trail of who
// connected what, and when, outlives the connection. A later reconnect of the
// same account flips it back to active via the callback upsert.
const Disconnect = async (req, res) => {
  try {
    const { instagramUserId } = req.body || {};
    const filter = instagramUserId
      ? { instagramUserId: String(instagramUserId), status: "active" }
      : { status: "active" };

    // Without an explicit id, refuse to guess when more than one account is
    // connected — silently revoking the wrong inbox is worse than an error.
    if (!instagramUserId) {
      const activeCount = await ConnectedInstagramAccount.countDocuments({ status: "active" });
      if (activeCount > 1) {
        return res.status(400).json({
          message: "More than one Instagram account is connected — specify instagramUserId.",
        });
      }
    }

    const updated = await ConnectedInstagramAccount.findOneAndUpdate(
      filter,
      { $set: { status: "revoked" } },
      { new: true }
    );
    if (!updated) {
      return res.status(404).json({ message: "No connected Instagram account found." });
    }
    console.log(`[InstagramOAuth] disconnected @${updated.username} (${updated.instagramUserId})`);
    return res.status(200).json({
      message: "Instagram account disconnected.",
      instagramUserId: updated.instagramUserId,
      username: updated.username,
    });
  } catch (error) {
    console.error("[InstagramOAuth] disconnect failed:", sanitizeError(error));
    return res.status(500).json({ message: "Could not disconnect the Instagram account." });
  }
};

module.exports = { Connect, Callback, Disconnect, REASONS };
