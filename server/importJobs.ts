import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import { mimeForFile, resolveCaptureDate, sha256File, walkImages } from './files.js';
import { ingestFile } from './ingest.js';
import type { SnapshotWriter } from './metadata.js';

export interface ImportJob {
  id: string;
  kind: 'scan' | 'import';
  sourcePath: string;
  state: 'running' | 'done' | 'error';
  error: string | null;
  total: number;
  processed: number;
  added: number;
  duplicates: number;
  datesFixed: number; // existing photos whose guessed date was corrected
  failed: number;
  failures: { file: string; reason: string }[];
  // scan-only results
  earliest: string | null;
  latest: string | null;
  startedAt: string;
  finishedAt: string | null;
}

// How much to trust a resolved capture date, for deciding whether to
// overwrite an existing photo's date. Manual edits are never overwritten.
const DATE_SOURCE_RANK: Record<string, number> = { manual: 4, exif: 3, container: 3, filename: 2, file: 1 };

/**
 * Bulk import runs as in-process jobs the client polls via
 * GET /api/import/jobs/:id. A scan job is the dry run: counts, date range
 * and duplicates, nothing written. An import job copies (default) or moves
 * files into the library.
 */
export class ImportJobs {
  private jobs = new Map<string, ImportJob>();

  get(id: string): ImportJob | null {
    return this.jobs.get(id) ?? null;
  }

  private create(kind: ImportJob['kind'], sourcePath: string): ImportJob {
    const job: ImportJob = {
      id: crypto.randomUUID(),
      kind,
      sourcePath,
      state: 'running',
      error: null,
      total: 0,
      processed: 0,
      added: 0,
      duplicates: 0,
      datesFixed: 0,
      failed: 0,
      failures: [],
      earliest: null,
      latest: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  startScan(db: DB, sourcePath: string): ImportJob {
    const job = this.create('scan', sourcePath);
    void this.runScan(db, job).catch((err) => this.fail(job, err));
    return job;
  }

  startImport(
    db: DB,
    photosRoot: string,
    snapshots: SnapshotWriter,
    sourcePath: string,
    childIds: string[],
    childName: string,
    mode: 'copy' | 'move',
    fixDates = false,
  ): ImportJob {
    const job = this.create('import', sourcePath);
    void this.runImport(db, photosRoot, snapshots, job, childIds, childName, mode, fixDates).catch((err) =>
      this.fail(job, err),
    );
    return job;
  }

  /**
   * When re-importing the original files, correct a photo already in the
   * library whose date was only a guess (source 'file') if the source file
   * yields a better date (EXIF/container/filename). Matches the existing
   * photo by content hash, since that's how it was deduped. Never touches a
   * manually set date, and never renames the file on disk.
   */
  private async tryFixExisting(db: DB, file: string): Promise<boolean> {
    const hash = await sha256File(file);
    const row = db.prepare('SELECT id, takenAt, takenAtSource FROM photos WHERE contentHash = ?').get(hash) as
      | { id: string; takenAt: string; takenAtSource: string }
      | undefined;
    if (!row || (DATE_SOURCE_RANK[row.takenAtSource] ?? 0) > 1) return false; // new file, or not a pure guess
    const resolved = await resolveCaptureDate(file, mimeForFile(file) ?? '', path.basename(file), fs.statSync(file).mtimeMs);
    if ((DATE_SOURCE_RANK[resolved.source] ?? 0) <= 1 || resolved.takenAt === row.takenAt) return false;
    db.prepare('UPDATE photos SET takenAt = ?, takenAtSource = ? WHERE id = ?').run(resolved.takenAt, resolved.source, row.id);
    return true;
  }

  private fail(job: ImportJob, err: unknown): void {
    job.state = 'error';
    job.error = (err as Error).message;
    job.finishedAt = new Date().toISOString();
  }

  private async runScan(db: DB, job: ImportJob): Promise<void> {
    const files = walkImages(job.sourcePath);
    job.total = files.length;
    const seenHashes = new Set<string>();
    for (const file of files) {
      try {
        const hash = await sha256File(file);
        const inLibrary = db.prepare('SELECT 1 FROM photos WHERE contentHash = ?').get(hash);
        if (inLibrary || seenHashes.has(hash)) job.duplicates++;
        seenHashes.add(hash);
        const { takenAt } = await resolveCaptureDate(file, mimeForFile(file) ?? '', path.basename(file));
        if (!job.earliest || takenAt < job.earliest) job.earliest = takenAt;
        if (!job.latest || takenAt > job.latest) job.latest = takenAt;
      } catch (err) {
        job.failed++;
        job.failures.push({ file: path.basename(file), reason: (err as Error).message });
      }
      job.processed++;
    }
    job.state = 'done';
    job.finishedAt = new Date().toISOString();
  }

  private async runImport(
    db: DB,
    photosRoot: string,
    snapshots: SnapshotWriter,
    job: ImportJob,
    childIds: string[],
    childName: string,
    mode: 'copy' | 'move',
    fixDates: boolean,
  ): Promise<void> {
    const files = walkImages(job.sourcePath);
    job.total = files.length;
    for (const file of files) {
      try {
        const mtimeMs = fs.statSync(file).mtimeMs;
        // fixDates re-reads the source before ingest may move/delete it
        const fixed = fixDates ? await this.tryFixExisting(db, file) : false;
        if (fixed) job.datesFixed++;
        const result = await ingestFile(db, photosRoot, {
          sourcePath: file,
          originalName: path.basename(file),
          childIds,
          childName,
          fallbackMtimeMs: mtimeMs,
          keepSource: mode === 'copy',
        });
        if (result.outcome === 'added') job.added++;
        else if (result.outcome === 'duplicate') job.duplicates++;
        else {
          job.failed++;
          job.failures.push({ file: path.basename(file), reason: result.reason });
        }
      } catch (err) {
        job.failed++;
        job.failures.push({ file: path.basename(file), reason: (err as Error).message });
      }
      job.processed++;
      if (job.processed % 25 === 0) snapshots.schedule();
    }
    snapshots.schedule();
    job.state = 'done';
    job.finishedAt = new Date().toISOString();
  }
}
