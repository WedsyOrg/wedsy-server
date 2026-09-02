const crypto = require("crypto");
const ConnectedInstagramAccount = require("../models/ConnectedInstagramAccount");
const InstagramDataDeletionRequest = require("../models/InstagramDataDeletionRequest");
const NotificationFailureLog = require("../models/NotificationFailureLog");
const { verifySignedRequest } = require("../utils/metaSignedRequest");
const { sanitizeError } = require("../utils/instagram");

// ───────────────────────────────────────────────────────────────────────────
// Meta app-review requirement: a deauthorize callback and a data-deletion
// request callback. Both are UNAUTHENTICATED POSTs from Meta carrying a
// `signed_request`, and both act on real data.
//
// utils/metaSignedRequest.verifySignedRequest is the whole security boundary.
// Every handler here treats a null return as final: reject, do nothing, log
// nothing sensitive. There is no "probably fine" path.
//
// LOGGING RULE. A signed_request payload identifies a real person and the
// segment itself is a live signed credential. Nothing raw from the request body
// is ever logged — not the signed_request, not the decoded payload. Errors go
// through the same sanitizeError() built for the token work, and the only
// identifier that reaches a log line is the Instagram user id, which we already
// store in the clear and need in order to act at all.
// ───────────────────────────────────────────────────────────────────────────

const logFailure = async (template, error, params = null) => {
  try {
    await NotificationFailureLog.create({
      service: "Instagram",
      template,
      error: sanitizeError(error),
      params,
      attempts: 1,
      createdAt: new Date(),
    });
  } catch (logErr) {
    console.error(`[InstagramPrivacy] failed to log ${template}:`, sanitizeError(logErr));
  }
};

// Pull signed_request from wherever the body parser put it. Meta sends
// form-urlencoded; JSON is accepted defensively. Never trusted until verified.
const readSignedRequest = (req) =>
  (req.body && (req.body.signed_request || req.body.signedRequest)) || null;

// The status URL handed to Meta and to the person. Absolute, because it is
// opened from Meta's UI and from an email — never a relative path.
const statusUrl = (code) => {
  const base = (process.env.PUBLIC_SERVER_ORIGIN || "https://prod.server.wedsy.in").replace(/\/+$/, "");
  return `${base}/privacy/instagram-data-deletion?code=${encodeURIComponent(code)}`;
};

