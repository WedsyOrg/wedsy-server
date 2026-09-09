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
