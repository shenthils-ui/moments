# Moments

A private, self-hosted photo timeline for your kids — a replacement for
Peekaboo Moments / TimeHut that you fully own.

**The one idea that matters:** your photos live as plain files on **your own
disk**, in real folders you can browse, copy and back up with any tool. The
app is only an organizer and viewer on top. Uninstall it and you lose
nothing. No cloud, no account, no data ever leaves your network.

```
data/photos/                  ← PHOTOS_ROOT: this folder IS the library
├── Mila/
│   └── 2024/
│       └── 2024-06/
│           └── 2024-06-14_183021_a1b2c3d4.jpg   ← original, never modified
├── _meta/
│   └── metadata.json         ← all captions, children, tags, milestones
└── _trash/                   ← deleted photos, kept 30 days
```

Back up `data/photos` and you have everything.

---

## Running on a Windows PC

1. **Install Node.js** (once): go to <https://nodejs.org>, download the LTS
   version, run the installer with default settings.
2. **Double-click `start.bat`.** The first run installs and builds
   (a few minutes); after that it starts in seconds.
3. Your browser opens at `http://localhost:3000`. The first-run wizard asks
   where photos are stored, an optional family password, and your first
   child.

### Connecting phones

`start.bat`'s window prints the address for phones **and a QR code** — scan
it with the phone camera (phone must be on the same Wi-Fi). Add the page to
your home screen for an app-like feel.

> Over plain `http://` on a LAN address, browsers don't allow full PWA
> install or service workers (no "secure context"). Moments detects this
> and simply runs as a normal web app — everything works. For full PWA
> install and access away from home, see [Tailscale](#remote-access-with-tailscale) below.

### Where photos are stored

By default `data/photos` next to the app. To use another disk, set the
`PHOTOS_ROOT` environment variable or create `config.json` next to
`package.json`:

```json
{ "photosRoot": "D:/FamilyPhotos", "dataDir": "D:/MomentsData", "port": 3000 }
```

## Importing years of old photos (Peekaboo / TimeHut exports)

1. Put the export folder somewhere on the server's disk
   (e.g. `D:\exports\timehut`).
2. In Moments open **More → Bulk import**.
3. Enter the folder path and press **Dry run** — you get counts, the date
   range, and how many duplicates would be skipped. Nothing is written yet.
4. Choose which child(ren) the photos belong to, keep **Copy** mode
   (the export stays untouched), and press **Import**. Progress is shown
   per file; duplicates (identical bytes) are skipped automatically.

Dates come from EXIF when present, otherwise from the file's modified time,
and can be fixed per photo later.

## The family password

Optional, off by default (fine for a trusted home network). Set it in the
wizard or in **Settings → Family password**; it then protects everything,
including the image URLs themselves. One password for the whole family.

## Backups (please read)

- **Back up `PHOTOS_ROOT`. That's it.** Photos are the original files and
  `_meta/metadata.json` carries every caption, child, tag and milestone.
- **RAID is not backup.** RAID protects against a dead disk, not against
  accidental deletion, ransomware, fire or theft.
- Keep **at least one copy off-site** (an external disk at a relative's
  house, or the built-in Google Drive mirror below).
- Restore = copy the folder back, start Moments pointed at it, accept the
  restore prompt. You can rehearse this any time — it's read-only for your
  files. If even `metadata.json` is lost, **Settings → Rebuild index from
  folders** brings every photo back from the files alone (captions can't be
  recovered that way).

### Built-in backup mirrors (Settings → Backup)

Moments can mirror the photo folder to one or more targets, on a schedule
(manual, hourly, or daily at a set time):

- **Local folder** — an external USB disk, a mounted NAS share, a second
  drive. The mirror is the same plain folder tree; it works without the app.
- **Google Drive** — see setup below.

How mirroring behaves (by design, not configurable away):

- One-way only: local → target. Your disk is the single source of truth.
- A run uploads only what's missing at the target (compared by content
  hash), retries with backoff, survives restarts mid-run, and never blocks
  browsing or uploads.
- **Nothing is ever deleted at the target by default.** The optional
  per-target "mirror deletions" switch only removes files whose photo was
  deleted in the app AND already purged from the 30-day trash.
- After each upload the size (and checksum where available) is verified;
  "Verify backup" re-checks a random 1% sample any time and reports drift.

### Google Drive backup — one-time OAuth setup

Moments uses the minimal `drive.file` permission: it can only see files it
uploaded itself, nothing else in your Drive. Google requires you to create
your own (free) OAuth client once:

