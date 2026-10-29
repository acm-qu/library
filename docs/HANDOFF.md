# Engineering handoff: QU ACM Media Library (backend + interim UI)

**For:** Claude Code · **From:** QU ACM Student Chapter · **Date:** 29 October 2026
**Ask:** build the complete backend (API, auth, uploads, processing worker, encryption, admin) and a **deliberately simple interim web UI** that exercises every feature. The interim UI will be replaced by designs from Claude Design (separate brief: `handoff.md`), so keep all logic in the API and a typed client, and keep UI components thin.

How to use this document:
- **Decided** items are requirements. Don't redesign them; raise a concern instead.
- **Verify** items are believed correct but not yet tested on the production server. Write a test or spike for each before building on it.
- **Open** items are undecided. Implement the stated default behind a config flag.

Put a copy of this file in the repo at `docs/HANDOFF.md`, and write a short `CLAUDE.md` that points to it.

---

## 0. Summary

A private, login-only library of the chapter's event photos and videos. Members browse events, view compressed photos, stream videos at 360p/720p/1080p, and download originals. Core members also see core-only content (encrypted at rest), upload media, and manage events. Admins manage members and processing.

Everything runs on **one shared cPanel account** provided by ACM HQ. That host constrains almost every engineering decision (§1).

---

## 1. Production environment (measured, Decided)

| Item | Value | Consequence |
|---|---|---|
| Host | ACM HQ chapter cPanel account, shared server, CloudLinux (CageFS) | No root, no system packages, no Docker |
| Access | SSH (key-based), Terminal, Git Version Control, Cron Jobs | Deploy by `git pull` + build on the server, or by pushing built artifacts |
| Node | Setup Node.js App (Passenger); `alt-nodejs` up to **24** | Use Node 24 LTS |
| Python | Setup Python App; **3.13** available | Worker media steps in a venv |
| Database | **PostgreSQL** available (2 databases already exist) | Use PostgreSQL |
| CPU | "CPU 100%" = account limit. Tests sustained **≈3.9 cores** in bursts | Treat as about 4 cores; never assume 64 (`nproc` reports the host) |
| Memory | 4 GB physical | One heavy job at a time |
| Processes | **200, and this counts threads** | Every tool must have explicit thread caps (§8.7) |
| Entry processes | 150 | No long-lived HTTP connections per client (no SSE/WebSockets in v1; use polling) |
| I/O | 30 MB/s, 4096 IOPS | Fine for chapter scale |
| Disk | "Unlimited" bytes; **file-count (inode) limit unknown** (currently 27,279 used) | Minimise file count (§7.3) |
| glibc | 2.28 | Manylinux 2.28 wheels OK |
| ffmpeg | Static build 7.0.2 in `~/bin/ffmpeg`, `~/bin/ffprobe` (works) | Always call by absolute path |
| `xz` | Execution blocked by CageFS | Extract `.tar.xz` with Python `tarfile` if needed |
| PHP | Present but **not used** (team has no PHP experience) | — |
| Mail | cPanel email; core members have `@qu.acm.org` mailboxes | Send OTP via the account's SMTP |

**Measured processing cost** for a 30 s, 1080p, HLG HEVC iPhone clip. $\rho$ is wall time ÷ clip duration:
- SDR pipeline: $\rho \approx 0.59$.
- HDR pipeline (tone map, 4 filter threads): $\rho \approx 1.17$.

Use these for ETAs and job-time limits.

**Open: production URL.** It must be same-origin for the SPA and the API, because session cookies and HLS key requests rely on it. Default: a subdomain such as `media.qu.acm.org`, with the Node app serving both `/api/*` and the built SPA.

---

## 2. Tech stack (Decided)

| Layer | Choice |
|---|---|
| Language | TypeScript (strict) for API, worker orchestration and UI; Python 3.13 for media steps |
| API | Node 24 + **Fastify** (`@fastify/cookie`, `@fastify/static`, `@fastify/rate-limit`, `@fastify/helmet`) |
| DB access | PostgreSQL + **Drizzle ORM** with drizzle-kit migrations. Prisma was the alternative; Drizzle chosen for zero native engine binaries on shared hosting |
| Validation | `zod` schemas, shared between API and UI |
| Uploads | **`@tus/server`** + `@tus/file-store` on the server; **Uppy** (`@uppy/tus`) in the UI |
| Email | `nodemailer` via cPanel SMTP |
| Crypto | `sodium-native` (libsodium) for at-rest encryption; Node `crypto` for HLS keys and token hashing |
| Worker orchestration | Node script run by **cron every minute** under `flock` |
| Video | Static **ffmpeg/ffprobe 7.0.2** |
| Images | Python: **Pillow + pillow-heif** (HEIC/AVIF/JPEG/PNG/WebP decode, ICC conversion via LittleCMS, WebP encode). `sharp` was rejected: its prebuilt binaries read AVIF but **not HEIC**, verified |
| Tone-curve selection | Python: **pyiqa** (DISTS, TOPIQ-FR; pretrained weights), CPU PyTorch, numpy |
| Interim UI | Vite + React 18 + React Router + TanStack Query + **hls.js** + Uppy; plain CSS |
| Tests | Vitest (TS), pytest (Python) |

---

## 3. Repository layout

