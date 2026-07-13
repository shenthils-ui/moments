import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import { resolveTakenAt, sha256File, walkImages } from './files.js';
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
  failed: number;
  failures: { file: string; reason: string }[];
  // scan-only results
  earliest: string | null;
  latest: string | null;
  startedAt: string;
  finishedAt: string | null;
}

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
  ): ImportJob {
    const job = this.create('import', sourcePath);
    void this.runImport(db, photosRoot, snapshots, job, childIds, childName, mode).catch((err) =>
      this.fail(job, err),
    );
    return job;
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
        const { takenAt } = await resolveTakenAt(file);
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
  ): Promise<void> {
    const files = walkImages(job.sourcePath);
    job.total = files.length;
    for (const file of files) {
      try {
        const mtimeMs = fs.statSync(file).mtimeMs;
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
