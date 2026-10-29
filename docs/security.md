# Security

What protects the library, where it lives in the code, and the gaps we know about.

## Who may see what

- One rule, `access(viewer, asset)` in `apps/api/src/policy/canView.ts`, returns `none | status | download | full`.
  Every media route, asset read and HLS key request compares it with the route's minimum.
- Anything below the minimum is **404**, never 403, so members never learn that core items exist. Lists use the SQL
  twin in `policy/visibleSql.ts`. `apps/api/test/canView.test.ts` checks both against every role × tier × status ×
  deleted combination, row by row.
- Members only see events that contain something they can see. Event counts and covers are computed per viewer.
- Disabled users lose every session immediately. Their next request is a 401.

## Sign-in

- **Codes.** Email one-time codes: 6 digits, valid for 10 minutes, 5 attempts, newest code only. Codes are stored as
  `HMAC-SHA256(OTP_PEPPER, email:code)` and compared in constant time.
- **No enumeration.** Unknown, disabled and (before launch) non-allowlisted addresses get a decoy row. request-code
  always answers 204 after a ~350 ms floor, and mail is sent after the response.
- **Rate limits** (in memory, per process; Passenger runs one process):
  - request-code: 3 per 15 min per email, and 10 per hour per IP;
  - verify: 20 per 15 min per IP;
  - all of `/api`: 600 per minute per IP, except media and uploads.

  Client IPs come from `X-Forwarded-For`, trusted only from 127.0.0.1 (Apache in front of Passenger).
- **Sessions.** A 32-byte random token in an `HttpOnly; SameSite=Lax; Secure` cookie (`sid`). Only its SHA-256 is
  stored. Sessions are valid for 30 days, sliding (extended at most once an hour).
- **CSRF.** Every non-GET `/api` request needs `X-Requested-With: acm-media`. The API never grants CORS, so another
  origin can't send that header.

## Encryption at rest (core tier)

- **Originals and image outputs.** These, plus video posters and thumbnails, are sealed as **ACMENC01**:
  XChaCha20-Poly1305 in 1 MiB chunks.
  - Each chunk's nonce is a per-file random base XOR the chunk index.
  - Each chunk's associated data is `asset_id ‖ chunk index ‖ is_last`, so reordering, truncation, swapping chunks
    between files and header edits all fail authentication.
  - A Range request decrypts only the chunks it overlaps (`packages/core/src/crypto/aeadFile.ts`).
- **Video segments.** These are AES-128 encrypted by ffmpeg at encode time (`-hls_key_info_file`) and served as-is.
  The 16-byte key is served by `GET /api/media/:id/hls/key`, behind the same `access()` check, with `Cache-Control: no-store`.
- **Keys.** Each asset has a 32-byte file key and a 16-byte HLS key, wrapped with `crypto_secretbox` under
  `MASTER_KEY`, in `asset_keys`.
  - `MASTER_KEY` lives only in `~/apps/acm-media/shared/.env` (chmod 600) and the chapter's password manager.
  - Rotate it with `npm run rotate-master-key`; that re-wraps the keys and leaves the files untouched.
- **Plaintext core data** exists only inside a job's `tmp/<job>/` and the asset directory while that job runs:
  - the worker seals the original once its outputs exist;
  - re-processing decrypts into `tmp/`, which is removed when the job ends;
  - ffmpeg's key files sit in `KEYS_DIR` only during the encode.
- **Tier changes** take effect for access immediately. A `retier` job (images) or a re-process (videos) then
  re-seals or unseals the stored bytes. Moving an item back to member tier deletes its keys.

## Uploads and processing

- **Types.** The file type comes from magic bytes, never from the name. Only JPEG, PNG, HEIC/HEIF, AVIF, WebP,
  MP4 and MOV are accepted.
- **Uploader identity.** The uploader is set by the API in an internal header, after authentication. Any
  client-sent copy is stripped from both `headers` and `rawHeaders`, and a test covers spoofing.
- **Child processes** (Python, ffmpeg):
  - get fixed argument lists, no shell;
  - run at nice 10, with thread caps (the host reports 64 CPUs), hard timeouts and cancellation;
  - never have untrusted strings joined into paths: HLS variant names are checked against stored labels.

## Headers and logs

- **Security headers.** Helmet sets a strict CSP:
  `default-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; img-src 'self' blob: data:; font-src 'self'; style-src 'self'; frame-ancestors 'none'`,
  plus `Referrer-Policy: same-origin` and `nosniff`. Fonts are self-hosted. zod runs in jitless mode in the browser,
  so `script-src` needs no `unsafe-eval`. HSTS is added once AutoSSL is confirmed for library.qu.acm.org.
- **Log redaction.** Logs leave out cookies, `Set-Cookie`, OTP codes and emails on auth routes. The worker never logs
  job params or key paths.
- **Error references.** Server errors return a short reference (e.g. `7F3A-21C9`) that matches the log line, never a
  stack trace.

## Known gaps

| Gap | Why it is acceptable for now | What would fix it |
|---|---|---|
| PostgreSQL 9.6 is end-of-life | It is the only Postgres the cPanel host offers; the schema avoids newer features so moving up is a dump/restore | Ask the host for a supported version, or move hosts |
| HLS segments of one rung share a key and IV (`single_file` writes `IV=0x0`) | Leaks only whether two segments start with identical 16-byte blocks; keys are per asset and the same viewers can download the original | Package segments separately with per-segment IVs (more files per video) |
| Rate limits and tus locks are in memory | Passenger is pinned to one process | A shared store if the app ever runs more than one process |
| No offsite backup of originals | Shared-hosting disk only; the database is dumped nightly | An offsite copy of `~/media/assets` (see `docs/ops.md`) |
