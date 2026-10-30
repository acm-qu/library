#!/usr/bin/env bash
# Build locally, ship the release with rsync, install two native deps, migrate, flip the symlink, restart,
# and wait for the new release to answer /api/health. Rollback: scripts/deploy.sh --rollback <sha>.
set -euo pipefail
HOST=${DEPLOY_HOST:-quhosting@qu.hosting.acm.org}
KEY=${DEPLOY_KEY:-keys/openssh}
BASE=/home/quhosting/apps/acm-media
NODE=/opt/alt/alt-nodejs24/root/usr/bin/node
NPM=/opt/alt/alt-nodejs24/root/usr/bin/npm
URL=${PUBLIC_URL:-https://library.qu.acm.org}
ssh_() { ssh -i "$KEY" -o BatchMode=yes "$HOST" "$@"; }
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--rollback" ]; then
  sha=${2:?usage: deploy.sh --rollback <sha>}
  ssh_ "test -d $BASE/releases/$sha && ln -sfn releases/$sha $BASE/current.new && mv -T $BASE/current.new $BASE/current && mkdir -p $BASE/app/tmp && touch $BASE/app/tmp/restart.txt && { pkill -u \$USER -f '^lsnode:$BASE/app/' || true; }"
  echo "rolled back to $sha (migrations are additive, so the schema stays)"; exit 0
fi

npm run typecheck
npx vitest run
npm run build
sha=$(cat dist/release/RELEASE)
case "$sha" in *dirty*) [ "${ALLOW_DIRTY:-}" = 1 ] || { echo "refusing to deploy a dirty tree ($sha); commit first or set ALLOW_DIRTY=1" >&2; exit 1; };; esac

echo "→ uploading $sha"
# 8 MB/s: the copy lands on the account's 30 MB/s disk budget while the live site keeps running.
rsync -az --bwlimit=8000 --delete --exclude node_modules -e "ssh -i $KEY" dist/release/ "$HOST:$BASE/releases/$sha/"
ssh_ bash -s <<REMOTE
set -euo pipefail
cd $BASE/releases/$sha
# Deploy work runs at the lowest CPU and IO priority, so the live site (and the account's 30 MB/s IO cap) come first.
IONICE=\$(command -v ionice || true); [ -z "\$IONICE" ] && [ -x /usr/bin/ionice ] && IONICE=/usr/bin/ionice
LOW="nice -n 19"; [ -n "\$IONICE" ] && LOW="\$IONICE -c3 \$LOW"
PATH=/opt/alt/alt-nodejs24/root/usr/bin:\$PATH \$LOW $NPM install --omit=dev --no-audit --no-fund --loglevel=error
# The venv, the scorer weights and the tone-curve gate only depend on py/, the venv script and the gate's filters;
# skip them (torch, ~0.6 GB of weights, minutes of scoring) when none changed since the last successful run.
# After changing ffmpeg by hand, rm $BASE/shared/.py-hash (or run the gate with --force).
pyhash=\$(find py deploy/setup-worker-venv.sh worker/tonemap-gate.mjs -type f ! -name '*.pyc' ! -path '*.egg-info/*' ! -path '*/build/*' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64)
py_changed=; [ "\$pyhash" = "\$(cat $BASE/shared/.py-hash 2>/dev/null)" ] || py_changed=1
[ -n "\$py_changed" ] && \$LOW bash ./deploy/setup-worker-venv.sh \$PWD --with-tonemap
\$LOW $NODE --env-file=$BASE/shared/.env migrate.mjs
ln -sfn releases/$sha $BASE/current.new && mv -T $BASE/current.new $BASE/current
# Passenger's app root is the fixed launcher dir $BASE/app (registered in Setup Node.js App); it loads current/.
mkdir -p $BASE/app/tmp && touch $BASE/app/tmp/restart.txt
# The host runs Node under LiteSpeed, which ignores restart.txt; it respawns lsnode on the next request.
pkill -u \$USER -f '^lsnode:$BASE/app/' || true
# Tone-curve tables + validation gate (its result is shown to admins; it doesn't switch anything off).
if [ -n "\$py_changed" ]; then
  if \$LOW $NODE --env-file=$BASE/shared/.env worker/tonemap-gate.mjs >> \$HOME/logs/acm-gate.log 2>&1; then echo "\$pyhash" > $BASE/shared/.py-hash
  else echo "tone-curve gate crashed; see ~/logs/acm-gate.log"; fi
fi
ls -1dt $BASE/releases/* | tail -n +6 | xargs -r rm -rf --
REMOTE

echo "→ waiting for $URL to report $sha"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 10 "$URL/api/health" | grep -q "\"release\":\"$sha\""; then echo "✓ live: $sha"; exit 0; fi
  sleep 2
done
echo "✗ $sha did not come up; previous releases are in $BASE/releases (deploy.sh --rollback <sha>)" >&2
exit 1
