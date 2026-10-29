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
rsync -az --delete --exclude node_modules -e "ssh -i $KEY" dist/release/ "$HOST:$BASE/releases/$sha/"
ssh_ bash -s <<REMOTE
set -euo pipefail
cd $BASE/releases/$sha
PATH=/opt/alt/alt-nodejs24/root/usr/bin:\$PATH $NPM install --omit=dev --no-audit --no-fund --loglevel=error
bash ./deploy/setup-worker-venv.sh \$PWD --with-tonemap
$NODE --env-file=$BASE/shared/.env migrate.mjs
ln -sfn releases/$sha $BASE/current.new && mv -T $BASE/current.new $BASE/current
# Passenger's app root is the fixed launcher dir $BASE/app (registered in Setup Node.js App); it loads current/.
mkdir -p $BASE/app/tmp && touch $BASE/app/tmp/restart.txt
# The host runs Node under LiteSpeed, which ignores restart.txt; it respawns lsnode on the next request.
pkill -u \$USER -f '^lsnode:$BASE/app/' || true
# Tone-curve tables + validation gate (reused when nothing changed). A failed gate only keeps tonemap_auto off.
$NODE --env-file=$BASE/shared/.env worker/tonemap-gate.mjs >> \$HOME/logs/acm-gate.log 2>&1 || echo "tone-curve gate crashed; see ~/logs/acm-gate.log"
ls -1dt $BASE/releases/* | tail -n +6 | xargs -r rm -rf --
REMOTE

echo "→ waiting for $URL to report $sha"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 10 "$URL/api/health" | grep -q "\"release\":\"$sha\""; then echo "✓ live: $sha"; exit 0; fi
  sleep 2
done
echo "✗ $sha did not come up; previous releases are in $BASE/releases (deploy.sh --rollback <sha>)" >&2
exit 1