```
/
├─ apps/
│  ├─ api/                 Fastify app (routes, auth, media serving, tus)
│  │  ├─ src/
│  │  │  ├─ server.ts      buildApp() — no listen() here (testable)
│  │  │  ├─ main.ts        listen(); Passenger entry wraps this
│  │  │  ├─ routes/        auth, me, events, assets, media, uploads, admin
│  │  │  ├─ auth/          otp, sessions, guards (requireUser, requireCore, requireAdmin)
│  │  │  ├─ media/         file serving, Range, decryption streams, HLS playlist/key
│  │  │  ├─ db/            drizzle schema + client
│  │  │  ├─ crypto/        aead-file format, key wrap
│  │  │  └─ config.ts      env parsing (zod)
│  │  └─ app.cjs           Passenger entry (CommonJS shim requiring dist/main.js)
│  ├─ worker/              job runner (TS)
│  │  └─ src/ run.ts, jobs/*.ts, ffmpeg.ts, python.ts, eta.ts
│  └─ web/                 interim UI (Vite)
├─ packages/
│  └─ shared/              zod schemas + TS types for every API request/response
├─ py/
│  └─ mediaworker/         Python package: images.py, tonemap/{luts,select,pu21}.py, probe helpers
│     └─ tests/
├─ migrations/             drizzle SQL migrations
├─ scripts/                bootstrap-admin.ts, deploy.sh, build-luts.sh, backup.sh
├─ docs/HANDOFF.md
└─ CLAUDE.md
```

Use a pnpm or npm workspace. Production installs must not need native compilation on the server, except `sodium-native`, which ships prebuilt binaries (**Verify** that it loads on the server).

---

## 4. Domain model and roles (Decided unless marked)

- **Roles:** `member` and `core`, stored in the database. **Admin** is a boolean flag (`is_admin`) that may be set only on core users (**assumption**; enforce with a check constraint).
- The role never comes from the email domain.
- **Tiers:** each asset is `member` (visible to all active users) or `core` (visible to core only).
- **Who can do what:**

| Action | member | core | admin |
|---|---|---|---|
| View/stream/download member-tier | ✓ | ✓ | ✓ |
| View/stream/download core-tier | — | ✓ | ✓ |
| Create/edit events, upload, set tier on own uploads | — | ✓ | ✓ |
| Change tier of any asset, delete assets/events | — | — | ✓ |
| Manage users, processing, overrides, storage view | — | — | ✓ |

- **Invisibility rule (Decided default):** a user who may not see an asset gets **404**, never 403, for the asset, its media URLs and its key. Lists omit such assets, and event counts reflect only what the viewer can see.
- **Assumption:** only core members upload.

---

## 5. Database schema (PostgreSQL)

Use UUID v7 or v4 primary keys, `timestamptz` everywhere, `citext` for emails (enable the extension; **Verify** it is permitted on the cPanel Postgres. Otherwise store lower-cased text with a unique index).

```sql
-- enums
create type role as enum ('member','core');
create type user_status as enum ('active','disabled');
create type tier as enum ('member','core');
create type asset_kind as enum ('image','video');
create type asset_status as enum ('uploading','queued','processing','ready','failed','needs_review','original_only','deleting');
create type hdr_format as enum ('sdr','hlg','pq','unknown');
create type job_kind as enum ('process','reprocess','retier','purge');
create type job_state as enum ('queued','running','done','failed','cancelled');
create type rendition_kind as enum ('image_view','image_thumb','video_poster','hls_master','hls_variant');

create table users (
  id uuid primary key, email citext unique not null, name text not null default '',
  role role not null default 'member', is_admin boolean not null default false,
  status user_status not null default 'active',
  created_by uuid references users(id), created_at timestamptz not null default now(),
  last_login_at timestamptz,
  constraint admin_is_core check (not is_admin or role = 'core')
);

create table otp_codes (
  id uuid primary key, email citext not null, code_hash text not null,
  expires_at timestamptz not null, attempts int not null default 0,
  consumed_at timestamptz, created_at timestamptz not null default now(), request_ip inet
);
create index on otp_codes (email, created_at desc);

create table sessions (
  id uuid primary key, token_hash bytea unique not null, user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(), ip inet, user_agent text
);

create table events (
  id uuid primary key, title text not null, slug text unique not null,
  starts_on date not null, ends_on date, location text, description text,
  cover_asset_id uuid, default_tier tier not null default 'member',
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table assets (
  id uuid primary key, event_id uuid not null references events(id),
  kind asset_kind not null, tier tier not null, status asset_status not null,
  original_filename text not null, original_mime text, original_size bigint, original_sha256 bytea,
  original_ext text not null,            -- e.g. 'heic', 'mov'
  encrypted boolean not null default false,
  captured_at timestamptz, width int, height int, duration_s real, fps real,
  device text, hdr hdr_format, source_info jsonb,   -- ffprobe/EXIF summary
  uploader_id uuid not null references users(id), upload_id text unique,  -- tus id
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index on assets (event_id, tier, status) where deleted_at is null;
create index on assets (event_id, original_sha256);

create table renditions (
  id uuid primary key, asset_id uuid not null references assets(id) on delete cascade,
  kind rendition_kind not null, label text,           -- '360p' | '720p' | '1080p' | null
  width int, height int, bandwidth int, bytes bigint not null,
  rel_path text not null,                             -- relative to the asset dir
  settings_version int not null, created_at timestamptz not null default now(),
  unique (asset_id, kind, label)
);

create table processing_runs (
  id uuid primary key, asset_id uuid not null references assets(id) on delete cascade,
  settings_version int not null,
  tone_curve text,                 -- 'hable203' | 'bt2446a' | 'bt2390' | 'reinhard203' | null (SDR)
  curve_source text,               -- 'auto' | 'fallback' | 'override' | 'none'
  scores jsonb,                    -- {candidates:[{curve, dists, topiq, r_dists, r_topiq, sum}], frames:[t...]}
  started_at timestamptz not null, finished_at timestamptz, ok boolean, error text, log_tail text
);

create table jobs (
  id uuid primary key, asset_id uuid references assets(id) on delete cascade,
  kind job_kind not null, state job_state not null default 'queued',
  params jsonb not null default '{}',               -- e.g. {"tone_curve":"bt2390"} for overrides
  priority int not null default 0, attempts int not null default 0, max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  step text, progress real, est_seconds int, started_at timestamptz, finished_at timestamptz,
  last_error text, created_at timestamptz not null default now()
);
create index on jobs (state, priority desc, created_at);

create table asset_keys (            -- per-asset keys, wrapped with the master key
  asset_id uuid primary key references assets(id) on delete cascade,
  file_key_wrapped bytea not null,   -- AEAD key for files at rest (core tier)
  hls_key_wrapped bytea,             -- 16-byte AES-128 key for HLS (core videos)
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key, actor_id uuid references users(id), action text not null,
  target_type text, target_id uuid, data jsonb, at timestamptz not null default now()
);

create table app_settings (key text primary key, value jsonb not null);
-- e.g. inode_limit (null = unknown), tonemap_auto (bool), settings_version (int)
```

