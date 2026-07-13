# Google Drive backup — 10-minute manual smoke test

The automated suite tests `GoogleDriveTarget` against a local mock of the
Drive REST API (`tests/driveMock.ts` + `tests/gdrive.test.ts`). Real Google
OAuth and the real Drive service can't run in CI, so check this list once
against your actual Google account after setting up the OAuth client
(README → "Google Drive backup").

Prep: server running with `GOOGLE_CLIENT_ID` (+ `GOOGLE_CLIENT_SECRET` for
a "Web application" client) set; a library with at least a handful of
photos, at least one larger than 5 MB (any big JPEG) to exercise the
resumable upload path.

1. **Add target** — Backup screen → "Google Drive" → Add. The target
   appears with a "Connect / reconnect" button. *(~30 s)*
2. **Consent flow** — press Connect. Google's consent screen must ask for
   ONLY "See, edit, create and delete **only the specific Google Drive
   files that you use with this app**" (that's `drive.file`). Approve. You
   land back on the Backup screen with "Google Drive connected ✓" and the
   target shows "connected". *(~1 min)*
3. **Token storage** — confirm `DATA_DIR/backup/gdrive-<target-id>.json`
   exists and (on Linux/NAS) has `-rw-------` permissions. Confirm the
   refresh token never appears in any API response: open DevTools →
   Network → `/api/backup/targets` — the gdrive target's `config` must be
   empty. *(~1 min)*
4. **First run** — "Back up now". Progress advances; the big file takes
   visibly longer (resumable path). Run ends "done — N uploaded, 0 FAILED".
   *(~2 min for a small library)*
5. **Drive side** — in drive.google.com you see a "Moments Backup" folder
   containing the same `Child/Year/Month` tree as your photo folder, plus
   `_meta/metadata.json`. Spot-check one photo opens and is the original
   resolution. *(~1 min)*
6. **Idempotence** — "Back up now" again: finishes quickly with
   "0 uploaded, N already present". *(~30 s)*
7. **Incremental** — upload one new photo in the app, run again: exactly
   1 photo uploaded (+ the updated `metadata.json`). *(~1 min)*
8. **No deletions by default** — delete that photo in the app (to trash),
   run again: the file is still in Drive. *(~1 min)*
9. **Verify** — "Verify backup (1% sample)" reports "no drift". *(~30 s)*
10. **Revocation → reconnect** — at myaccount.google.com → Security →
    Third-party access, remove the app's access. "Back up now" → the run
    fails with a clear "revoked — reconnect" error and the target shows
    the Connect button again. Reconnect; a run works again. *(~2 min)*

Restore rehearsal (optional but recommended once): download the
"Moments Backup" folder from Drive (right-click → Download, unzip), point a
fresh Moments install's `PHOTOS_ROOT` at the unzipped folder, accept the
restore prompt, and confirm photos + captions + children are all there.
