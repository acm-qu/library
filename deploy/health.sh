#!/usr/bin/env bash
# Every 10 minutes: check /api/health; after 3 failures in a row, mail the admin once (until it recovers).
set -uo pipefail
state=/home/quhosting/tmp/acm-health.fails
url=https://library.qu.acm.org/api/health
if body=$(curl -fsS --max-time 15 "$url"); then
  [ -f "$state" ] && [ "$(cat "$state")" -ge 3 ] && echo "Recovered: $body" | mail -s "ACM Media is back up" tech@qu.acm.org
  echo 0 > "$state"
  # A worker that hasn't ticked for 15 minutes counts as unhealthy too.
  tick=$(sed -n 's/.*"workerTick":"\([^"]*\)".*/\1/p' <<<"$body")
  if [ -n "$tick" ] && [ $(( $(date +%s) - $(date -d "$tick" +%s) )) -gt 900 ]; then body="worker stalled since $tick"; else exit 0; fi
fi
n=$(( $(cat "$state" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$state"
echo "$(date -Is) health failure $n: ${body:-no response}"
[ "$n" -eq 3 ] && echo "Health check failed 3 times: ${body:-no response}" | mail -s "ACM Media is down" tech@qu.acm.org
exit 0
