const ConnectedInstagramAccount = require('../models/ConnectedInstagramAccount');
const NotificationFailureLog = require('../models/NotificationFailureLog');
const Admin = require('../models/Admin');
const AdminNotificationService = require('../services/AdminNotificationService');
const { refreshLongLivedToken, sanitizeError } = require('./instagram');

// ───────────────────────────────────────────────────────────────────────────
// INSTAGRAM LONG-LIVED TOKEN REFRESH
//
// Instagram Login has no non-expiring token. A long-lived token lasts 60 days,
// and when it dies the whole Instagram inbox goes dark and Kiara stops
// answering DMs — silently, with no error anyone is watching. This job is the
// only thing standing between us and that dated outage.
//
// CADENCE: every 7 days, not every 50. A weekly run gives ~8 attempts inside
// the 60-day window, so one failed run is a non-event rather than the last
// chance. It also keeps the token "used": a token untouched for 60 days expires
// regardless of refresh, and the refresh call itself counts as use.
// ───────────────────────────────────────────────────────────────────────────

// Meta refuses to refresh a token less than 24 hours old. Sending one anyway
// just earns a 400 and a failure log, so those accounts are skipped — they are
// nowhere near expiry by definition.
const MIN_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;

// The age anchor is the last time this row's token was MINTED: the last
// successful refresh, or failing that the moment it was connected/seeded.
const tokenMintedAt = (account) =>
  account.lastRefreshedAt || account.createdAt || new Date(0);

// "Consecutive failures" without a counter field: lastRefreshedAt only moves on
// SUCCESS, so failure logs newer than it are exactly the unbroken run since the
// last good refresh. A success resets the count by moving the watermark.
const countFailuresSinceLastSuccess = async (account) => {
  try {
    return await NotificationFailureLog.countDocuments({
      service: 'Instagram',
      template: 'token-refresh',
      'params.instagramUserId': account.instagramUserId,
      createdAt: { $gt: tokenMintedAt(account) },
    });
  } catch (error) {
    console.error('[igTokenRefresh] failure-count query failed:', sanitizeError(error));
    return 0;
  }
};

// Loud, but only once it means something. A single transient blip is noise; a
// second consecutive failure for the same account is a real expiry heading our
// way and the owners need to see it while there is still time to reconnect.
const alertOwners = async (account, safeError, failureCount) => {
  try {
    const owners = await Admin.find({
      roles: 'owner',
      status: { $ne: 'exited' },
      isDisabled: { $ne: true },
    }).select('_id').lean();
    if (!owners.length) return;
    await AdminNotificationService.notify(
      owners.map((o) => o._id),
      {
        type: 'instagram_token_refresh_failed',
        title: 'Instagram token refresh is failing',
        message:
          `@${account.username} has failed to refresh ${failureCount} times in a row. ` +
          `The token expires ${account.tokenExpiresAt ? account.tokenExpiresAt.toISOString().slice(0, 10) : 'soon'} — ` +
          `reconnect the account from the Instagram inbox before then or DMs will stop.`,
        payload: {
          instagramUserId: account.instagramUserId,
          username: account.username,
          failureCount,
          // Already sanitised by the caller. Never put a raw error here.
          error: safeError,
        },
      }
    );
  } catch (error) {
    console.error('[igTokenRefresh] owner alert failed:', sanitizeError(error));
  }
};

const refreshOne = async (account) => {
  const age = Date.now() - new Date(tokenMintedAt(account)).getTime();
  if (age < MIN_TOKEN_AGE_MS) {
    return { instagramUserId: account.instagramUserId, skipped: 'token younger than 24h' };
  }

  let refreshed;
  try {
    // logParams tags the NotificationFailureLog row igRequest writes on failure
    // with WHICH account failed — countFailuresSinceLastSuccess keys on it.
    refreshed = await refreshLongLivedToken(account.accessToken, {
      logParams: { instagramUserId: account.instagramUserId, username: account.username },
    });
  } catch (error) {
    // The sanitised failure row is already persisted by igRequest. All that is
    // left is deciding whether this failure is loud yet.
    const safe = sanitizeError(error, account.accessToken);
    const failureCount = await countFailuresSinceLastSuccess(account);
    if (failureCount >= 2) await alertOwners(account, safe, failureCount);
    return { instagramUserId: account.instagramUserId, ok: false, error: safe, failureCount };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // THE ONE ORDERING RULE IN THIS FILE.
  //
  // The line above returned a NEW token and silently retired the old one. From
  // here until the write below there must be NO await, NO log, NO notification
  // and NO branch that can throw: anything that throws in between loses the
  // rotated token while the previous one is already dead, and production's only
  // Instagram credential is gone. Notify AFTER the write, never before.
  // ─────────────────────────────────────────────────────────────────────────
  const now = new Date();
  await ConnectedInstagramAccount.updateOne(
    { _id: account._id },
    {
      $set: {
        accessToken: refreshed.accessToken,
        tokenExpiresAt: new Date(now.getTime() + refreshed.expiresIn * 1000),
        lastRefreshedAt: now,
      },
    }
  );
  // Safe to speak again.

  const expiresAt = new Date(now.getTime() + refreshed.expiresIn * 1000);
  console.log(
    `[igTokenRefresh] rotated @${account.username} (${account.instagramUserId}) — expires ${expiresAt.toISOString()}`
  );
  return {
    instagramUserId: account.instagramUserId,
    username: account.username,
    ok: true,
    tokenExpiresAt: expiresAt,
  };
};

// Cron entry point. Never throws: one bad account must not stop the others, and
// a thrown error inside node-cron is an unhandled rejection.
const runInstagramTokenRefresh = async () => {
  const results = [];
  try {
    const accounts = await ConnectedInstagramAccount.find({ status: 'active' });
    if (!accounts.length) {
      console.log('[igTokenRefresh] no active connected accounts — nothing to do');
      return { accounts: 0, refreshed: 0, skipped: 0, failed: 0, results };
    }
    for (const account of accounts) {
      try {
        results.push(await refreshOne(account));
      } catch (error) {
        // Belt and braces — refreshOne handles its own failures.
        results.push({ instagramUserId: account.instagramUserId, ok: false, error: sanitizeError(error, account.accessToken) });
      }
    }
  } catch (error) {
    console.error('[igTokenRefresh] sweep failed:', sanitizeError(error));
  }
  const summary = {
    accounts: results.length,
    refreshed: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => r.ok === false).length,
    results,
  };
  console.log(`[igTokenRefresh] ${summary.refreshed} rotated, ${summary.skipped} skipped, ${summary.failed} failed`);
  return summary;
};

module.exports = { runInstagramTokenRefresh, refreshOne, MIN_TOKEN_AGE_MS, tokenMintedAt, countFailuresSinceLastSuccess };
