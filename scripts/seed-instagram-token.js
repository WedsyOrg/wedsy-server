/* Seed the existing hand-minted @wedsy.in token into ConnectedInstagramAccount
 * — and establish its REAL expiry instead of inventing one.
 *
 * WHY THE REFRESH IS PART OF THE SEED, NOT A FOLLOW-UP.
 * The @wedsy.in token was minted by hand in the Meta dashboard and nobody
 * recorded when. Any tokenExpiresAt this script wrote from a guess would be
 * fiction, and the refresh job reads that field — so its behaviour would be
 * undefined from day one. The fix is to seed the row and IMMEDIATELY refresh:
 * the response's expires_in is Meta's own answer, measured from now. The
 * existing token is far older than Meta's 24-hour minimum, so the refresh is
 * allowed. The rotated token is persisted and becomes the live credential.
 *
 * The placeholder expiry written in step 1 therefore lives for milliseconds and
 * is overwritten in step 2. If step 2 fails, the script says so loudly and the
 * row is left with status 'revoked' rather than a fictional expiry that would
 * quietly mislead the refresh job.
 *
 * RUN THIS **AFTER** THE DEPLOY, NOT BEFORE. The refresh in step 2 rotates the
 * live credential. Until the new code is running, production still reads the
 * token from process.env — which this rotation may retire — so seeding first
 * would cause exactly the outage this change exists to prevent. Order is:
 * deploy → seed → confirm the inbox still sends.
 *
 * NOT BLINDLY IDEMPOTENT, on purpose. A re-run after a SUCCESSFUL seed would
 * otherwise overwrite the freshly rotated token with the stale one from .env
 * and then try to refresh THAT — and a dead env token means the refresh fails,
 * the row is left revoked, and production falls back to the same dead token.
 * So a row that has already been rotated (lastRefreshedAt set) is left alone;
 * the weekly job owns it from then on.
 *
 * NEVER prints the token or the app secret.
 *
 * Usage:
 *   node scripts/seed-instagram-token.js            # dry-run: report only
 *   node scripts/seed-instagram-token.js --confirm  # seed + refresh + persist
 */
require("dotenv").config();
const mongoose = require("mongoose");

const CONFIRM = process.argv.includes("--confirm");

// The account being migrated off .env (given).
const INSTAGRAM_USER_ID = "17841447723681883";
const USERNAME = "wedsy.in";

// A fingerprint, NOT a preview: length plus a truncated SHA-256. Enough to tell
// two tokens apart and to confirm the rotation actually changed the credential,
// while printing zero characters of the secret itself.
const fingerprint = (token) => {
  if (!token) return "(absent)";
  const hash = require("crypto").createHash("sha256").update(token).digest("hex").slice(0, 12);
  return `len=${token.length} sha256:${hash}…`;
};

(async () => {
  const ConnectedInstagramAccount = require("../models/ConnectedInstagramAccount");
  const { refreshLongLivedToken, sanitizeError } = require("../utils/instagram");

  const envToken = process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN;
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    console.error("DATABASE_URL is not set — refusing to run.");
    process.exit(1);
  }
  if (!envToken) {
    console.error("INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN is not set — nothing to seed.");
    process.exit(1);
  }

  console.log(`[seed] target account : @${USERNAME} (${INSTAGRAM_USER_ID})`);
  console.log(`[seed] env token      : ${fingerprint(envToken)}`);
  console.log(`[seed] mode           : ${CONFIRM ? "APPLY" : "DRY RUN (pass --confirm to apply)"}`);

  await mongoose.connect(dbUrl, { serverSelectionTimeoutMS: 10000 });
  console.log("[seed] connected to MongoDB");

  try {
    const existing = await ConnectedInstagramAccount.findOne({ instagramUserId: INSTAGRAM_USER_ID }).lean();
    console.log(
      existing
        ? `[seed] existing row found (status=${existing.status}, expires=${existing.tokenExpiresAt && existing.tokenExpiresAt.toISOString()})`
        : "[seed] no existing row — will create"
    );

    // Refuse to clobber a row the refresh job already owns — see the header.
    if (existing && existing.lastRefreshedAt) {
      console.log("");
      console.log("  ! ALREADY SEEDED AND ROTATED — refusing to overwrite.");
      console.log(`    lastRefreshedAt : ${new Date(existing.lastRefreshedAt).toISOString()}`);
      console.log(`    tokenExpiresAt  : ${existing.tokenExpiresAt && new Date(existing.tokenExpiresAt).toISOString()}`);
      console.log(`    status          : ${existing.status}`);
      console.log("    The weekly refresh job owns this token. Nothing to do.");
      return;
    }

    if (!CONFIRM) {
      console.log("[seed] DRY RUN — no write, no refresh call. Re-run with --confirm.");
      return;
    }

    // ── Step 1: seed the row ────────────────────────────────────────────────
    // tokenExpiresAt here is a deliberate PLACEHOLDER. It is required by the
    // schema and unknowable at this instant; step 2 replaces it with the truth
    // seconds later. status starts 'revoked' so that if step 2 fails, the
    // refresh job never sees a row carrying a fictional expiry.
    const seeded = await ConnectedInstagramAccount.findOneAndUpdate(
      { instagramUserId: INSTAGRAM_USER_ID },
      {
        $set: {
          username: USERNAME,
          accessToken: envToken,
          status: "revoked", // provisional — flipped to 'active' after the refresh
        },
        $setOnInsert: { tokenExpiresAt: new Date(), connectedBy: null },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log(`[seed] row upserted (_id=${seeded._id})`);

    // ── Step 2: refresh immediately, to learn the real expiry ───────────────
    console.log("[seed] refreshing to establish the real expiry…");
    const refreshed = await refreshLongLivedToken(envToken, {
      logParams: { instagramUserId: INSTAGRAM_USER_ID, username: USERNAME },
    });

    // Same ordering rule as the refresh job: the new token exists and the old
    // one is now retired. Persist it as the very NEXT statement — no logging,
    // no branching, nothing that can throw in between.
    const now = new Date();
    const tokenExpiresAt = new Date(now.getTime() + refreshed.expiresIn * 1000);
    await ConnectedInstagramAccount.updateOne(
      { _id: seeded._id },
      {
        $set: {
          accessToken: refreshed.accessToken,
          tokenExpiresAt,
          lastRefreshedAt: now,
          status: "active",
        },
      }
    );
    // Safe to speak again.

    console.log("");
    console.log("  ✓ SEEDED AND ROTATED");
    console.log(`    account        : @${USERNAME} (${INSTAGRAM_USER_ID})`);
    console.log(`    new token      : ${fingerprint(refreshed.accessToken)} (differs from the old one — rotation confirmed)`);
    console.log(`    expires_in     : ${refreshed.expiresIn}s (${Math.round(refreshed.expiresIn / 86400)} days)`);
    console.log(`    tokenExpiresAt : ${tokenExpiresAt.toISOString()}`);
    console.log(`    status         : active`);
    console.log("");
    console.log("  The weekly refresh job now owns this token. INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN");
    console.log("  can be removed from the EC2 .env once this row is confirmed live.");
  } catch (error) {
    console.error("[seed] FAILED:", sanitizeError(error, process.env.INSTAGRAM_AGENT_PAGE_ACCESS_TOKEN));
    console.error("[seed] the row was left status='revoked' — no fictional expiry was published.");
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("[seed] disconnected");
  }
})();
