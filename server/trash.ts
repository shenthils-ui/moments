import fs from 'node:fs';
import path from 'node:path';
import { TRASH_RETENTION_DAYS, type Photo } from '../shared/types.js';
import { type DB, getPhoto } from './db.js';
import { canonicalRelPath } from './files.js';

function trashDir(photosRoot: string): string {
  return path.join(photosRoot, '_trash');
}

/**
 * Deleting a photo moves the original into PHOTOS_ROOT/_trash/ (named by its
 * canonical filename, which is unique via the content hash) and marks the
 * row trashed. Nothing is hard-deleted until the 30-day purge.
 */
export function trashPhoto(db: DB, photosRoot: string, photo: Photo): void {
  const source = path.join(photosRoot, photo.relPath);
  const target = path.join(trashDir(photosRoot), photo.filename);
  fs.mkdirSync(trashDir(photosRoot), { recursive: true });
  if (fs.existsSync(source)) fs.renameSync(source, target);
  db.prepare("UPDATE photos SET status = 'trashed', trashedAt = ? WHERE id = ?").run(
    new Date().toISOString(),
    photo.id,
  );
}

export function restorePhoto(db: DB, photosRoot: string, photo: Photo, childName: string): Photo {
  const source = path.join(trashDir(photosRoot), photo.filename);
  // Recompute the canonical location in case folders changed while trashed.
  const relPath = canonicalRelPath(childName, photo.takenAt, photo.filename);
  const target = path.join(photosRoot, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(source) && !fs.existsSync(target)) fs.renameSync(source, target);
  db.prepare("UPDATE photos SET status = 'active', trashedAt = NULL, relPath = ? WHERE id = ?").run(
    relPath,
    photo.id,
  );
  return getPhoto(db, photo.id)!;
}

/** Permanently delete a single trashed photo (explicit user action). */
export function purgePhoto(db: DB, photosRoot: string, photo: Photo): void {
  fs.rmSync(path.join(trashDir(photosRoot), photo.filename), { force: true });
  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
}

/** Remove trashed photos past the retention window. Runs at boot and daily. */
export function purgeExpired(db: DB, photosRoot: string): number {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  const rows = db
    .prepare("SELECT id FROM photos WHERE status = 'trashed' AND trashedAt < ?")
    .all(cutoff) as { id: string }[];
  for (const row of rows) {
    const photo = getPhoto(db, row.id);
    if (photo) purgePhoto(db, photosRoot, photo);
  }
  return rows.length;
}
