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
  house, or the Drive mirror coming in phase two).
- Restore = copy the folder back, start Moments pointed at it, accept the
  restore prompt. You can rehearse this any time — it's read-only for your
  files. If even `metadata.json` is lost, **Settings → Rebuild index from
  folders** brings every photo back from the files alone (captions can't be
  recovered that way).

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

## Video?

Not in v1 — images only (JPEG, PNG, WebP, HEIC). Keep videos in the same
folder tree if you like; Moments ignores them and they'll still be in your
backups.

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

## Phase two (planned, not yet built)

One-way backup mirrors from `PHOTOS_ROOT` to a local folder / USB disk and
to Google Drive (OAuth `drive.file` scope, resumable uploads), with
scheduling, verification, and a documented S3/R2 target mapping. The design
principles are fixed: local disk is the single authoritative copy, mirrors
are one-way, and a backup run never deletes at the target by default.
