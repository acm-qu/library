# Cron jobs for the media library

Add each job in **cPanel → Cron Jobs → Add New Cron Job**: fill in the five time fields shown, paste the command
into **Command**, then click **Add New Cron Job**. A `*` means "every" (every hour, every day, …).

The server's clock is **US Eastern time** (EDT now, EST from 1 November), so "3 AM" below is 3 AM in New York,
which is 10 AM in Doha (11 AM in winter).

## 1. Worker: every 2 minutes (required)

Processes uploaded photos and videos. Without it, every upload stays "Queued" forever.

Runs **every 2 minutes**. A finished upload also starts it straight away (`WORKER_WAKE` in `shared/.env`), so this
is the safety net for retries, admin actions and crashes. If the previous run is still busy (for example encoding a
long video), the new one exits straight away, so two runs never work at the same time. Each run stops after at most
50 minutes. `taskset -c 2-3 nice -n 19` keeps it on 2 of the account's 4 cores at the lowest priority.

| Minute | Hour | Day | Month | Weekday |
|---|---|---|---|---|
| `*/2` | `*` | `*` | `*` | `*` |

```
/usr/bin/flock -n /home/quhosting/tmp/acm-worker.lock /usr/bin/taskset -c 2-3 nice -n 19 /opt/alt/alt-nodejs24/root/usr/bin/node --env-file=/home/quhosting/apps/acm-media/shared/.env /home/quhosting/apps/acm-media/current/worker/run.mjs >> /home/quhosting/logs/acm-worker.log 2>&1
```

## 2. Cleanup: once an hour, at 7 minutes past

Deletes uploads that were started and never finished, expired sign-in sessions and codes, and files left behind by
a crashed job.

Runs **once an hour, at 7 minutes past the hour** (1:07, 2:07, 3:07, …).

| Minute | Hour | Day | Month | Weekday |
|---|---|---|---|---|
| `7` | `*` | `*` | `*` | `*` |

```
/usr/bin/taskset -c 2-3 nice -n 19 /opt/alt/alt-nodejs24/root/usr/bin/node --env-file=/home/quhosting/apps/acm-media/shared/.env /home/quhosting/apps/acm-media/current/worker/cleanup.mjs >> /home/quhosting/logs/acm-cleanup.log 2>&1
```

## 3. Storage stats: once a day, at 3:23 AM

Counts files and disk use for **Admin · Storage** and adds a point to its daily history.

Runs **once a day, at 3:23 AM** server time.

| Minute | Hour | Day | Month | Weekday |
|---|---|---|---|---|
| `23` | `3` | `*` | `*` | `*` |

```
/usr/bin/taskset -c 2-3 nice -n 19 /opt/alt/alt-nodejs24/root/usr/bin/node --env-file=/home/quhosting/apps/acm-media/shared/.env /home/quhosting/apps/acm-media/current/worker/stats.mjs >> /home/quhosting/logs/acm-stats.log 2>&1
```

## 4. Database backup: once a day, at 3:41 AM

Dumps the database (users, events, item details; not the media files themselves) to `~/backups/` and keeps the
last 14.

Runs **once a day, at 3:41 AM** server time.

| Minute | Hour | Day | Month | Weekday |
|---|---|---|---|---|
| `41` | `3` | `*` | `*` | `*` |

```
/home/quhosting/apps/acm-media/shared/backup.sh >> /home/quhosting/logs/acm-backup.log 2>&1
```

## 5. Health check: every 10 minutes

Checks that the site answers and that the worker has run in the last 15 minutes. After three failures in a row
(about 30 minutes of trouble) it emails tech@qu.acm.org once, and again when things recover.

Runs **every 10 minutes** (:00, :10, :20, …).

| Minute | Hour | Day | Month | Weekday |
|---|---|---|---|---|
| `*/10` | `*` | `*` | `*` | `*` |

```
/home/quhosting/apps/acm-media/shared/health.sh >> /home/quhosting/logs/acm-health.log 2>&1
```

## Notes

- None of these need changing after a deploy: `current` always points to the live release.
- Each job writes to its own file in `~/logs/` instead of emailing its output.
- To check the worker is running: `https://library.qu.acm.org/api/health` shows `workerTick`, which should be less
  than a minute or two old.
