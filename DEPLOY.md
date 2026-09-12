# Deploying wedsy-server

## Always use `scripts/deploy.sh` on EC2

On the production host, deploy with:

```bash
cd /var/www/wedsy-server
./scripts/deploy.sh
```

**Never just `git pull` + `pm2 restart`.** That skips `npm install`, so any commit
that adds a new dependency will crash-loop pm2 the moment it restarts. This is
how the `express-rate-limit` outage happened — the require landed on the host
without the module being installed.

`scripts/deploy.sh` runs:

1. `git pull origin main` — fetch the latest code
2. `npm install --omit=dev` — install any new/updated dependencies (production only)
3. `pm2 restart wedsy-prod --update-env` — restart the app and pick up env changes
4. `pm2 status` — confirm the process came back up

If you change `.env` on the host, the `--update-env` flag on the pm2 restart
ensures the new values are loaded — pm2 caches env vars from the time the
process was first started.

## Meta Conversions API (qualified-lead signal)

`services/MetaConversionsService.js` reports a qualification back to Meta so its
algorithm optimises for leads sales can work with rather than the cheapest form
fill. It is INERT until both of these are set in the host `.env`:

| Variable | Required | Notes |
| --- | --- | --- |
| `META_CAPI_DATASET_ID` | yes | The dataset the events are posted to. |
| `META_CAPI_ACCESS_TOKEN` | yes | **Secret.** Never appears in a log line or a printed URL. |
| `META_CAPI_TEST_EVENT_CODE` | no | When set, events go to Events Manager → Test Events ONLY and do not affect real data or optimisation. |

With the first two unset the service logs `SKIPPED — … not configured` and
qualification proceeds untouched, so an environment that never sets them
behaves exactly as it did before.

**Roll it out with `META_CAPI_TEST_EVENT_CODE` set first**, confirm the event
lands in Events Manager → Test Events, and only then remove the code so real
events flow. The send is fire-and-forget and can never fail a qualification,
but a misconfigured dataset is only visible in Events Manager — not here.

Before widening which leads are sent, run
`node scripts/audit-lead-source-meta-origin.js --qualified-only` and read
`META_AD_SOURCES` in the service header. Sending a non-ad lead trains the
algorithm on organic business and cannot be undone.

### Phone country codes

`utils/phone.js` is the ONE phone normaliser. A stored number that already
carries a country code — a leading `+`, or more than ten digits — is used
verbatim and never re-derived. Only a bare ten-digit number gets a code
applied, from `DEFAULT_COUNTRY_CODE` (default `91`), and every such guess is
logged with the lead id.

| Variable | Required | Notes |
| --- | --- | --- |
| `DEFAULT_COUNTRY_CODE` | no | Digits only, no `+`. Applied ONLY to bare ten-digit numbers. Defaults to `91`. |

Grep the logs for `[phone] ASSUMED` to see how often we are guessing and on
which leads. That line is the audit trail for the one case where this file does
not know the answer.

**SMS is India-only, by the gateway's own limits.** Fast2SMS's `dlt` route is
TRAI's Indian registration regime and its documentation states recipients are
Indian ten-digit mobile numbers. An international destination is therefore
refused — but out loud: grep `[sms] SKIPPED` and `[otp] SMS SKIPPED` for the
lead id and the number's leading digits. WhatsApp is unaffected and still
reaches international numbers.

Before changing `LeadIntakeService.normalizePhone` (it dedups on the last ten
digits, so two countries can collide), run
`node scripts/audit-phone-dedup-collisions.js` — read-only — and let the count
decide.

## Google Chat — new-lead ping

`services/GoogleChatNotifyService.js` posts a new-lead message into Google Chat
from `LeadIntakeService.afterCreate`. It replaces the notification the Make
scenario owns today.

| Variable | Required | Notes |
| --- | --- | --- |
| `GOOGLE_CHAT_LEADS_WEBHOOK_URL` | to enable | **Secret.** The incoming-webhook URL carries its own `key` and `token` — anyone holding it can post into the space. Never logged. |
| `OS_FRONTEND_URL` | no | Base for the deep link (defaults to `https://os.wedsy.in`). Already used elsewhere. |

**IT SHIPS DORMANT, AND THE ORDER OF ROLLOUT MATTERS.** With
`GOOGLE_CHAT_LEADS_WEBHOOK_URL` unset it logs
`[chat-notify] SKIPPED … not configured` and posts nothing. Make is still
posting today, so setting this before Make's Chat module is switched off would
double-notify the team on every lead — and an alert people learn to ignore has
stopped working.

    1. switch the Chat module OFF in the Make scenario
    2. THEN set GOOGLE_CHAT_LEADS_WEBHOOK_URL and restart with --update-env

Never the other way round. To verify, create one lead and grep for
`[chat-notify] SENT`.

The message wording lives in `utils/chatMessages.js` — one pure function,
deliberately isolated from the transport so it can be reworded without touching
the HTTP call, the secret, or the fire-and-forget contract.

## Encrypted credentials at rest

Two stored third-party credentials are sealed with AES-256-GCM via
`utils/secretBox.js`: `GoogleAccount.refreshToken` (per-admin, calendar write)
and `ConnectedInstagramAccount.accessToken` (the business account's DM token).
`VenueSheetIntegration.refreshToken` was already encrypted and keeps its own
key.

| Variable | Used by | Notes |
| --- | --- | --- |
| `CREDENTIAL_ENC_KEY` | GoogleAccount, ConnectedInstagramAccount | **Secret.** Any passphrase; a 32-byte key is derived from it. |
| `SHEETS_TOKEN_ENC_KEY` | VenueSheetIntegration | **Unchanged.** Deliberately a separate key — rotating one store must not break another. |

**Unset `CREDENTIAL_ENC_KEY` is safe to deploy.** Sealing degrades to storing
plain text — exactly today's behaviour — and logs
`[secretbox] NO KEY …`. Grep for that line to confirm the key is actually in
use after setting it.

**Stored format:** `v1.gcm:<iv>:<tag>:<ciphertext>`. A value **without** that
prefix is plain text, from before this shipped, and is returned as-is. That one
rule is the whole migration: rows re-encrypt as they are rewritten, and nothing
needs a backfill script.

### ROLLBACK — read this before reverting

Reverting the code is **safe but not free**, and the cost is bounded:

* Rows still in plain text (never re-linked) keep working — the old code reads
  plain text.
* Rows written **while the new code was live** are `v1.gcm:…`. The old code
  hands that string to Google or Meta as a token, it is rejected, and
  `accessTokenFor` raises `502 Google token refresh failed`.

**Nothing is lost and nothing corrupts.** Those people reconnect —
`/google/oauth/start` for Google, the Instagram connect flow for Meta — and are
fine. Meetings booked in the gap fall back to OS-only (no Meet link, no
invitations), which is the same fallback as an unlinked account.

So the recovery plan is: **whoever linked during the window links again.** With
a handful of linked accounts that is minutes of work, which is why no
decrypt-in-place script is kept. If the number of linked accounts ever grows
into the hundreds, write one before reverting.

### If the key is lost or rotated

Every sealed credential becomes unreadable — the GCM tag fails, `decryptSecret`
returns `""` and logs `[secretbox] DECRYPT FAILED` with the row's id. Then:

* **Google:** each admin reconnects. Calendar events are unaffected — they live
  in Google, not here.
* **Instagram:** reconnect the business account once. DM history is in
  `WAAgentMessage` and is untouched.

**Nothing irreplaceable is protected by this key.** Every credential under it is
re-obtainable by a consent flow, so key loss costs a reconnect, not data.
