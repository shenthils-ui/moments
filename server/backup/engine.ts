import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { type DB } from '../db.js';
import { sha256File } from '../files.js';
import { metadataPath, type SnapshotWriter } from '../metadata.js';
import { GoogleDriveTarget } from './gdrive.js';
import { LocalFolderTarget } from './localFolder.js';
import type { BackupSchedule, BackupTarget } from './types.js';

const METADATA_RELPATH = '_meta/metadata.json';
const MAX_ATTEMPTS = 5;

export interface TargetRow {
  id: string;
  kind: string;
  displayName: string;
  config: Record<string, any>;
  schedule: BackupSchedule;
  mirrorDeletions: boolean;
  createdAt: string;
}

export interface RunRow {
  id: string;
  targetId: string;
  state: 'running' | 'done' | 'error' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  total: number;
  processed: number;
  uploaded: number;
  skipped: number;
  deleted: number;
  failed: number;
  error: string | null;
  failures: { relPath: string; reason: string }[];
}

interface ManifestEntry {
  relPath: string;
  contentHash: string;
  localPath: string;
  sizeBytes: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BackupManager {
  private running = new Map<string, string>(); // targetId -> runId
  private schedulerTimer: NodeJS.Timeout | null = null;
  private lastDailyFire = new Map<string, string>(); // targetId -> YYYY-MM-DD fired
  /** Test hook: slows each file operation so interruption tests have a window. */
  private fileDelayMs = Number(process.env.BACKUP_FILE_DELAY_MS ?? 0);

  constructor(
    private db: DB,
    private config: AppConfig,
    private snapshots: SnapshotWriter,
  ) {}

  // ---- target CRUD ----------------------------------------------------------

  private rowFromDb(raw: any): TargetRow {
    return {
      ...raw,
      config: JSON.parse(raw.config),
      schedule: JSON.parse(raw.schedule),
      mirrorDeletions: Boolean(raw.mirrorDeletions),
    };
  }

  listTargets(): TargetRow[] {
    return (this.db.prepare('SELECT * FROM backup_targets ORDER BY createdAt').all() as any[]).map((r) =>
      this.rowFromDb(r),
    );
  }

  getTarget(id: string): TargetRow | null {
    const raw = this.db.prepare('SELECT * FROM backup_targets WHERE id = ?').get(id);
    return raw ? this.rowFromDb(raw) : null;
  }

  createTarget(input: {
    kind: string;
    displayName: string;
    config?: Record<string, any>;
    schedule?: BackupSchedule;
    mirrorDeletions?: boolean;
  }): TargetRow {
    if (input.kind !== 'local' && input.kind !== 'gdrive') throw new Error(`unknown target kind: ${input.kind}`);
    if (input.kind === 'local' && !input.config?.path) throw new Error('a folder path is required');
    const row = {
      id: crypto.randomUUID(),
      kind: input.kind,
      displayName: input.displayName || (input.kind === 'local' ? String(input.config!.path) : 'Google Drive'),
      config: JSON.stringify(input.config ?? {}),
      schedule: JSON.stringify(input.schedule ?? { mode: 'manual' }),
      mirrorDeletions: input.mirrorDeletions ? 1 : 0,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO backup_targets (id, kind, displayName, config, schedule, mirrorDeletions, createdAt)
         VALUES (@id, @kind, @displayName, @config, @schedule, @mirrorDeletions, @createdAt)`,
      )
      .run(row);
    return this.getTarget(row.id)!;
  }

  updateTarget(
    id: string,
    patch: Partial<Pick<TargetRow, 'displayName' | 'schedule' | 'mirrorDeletions' | 'config'>>,
  ): TargetRow {
    const current = this.getTarget(id);
    if (!current) throw new Error('target not found');
    this.db
      .prepare('UPDATE backup_targets SET displayName = ?, config = ?, schedule = ?, mirrorDeletions = ? WHERE id = ?')
      .run(
        patch.displayName ?? current.displayName,
        JSON.stringify(patch.config ?? current.config),
        JSON.stringify(patch.schedule ?? current.schedule),
        (patch.mirrorDeletions ?? current.mirrorDeletions) ? 1 : 0,
        id,
      );
    return this.getTarget(id)!;
  }

  deleteTarget(id: string): void {
    // Never touches data AT the target — mirrors outlive their configuration.
    this.db.prepare('DELETE FROM backup_targets WHERE id = ?').run(id);
  }

  instantiate(row: TargetRow): BackupTarget {
    if (row.kind === 'local') return new LocalFolderTarget(row.id, row.displayName, String(row.config.path));
    return new GoogleDriveTarget(row.id, row.displayName, this.config.dataDir, row.config);
  }

  // ---- runs -----------------------------------------------------------------

  getRun(id: string): RunRow | null {
    const raw = this.db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(id) as any;
    return raw ? { ...raw, failures: JSON.parse(raw.failures) } : null;
  }

  listRuns(targetId: string, limit = 10): RunRow[] {
    const rows = this.db
      .prepare('SELECT * FROM backup_runs WHERE targetId = ? ORDER BY startedAt DESC LIMIT ?')
      .all(targetId, limit) as any[];
    return rows.map((r) => ({ ...r, failures: JSON.parse(r.failures) }));
  }

  activeRun(targetId: string): RunRow | null {
    const runId = this.running.get(targetId);
    return runId ? this.getRun(runId) : null;
  }

  /**
   * Start a mirror run. Returns the run row immediately; work continues in
   * the background and never blocks uploads or browsing.
   */
  startRun(targetId: string): RunRow {
    const target = this.getTarget(targetId);
    if (!target) throw new Error('target not found');
    if (this.running.has(targetId)) return this.activeRun(targetId)!;

    const run: any = {
      id: crypto.randomUUID(),
      targetId,
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      total: 0,
      processed: 0,
      uploaded: 0,
      skipped: 0,
      deleted: 0,
      failed: 0,
      error: null,
      failures: '[]',
    };
    this.db
      .prepare(
        `INSERT INTO backup_runs (id, targetId, state, startedAt, finishedAt, total, processed, uploaded, skipped, deleted, failed, error, failures)
         VALUES (@id, @targetId, @state, @startedAt, @finishedAt, @total, @processed, @uploaded, @skipped, @deleted, @failed, @error, @failures)`,
      )
      .run(run);
    this.running.set(targetId, run.id);

    void this.executeRun(this.getRun(run.id)!, target).finally(() => this.running.delete(targetId));
    return this.getRun(run.id)!;
  }

  private persistRun(run: RunRow): void {
    this.db
      .prepare(
        `UPDATE backup_runs SET state = ?, finishedAt = ?, total = ?, processed = ?, uploaded = ?,
         skipped = ?, deleted = ?, failed = ?, error = ?, failures = ? WHERE id = ?`,
      )
      .run(
        run.state,
        run.finishedAt,
        run.total,
        run.processed,
        run.uploaded,
        run.skipped,
        run.deleted,
        run.failed,
        run.error,
        JSON.stringify(run.failures.slice(0, 500)),
        run.id,
      );
  }

  /**
   * Local files that should exist at the target: every active photo plus a
   * staged copy of _meta/metadata.json (staged so its hash stays stable for
   * the duration of the run even if metadata changes mid-run).
   */
  private async buildManifest(runId: string): Promise<ManifestEntry[]> {
    const photos = this.db
      .prepare("SELECT relPath, contentHash, sizeBytes FROM photos WHERE status = 'active'")
      .all() as { relPath: string; contentHash: string; sizeBytes: number }[];
    const entries: ManifestEntry[] = photos.map((p) => ({
      relPath: p.relPath,
      contentHash: p.contentHash,
      sizeBytes: p.sizeBytes,
      localPath: path.join(this.config.photosRoot, p.relPath),
    }));

    this.snapshots.flush();
    const metaSource = metadataPath(this.config.photosRoot);
    if (fs.existsSync(metaSource)) {
      const staged = path.join(this.config.dataDir, 'tmp', `metadata-backup-${runId}.json`);
      fs.copyFileSync(metaSource, staged);
      entries.push({
        relPath: METADATA_RELPATH,
        contentHash: await sha256File(staged),
        sizeBytes: fs.statSync(staged).size,
        localPath: staged,
      });
    }
    return entries;
  }

  private async executeRun(run: RunRow, targetRow: TargetRow): Promise<void> {
    const target = this.instantiate(targetRow);
    try {
      await target.connect();
      const manifest = await this.buildManifest(run.id);
      const remote = await target.listRemoteHashes();

      const toUpload = manifest.filter((e) => !remote.has(e.contentHash));
      run.total = manifest.length;
      run.skipped = manifest.length - toUpload.length;
      this.persistRun(run);
      run.processed = run.skipped;

      // fixed-size worker pool: limited concurrency, per-file backoff
      const queue = [...toUpload];
      const concurrency = Math.max(1, Number(targetRow.config.concurrency ?? 3));
      const workers = Array.from({ length: concurrency }, async () => {
        for (;;) {
          const entry = queue.shift();
          if (!entry) return;
          await this.uploadWithBackoff(target, targetRow.id, entry, run);
          run.processed++;
          this.persistRun(run);
        }
      });
      await Promise.all(workers);

      if (targetRow.mirrorDeletions) {
        await this.propagateDeletions(target, targetRow.id, run);
      }

      run.state = 'done';
    } catch (err) {
      run.state = 'error';
      run.error = (err as Error).message;
    } finally {
      run.finishedAt = new Date().toISOString();
      this.persistRun(run);
      fs.rmSync(path.join(this.config.dataDir, 'tmp', `metadata-backup-${run.id}.json`), { force: true });
    }
  }

  private async uploadWithBackoff(
    target: BackupTarget,
    targetId: string,
    entry: ManifestEntry,
    run: RunRow,
  ): Promise<void> {
    if (this.fileDelayMs > 0) await sleep(this.fileDelayMs);
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (!fs.existsSync(entry.localPath)) throw new Error('local file missing on disk');
        await target.putFile(entry.relPath, entry.localPath, entry.contentHash);
        this.db
          .prepare(
            `INSERT INTO backup_files (targetId, relPath, contentHash, sizeBytes, uploadedAt, verifiedAt)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(targetId, relPath) DO UPDATE SET
               contentHash = excluded.contentHash, sizeBytes = excluded.sizeBytes,
               uploadedAt = excluded.uploadedAt, verifiedAt = excluded.verifiedAt`,
          )
          .run(targetId, entry.relPath, entry.contentHash, entry.sizeBytes, new Date().toISOString(), new Date().toISOString());
        run.uploaded++;
        return;
      } catch (err) {
        lastError = (err as Error).message;
        if (attempt < MAX_ATTEMPTS) await sleep(Math.min(30000, 1000 * 2 ** (attempt - 1)));
      }
    }
    run.failed++;
    run.failures.push({ relPath: entry.relPath, reason: lastError });
  }

  /**
   * Mirror deletions are opt-in per target and deliberately narrow: only
   * files this app itself uploaded (recorded in backup_files) whose content
   * no longer exists in the library AT ALL — i.e. photos that sat in _trash
   * past the retention window and were purged. Photos still in _trash are
   * never deleted at the target.
   */
  private async propagateDeletions(target: BackupTarget, targetId: string, run: RunRow): Promise<void> {
    const candidates = this.db
      .prepare(
        `SELECT relPath FROM backup_files
         WHERE targetId = ? AND relPath != ?
           AND contentHash NOT IN (SELECT contentHash FROM photos)`,
      )
      .all(targetId, METADATA_RELPATH) as { relPath: string }[];
    for (const { relPath } of candidates) {
      try {
        await target.deleteFile(relPath);
        this.db.prepare('DELETE FROM backup_files WHERE targetId = ? AND relPath = ?').run(targetId, relPath);
        run.deleted++;
      } catch (err) {
        run.failed++;
        run.failures.push({ relPath, reason: `delete failed: ${(err as Error).message}` });
      }
    }
  }

  // ---- verify ---------------------------------------------------------------

  /**
   * Re-checks a random sample (default 1%) of uploaded files against the
   * target and reports drift. LocalFolderTarget re-hashes actual remote
   * bytes, so corruption shows up as a missing hash.
   */
  async verify(targetId: string, sampleRate = 0.01): Promise<{
    sampled: number;
    ok: number;
    missing: { relPath: string; contentHash: string }[];
  }> {
    const targetRow = this.getTarget(targetId);
    if (!targetRow) throw new Error('target not found');
    const target = this.instantiate(targetRow);
    await target.connect();

    const all = this.db
      .prepare('SELECT relPath, contentHash FROM backup_files WHERE targetId = ?')
      .all(targetId) as { relPath: string; contentHash: string }[];
    const sampleSize = Math.min(all.length, Math.max(1, Math.ceil(all.length * sampleRate)));
    const shuffled = [...all].sort(() => Math.random() - 0.5);
    const sample = shuffled.slice(0, sampleSize);

    const remote = await target.listRemoteHashes();
    const missing = sample.filter((s) => !remote.has(s.contentHash));
    const now = new Date().toISOString();
    const markVerified = this.db.prepare(
      'UPDATE backup_files SET verifiedAt = ? WHERE targetId = ? AND relPath = ?',
    );
    for (const s of sample) {
      if (!missing.includes(s)) markVerified.run(now, targetId, s.relPath);
    }
    return { sampled: sample.length, ok: sample.length - missing.length, missing };
  }

  // ---- scheduler + recovery -------------------------------------------------

  /** Mark runs left 'running' by a crash as interrupted and pick them up. */
  recoverInterrupted(): void {
    const stale = this.db.prepare("SELECT id, targetId FROM backup_runs WHERE state = 'running'").all() as {
      id: string;
      targetId: string;
    }[];
    for (const row of stale) {
      this.db.prepare("UPDATE backup_runs SET state = 'interrupted', finishedAt = ? WHERE id = ?").run(
        new Date().toISOString(),
        row.id,
      );
    }
    const targets = new Set(stale.map((s) => s.targetId));
    for (const targetId of targets) {
      if (this.getTarget(targetId)) {
        try {
          this.startRun(targetId);
        } catch (err) {
          console.error(`[backup] could not resume run for target ${targetId}:`, err);
        }
      }
    }
  }

  startScheduler(): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => this.tick(), 60 * 1000);
    this.schedulerTimer.unref?.();
  }

  private tick(): void {
    const now = new Date();
    for (const target of this.listTargets()) {
      if (this.running.has(target.id)) continue;
      const schedule = target.schedule;
      if (schedule.mode === 'hourly') {
        const last = this.listRuns(target.id, 1)[0];
        if (!last || Date.now() - new Date(last.startedAt).getTime() >= 3600 * 1000) {
          this.safeStart(target.id);
        }
      } else if (schedule.mode === 'daily' && schedule.at) {
        const pad = (n: number) => String(n).padStart(2, '0');
        const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const today = now.toISOString().slice(0, 10);
        if (hhmm === schedule.at && this.lastDailyFire.get(target.id) !== today) {
          this.lastDailyFire.set(target.id, today);
          this.safeStart(target.id);
        }
      }
    }
  }

  private safeStart(targetId: string): void {
    try {
      this.startRun(targetId);
    } catch (err) {
      console.error(`[backup] scheduled run failed to start for ${targetId}:`, err);
    }
  }

  stop(): void {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
  }
}