---

## 6. Authentication (Decided)

### 6.1 OTP flow
1. `POST /api/auth/request-code {email}`. Always respond `204` with no difference between known and unknown emails.
   - If the email belongs to an **active** user: create a code, store `code_hash`, and send the email.
   - Otherwise: do nothing, but take the same time (constant-ish delay) to avoid timing leaks.
2. The code is 6 digits from `crypto.randomInt(0, 1_000_000)`, zero-padded.
   - Store `code_hash = HMAC-SHA256(OTP_PEPPER, email + ':' + code)`.
   - TTL 10 minutes. Single use (`consumed_at`). A new request invalidates older unconsumed codes for that email.
3. `POST /api/auth/verify {email, code}`:
   - Look up the newest unexpired, unconsumed code and increment `attempts`.
   - At more than **5** attempts, invalidate it and return `429 {"error":"too_many_attempts"}`.
   - Compare with `crypto.timingSafeEqual`.
   - On success, mark it consumed, create a session, set the cookie, update `last_login_at`, and return `/me`.
4. **Rate limits:**
   - request-code: 3 per 15 minutes per email, 10 per hour per IP;
   - verify: 20 per 15 minutes per IP.
   - Return `429` with a `retry_after` value in seconds.

### 6.2 Sessions
- Token: 32 random bytes, base64url, in cookie `sid` (`HttpOnly; Secure; SameSite=Lax; Path=/`). The database stores `sha256(token)`.
- Lifetime 30 days, sliding (refresh `expires_at` at most once per hour of activity). `last_seen_at` is updated at most every 5 minutes.
- `POST /api/auth/logout` deletes the current session; `POST /api/auth/logout-all` deletes all of the user's sessions.
- Disabling a user deletes all their sessions.
- **CSRF:** SameSite=Lax, plus every state-changing route (POST, PATCH, DELETE, and tus PATCH) requires the header `X-Requested-With: acm-media`. Uppy's tus plugin can send custom headers.

### 6.3 Email
- Send via nodemailer through cPanel SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) from a mailbox such as `noreply@qu.acm.org`.
- **Verify:** SPF, DKIM and DMARC are valid (cPanel → Email Deliverability). Test delivery to a `@qu.acm.org` mailbox and to a QU student mailbox.
- Plain-text and simple HTML bodies: the code, the expiry, and "if you didn't request this, ignore it".

### 6.4 Bootstrap
`scripts/bootstrap-admin.ts --email x --name y` creates the first core admin directly in the database. This is the only way to create a user outside the admin API.

---

## 7. Storage

### 7.1 Layout (Decided)
```
$MEDIA_ROOT/                                  (outside public_html, e.g. ~/media)
  tus/                                        tus upload staging (file-store)
  assets/{a[0:2]}/{asset_id}/
     original.{ext}            or original.{ext}.enc   (core)
     view.webp | view.webp.enc                 images
     thumb.webp | thumb.webp.enc               images & video posters
     poster.webp | poster.webp.enc             videos (frame at 10% of duration)
     hls/master.m3u8
     hls/{360p,720p,1080p}/index.m3u8
     hls/{360p,720p,1080p}/data.ts             (single-file HLS, see §7.3)
  tmp/{job_id}/                               worker scratch, deleted after each job
$KEYS_DIR/ (not under MEDIA_ROOT, chmod 700)  only transient HLS key files during packaging
```
- The two-character shard directory keeps any single directory small.
- Write every output to a temp name, then `rename` (atomic).
- A job is idempotent: re-running it replaces outputs and rendition rows.

