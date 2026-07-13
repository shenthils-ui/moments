# Backup targets: design and how to add S3 / Cloudflare R2

## Principles (non-negotiable)

- The local `PHOTOS_ROOT` is the **one authoritative copy**. Targets are
  strictly one-way mirrors: local → target. The app never reads photo data
  from a target during normal operation.
- A run **never deletes at the target by default**. Deletions propagate only
  when "mirror deletions" is enabled per target, and even then only for
  files whose photo was purged from `_trash` after the retention window —
  and only for files this app itself uploaded.
- The target holds the **same plain folder tree** as `PHOTOS_ROOT`,
  including `_meta/metadata.json`. Restoring = download the folder, point a
  fresh install at it, accept the restore prompt. (This is verified by the
  automated disaster drill in `e2e/backup.spec.ts`.)

## The interface

Everything a target must implement lives in `server/backup/types.ts`:

```ts
interface BackupTarget {
  id: string;
  kind: string;
  displayName: string;
  connect(): Promise<void>;
  isConnected(): Promise<boolean>;
  listRemoteHashes(prefix?: string): Promise<Set<string>>;
  putFile(relPath: string, localPath: string, contentHash: string): Promise<PutResult>;
  deleteFile(relPath: string): Promise<void>;
  stat(): Promise<{ fileCount: number; bytes: number }>;
}
```

The engine (`server/backup/engine.ts`) owns everything else: run planning
(upload local files whose sha256 is absent from `listRemoteHashes()`),
concurrency limiting (default 3), exponential backoff, resume after crash,
run history, deletions policy, verification sampling, and scheduling. A new
target kind never needs to touch any of that — implement the six methods
and register the kind in `BackupManager.instantiate()` plus a small
"add target" form.

### Contract notes

- `putFile` must overwrite whatever was previously at `relPath`, and must
  verify the target's reported size (and checksum where the platform gives
  one) before resolving. A resolved `putFile` means "this file is safely and
  verifiably at the target".
- `listRemoteHashes` returns **content hashes**, not paths. That makes runs
  idempotent and resumable for free: after any interruption, the next run
  lists what actually arrived and uploads only the remainder.
- `deleteFile` is only ever called for explicit mirror-deletions.
- Failures should throw with human-readable messages; the engine records
  them per file and retries with backoff.
- Known limitation (all kinds): the diff is by content hash, so if a file's
  *path* changes locally while its content stays identical (e.g. a child was
  renamed and a photo was restored from trash into the new folder), the
  mirror keeps the old path until that file is next uploaded. Content is
  never lost, and `metadata.json` restore reports any path mismatches.

## Existing implementations

| Concern            | LocalFolderTarget                  | GoogleDriveTarget                                |
| ------------------ | ---------------------------------- | ------------------------------------------------ |
| connect            | mkdir + write-probe                | OAuth refresh-token → access token, ensure root folder |
| listRemoteHashes   | walk + re-hash actual bytes        | `files.list` filtered by `appProperties`, hash stored per file |
| putFile            | copy to temp + size/sha256 check + rename | multipart ≤5 MB / resumable chunks >5 MB; size + md5 verified |
| deleteFile         | `rm`                               | `files.delete` by stored file id                 |
| stat               | walk + sum                         | `files.list` + sum of `size`                     |
| identity/state     | none                               | `DATA_DIR/backup/gdrive-<id>.json` (0600): refresh token, folder/file id maps |

## Mapping to S3 / Cloudflare R2 (future target — do NOT build yet)

An `S3Target` fits the interface with no engine changes:

| Interface method   | S3 / R2 mapping |
| ------------------ | --------------- |
| `connect()`        | `HeadBucket` (and optionally a probe `PutObject`/`DeleteObject` under `.moments-probe`) using server-side credentials. Keys live in env vars / DATA_DIR — **never** in the client. |
| `isConnected()`    | `connect()` with errors swallowed. |
| `listRemoteHashes(prefix)` | `ListObjectsV2` with `Prefix`, paginated. Store the sha256 as object **metadata** (`x-amz-meta-moments-hash`) at upload; ListObjects doesn't return user metadata, so either (a) mirror the hash into the object key's sidecar index object `_meta/backup-index.json` updated per run, or (b) issue `HeadObject` only for keys whose `ETag`/size changed since the recorded state in `backup_files`. Simplest correct v1: rely on `ETag` — for non-multipart PUTs the ETag **is** the hex md5; store local md5 alongside sha256 in `backup_files` and compare. |
| `putFile(relPath, localPath, hash)` | Single `PutObject` for small files; multipart upload (or a **presigned PUT** issued server-side if an edge worker fronts R2) above ~50 MB. Set `x-amz-meta-moments-hash`. Verify: compare response `ETag` to the local md5 (single-part), or use `ChecksumSHA256` — S3 and R2 both support requesting a SHA-256 checksum on upload, which maps perfectly onto our `contentHash`. |
| `deleteFile(relPath)` | `DeleteObject` with the key = relPath. |
| `stat()`           | `ListObjectsV2` pagination, summing `Size`. |

Object keys are simply the relPaths (`Mila/2024/2024-06/....jpg`,
`_meta/metadata.json`), so a restore is: sync the bucket to a folder with
any S3 tool (`aws s3 sync`, `rclone`), point a fresh install at it. The
disaster drill applies unchanged.

Security posture, same as Drive: all credentials and signing stay
server-side; the browser only ever talks to the Moments API.
