import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Photo } from '../shared/types.js';
import { type DB, getPhoto, insertPhoto } from './db.js';
import {
  canonicalFilename,
  canonicalRelPath,
  imageDimensions,
  mimeForFile,
  resolveTakenAt,
  sha256File,
  placeFile,
} from './files.js';

export interface IngestOptions {
  sourcePath: string;
  originalName: string;
  childIds: string[];
  childName: string; // folder the photo lands under (first assigned child)
  caption?: string;
  tags?: string[];
  fallbackMtimeMs?: number;
  keepSource: boolean; // true = copy, false = move
}

export type IngestResult =
  | { outcome: 'added'; photo: Photo }
  | { outcome: 'duplicate'; existingId: string; contentHash: string }
  | { outcome: 'error'; reason: string };

/**
 * The one path by which a photo enters the library. Computes the content
 * hash, skips exact duplicates, resolves the taken-at date (EXIF, then
 * mtime), places the original into PHOTOS_ROOT/<Child>/<YYYY>/<YYYY-MM>/
 * and records it. Originals are never modified or recompressed.
 */
export async function ingestFile(db: DB, photosRoot: string, opts: IngestOptions): Promise<IngestResult> {
  const mimeType = mimeForFile(opts.originalName);
  if (!mimeType) return { outcome: 'error', reason: `unsupported file type: ${opts.originalName}` };

  let contentHash: string;
  try {
    contentHash = await sha256File(opts.sourcePath);
  } catch (err) {
    return { outcome: 'error', reason: `could not read file: ${(err as Error).message}` };
  }

  const existing = db.prepare('SELECT id FROM photos WHERE contentHash = ?').get(contentHash) as
    | { id: string }
    | undefined;
  if (existing) {
    if (!opts.keepSource) fs.rmSync(opts.sourcePath, { force: true });
    return { outcome: 'duplicate', existingId: existing.id, contentHash };
  }

  const { takenAt, source } = await resolveTakenAt(opts.sourcePath, opts.fallbackMtimeMs);
  const { width, height } = await imageDimensions(opts.sourcePath);
  const sizeBytes = fs.statSync(opts.sourcePath).size;
  const filename = canonicalFilename(takenAt, contentHash, opts.originalName);
  const relPath = canonicalRelPath(opts.childName, takenAt, filename);

  placeFile(photosRoot, opts.sourcePath, relPath, opts.keepSource);

  const photo: Photo = {
    id: crypto.randomUUID(),
    contentHash,
    childIds: opts.childIds,
    takenAt,
    takenAtSource: source,
    relPath,
    filename,
    mimeType,
    width,
    height,
    sizeBytes,
    caption: opts.caption ?? '',
    tags: opts.tags ?? [],
    milestone: null,
    status: 'active',
    trashedAt: null,
    createdAt: new Date().toISOString(),
  };

  try {
    insertPhoto(db, photo);
  } catch (err) {
    // A concurrent request may have inserted the same hash between our check
    // and now; treat it as a duplicate rather than failing the batch.
    const raced = db.prepare('SELECT id FROM photos WHERE contentHash = ?').get(contentHash) as
      | { id: string }
      | undefined;
    if (raced) return { outcome: 'duplicate', existingId: raced.id, contentHash };
    throw err;
  }
  return { outcome: 'added', photo: getPhoto(db, photo.id)! };
}