### 7.2 Nothing is publicly served
`public_html` (or the app's static root) contains only the built SPA. Every media byte goes through the API's permission checks.

### 7.3 File-count budget (Decided)
- Images use 3 files per asset.
- **Videos use HLS with `single_file`** (one `.ts` per variant, addressed by byte ranges), so a video costs about $2R + 3$ files regardless of duration.
- **Verify early (spike):** `-hls_flags single_file` together with `-hls_key_info_file` (AES-128) produces playlists hls.js plays.
- If the combination fails, fall back to normal segments with `hls_time 10`, about $R\lceil D/10\rceil$ files, and record the decision in `docs/`.

### 7.4 Inode visibility
The admin storage endpoint reports bytes (`du`) and file count, computed by a nightly cron job into `app_settings` rather than per request, against the `inode_limit` setting (null means unknown).

---

## 8. Processing worker

### 8.1 Runner (Decided)
- Cron, every minute:
  ```
  * * * * * /usr/bin/flock -n $HOME/locks/worker.lock $HOME/nodevenv/.../bin/node $APP/apps/worker/dist/run.js >> $HOME/logs/worker.log 2>&1
  ```
  **Verify** the paths of `flock` and the Node binary inside the cPanel Node venv.
- **On start:** any job in `running` state is stale, because `flock` guarantees no other runner. Set it back to `queued` and increment `attempts`.
- **Claim one job:**
  ```sql
  update jobs set state='running', started_at=now(), attempts=attempts+1
  where id = (select id from jobs where state='queued' and run_after<=now()
              order by priority desc, created_at limit 1 for update skip locked)
  returning *;
  ```
- Process it, then claim the next. Exit when the queue is empty or after **50 minutes** of wall time; the next cron tick continues.
- A video job may run longer than 50 minutes, so the limit applies between jobs, not within one.
- **Verify:** a 60+ minute ffmpeg run under cron is not killed by the host. If it is, split video jobs into resumable steps (§8.4 is already written step-by-step and idempotent).
- **Failure:** `failed` with `last_error`. Retry with backoff (`run_after = now() + 5 min × attempts`) until `max_attempts`; after that the asset status becomes `failed`.
- Update `jobs.step` and `jobs.progress` as work proceeds. ffmpeg progress comes from `-progress pipe:1` (`out_time_ms` ÷ duration).

### 8.2 After upload
The tus `onUploadFinish` hook (in the API):
1. Verify the user may upload to the event.
2. Sniff the type from magic bytes (don't trust the extension). Accept JPEG, PNG, HEIC/HEIF, AVIF, WebP, MP4, MOV (QuickTime). Reject others and delete the upload.
3. Compute SHA-256 while streaming. On a duplicate within the same event, still accept, but return `duplicate_of` in the asset response so the UI can warn.
4. Move the file to `assets/../original.{ext}`, create the asset (`status='queued'`) and a `process` job, and delete the tus file and its `.json` info.

**Core tier:** the original stays plaintext only until the worker's first step, which encrypts it (§9). Plaintext core data must never sit outside `tmp/` and the asset directory, and is removed as soon as the job finishes (the job writes encrypted outputs and deletes plaintext).

### 8.3 Image job (Python, Decided)
`node → spawn("~/venvs/worker/bin/python", ["-m","mediaworker.images", "--src", P, "--out", DIR])`, which prints JSON to stdout.
1. Open with Pillow (with `pillow_heif.register_heif_opener()`). For a HEIC with a gain map, this yields the SDR base image, which is what we want.
2. `ImageOps.exif_transpose`.
3. If an ICC profile is embedded, convert to sRGB with `ImageCms.profileToProfile(...)`. iPhone photos are usually Display P3.
4. Write `view.webp` (long edge ≤ **2560**, quality 82, method 4) and `thumb.webp` (long edge ≤ **480**, quality 75). Never upscale.
5. Extract metadata: capture date (EXIF DateTimeOriginal + offset), make/model, dimensions.
6. **True-HDR stills** (e.g. PQ/HLG AVIF with no SDR base): set `needs_review`; do not tone map in v1.
7. Set `OMP_NUM_THREADS=2`. Pillow is single-threaded for these operations.

The worker then encrypts outputs for core assets (§9), writes renditions, and sets `ready`.

### 8.4 Video job (Decided unless marked)
Steps, each idempotent:

1. **Probe:** `ffprobe -v error -show_streams -show_format -of json`. Record codec, width/height, rotation, `r_frame_rate`/`avg_frame_rate` (VFR if they differ), `color_transfer`, `color_primaries`, `pix_fmt`, duration, `creation_time`, Apple/Android make/model tags, and Dolby Vision side data (`dv_profile`).
2. **Classify:**
   - `color_transfer = arib-std-b67` → `hlg`
   - `smpte2084` → `pq`
   - `bt709`, `smpte170m` or unset with 8-bit → `sdr`
   - anything else (e.g. Log profiles, unknown transfers) → `needs_review`. Stop; an admin decides (§10.3).
3. **Tone-curve choice** (HDR only, §8.5): produces `tone_curve` and `curve_source`.
4. **Encode + package** (one ffmpeg run, decode once):
   - **Ladder:** 360p, 720p and 1080p by the *shorter* side. Skip any rung larger than the source; always keep at least one.
   - **Portrait sources:** scale the width. Use `scale='if(gte(iw,ih),-2,H)':'if(gte(iw,ih),H,-2)'`.
   - **Per-rung settings:** H.264 High, `-preset veryfast`, CRF 26/23/22 with a capped maximum bitrate:

     | Rung | maxrate | bufsize |
     |---|---|---|
     | 360p | 1.0M | 2M |
     | 720p | 3.0M | 6M |
     | 1080p | 6.0M | 12M |

   - **Common settings:** `-pix_fmt yuv420p`, and always tag `-color_primaries bt709 -color_trc bt709 -colorspace bt709`. AAC 128k stereo (96k for 360p).
   - **GOP:** fixed keyframes every 2 s (`-g`/`-keyint_min` = 2×fps, `-sc_threshold 0`), with `hls_time 6`.
   - **VFR sources:** `-fps_mode cfr -r <rounded avg fps>`.
   - Audio is optional: build the maps dynamically, because `-map 0:a?` combined with a `var_stream_map` that references `a:N` breaks without audio.
   - **Video filter, SDR source:** `format=yuv420p`.
   - **Video filter, HDR source, fallback path (verified on the server):**
     ```
     zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:t=linear:npl=203,format=gbrpf32le,
     zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p
     ```
     For PQ use `tin=smpte2084`. **Verify** the `npl` value for PQ footage on Samsung samples.
   - **Video filter, HDR source, table path (§8.5):** convert to RGB without changing transfer or primaries, apply `lut3d=file=<curve>.cube:interp=tetrahedral`, then convert to BT.709 YUV tv-range. **Verify** with the acceptance test in §8.5.
   - **Template** (assemble programmatically):
     ```
     ffmpeg -nostdin -hide_banner -y -threads 2 -i SRC -filter_complex_threads 4 \
       -filter_complex "[0:v]<VF>,split=3[a][b][c];[a]<SCALE360>[v0];[b]<SCALE720>[v1];[c]<SCALE1080>[v2]" \
       -map "[v0]" -map 0:a:0 -map "[v1]" -map 0:a:0 -map "[v2]" -map 0:a:0 \
       -c:v libx264 -threads 2 -preset veryfast -profile:v high -pix_fmt yuv420p \
       -crf:v:0 26 -maxrate:v:0 1M -bufsize:v:0 2M \
       -crf:v:1 23 -maxrate:v:1 3M -bufsize:v:1 6M \
       -crf:v:2 22 -maxrate:v:2 6M -bufsize:v:2 12M \
       -g G -keyint_min G -sc_threshold 0 \
       -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
       -c:a aac -ac 2 -b:a:0 96k -b:a:1 128k -b:a:2 128k \
       -f hls -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments+single_file \
       [-hls_key_info_file KEYINFO]   # core only (§9.2)
       -master_pl_name master.m3u8 \
       -var_stream_map "v:0,a:0,name:360p v:1,a:1,name:720p v:2,a:2,name:1080p" \
       -hls_segment_filename "OUT/hls/%v/data.ts" "OUT/hls/%v/index.m3u8" \
       -progress pipe:1
     ```
5. **Poster:** extract a frame at 10% of the duration with the same filter chain, and save it as a PNG in `tmp/`. Python (`mediaworker.images --poster`) then writes `poster.webp` and `thumb.webp`.
6. **Finalize:**
   - Write renditions (bandwidth taken from the master playlist) and the `processing_runs` row.
   - Encrypt the original and the poster/thumb (core).
   - Delete `tmp/`. Set `ready`.

### 8.5 Automatic tone-curve selection (Decided design; ships behind `tonemap_auto=false` until validated)

**Candidates** ($K = 4$), each a 65³ `.cube` table mapping BT.2020 HLG RGB′ → BT.709 RGB′. Each implements the full conversion $S = \varepsilon\circ T\circ M\circ\ell$ (decode HLG with reference white at 203 nits, BT.2020→BT.709 matrix with clipping, tone curve on $\max(r,g,b)$ with the RGB ratios preserved, BT.709 OETF):
- `hable203`: Hable filmic curve, $A..F = 0.15, 0.50, 0.10, 0.20, 0.02, 0.30$, normalised by $u(x_{\max})$.
- `reinhard203`: $x/(1+x)$.
- `bt2446a`: ITU-R BT.2446 Method A.
- `bt2390`: ITU-R BT.2390 EETF roll-off.

Generate the tables with `scripts/build-luts.sh` → `python -m mediaworker.tonemap.luts`, implemented from the ITU documents. Store them in `$APP/luts/` (versioned in git; small).

**Acceptance test for the table path:** for `hable203`, compare the table-path output with the verified zscale+tonemap fallback chain on test frames. The mean absolute difference must be < 2 code values (8-bit). This validates the shared $\ell$, $M$ and $\varepsilon$ implementation.

**Selection** (`python -m mediaworker.tonemap.select --src SRC --luts DIR --out JSON`):
1. **Sample** $N=8$ frames: 6 at the centres of equal time intervals, skipping black or near-uniform frames (luma stddev < 2%), plus the 2 frames with the highest 99th-percentile luminance (scan a low-res proxy at 1 fps).
2. **Reference:** export each frame losslessly from the HDR source as 16-bit **PQ**-encoded RGB (absolute nits).
3. **Candidates:** apply each `.cube` to each frame, giving 8-bit BT.709.
4. **Same scale for both:**
   - Candidate → nits with $L = (200-0.2)\,v^{2.2} + 0.2$.
   - Reference → nits via the PQ EOTF.
   - Then apply **PU21** to both: $P(L) = a(\log_2 L - \log_2 0.005)^2 + b(\log_2 L - \log_2 0.005)$, with $a=0.001908$ and $b=0.0078$. Clamp $L \ge 0.005$; scale to $[0,1]$.
   - This is the "DM + PU21" adaptation from Chen et al., *Adapting Quality Metrics to Tone Mapping*, SIGGRAPH 2026.
5. **Score** with `pyiqa.create_metric('dists')` and `pyiqa.create_metric('topiq_fr')` (full-reference: reference vs. candidate) on frames downscaled to a long edge of 1024. Use **CPU**, `torch.set_num_threads(2)` and `OMP_NUM_THREADS=2`.
6. **Choose:** average over frames per metric, convert to ranks $r_{\text{DISTS}}(m)$ and $r_{\text{TOPIQ}}(m)$ (respect each metric's direction: higher-is-better or lower-is-better), and set $m^* = \arg\min_m [r_{\text{DISTS}}(m) + r_{\text{TOPIQ}}(m)]$.
7. **Fallback** to `hable203` (`curve_source='fallback'`) when the two metrics' top choices differ by 2 or more rank positions, or on any error. Record everything in `processing_runs.scores`.

**Model weights:** pyiqa downloads them on first use (Hugging Face `chaofengc/IQA-PyTorch-Weights`). Pre-fetch them into the venv cache during deployment (`scripts/fetch-weights`); never download during a job.

**Validation gate before enabling `tonemap_auto`:**
- The repo includes `T_hable_100/203`, `T_mobius_100/203`, `T_reinhard_100/203` (10 s clips) and the chapter's human ranking: `hable_203` best, Reinhard better than Möbius.
- `pytest -m validation` must reproduce **hable_203 first**.

**Open:** check the pyiqa license before deployment. PyPI metadata says Apache, while the README states CC BY-NC-SA 4.0. Non-commercial internal use is expected.

**Cost:** about $K \times N = 32$ scorings per HDR video. Measure on the server and log it; run scoring before encoding, never concurrently.

### 8.6 ETA (Decided)
$$\text{ETA}(\text{job}) = \sum_{\text{jobs ahead, incl. current remainder}} c(j), \qquad c(j) = \begin{cases}\rho_{\text{sdr}}\,D_j & \text{SDR video}\\ \rho_{\text{hdr}}\,D_j + 60\text{ s} & \text{HDR video}\\ 3\text{ s} & \text{image}\end{cases}$$
- Initial constants: $\rho_{\text{sdr}} = 0.6$, $\rho_{\text{hdr}} = 1.2$.
- Refine them with an exponential moving average of measured $T/D$ after each job, stored in `app_settings`.

### 8.7 Process hygiene (Decided, required)
- `nice -n 19` for every spawned tool.
- ffmpeg: `-nostdin`, `-threads 2` on decoder and encoder, `-filter_complex_threads 4`.
- Python: `OMP_NUM_THREADS=2`, `MKL_NUM_THREADS=2`, `torch.set_num_threads(2)`.
- **Why:** the 200-process limit counts threads. x264 auto-threading saw 64 host cores and broke the third encoder in testing.
- Kill the child process tree on timeout: 3 × expected cost, minimum 10 minutes.
- Settings live in `apps/worker/src/settings.ts` with `SETTINGS_VERSION`. Every rendition and run records it.

---

## 9. Encryption (Decided)

**Threat model, documented honestly in `docs/security.md`:**
- **Protects against:** leaked or guessed URLs, directory listings, backup or file-system access without the master key.
- **Does not protect against:** an authorised core member saving content they can view, or an attacker who controls the running app (it holds the master key).
- DRM is out of scope.

### 9.1 Keys
- **Master key:** `MASTER_KEY` (32 random bytes, base64) in the app's `.env` (`chmod 600`, outside the web root and git).
- Each core asset gets a random 32-byte `file_key`; each core video also gets a random 16-byte `hls_key`.
- Both are stored in `asset_keys`, wrapped with `crypto_secretbox_easy` (libsodium) under `MASTER_KEY`.
- Key rotation for `MASTER_KEY`: a script that re-wraps all rows.

### 9.2 Files at rest: seekable chunked AEAD (core originals, views, thumbs, posters)
Custom format, so HTTP Range keeps working:
```
header (32 B): magic "ACMENC01" (8) | chunk_size u32 (=1 MiB) | plaintext_size u64 | reserved (12)
nonce_base (24 B, random)
chunks: for i in 0..n-1: crypto_aead_xchacha20poly1305_ietf_encrypt(
          plaintext_chunk_i, AD = asset_id(16) || u64(i) || u8(is_last), nonce = nonce_base XOR u64le(i) in the last 8 bytes, key = file_key)
        → ciphertext_i (len_i + 16)
```
- A Range request maps to chunk indices; decrypt only the needed chunks and slice.
- Tampering, truncation and reordering all fail authentication.
- Unit-test round trips, ranges across chunk boundaries, the last chunk, and an empty file.

### 9.3 HLS (core videos)
- **Packaging:** write a key-info file into `$KEYS_DIR/{job}.keyinfo` (chmod 600) and delete it after ffmpeg exits. It contains:
  - line 1: the URI as written in the playlist, `/api/media/{asset_id}/hls/key`;
  - line 2: the path of the transient key file;
  - line 3: an optional IV (omit it so segments use the sequence number).
- **Serving:** `GET /api/media/{id}/hls/key` returns the 16 raw bytes, only for users who may view the asset. Headers: `Cache-Control: no-store`, `Content-Type: application/octet-stream`.
- Playlists and the `.ts` data stay as ffmpeg wrote them; the segments are AES-128 encrypted at rest.
- **Member-tier videos are not encrypted.** They are still served only through authenticated routes.

### 9.4 Tier changes
- **Image** → `retier` job: re-encrypt or decrypt view, thumb and original.
- **Video** → `reprocess` job from the original (re-packaging needs the key path; reprocessing is simpler and tier changes are rare). The UI shows it as processing.
- Delete old keys after success.

---

## 10. HTTP API

JSON under `/api`. Errors are `{"error": "<code>", "message": "<human>"}`. Pagination is cursor-based (`?cursor=&limit=`, max 100). All shapes are defined in `packages/shared` with zod and inferred TS types.

### 10.1 Auth and account
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/request-code` | `{email}` → 204 always (rate-limited) |
| POST | `/auth/verify` | `{email, code}` → `Me`, sets cookie |
| POST | `/auth/logout` · `/auth/logout-all` | |
| GET | `/me` | `{id, email, name, role, isAdmin}` or 401 |
| PATCH | `/me` | `{name}` |

### 10.2 Library
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/events?q=&year=&cursor=` | any | Counts and cover computed **per viewer** (§4) |
| POST | `/events` | core | `{title, startsOn, endsOn?, location?, description?, defaultTier}` |
| GET | `/events/:id` | any | 404 if deleted |
| PATCH | `/events/:id` | core | Includes `coverAssetId` |
| DELETE | `/events/:id` | admin | Soft delete + purge jobs for its assets |
| GET | `/events/:id/assets?kind=&tier=&cursor=` | any | Members: only `ready` member-tier. Core: also processing/failed/needs_review for their uploads (admins: all), with status and ETA |
| GET | `/assets/:id` | any | Metadata, available renditions, `downloadName`; 404 rule |
| PATCH | `/assets/:id` | core (own) / admin | `{tier?, eventId?}` → may enqueue `retier`/`reprocess` |
| DELETE | `/assets/:id` | admin | `status='deleting'` + purge job |

### 10.3 Media bytes (all check `canView`; 404 otherwise)
| Path | Content | Notes |
|---|---|---|
| `/media/:id/thumb` · `/view` · `/poster` | `image/webp` | `Cache-Control: private, max-age=31536000, immutable` with `?v={settings_version}` |
| `/media/:id/original` | original MIME | **Range support** (plain or §9.2), `Content-Disposition: attachment; filename*=UTF-8''…` |
| `/media/:id/hls/master.m3u8` | `application/vnd.apple.mpegurl` | `Cache-Control: private, no-cache` |
| `/media/:id/hls/:variant/index.m3u8` | same | |
| `/media/:id/hls/:variant/data.ts` | `video/mp2t` | **Range support required** (single_file byte ranges) |
| `/media/:id/hls/key` | octet-stream | Core videos only; `no-store` |

- Use `@fastify/static`'s `sendFile` for plaintext files and a custom Range-aware decrypting stream for `.enc` files.
- Validate that `:variant` is one of the stored labels; never join untrusted strings into paths.

### 10.4 Uploads
- `ALL /uploads/*` is the tus endpoint (`@tus/server`, file-store at `$MEDIA_ROOT/tus`).
  - Metadata: `eventId`, `tier`, `filename`, `filetype`.
  - Chunk size **8 MiB** (client). Max file size 20 GiB (config).
  - **Verify:** the web server and Passenger allow 8 MiB request bodies. Lower it to 5 MiB if not.
  - Hooks: `onIncomingRequest` (auth: core only; event exists; tier allowed) and `onUploadFinish` (§8.2).
  - Expire incomplete uploads after 48 h (cron cleanup).
- `GET /uploads/mine?cursor=`: the user's assets with status, step, progress and ETA. The UI polls every 5 s while any item isn't final.

### 10.5 Admin
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/admin/users` | List with filters; create `{email, name, role, isAdmin}` |
| POST | `/admin/users/bulk` | `{emails: string[], role}` → `{created, skipped:[{email, reason}]}` |
| PATCH | `/admin/users/:id` | `{role?, isAdmin?, status?, name?}`. Refuse removing the last admin; disabling deletes sessions |
| GET | `/admin/jobs?state=` | Includes asset summary, step, progress, ETA; queue summary (count, queued video seconds, drain ETA) |
| POST | `/admin/jobs/:id/retry` · `/cancel` | |
| GET | `/admin/assets/:id/processing` | Source info, renditions, runs (with scores and sampled frame times) |
| GET | `/admin/assets/:id/frames/:n` | Sampled frame thumbnails from the last run (kept as small WebP files under `tmp`-free `assets/.../runs/{run_id}/`) |
| POST | `/admin/assets/:id/reprocess` | `{toneCurve?: 'hable203' \| 'bt2446a' \| 'bt2390' \| 'reinhard203'}` → job with `curve_source='override'` |
| POST | `/admin/assets/:id/resolve` | For `needs_review`: `{action: 'process_default' \| 'original_only'}` |
| GET | `/admin/storage` | Bytes (originals vs renditions), file count, `inode_limit`, top events, daily history |
| GET/PATCH | `/admin/settings` | `tonemap_auto`, `inode_limit` |

**Audit log:** record every admin mutation, every tier change and every delete.

---

## 11. Interim UI (simple by design; will be replaced)

**Goal:** prove every API path works end to end, on desktop and phone. No visual polish. Use plain CSS with a small token file (light and dark) and semantic HTML.

**Rule:** pages call only `apps/web/src/api/*` (typed with `packages/shared`). No fetch calls inside components. Keep data hooks (TanStack Query) separate from presentational components, so the Claude Design implementation can replace the presentation layer without touching the data layer.

Pages (route → contents):
| Route | Contents |
|---|---|
| `/login` | Email field → code field (6 digits, paste OK), resend with countdown, all error states from the API |
| `/` | Event list: search, year filter, cards (title, date, counts, cover thumb) |
| `/events/:id` | Header, filter (all/photos/videos; core: tier), grid of thumbs; core: "Add media", "Edit" |
| `/assets/:id` | Image: view.webp + "Download original" (size, format). Video: hls.js player with Auto/360/720/1080 selector and download |
| `/upload` | Pick or create event → Uppy Dashboard (tus, 8 MiB chunks, `X-Requested-With` header, metadata) → done summary with ETAs |
| `/uploads` | My uploads table with status, step, progress, ETA; polls every 5 s |
| `/admin/users` | Table + add + bulk paste + role/admin/status toggles |
| `/admin/jobs` | Tabs: running, queued, failed, needs review, recent; retry/cancel/resolve |
| `/admin/assets/:id` | Source info, renditions, scores table, sampled frames, override + reprocess |
| `/admin/storage` | Numbers + simple table |
| `/account` | Name, sign out, sign out everywhere |

hls.js configuration:
- default settings, same-origin cookies (no `withCredentials` needed);
- expose `levels` for the manual picker;
- on a fatal error, show "Can't play this video right now".

---

## 12. Security checklist (Decided)

- **Helmet:** a strict CSP that allows `blob:` for `media-src` (hls.js uses MediaSource), `frame-ancestors 'none'`, `Referrer-Policy: same-origin`.
- Every media route uses the single `canView(user, asset)` function, with a unit test matrix covering roles × tiers × statuses × deleted.
- Path safety: resolve every file path from the database, never from the request. Reject unexpected `:variant` values.
- Rate limits on auth (§6.1) and a global per-IP limit.
- Logs never contain OTP codes, session tokens or keys.
- `.env` holds: `DATABASE_URL`, `MASTER_KEY`, `OTP_PEPPER`, `SMTP_*`, `MEDIA_ROOT`, `KEYS_DIR`, `FFMPEG`, `FFPROBE`, `PYTHON`, `PUBLIC_ORIGIN`. Ship `.env.example`.
- SSH: one key per maintainer; cPanel 2FA (operational, document it in `docs/ops.md`).

---

## 13. Deployment on cPanel (Decided; Verify each step)

1. **Node app:** cPanel → Setup Node.js App.
   - Node 24, application root = repo checkout, URL = the chosen domain, startup file `apps/api/app.cjs` (CommonJS shim: `require('./dist/main.js')`; Passenger intercepts `listen`).
   - Run `npm ci && npm run build` in the app's virtualenv shell. Restart with `touch tmp/restart.txt`.
2. **SPA:** `apps/web` build output served by Fastify (`@fastify/static`) with a history-API fallback to `index.html` for non-`/api` paths.
3. **Python venv:** `python3.13 -m venv ~/venvs/worker`, then `pip install -r py/requirements.txt`:
   - `pillow`, `pillow-heif`, `numpy`, `pyiqa`, `torch` (CPU wheel index), `opencv-python-headless` if needed.
   - **Verify** the `torch` CPU wheel installs (size and inode use). Record the count added (`find ~/venvs -xdev | wc -l`).
4. **ffmpeg:** already in `~/bin`. The config points to absolute paths.
5. **Database:** create the database and user in cPanel → PostgreSQL; run `npm run db:migrate`; run `scripts/bootstrap-admin.ts`.
6. **Cron jobs:**
   - worker: every minute (§8.1);
   - `cleanup` (expired tus uploads, OTPs, sessions): hourly;
   - `storage-stats`: nightly;
   - `pg_dump` backup: nightly to `~/backups`, keeping 14 days.
7. **Logs:** `~/logs/{api,worker}.log`, rotated by size within the cron cleanup.
8. **Backups of originals** are out of scope for v1; flag the risk in `docs/ops.md`.

**Local development:**
- `docker compose` with Postgres 16;
- static ffmpeg 7 on the dev machine;
- the same Python venv requirements;
- a `.env.local`;
- `npm run dev` starts the API, the web app (Vite proxy to the API) and a worker loop (`--watch`, polling every 5 s instead of cron).

---

## 14. Testing (Decided)

- **API (Vitest + `app.inject`):**
  - OTP lifecycle: expiry, attempts, rate limits, unknown email identical to known;
  - sessions; CSRF header;
  - the `canView` matrix;
  - Range responses (plain and encrypted);
  - the HLS key route;
  - tus happy path, resume and rejection of a wrong type.
- **Crypto:** round-trip and tamper tests for §9.2.
- **Worker:**
  - fixtures generated with ffmpeg `testsrc2`: SDR 1080p landscape, portrait, VFR, no-audio, and a 360p-only source (the ladder skips larger rungs);
  - one real HLG sample (the chapter's `IMG_4515.MOV`, 30 s, HEVC 1920×1080, `arib-std-b67`, Dolby Vision side data) for HDR paths;
  - assert outputs exist, playlists parse, and `color_*` tags are BT.709.
- **Spikes before building on them (§1, §7.3, §8, §10.4):**
  1. single_file + AES-128 playback in hls.js;
  2. `sodium-native` and `pillow-heif` load on the server;
  3. 8 MiB tus chunks through Passenger;
  4. a 60-minute cron job survives;
  5. torch CPU install footprint.
- **Python (pytest):**
  - image pipeline (HEIC with P3 profile, EXIF rotation, PNG with alpha → flattened on white);
  - `.cube` generation;
  - the `hable203` table-vs-zscale acceptance test;
  - the selection validation gate (§8.5).

---

## 15. Milestones (suggested order; each ends with passing tests and a demo in the interim UI)

1. Scaffold the workspace, config, database schema and migrations, bootstrap admin, CI-less test scripts.
2. Auth (OTP, sessions, rate limits, email) + `/me` + login UI.
3. Events + assets read APIs + library/event pages (seed script with sample data).
4. tus uploads + asset/job creation + upload UI + My uploads.
5. Worker runner + image pipeline (Python) + image serving + viewer.
6. Video SDR pipeline + HLS + poster + player (plus the single_file spike result).
7. HDR detection + verified Hable fallback chain + `needs_review` handling.
8. Encryption: key management, chunked AEAD with Range, HLS AES-128, tier changes.
9. Admin APIs and pages: users, jobs, item processing panel, storage, settings.
10. Tone-curve tables + acceptance test; selection + validation gate; enable behind `tonemap_auto`.
11. cPanel deployment scripts, cron, backups, `docs/ops.md`, `docs/security.md`.

---

## 16. Open items (implement the default; keep each configurable)

| # | Item | Default |
|---|---|---|
| 1 | Production domain/path | Subdomain, same origin for SPA + API |
| 2 | Inode limit (ask ACM HQ) | Unknown → shown as such |
| 3 | ACM HQ acceptable use for streaming + background transcoding | Proceed; document the risk |
| 4 | Members see that core items exist? | No (404 / omitted) |
| 5 | Who uploads | Core only |
| 6 | "Download as JPEG" for HEIC originals | Not in v1 |
| 7 | Zip downloads | Not in v1 |
| 8 | Queue reordering | Admin `priority` field exists; UI optional |
| 9 | Arabic / RTL | Not in interim UI; the API stores UTF-8 everywhere |
| 10 | PQ `npl` value | 203 until Samsung samples are tested |
| 11 | pyiqa licence | Confirm before enabling `tonemap_auto` |

## 17. Out of scope (v1)

Public share links · comments, likes, people tags · photo editing · HDR (PQ/HLG) renditions for HDR displays · native apps · DRM · server-side zip · offsite backup of originals.
