# Changelog

All notable changes to Moments are recorded here. Dates are ISO (YYYY-MM-DD).

## [1.2.0] — 2026-07-15

### Added — timeline navigation, smarter dates, video filter

- **Filename date recovery.** When a photo/video has no embedded date (common
  for screenshots and files pasted/copied off a phone, whose file time is the
  copy time), the capture date is now recovered from the filename — the usual
  camera/app conventions (`IMG_20230514_130502`, `PXL_…`, WhatsApp
  `IMG-20230514-WA…`, `Screenshot_…`, `2023-05-14 13.05.02`, etc.). Resolution
  order is embedded metadata → filename → file time. This stops undated files
  piling up in the current month.
- **Fix already-imported dates.** Bulk import gains a "Fix dates of photos
  already imported" option: re-run it on your original folder and any photo
  whose date was only a guess is corrected from the file's real date/filename —
  no duplicates created, no files renamed.
- **"Date guessed" indicator** in the lightbox for photos whose date is only a
  file-time guess, so they're easy to find and fix.
- **Date-jump navigator.** A "Jump to date" dropdown on the timeline lists
  years → months → days (with counts); click to jump straight there. Backed by
  a new `/api/photos/histogram` endpoint; respects the active filters.
- **Photo / video filter.** All / Photos / Videos toggle on the timeline
  (`?kind=` on the photos API), so videos are easy to find.
- **Real "More" menu.** The bottom-nav "More" now opens a menu of the secondary
  screens (Milestones, Folders, Bulk import, Backup, Trash, Settings) instead
  of jumping straight to Settings.
- Duplicate handling unchanged and confirmed: exact (byte-identical)
  duplicates are detected by content hash and skipped on upload and import,
  and reported in the results — regardless of filename or date.
- Tests: new API coverage (filename dates, histogram, the `to` anchor, the
  fix-dates re-import) and e2e (date-jump, video filter, More menu).

## [1.1.0] — 2026-07-15

### Added — videos and GIFs

- **Video support** (`.mp4`, `.mov`, `.m4v`, `.webm`): originals are stored
  untouched (never re-encoded), with a poster thumbnail, duration, and
  recording-date extraction via ffmpeg/ffprobe. Videos play in the lightbox
  with native controls and byte-range seeking; a "download to view" fallback
  covers codecs a browser can't decode. Timeline/calendar/folder tiles show a
  play badge and duration.
- **GIF support** (`.gif`): stored as images, thumbnailed to a static poster,
  and animated when opened.
- ffmpeg is resolved from `FFMPEG_PATH`/`FFPROBE_PATH`, then the bundled
  `ffmpeg-static`/`ffprobe-static` optional dependencies (Windows/dev), then a
  system `ffmpeg` on `PATH` (used by the Docker image, which now installs it).
  Without ffmpeg, videos still upload and store; only the poster is skipped.
- Data model gains `kind` ('photo'|'video', derived) and `durationSec`
  (schema migration v3). New `?kind=video|photo` filter on the photos API.
- Upload accepts and previews videos; larger upload size limit (2 GB) for
  full-length clips.
- Tests: 7 new API tests (video ingest, poster, mtime fallback, range
  streaming, kind filter, rebuild) and a new browser e2e that uploads a video
  and plays it. Video tests skip gracefully where ffmpeg is absent.

## [1.0.0] — 2026-07-15

First complete release: a private, self-hosted family photo timeline where
photos live as plain files on your own disk.

### Phase one — the app

- **Storage model**: `PHOTOS_ROOT/<Child>/<YYYY>/<YYYY-MM>/` with
  content-hashed filenames; originals never modified after ingest. Full
  metadata snapshot at `_meta/metadata.json` (debounced, atomic writes).
  SQLite runtime index with schema versioning + migrations, always
  reconstructable via one-click restore or rebuild-from-folders.
- **Ingest**: multipart upload and server-side bulk import (dry-run +
  progress), sha256 dedupe, EXIF `DateTimeOriginal` with file-mtime
  fallback, HEIC support via sharp with a libheif-WASM fallback and a
  labelled placeholder when a file can't be decoded.
- **Screens**: first-run wizard (with restore detection), timeline (month
  groups, per-child ages, "pregnancy" label, infinite scroll), calendar,
  upload (previews, per-file progress/retry, duplicate reporting), lightbox
  (full-res, swipe, edit caption/tags/date/milestone, delete-to-trash, on-disk
  path), milestones, on-disk folder browser, bulk import, settings, trash
  (30-day retention with restore).
- **Data portability**: metadata export/import (lossless round-trip) and
  streamed ZIP export of originals.
- **Auth**: optional single family password (scrypt, timing-safe) protecting
  everything including image URLs; off by default for LAN use.
- **Packaging**: `start.bat` (Node check, first-run build, LAN URL + terminal
  QR), Dockerfile + docker-compose with healthcheck, PWA manifest/service
  worker feature-detected so plain-http LAN use degrades gracefully. Zero
  external requests at runtime (asserted in the e2e suite).

### Phase two — backup mirrors

- **One-way mirror engine**: content-hash diff, concurrency-limited uploads
  (default 3) with exponential backoff, resume after crash, run history with
  per-file failure lists, manual/hourly/daily schedules, post-upload
  size+checksum verification and a 1%-sample "verify backup" action.
- **Targets**: `LocalFolderTarget` (USB/NAS/any writable path, self-healing
  on corruption) and `GoogleDriveTarget` (Drive REST v3, `drive.file` scope
  only, PKCE OAuth, resumable uploads >5 MB, server-side 0600 token storage,
  clear reconnect state on revocation).
- **Deletion safety**: nothing is deleted at a target by default; the opt-in
  "mirror deletions" toggle only removes files whose photo was purged from
  trash after the retention window.
- **Backup screen**: target management, schedules, live progress, last-run
  status/failures, verify, Drive connect/reconnect.
- **Docs**: `docs/backup-targets.md` (architecture + S3/R2 mapping) and
  `docs/manual-drive-checklist.md` (10-minute real-Drive smoke test).

### Review pass — hardening (2026-07-15)

- **Security**: family-password sessions now expire (60-day TTL); expired
  tokens are rejected on use and swept daily, so the sessions table can't grow
  without bound and a leaked cookie can't stay valid indefinitely.
- **Correctness**: the folder filter now escapes SQL `LIKE` metacharacters, so
  a child folder containing `_` or `%` (e.g. "100_days") matches literally
  instead of as a wildcard.
- **Accessibility**: added accessible names to icon-only controls (lightbox
  previous/next, calendar previous/next month).
- **Build hygiene**: added `.dockerignore` so the image build context excludes
  `node_modules`, `dist`, local `data/`, and test artifacts — smaller images
  and no risk of baking private photos into an image layer.

### Verification

35 API/integration tests (vitest + supertest, including a mock Google Drive
server) and 15 Playwright end-to-end tests against the real built server,
covering the recovery drill, the backup interrupt/resume drill (hard process
kill), and the full disaster drill. One command: `npm run verify`.

### Known limitations

- UI is English-only.
- The backup diff is by content hash, so a file whose local path changes while
  its bytes stay identical keeps its old path at the target until re-uploaded
  (content is never lost).
