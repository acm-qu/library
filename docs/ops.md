# Operations

How the library runs on the chapter's cPanel host (`qu.hosting.acm.org`, user `quhosting`), and what to do when
something goes wrong. Security details are in `docs/security.md`.

## Layout on the server

| Path | What |
|---|---|
| `~/apps/acm-media/releases/<sha>/` | One built release: `api/`, `worker/`, `web/`, `migrate.mjs`, `migrations/`, `py/`, `node_modules/` (pg, sodium-native) |
| `~/apps/acm-media/current` | Symlink to the live release |
| `~/apps/acm-media/app/` | Passenger app root registered in cPanel **Setup Node.js App** (Node 24, startup file `start.cjs`). `start.cjs` loads `current/api/app.cjs`, so the registration never changes; restart with `pkill -u $USER -f '^lsnode:/home/quhosting/apps/acm-media/app/'` (LiteSpeed respawns it on the next request; it ignores `tmp/restart.txt`, and the selector's Restart did not replace the processes either) |
| `~/apps/acm-media/shared/.env` | All secrets and paths (chmod 600). The only copy of `MASTER_KEY` besides the password manager |
| `~/apps/acm-media/shared/{backup,health}.sh` | Cron scripts (from `deploy/`) |
| `~/media/` | `tus/` uploads in flight · `assets/<shard>/<id>/` originals and copies · `tmp/<job>/` scratch |
| `~/keys/` (700) | ffmpeg key files, only while a core video encodes |
| `~/venvs/worker/` | The worker's own Python 3.13 venv (nothing system-wide): Pillow, pillow-heif, numpy, mediaworker, and torch 2.15 CPU + pyiqa for tone-curve selection. Built by `deploy/setup-worker-venv.sh` |
| `~/backups/` | Nightly `pg_dump -Fc -n public`, 14 kept |
| `~/logs/acm-*.log` | worker, cleanup, stats, backup, health |
| `~/library.qu.acm.org/.htaccess` | Passenger block, written by Setup Node.js App — don't edit by hand |

`shared/.env` holds `NODE_ENV=production`, `PUBLIC_ORIGIN=https://library.qu.acm.org`, `DATABASE_URL`, `MASTER_KEY`,
`OTP_PEPPER`, `MAIL_TRANSPORT=smtp` with the `SMTP_*` values, `MEDIA_ROOT=/home/quhosting/media`,
`KEYS_DIR=/home/quhosting/keys`, `FFMPEG`/`FFPROBE=/home/quhosting/bin/…`, `PYTHON=/home/quhosting/venvs/worker/bin/python`,
`LUTS_DIR`, `LOG_FILE=/home/quhosting/logs/acm-api.log` (lsnode drops the API's stdout), `WORKER_WAKE` (the crontab's worker command with `flock -w 20` instead of `-n`), and `PRELAUNCH_ALLOWLIST` until
launch (it only limits who can sign in; member-tier items are public either way).

## Deploy

```sh
scripts/deploy.sh            # tests → build → rsync → npm install (2 packages) → migrate → flip symlink → restart → health
scripts/deploy.sh --rollback <sha>
```

- **Where the build happens.** Releases are built on a laptop, never on the server, so a build can't compete with
  live traffic for the host's CPU and memory.
- **Migrations are additive only.** Add a column or table in one release, and only stop using or drop the old
  one in a later release. A rollback just re-points the symlink, so the previous code must still work with the
  new schema.
- **Health check.** `/api/health` reports the live release. The deploy waits until it shows the new one.

## Cron

Install `deploy/crontab.template` with `crontab`. Or add each line in cPanel's Cron Jobs page, which edits the same crontab (`cpapi2 Cron` does not work over SSH here because of CageFS). It runs:
- the worker every 2 minutes (under `flock`, so only one runs at a time); a finished upload also starts it straight away through `WORKER_WAKE`;
- cleanup hourly;
- storage stats and the database backup nightly;
- a health check every 10 minutes, which mails tech@qu.acm.org after 3 failures in a row.

## Everyday checks

- **Admin · Processing queue** shows when the worker last checked in. The worker runs every minute, so a time more
  than a few minutes old means cron stopped. Check `crontab -l` and `~/logs/acm-worker.log`.
- **Admin · Storage** shows file count against the host's limit. The limit is unknown until A2 confirms it; enter
  it there once you know. Each video adds about 10 files whatever its length, and each photo adds 3 or 4.

## When something breaks

| Symptom | Look at | Usual fix |
|---|---|---|
| Site down / 503 | `~/logs/` Passenger error log in cPanel, `curl localhost` health | `pkill -u $USER -f '^lsnode:/home/quhosting/apps/acm-media/app/'`; roll back if a deploy just happened |
| Uploads stall at the same % | Browser console, request size errors | Passenger/Apache body limit: chunks are 8 MiB; lower `chunkSize` in `apps/web/src/lib/uploader.ts` to 5 MiB if the host caps it |
| Everything "Queued", nothing moves | `~/logs/acm-worker.log` | Cron missing or the lock file stuck: `rm ~/tmp/acm-worker.lock` only if no worker process is running (`pgrep -f run.mjs`) |
| A video keeps failing | Admin · Item details → Jobs, `last_error` | `decode_failed`/`unsupported_codec`: ask for the original file again, or "Keep original only" |
| Core media 500s after a key change | API log mentions authentication | `MASTER_KEY` doesn't match: restore the previous value from the password manager |
| Sign-in mails don't arrive | API log `sign-in mail failed` | SMTP credentials in `shared/.env`; test with the cPanel mailbox's webmail |

## Backups and their gap

- **Database.** Dumped nightly to `~/backups` (14 days). Restore with
  `pg_restore -n public --clean --no-owner -d "$DATABASE_URL" <file>`. The dumps contain the wrapped keys, so the
  dumps and `MASTER_KEY` together can decrypt core media. Keep them apart.
- **Originals are not backed up off the host.** This is the biggest operational risk. A copy of `~/media/assets`
  somewhere else (even a chapter drive, monthly) would cover it. Core originals are encrypted at rest, so such a
  copy is only useful together with `MASTER_KEY` and a database dump.

## File-count budget

Measured on 29 Oct 2026, when torch (CPU build) and pyiqa were installed into `~/venvs/worker`:
- **Account total:** 31,097 → 81,303 files.
- **Venv:** 2.5 GB and 53,020 files.
- **Largest packages:** torch 15,845 files; transformers 6,739; sympy 3,420; pandas 3,288; scipy 2,635.

Admin · Storage counts only `~/media`, but the host's limit applies to the whole account. If A2's limit turns out
to be tight, torch's C++ headers (`torch/include`, never used at runtime) are the first thing to remove.

## Known host constraints

- **PostgreSQL 9.6 (EOL).** The schema avoids features newer than 9.6, so moving to a newer Postgres is a
  dump and restore.
- **A PostGIS `topology` schema** came with the database and our role can't dump it. Backups use `-n public`.
- **CloudLinux limits per-account CPU and memory.** The worker runs one job at a time, children run at nice 10
  with capped threads, and ffmpeg gets `-threads 2`.
- **One Passenger process.** Rate limits and tus upload locks are in memory. Running more processes would need
  a shared store first.
- **Accounts.** One SSH key per maintainer, and turn on cPanel two-factor authentication for every account that
  can log in.