1. Go to <https://console.cloud.google.com> and sign in.
2. Create a project (name it e.g. `moments-backup`).
3. **APIs & Services → Library** → search "Google Drive API" → Enable.
4. **APIs & Services → OAuth consent screen**: choose External, fill in
   just the app name and your email, add yourself as a **test user**
   (that's enough — the app stays in testing mode, only you can use it).
5. **APIs & Services → Credentials → Create credentials → OAuth client
   ID** → type **Web application**. Under "Authorised redirect URIs" add:
   `http://localhost:3000/api/backup/gdrive/callback` — and if you'll
   connect from another address, that one too, e.g.
   `http://192.168.1.50:3000/api/backup/gdrive/callback`.
6. Copy the **Client ID** and **Client secret**, then start Moments with
   them set as environment variables (never commit them anywhere):
   - Windows: `set GOOGLE_CLIENT_ID=...` and `set GOOGLE_CLIENT_SECRET=...`
     before `start.bat`, or set them in System → Environment Variables.
   - Docker: uncomment the lines in `docker-compose.yml`.
7. In Moments: **Settings → Backup → Google Drive → Add**, then
   **Connect** and approve in the browser. Done — the refresh token is
   stored server-side (0600 permissions) and never shown to any browser.

A 10-minute manual test list for the Drive target lives in
[`docs/manual-drive-checklist.md`](docs/manual-drive-checklist.md).
Extending backups to S3/Cloudflare R2 is documented in
[`docs/backup-targets.md`](docs/backup-targets.md).

## Moving to a NAS (Synology / QNAP)

1. Copy your `PHOTOS_ROOT` folder to the NAS (e.g. `/volume1/photos`).
2. Put this project folder on the NAS and edit `docker-compose.yml`'s left
   volume side: `/volume1/photos:/photos`.
3. `docker compose up -d --build`
4. Open `http://<nas-ip>:3000` — Moments detects the existing library and
   offers one-click restore. Done: same photos, same captions.

The container has a healthcheck, so the NAS UI shows if it's unhealthy.

## Remote access with Tailscale

[Tailscale](https://tailscale.com) gives every device a private, encrypted
address that works from anywhere — no ports opened on your router:

1. Install Tailscale on the server (PC/NAS) and on your phones; log all
   devices into the same tailnet.
2. Moments is now reachable at `http://<server-tailscale-name>:3000` from
   anywhere.
3. For **https** (which also unlocks full PWA install): enable HTTPS
   certificates in the Tailscale admin console, then on the server run
   `tailscale serve --bg 3000`. Moments is then at
   `https://<machine>.<tailnet>.ts.net`, with a valid certificate, and the
   install prompt appears on phones.

## Photos and videos

Moments handles both:

- **Photos:** JPEG, PNG, WebP, GIF, HEIC.
- **Videos:** MP4, MOV (QuickTime), M4V, WebM.

Videos are stored exactly as you upload them — **never re-encoded** — just
like photos. Moments generates a poster thumbnail and reads the duration and
recording date, then plays the video right in the browser with normal
controls and seeking. GIFs animate when opened.

A video's format has to be one your browser can decode (H.264 MP4 and WebM
play virtually everywhere; some phone codecs may not). When a browser can't
play a particular file, Moments shows a clear message with a **Download**
button instead of a broken player — the original is always safe on disk.

**Thumbnails and metadata for video need `ffmpeg`.** You don't have to install
it yourself: on Windows/macOS the `npm install` step fetches a bundled copy
automatically, and the Docker image installs it. If a system `ffmpeg` is on
your `PATH`, that's used too. Without ffmpeg, videos still upload and store
safely — only the poster thumbnail is skipped (a placeholder is shown). You
can point Moments at a specific binary with the `FFMPEG_PATH` / `FFPROBE_PATH`
environment variables.

## For developers

```bash
npm install
npm run dev:server     # API on :3000 (tsx watch)
npm run dev:client     # Vite dev server on :5173, proxies /api
npm run build          # server -> dist/server, client -> dist/client
npm start              # run the built app
npm test               # API tests (vitest + supertest)
npm run e2e            # Playwright end-to-end suite (needs `npm run build` first,
                       # and `npx playwright install chromium` once — or point
                       # CHROMIUM_PATH at an existing Chromium binary)
npm run verify         # build + all of the above, one command
```

- `PHOTOS_ROOT` / `DATA_DIR` / `PORT` env vars (or `config.json`) configure
  everything.
- SQLite (`DATA_DIR/library.db`) is the runtime index; it is always
  reconstructable from `PHOTOS_ROOT` (restore or rebuild), so deleting
  `DATA_DIR` is never fatal.
- Thumbnails are a disposable cache in `DATA_DIR/cache/thumbs`.
- The e2e suite includes the **recovery drill**: it deletes `DATA_DIR`,
  restarts the server against the same `PHOTOS_ROOT` and proves everything
  comes back. Run it after any change to storage code.
- Renaming the app is a one-line change in `shared/appName.ts`.

## Docs

- [`docs/backup-targets.md`](docs/backup-targets.md) — backup architecture
  and the S3/Cloudflare R2 target mapping (future).
- [`docs/manual-drive-checklist.md`](docs/manual-drive-checklist.md) —
  10-minute manual smoke test for the real Google Drive target.
