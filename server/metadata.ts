import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME } from '../shared/appName.js';
import { METADATA_FORMAT_VERSION, type MetadataSnapshot, type Child, type Photo } from '../shared/types.js';
import { type DB, listChildren, rowToPhoto, allSettings, insertPhoto, setSetting } from './db.js';

export function metadataPath(photosRoot: string): string {
  return path.join(photosRoot, '_meta', 'metadata.json');
}

export function buildSnapshot(db: DB): MetadataSnapshot {
  const photos = (db.prepare('SELECT * FROM photos ORDER BY takenAt').all() as any[]).map((row) =>
    rowToPhoto(db, row),
  );
  return {
    app: APP_NAME,
    formatVersion: METADATA_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    children: listChildren(db),
    photos,
    settings: allSettings(db),
  };
}

/** Atomic write: temp file in the same directory, then rename. */
export function writeSnapshotNow(db: DB, photosRoot: string): void {
  const target = metadataPath(photosRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(buildSnapshot(db), null, 2));
  fs.renameSync(tmp, target);
}

/**
 * Debounced snapshot writer. Every metadata change calls schedule(); the
 * snapshot is rewritten at most once per `delayMs` and always flushed on
 * process exit via flush().
 */
export class SnapshotWriter {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(
    private db: DB,
    private photosRoot: string,
    private delayMs = 2000,
  ) {}

  schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.delayMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeSnapshotNow(this.db, this.photosRoot);
    } catch (err) {
      console.error('[metadata] snapshot write failed:', err);
      this.dirty = true; // retry on next schedule/flush
    }
  }
}

export function readSnapshot(photosRoot: string): MetadataSnapshot | null {
  const file = metadataPath(photosRoot);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed.formatVersion !== 'number' || !Array.isArray(parsed.children) || !Array.isArray(parsed.photos)) {
      return null;
    }
    return parsed as MetadataSnapshot;
  } catch {
    return null;
  }
}

export interface RestoreResult {
  children: number;
  photos: number;
  missingFiles: string[];
}

/**
 * Replace the entire database contents with a snapshot. Used by the
 * first-run restore flow (NAS migration) and by metadata import.
 * Photo files themselves are never touched.
 */
export function applySnapshot(db: DB, photosRoot: string, snapshot: MetadataSnapshot): RestoreResult {
  const missingFiles: string[] = [];
  const apply = db.transaction(() => {
    db.prepare('DELETE FROM photo_children').run();
    db.prepare('DELETE FROM photos').run();
    db.prepare('DELETE FROM children').run();
    db.prepare('DELETE FROM settings').run();

    const insertChild = db.prepare(
      'INSERT INTO children (id, name, birthDate, color, createdAt) VALUES (@id, @name, @birthDate, @color, @createdAt)',
    );
    for (const child of snapshot.children as Child[]) {
      insertChild.run({ ...child, birthDate: child.birthDate ?? null, color: child.color ?? '#6366f1' });
    }
    for (const photo of snapshot.photos as Photo[]) {
      insertPhoto(db, {
        ...photo,
        status: photo.status ?? 'active',
        trashedAt: photo.trashedAt ?? null,
        milestone: photo.milestone ?? null,
        caption: photo.caption ?? '',
        tags: photo.tags ?? [],
        favorite: photo.favorite ?? false,
      });
      const onDisk =
        photo.status === 'trashed'
          ? path.join(photosRoot, '_trash', photo.filename)
          : path.join(photosRoot, photo.relPath);
      if (!fs.existsSync(onDisk)) missingFiles.push(photo.relPath);
    }
    for (const [key, value] of Object.entries(snapshot.settings ?? {})) {
      setSetting(db, key, value);
    }
    setSetting(db, 'setupComplete', '1');
  });
  apply();
  return { children: snapshot.children.length, photos: snapshot.photos.length, missingFiles };
}
