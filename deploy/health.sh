#!/usr/bin/env bash
# Every 10 minutes: check /api/health; after 3 failures in a row, mail the admin once (until it recovers).
set -uo pipefail
state=/home/quhosting/tmp/acm-health.fails
wstate=/home/quhosting/tmp/acm-health.worker-stalled
url=https://library.qu.acm.org/api/health
if body=$(curl -fsS --max-time 15 "$url"); then
  [ -f "$state" ] && [ "$(cat "$state")" -ge 3 ] && echo "Recovered: $body" | mail -s "ACM Media is back up" tech@qu.acm.org
  echo 0 > "$state"
  # A worker that hasn't ticked for 10 minutes (cron starts it every 2 minutes and it beats during long jobs): mail once until it's back.
  tick=$(sed -n 's/.*"workerTick":"\([^"]*\)".*/\1/p' <<<"$body")
  if [ -n "$tick" ] && [ $(( $(date +%s) - $(date -d "$tick" +%s) )) -gt 600 ]; then
    echo "$(date -Is) worker stalled since $tick"
    [ -f "$wstate" ] || { echo "The worker hasn't checked in since $tick. Check the cron job and ~/logs/acm-worker.log." | mail -s "ACM Media worker stalled" tech@qu.acm.org; touch "$wstate"; }
  elif [ -f "$wstate" ]; then
    echo "Worker checked in again at $tick" | mail -s "ACM Media worker is back" tech@qu.acm.org; rm -f "$wstate"
  fi
  exit 0
fi
n=$(( $(cat "$state" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$state"
echo "$(date -Is) health failure $n: ${body:-no response}"
[ "$n" -eq 3 ] && echo "Health check failed 3 times: ${body:-no response}" | mail -s "ACM Media is down" tech@qu.acm.org
exit 0
