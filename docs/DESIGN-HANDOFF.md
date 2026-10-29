# Design handoff: QU ACM Media Library

**For:** Claude Design · **From:** QU ACM Student Chapter · **Date:** 29 October 2026
**Ask:** design the complete application (every screen, state and flow listed below) as a responsive web app, desktop and phone.

This document is the single source of truth for the design. The backend and processing pipeline are already designed; the sections marked **Constraint** come from that design and should not be changed by the UI. Items marked **Open** are undecided: design a reasonable answer and flag it.

---

## 1. Product in one paragraph

A private web library for every photo and video the Qatar University ACM Student Chapter takes at its events. Members log in with a one-time code sent to their email, browse events, view photos as fast-loading compressed copies, stream videos at several qualities, and download the full-quality originals. Some content is restricted to **core members** (the chapter's organizing team) and is encrypted on the server. Core members upload content after each event; the server then processes it (compression, video renditions, HDR→SDR conversion) in the background, which can take from minutes to several hours.

## 2. Users and roles

| Role | Who | Can |
|---|---|---|
| **Member** | Regular chapter members, added by an admin | Log in; browse and view **member-tier** content; download member-tier originals |
| **Core** | Organizing team; every core member has a `@qu.acm.org` mailbox | Everything a member can, plus: view and download **core-tier** content; upload; create and edit events; set an item's tier |
| **Admin** | A core member with the admin flag (assumption) | Everything core can, plus: manage members and roles; see processing details; retry, override or re-process items; see storage usage |

- **Constraint:** there is **no public access**. Every screen except login requires a session.
- **Constraint:** the role comes from the database, never from the email domain. Having a `@qu.acm.org` address does not make someone core.
- **Assumption, confirm:** only core members upload. Members only view and download.
- **Open:** should members be able to tell that core-only items exist (e.g. "12 items restricted to core members"), or should core content be completely invisible to them? Recommendation: invisible. A member following a link to a core item gets the same "not found" as a missing item.

## 3. Platform constraints that shape the UI

1. **Login is email OTP only.** No passwords and no "sign up" (accounts are created by admins).
   - The code is 6 digits, valid about 10 minutes, single use, with about 5 attempts.
   - Resends and requests are rate limited.
   - For security, the request-code screen shows the **same message whether or not the email is registered** ("If this address has access, we sent a code").
2. **Processing is asynchronous and slow for video.** Measured on the server:
   - Normal (SDR) video takes about **0.6×** its duration to process.
   - HDR video (most iPhone footage) takes about **1.2×**.
   - One job runs at a time, so an upload's wait also depends on the queue. A 2-hour event recording can take 1.5–3 hours.
   - The UI needs honest status and an estimated ready time, computed as the queued video durations × these factors. Images take seconds.
3. **What exists for each item once processed:**
   - **Image:** a WebP *view* copy (long edge 2560 px), a WebP *thumbnail* (long edge 480 px), and the untouched *original* (JPEG, HEIC, PNG…). HEIC originals may not open on some Windows PCs. **Open:** offer "Download as JPEG" too?
   - **Video:** an adaptive stream at **360p / 720p / 1080p** (fewer if the source is smaller) and the original file. Playback is HLS via hls.js, so the player switches quality automatically and can expose a manual quality picker.
4. **Core-tier content is encrypted.** This is invisible to users: core members just see it play and download normally. The UI only shows a **tier marker** (member / core). Never show "encrypted" jargon to members.
5. **Uploads are resumable** (tus protocol, chunked). Large videos (several GB) can pause and resume and survive a dropped connection or a closed tab, since resume works when the same file is picked again. Upload UI must show per-file progress, speed, pause/resume, retry and cancel.
6. **Items can be flagged for review** instead of processed automatically:
   - video recorded in a "Log" color profile;
   - an unrecognized format;
   - a true-HDR still image with no standard version.

   Admins need a place to see and resolve these.
7. **Video tone-mapping choice is automatic but auditable.** For HDR videos the system picks a conversion curve (Hable, BT.2446-A, BT.2390 or Reinhard) by comparing quality scores; it falls back to Hable when the scores disagree. Admins can view the scores, override the curve, and re-process from the original.
   - **Members never see this.**
   - **Admins** see it in a details panel. The scores are two ranks per candidate (DISTS rank, TOPIQ rank, their sum, the winner).
8. **Originals are never deleted by processing**, so re-processing is always possible.
9. **Storage is "unlimited" in bytes but may be limited in file count** (that limit is unknown for now; current usage is about 27k files). The admin storage view shows bytes used, the file count, and the limit once known.
10. **Expected scale:** design for **hundreds of events and tens of thousands of items**. Grids must virtualize or paginate; never assume everything fits on one page.

## 4. Information architecture

```
Login
 ├─ Enter email
 └─ Enter code
Library (home)
 ├─ Event list (grid / list, search, filters)
 ├─ Event page
 │   ├─ Media grid (photos / videos / all, tier filter for core)
 │   ├─ Image viewer (lightbox)
 │   └─ Video player
 ├─ Search results (across events)
Upload (core)
 ├─ Choose or create event
 ├─ Add files, set tier
 └─ Upload progress
My uploads (core): processing status of what I uploaded
Admin (admin)
 ├─ Members
 ├─ Processing queue (queued, running, failed, flagged)
 ├─ Item details (renditions, tone-mapping scores, override, re-process)
 └─ Storage
Account: name, email, sign out, sign out of all devices
```

## 5. Data shown in the UI

**Event**
- title; date or date range; location (optional); description (optional)
- cover image (chosen, or the first photo)
- default tier for new uploads
- counts: photos, videos, total duration
- created by, created at

**Item (asset)**
- type: image or video; tier: member or core; event; uploader
- capture date (from file metadata, if present) and upload date
- dimensions; duration (video); original file size and format; capture device (from metadata, if present)
- status: `uploading → queued → processing (step) → ready`, or `failed`, or `needs review`
- for admins:
  - renditions list (size of each);
  - processing settings version;
  - HDR or not;
  - chosen tone curve and its scores;
  - error message if failed

**User**
- name; email
- role: member or core; admin flag
- status: active or disabled
- added by, added at; last login
- count of uploads (core)

**Job (admin)**
- item; kind (image or video)
- state, current step; position in queue; estimated start and finish
- attempts; last error

## 6. Screens

For each screen, design **all states listed**: default, loading (skeletons), empty, error, and the role variants.

### 6.1 Login: enter email
- One field and a button. Short line explaining access is invite-only.
- **States:** invalid email format; sending; rate limited ("Try again in N minutes"); generic network error.
- After submit, always go to the code screen with the neutral message from §3.1.

### 6.2 Login: enter code
- 6-digit code input, either six boxes or one field that accepts paste, with auto-submit on the sixth digit.
- Show the email it was sent to, with a "use a different email" link.
- "Resend code" stays disabled during a cooldown with a visible countdown.
- **States:**
  - wrong code, showing attempts left;
  - expired code;
  - too many attempts (request a new code);
  - success, which redirects to where the user was going.
- Note that core members receive the code at their `@qu.acm.org` mailbox. Phrase this generically: "Check your inbox".

### 6.3 Library (home)
- Event list as a grid of cover cards: title, date, photo/video counts, and a tier marker if the event has core-only content (core viewers only).
- Sorted newest first, with a year divider or a year filter.
- Search box for event titles and descriptions.
- Filters: year, has videos.
- Core members see an **Upload** entry point and a compact "processing" indicator when their uploads are still in progress.
- **Empty state:**
  - for core: "No events yet. Create the first one", pointing to the upload flow;
  - for members: "Nothing here yet".

### 6.4 Event page
- Header: cover, title, date, location, description, counts.
- Core members also get an "Edit event" action and an "Add media" action.
- Media grid (justified or masonry; photos and videos mixed):
  - videos show a duration badge and a play glyph;
  - core-tier items show a tier marker (core viewers only).
- Filter: All / Photos / Videos. Core viewers also get: Member-tier / Core-tier.
- **Items still processing:**
  - core members see placeholders with status and an estimated ready time;
  - members don't see unfinished items at all.
- **Selection mode (core; optional for members):** select several items to download.
  - **Open:** zip download or per-file downloads. Recommendation: per-file downloads in v1, with zip as future work.
- **Pagination:** infinite scroll with a virtualized grid.

### 6.5 Image viewer
- Full-screen lightbox showing the WebP view copy, with zoom/pan and previous/next (arrows, swipe, keyboard).
- Info panel:
  - capture date, device, dimensions;
  - original format and size;
  - uploader; event.
- **Download original** shows its format and size (e.g. "Download original · HEIC · 3.1 MB").
- Admin-only: "Details" opens the item admin panel (§6.11).
- **States:** loading (show the thumbnail first, then swap in the view copy); failed to load.

### 6.6 Video player
- Custom controls over hls.js: play/pause, seek with buffered range, time, volume, fullscreen, and **quality: Auto / 1080p / 720p / 360p** (only the renditions that exist). Show the current level while on Auto.
- Same info panel and **Download original** as images.
- **States:**
  - buffering;
  - stream error ("Can't play this video right now");
  - for core and admins only: video still processing, with progress and an estimated ready time.
- **Open:** keyboard shortcuts (space, arrows, f).

### 6.7 Upload (core)
1. **Choose event:** pick an existing event (search) or create one inline (title, date, optional location and description, default tier).
2. **Add files:** drag and drop on desktop, file picker on phone (photo library access).
   - Accepted: JPEG, PNG, HEIC, AVIF, WebP, MP4, MOV.
   - Show a file list with name, size, type icon, and a per-file tier toggle that defaults to the event's tier.
   - Bulk "set all to core / member".
3. **Upload:** per-file progress bar, speed, time remaining, and pause/resume/cancel; an overall progress summary.
   - **States:** paused; offline (auto-resume when back); failed (retry); a duplicate warning if the same file was already uploaded to this event.
   - Closing the tab mid-upload: on return, show "Resume N unfinished uploads". Re-selecting the same files continues where they stopped.
4. **Done:** "Uploaded N files. Photos will be ready in a few seconds; videos in about X." Provide a link to My uploads.

**Recording guidance (small, dismissible tip in the upload flow):** ask members to film with *HDR video turned off* on chapter phones. Such files process about twice as fast, and they look the same on every screen.

### 6.8 My uploads (core)
- List of the user's uploads grouped by event, each row showing:
  - thumbnail; name;
  - status chip: queued (position N), processing (current step), ready, failed, needs review;
  - estimated ready time.
- Failed rows show the error in plain language. Core members can retry; admins can do more.
- Live updates; no manual refresh needed.

### 6.9 Admin: Members
- Table: name, email, role, admin, status, last login, uploads.
- Search and filter by role and status.
- **Add member:** email, name, role. Bulk add by pasting a list of emails.
- Change role (member ↔ core), toggle admin, disable or re-enable.
- **Confirmations are in-page:** removing someone's core access; disabling a user; removing your own admin flag (prevent removing the last admin).
- Disabling a user signs them out everywhere. Say so in the confirmation.

### 6.10 Admin: Processing queue
- Tabs: **Running** (one at a time) · **Queued** · **Failed** · **Needs review** · **Recent** (completed).
- **Running:** item, kind, current step (e.g. "Scoring tone curves", "Encoding 720p"), elapsed time, estimated finish.
- **Queued:** order, estimated start and finish for each. **Open:** allow reordering or prioritizing?
- **Failed:** error, attempts, Retry.
- **Needs review:** reason (Log footage, unknown format, HDR still image) and actions: process anyway with the default settings, or mark as "original only" (downloadable, not streamable).
- A queue health summary at the top: jobs waiting, total queued video duration, estimated time to drain.

### 6.11 Admin: Item details panel
Opened from any item or job.
- Source info: codec, resolution, frame rate, HDR format (SDR / HLG / PQ), duration, size.
- Renditions: each quality with its size, and the view and thumbnail sizes for images.
- Processing settings version and processed-at time.
- **HDR videos:** a table of the candidate curves with DISTS rank, TOPIQ rank, their sum, the chosen curve highlighted, and a note when the fallback was used. Show the 8 sampled frames as small thumbnails along a timeline.
- Actions:
  - **Override curve** (pick a candidate) → **Re-process**, with a confirmation that shows the estimated processing time;
  - **Re-process with current settings**;
  - **Change tier** (re-encrypts; tell the admin it takes a moment);
  - **Delete item**, with a confirmation that says originals are deleted too.

### 6.12 Admin: Storage
- Bytes used: total, and split into originals vs renditions.
- File count vs limit (the limit can be "unknown"; design for both).
- Largest events. Growth over time (a simple chart).

### 6.13 Account
- Name (editable); email (read-only); role.
- Sign out; sign out of all devices.

### 6.14 System states (global)
- Session expired: ask the user to log in again, returning to the same page afterwards.
- Not found, used for both missing items and items the user lacks access to.
- Offline banner.
- Server error.

## 7. Key flows to prototype

1. **First login:** enter email → code arrives → enter code → library.
2. **Browse to a photo and download the original** on a phone.
3. **Watch a video:** open → starts on Auto → switch to 1080p → fullscreen.
4. **Core upload after an event, on a phone over campus Wi-Fi:** create the event → add 80 photos and 3 videos → leave the page → come back → resume → done screen with estimates → My uploads.
5. **Admin handles a flagged video:** Needs review → item details → process anyway.
6. **Admin overrides a tone curve:** item details → compare scores and frames → choose another curve → re-process → watch the status.
7. **Admin adds 20 new members** by pasting emails.

## 8. Component inventory

App shell (top bar, account menu, admin nav) · event card · media tile (image, video, processing, failed, needs review) · tier marker · status chip (queued, processing, ready, failed, needs review) · justified/masonry grid with virtualization · lightbox · video player with quality menu · info panel · upload dropzone · upload file row (progress, pause/resume/cancel/retry) · OTP code input · search field · filter chips · data table (sortable, filterable) · tabs · in-page confirmation dialog · toast · empty state · skeleton loaders · banner (offline, session) · small chart (storage).

## 9. Visual direction

- **No existing design system or brand tokens.** Define the app's own visual language: palette, type scale, spacing, radius, component styles. Deliver it as tokens with the screens.
- **The content is the hero.** The interface is a frame for event photography and video: neutral, low-chroma chrome; restrained accent color; no decorative backgrounds competing with photos.
- **Light and dark themes**, both first-class. Dark matters for viewing media. Follow the OS setting with a manual toggle.
- **Tier marker** must be legible in both themes and distinguishable without color (icon + label).
- **Status colors** (processing, ready, failed, needs review) are separate from the accent, and use shape or icon as well as color.
- **Accessibility:** WCAG 2.2 AA contrast; full keyboard support (lightbox, player, grids, tables); visible focus; reduced-motion support; alt text from the event title and date when nothing better exists.
- **Breakpoints:** phone (~390 px), tablet, desktop (1440 px). The upload flow and browsing must be excellent on phones, since content is captured on phones at events.

## 10. Copy

- Plain English, short sentences. Name things the way members think of them: event, photo, video, original, quality. Avoid rendition, HLS, transcode, tone mapping, encrypted.
- Admin screens may use precise technical terms (HDR format, curve names, scores), with one-line explanations on hover.
- Errors say what happened and what to do next.
- **Open:** Arabic. The chapter publishes bilingual (Arabic/English) content elsewhere. Should the UI support Arabic with right-to-left layout? Recommendation: design English first, but use layouts that mirror cleanly for RTL (logical start/end alignment, no direction-dependent icons without mirrored versions).

## 11. Out of scope for v1 (design should not depend on these)

Public sharing links · comments or likes · face recognition or people tags · editing photos · zip downloads (possible later) · HDR playback for HDR-capable devices (SDR only in v1) · native apps.

## 12. Open questions summary

| # | Question | Recommendation |
|---|---|---|
| 1 | Do members know core-only items exist? | No, hide them completely |
| 2 | Who uploads? | Core only (confirm) |
| 3 | "Download as JPEG" for HEIC originals? | Yes, if cheap; otherwise the original only |
| 4 | Multi-select download as zip? | Per-file in v1 |
| 5 | Can admins reorder the processing queue? | Nice to have |
| 6 | Arabic / RTL support? | Design RTL-ready |
| 7 | Which email addresses normal members log in with | Whatever an admin registers (likely QU student email) |

## 13. Deliverables

1. Design tokens (color for both themes, type, spacing, radius, elevation) and a short usage guide.
2. Components from §8 with all states.
3. Every screen in §6 at phone and desktop widths, in both themes, with loading, empty and error states.
4. Clickable prototypes of the flows in §7.
5. Annotations wherever behavior isn't obvious from the frame (live updates, cooldowns, resume logic, role differences).
