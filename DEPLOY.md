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
