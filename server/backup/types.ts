/**
 * A backup target is a strictly ONE-WAY mirror: local PHOTOS_ROOT -> target.
 * The local disk is the single authoritative copy; the app never reads photo
 * data back from a target during normal operation. A target holds the same
 * plain folder tree as PHOTOS_ROOT (including _meta/metadata.json), so a
 * restore is: download the folder, point a fresh install at it.
 *
 * The interface is deliberately small so that a future S3/R2 target (or any
 * object store) can implement it with no engine changes — see
 * docs/backup-targets.md for that mapping.
 */
export interface PutResult {
  /** Size the target reports after upload; must equal the local size. */
  sizeBytes: number;
  /** True when the target exposed a checksum and it matched. */
  checksumVerified: boolean;
}

export interface BackupTarget {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;

  /** Establish/refresh access. Throws with a human-readable reason. */
  connect(): Promise<void>;
  isConnected(): Promise<boolean>;

  /**
   * Content hashes of everything present at the target (optionally limited
   * to relPaths under `prefix`). The run uploads only local files whose
   * hash is absent from this set.
   */
  listRemoteHashes(prefix?: string): Promise<Set<string>>;

  /**
   * Upload one file to `relPath`, overwriting any previous version of that
   * path. Must verify the target's reported size (and checksum where the
   * target exposes one) before resolving.
   */
  putFile(relPath: string, localPath: string, contentHash: string): Promise<PutResult>;

  /** Remove one file. Only ever called for explicit mirror-deletions. */
  deleteFile(relPath: string): Promise<void>;

  stat(): Promise<{ fileCount: number; bytes: number }>;
}

export interface BackupSchedule {
  mode: 'manual' | 'hourly' | 'daily';
  /** For daily mode: local time "HH:MM". */
  at?: string;
}

export class NotConnectedError extends Error {}
