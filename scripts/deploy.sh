#!/bin/bash
set -euo pipefail
cd /var/www/wedsy-server
git pull origin main
npm ci --omit=dev
pm2 restart wedsy-prod --update-env
pm2 status