// ── 1. DEAUTHORIZE ─────────────────────────────────────────────────────────
// Fires when someone removes the app from their Instagram account. The row is
// marked 'revoked' — precisely what that field was added for. The token is left
// in place rather than blanked: it is already dead on Meta's side, and keeping
// it makes the audit trail ("this row was connected, then revoked on this
// date") legible. The weekly refresh job skips non-active rows.
const Deauthorize = async (req, res) => {
  try {
    const payload = verifySignedRequest(readSignedRequest(req));
    if (!payload) {
      console.error("[InstagramPrivacy] deauthorize rejected — signature did not verify");
      return res.sendStatus(400);
    }

    const instagramUserId = String(payload.user_id);
    const updated = await ConnectedInstagramAccount.findOneAndUpdate(
      { instagramUserId, status: "active" },
      { $set: { status: "revoked" } },
      { new: true }
    );

    // A user_id we hold no row for still gets a 200. Varying the response would
    // turn this endpoint into an oracle for whether a given Instagram account
    // is connected to Wedsy — which is exactly the kind of thing an
    // unauthenticated endpoint must not disclose.
    if (updated) {
      console.log(`[InstagramPrivacy] deauthorized ${instagramUserId} — row revoked`);
    } else {
      console.log(`[InstagramPrivacy] deauthorize for ${instagramUserId} — no active row (no-op)`);
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error("[InstagramPrivacy] deauthorize failed:", sanitizeError(error));
    await logFailure("deauthorize", error);
    // 500 so Meta retries — a DB blip should not silently drop a revocation.
    return res.sendStatus(500);
  }
};

// ── 2. DATA DELETION REQUEST ───────────────────────────────────────────────
// Must answer with { url, confirmation_code }. The row is written BEFORE the
// response, so the code we hand out is always one the status page can find.
//
// ═══ SCOPE OF DELETION: THE CONNECTION ONLY. Decided 2026-09-03. ═══════════
//
// This is the deliberate answer to "what must we delete", not an unfinished
// implementation. The reasoning, because it is the kind of thing that gets
// re-litigated by whoever reads this next:
//
//  1. user_id IDENTIFIES THE AUTHORISING BUSINESS, NOT THE COUPLE. Only the
//     Instagram professional account that authorised the app can trigger this
//     callback. So the question this endpoint actually answers is: what data do
//     we hold, obtained from Meta, ABOUT THE PARTY REQUESTING DELETION? That is
//     the ConnectedInstagramAccount row — the account id, username, and the
//     token minted for it. It is deleted below.
//
//  2. DM TRANSCRIPTS ARE CONVERSATIONS WITH THIRD PARTIES. The couples who sent
//     those messages are not the requester and did not ask for anything.
//     Deleting their messages on a business's request destroys records
//     belonging to people who never made the request — the wrong party's data,
//     removed without their say.
//
//  3. "ALL IG CONVERSATIONS" IS ONLY MEANINGFUL WHILE ONE ACCOUNT EXISTS.
//     Nothing joins a WAConversation back to the connected account that
//     received it (IG rows are keyed by the CUSTOMER's scoped id). So a cascade
//     would today delete every Instagram conversation regardless of which
//     account it belongs to — defensible with a single connected account,
//     silently wrong the day the venue owner portal ships and there are two.
//
// Meta's own wording supports the narrow reading: "delete any data your app has
// FROM FACEBOOK about the user". A phone number a couple gave us on a call is
// not data from Meta, and a couple's DM is not data about the requester.
//
// DOCUMENTED FALLBACK — OPTION B, if a reviewer ever rules that DM content is
// in scope: additionally delete WAConversation + WAAgentMessage rows with
// channel:'instagram'. That is the next step out and no further — leads stay
// untouched, because upgradeLeadWithPhone stamps additionalInfo.instagramId
// onto EXISTING, often WhatsApp-originated leads at merge time, so deleting
// "leads with an Instagram id" reaches booked clients with payments and
// contracts (25 models reference Enquiry, among them LeadPayment and
// PaymentMilestone). Before implementing B, add the missing conversation →
// account join first; without it B is only correct while one account exists.
// ═══════════════════════════════════════════════════════════════════════════
const DataDeletion = async (req, res) => {
  try {
    const payload = verifySignedRequest(readSignedRequest(req));
    if (!payload) {
      console.error("[InstagramPrivacy] data-deletion rejected — signature did not verify");
      return res.sendStatus(400);
    }

    const instagramUserId = String(payload.user_id);
    // Random, not derived from the user id: this code travels in a URL and must
    // not encode whose request it is.
    const confirmationCode = crypto.randomBytes(16).toString("hex");

    const request = await InstagramDataDeletionRequest.create({
      confirmationCode,
      instagramUserId,
      status: "received",
      actions: [{ step: "request_received", result: "verified signed_request from Meta" }],
    });

    // Delete the connection — per the scope note above, this IS the whole of it.
    try {
      const result = await ConnectedInstagramAccount.deleteMany({ instagramUserId });
      // 'completed', not 'received': with the scope settled, nothing further is
      // pending and the status page must say so. A deletedCount of 0 is still
      // complete — Meta explicitly says to disregard ids not in our records, and
      // "we hold nothing about you" is a finished answer, not an unfinished one.
      await InstagramDataDeletionRequest.updateOne(
        { _id: request._id },
        {
          $set: { status: "completed", completedAt: new Date() },
          $push: {
            actions: {
              step: "connected_account_deleted",
              result: `${result.deletedCount || 0} row(s) removed`,
              at: new Date(),
            },
          },
        }
      );
    } catch (error) {
      console.error("[InstagramPrivacy] account deletion step failed:", sanitizeError(error));
      await logFailure("data-deletion-account-step", error, { instagramUserId });
      await InstagramDataDeletionRequest.updateOne(
        { _id: request._id },
        {
          $set: { status: "failed" },
          $push: { actions: { step: "connected_account_deleted", result: "FAILED — see failure log", at: new Date() } },
        }
      );
    }

    console.log(`[InstagramPrivacy] deletion request ${confirmationCode} recorded for ${instagramUserId}`);
    return res.status(200).json({
      url: statusUrl(confirmationCode),
      confirmation_code: confirmationCode,
    });
  } catch (error) {
    console.error("[InstagramPrivacy] data-deletion failed:", sanitizeError(error));
    await logFailure("data-deletion", error);
    return res.sendStatus(500);
  }
};

// ── 3. STATUS PAGE ─────────────────────────────────────────────────────────
// A human-visitable page, not an API. Served as plain HTML with no template
// engine and no external assets — it must render for someone with no account,
// no session and no relationship to Wedsy beyond having asked us to delete
// something.
const escapeHtml = (value) =>
  String(value == null ? "" : value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       max-width:38rem;margin:0 auto;padding:3rem 1.25rem;color:#1a1a1a;background:#fff}
  h1{font-size:1.4rem;margin:0 0 1.25rem}
  code{background:#f3f3f3;padding:.15rem .4rem;border-radius:3px;font-size:.9em;word-break:break-all}
  .status{display:inline-block;padding:.2rem .6rem;border-radius:3px;font-size:.85rem;font-weight:600}
  .received{background:#fff4d6;color:#7a5600}
  .completed{background:#dff5e3;color:#1b5e2a}
  .failed{background:#fde2e2;color:#8a1c1c}
  .muted{color:#666;font-size:.9rem;margin-top:2rem;border-top:1px solid #eee;padding-top:1rem}
</style></head>
<body>${body}
<p class="muted">Questions about this request? Email
<a href="mailto:support@wedsy.in">support@wedsy.in</a> and quote your confirmation code.</p>
</body></html>`;

const DeletionStatus = async (req, res) => {
  try {
    const code = (req.query && (req.query.code || req.query.confirmation_code)) || "";
    if (!code) {
      return res.status(400).send(
        page("Data deletion status", `<h1>Data deletion status</h1>
        <p>No confirmation code was provided. Open the link exactly as it was given to you,
        or add your code to the end of the address.</p>`)
      );
    }

    const request = await InstagramDataDeletionRequest.findOne({
      confirmationCode: String(code),
    }).lean();

    // Unknown code says "not found" and nothing more — no hint about whether it
    // was never issued, expired, or belongs to someone else.
    if (!request) {
      return res.status(404).send(
        page("Data deletion status", `<h1>Data deletion status</h1>
        <p>We could not find a deletion request with the code
        <code>${escapeHtml(code)}</code>.</p>
        <p>Please check the code and try again.</p>`)
      );
    }

    const received = new Date(request.createdAt).toISOString().slice(0, 10);
    // Plain language, and TRUE. Someone reading this has asked what happened to
    // their data; every word here has to survive being checked against what the
    // code above actually did.
    const wording = {
      received: `We have received your request. The deletion is being carried out and this
                 page will show it as complete once it has finished.`,
      completed: `Your request is complete. We have deleted the connection between your
                  Instagram account and Wedsy, including the access token issued for it.
                  We hold no further information received from Instagram about your account.`,
      failed: `Something went wrong while processing your request and our team has been
               alerted. Please contact us using the address below and we will complete it
               by hand.`,
    }[request.status] || "";
    // Collapse the indentation of the multi-line strings above so the page
    // source reads as one clean sentence rather than a wrapped code block.
    const prose = wording.replace(/\s+/g, " ").trim();

    return res.status(200).send(
      page("Data deletion status", `<h1>Data deletion status</h1>
      <p>Confirmation code: <code>${escapeHtml(request.confirmationCode)}</code></p>
      <p>Status: <span class="status ${escapeHtml(request.status)}">${escapeHtml(request.status)}</span></p>
      <p>Requested on ${escapeHtml(received)}.</p>
      <p>${prose}</p>`)
    );
  } catch (error) {
    console.error("[InstagramPrivacy] status page failed:", sanitizeError(error));
    return res.status(500).send(
      page("Data deletion status", `<h1>Data deletion status</h1>
      <p>We could not load this request right now. Please try again shortly.</p>`)
    );
  }
};

module.exports = { Deauthorize, DataDeletion, DeletionStatus, statusUrl };
