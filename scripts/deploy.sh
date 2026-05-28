#!/bin/bash
set -e
cd /var/www/wedsy-server
git pull origin main
npm install --omit=dev
pm2 restart wedsy-prod --update-env
pm2 status
