#!/usr/bin/env bash
# Nightly pg_dump of the public schema. Only DATABASE_URL is read from shared/.env: sourcing the whole file fails on
# values bash can't parse (SMTP_PASS). The URL is never echoed.
set -euo pipefail
DATABASE_URL=$(grep '^DATABASE_URL=' /home/quhosting/apps/acm-media/shared/.env | cut -d= -f2- | tr -d '"')
dir=/home/quhosting/backups
mkdir -p "$dir"
f="$dir/acm-media-$(date +%F).dump"
nice -n 19 ionice -c3 pg_dump -Fc -n public --no-owner "$DATABASE_URL" > "$f.part" && mv "$f.part" "$f"
ls -1t "$dir"/acm-media-*.dump | tail -n +15 | xargs -r rm --
echo "$(date -Is) backup ok $(du -h "$f" | cut -f1)"
