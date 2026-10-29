#!/usr/bin/env bash
# Nightly pg_dump of the public schema. DATABASE_URL comes from shared/.env.
set -euo pipefail
set -a; source /home/quhosting/apps/acm-media/shared/.env; set +a
dir=/home/quhosting/backups
mkdir -p "$dir"
f="$dir/acm-media-$(date +%F).dump"
pg_dump -Fc -n public --no-owner "$DATABASE_URL" > "$f.part" && mv "$f.part" "$f"
ls -1t "$dir"/acm-media-*.dump | tail -n +15 | xargs -r rm --
echo "$(date -Is) backup ok $(du -h "$f" | cut -f1)"
