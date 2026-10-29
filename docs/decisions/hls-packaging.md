# HLS packaging: single_file + AES-128

**Status:** decided (spike, 29 Oct 2026, on the production host and in Chrome with hls.js).

## Decision

Each rung is one `data.ts` with `#EXT-X-BYTERANGE` entries (`-hls_flags single_file`), `hls_time 6`, a 2 s GOP,
bt709 tags. Core-tier videos are encrypted at rest by ffmpeg itself with AES-128 (`-hls_key_info_file`), and the
key is served by `GET /api/media/:id/hls/key` behind `canView`. The API never rewrites segments.

## Why

- One file per rung keeps the inode count low on shared hosting (a 1-hour video is 3 files per rung instead of ~600).
- AES-128 applied by ffmpeg means no per-request decryption for segments: `data.ts` is served with plain Range.

## What the spike showed

- An 8 s HLG iPhone clip (IMG_4515.MOV) encoded to 2 rungs in 7.7 s on the host (`nproc` reports 64; thread caps are required).
- hls.js in Chrome played the encrypted output; the negative control (wrong key) failed to decode, as it should.
- **Portrait sources:** the clip is portrait after rotation, so the ladder scales the short side:
  `scale='if(gte(iw,ih),-2,H)':'if(gte(iw,ih),H,-2)'`. Rungs taller than the source's short side are dropped; at least one is kept.
- **Leftovers:** ffmpeg leaves `hls/<rung>/data.ts.tmp`. The worker deletes it before the output directory is swapped in.
- **IV reuse:** with `single_file`, ffmpeg writes an explicit `IV=0x0…` for every segment, and each segment is padded
  independently. Playback is correct, but every segment of a rung uses the same key and IV.

## Consequences

- IV reuse under AES-128-CBC leaks whether two segments start with identical 16-byte blocks; it does not reveal content
  otherwise. It is acceptable here because keys are per asset, the files are only reachable by core members, and the
  same people can download the original anyway. Revisit if threat model changes (fix: per-segment IVs by packaging
  segments separately, at an inode cost).
- The keyinfo file is written to `~/keys/<asset>.keyinfo` (outside the web root) for the encode and deleted right after.
