import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Photo } from '../shared/types.js';
import { type DB, listChildren, insertPhoto, setSetting } from './db.js';
import { imageDimensions, mimeForFile, resolveTakenAt, safeFolderName, sha256File, walkImages } from './files.js';

export interface RebuildResult {
  scanned: number;
  added: number;
  alreadyIndexed: number;
  childrenCreated: string[];
  errors: string[];
}

const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})_([0-9a-f]{8})\./i;

/**
 * Worst-case recovery: reconstruct the photo index from the folder tree,
 * filenames and EXIF alone (metadata.json lost). Captions/tags/milestones
 * are unrecoverable in that case, but every photo comes back. Children are
 * matched by top-level folder name; unknown folders become new children
 * with no birth date (the UI prompts to fill it in).
 */
export async function rebuildIndex(db: DB, photosRoot: string): Promise<RebuildResult> {
  const result: RebuildResult = { scanned: 0, added: 0, alreadyIndexed: 0, childrenCreated: [], errors: [] };
  const files = walkImages(photosRoot);
  const children = listChildren(db);
  const childByFolder = new Map(children.map((c) => [safeFolderName(c.name), c]));

  for (const file of files) {
    result.scanned++;
    const rel = path.relative(photosRoot, file).split(path.sep).join('/');
    const topFolder = rel.split('/')[0];
    try {
      let child = childByFolder.get(topFolder);
      if (!child) {
        child = {
          id: crypto.randomUUID(),
          name: topFolder,
          birthDate: null,
          color: '#6366f1',
          createdAt: new Date().toISOString(),
        };
        db.prepare(
          'INSERT INTO children (id, name, birthDate, color, createdAt) VALUES (@id, @name, @birthDate, @color, @createdAt)',
        ).run(child);
        childByFolder.set(topFolder, child);
        result.childrenCreated.push(topFolder);
      }

      const base = path.basename(file);
      const match = base.match(FILENAME_RE);
      const contentHash = await sha256File(file);
      const existing = db.prepare('SELECT id FROM photos WHERE contentHash = ?').get(contentHash);
      if (existing) {
        result.alreadyIndexed++;
        continue;
      }

      let takenAt: string;
      let takenAtSource: Photo['takenAtSource'];
      if (match) {
        const local = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`);
        takenAt = local.toISOString();
        takenAtSource = 'file';
      } else {
        const resolved = await resolveTakenAt(file);
        takenAt = resolved.takenAt;
        takenAtSource = resolved.source;
      }

      const { width, height } = await imageDimensions(file);
      insertPhoto(db, {
        id: crypto.randomUUID(),
        contentHash,
        childIds: [child.id],
        takenAt,
        takenAtSource,
        relPath: rel,
        filename: base,
        mimeType: mimeForFile(base)!,
        width,
        height,
        sizeBytes: fs.statSync(file).size,
        caption: '',
        tags: [],
        milestone: null,
        status: 'active',
        trashedAt: null,
        createdAt: new Date().toISOString(),
      });
      result.added++;
    } catch (err) {
      result.errors.push(`${rel}: ${(err as Error).message}`);
    }
  }
  setSetting(db, 'setupComplete', '1');
  return result;
}
