import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import cookieParser from 'cookie-parser';
import express, { type Express, type Request, type Response } from 'express';
import multer from 'multer';
import { APP_NAME } from '../shared/appName.js';
import type { Child, Photo } from '../shared/types.js';
import { BackupManager } from './backup/engine.js';
import { GoogleDriveTarget, buildAuthUrl, exchangeCode } from './backup/gdrive.js';
import {
  SESSION_COOKIE,
  authEnabled,
  createSession,
  destroySession,
  isAuthed,
  requireAuth,
  setPassword,
  verifyPassword,
} from './auth.js';
import { type AppConfig, ensureDirs } from './config.js';
import { type DB, getPhoto, getSetting, listChildren, openDb, rowToPhoto, setPhotoChildren, setSetting } from './db.js';
import { mimeForFile } from './files.js';
import { ImportJobs } from './importJobs.js';
import { ingestFile } from './ingest.js';
import { SnapshotWriter, applySnapshot, buildSnapshot, metadataPath, readSnapshot } from './metadata.js';
import { rebuildIndex } from './rebuild.js';
import { ThumbnailError, getThumbnail, normalizeSize } from './thumbs.js';
import { purgeExpired, purgePhoto, restorePhoto, trashPhoto } from './trash.js';

export interface AppContext {
  app: Express;
  db: DB;
  config: AppConfig;
  snapshots: SnapshotWriter;
  backups: BackupManager;
  close: () => void;
}

export function createApp(config: AppConfig): AppContext {
  ensureDirs(config);
  const db = openDb(config.dataDir);
  const snapshots = new SnapshotWriter(db, config.photosRoot);
  const importJobs = new ImportJobs();
  const thumbsDir = path.join(config.dataDir, 'cache', 'thumbs');
  const tmpDir = path.join(config.dataDir, 'tmp');

  purgeExpired(db, config.photosRoot);
  const purgeTimer = setInterval(() => purgeExpired(db, config.photosRoot), 24 * 3600 * 1000);
  purgeTimer.unref?.();

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());

  const api = express.Router();
  app.use('/api', api);
  api.use(requireAuth(db));

  const upload = multer({ dest: tmpDir, limits: { fileSize: 500 * 1024 * 1024 } });

  const childById = (id: string): Child | undefined =>
    (db.prepare('SELECT * FROM children WHERE id = ?').get(id) as Child | undefined) ?? undefined;

  const validChildIds = (ids: unknown): string[] | null => {
    if (!Array.isArray(ids) || ids.length === 0) return null;
    const children = ids.map((id) => childById(String(id)));
    if (children.some((c) => !c)) return null;
    return ids.map(String);
  };

  // ---- system ---------------------------------------------------------------

  api.get('/system/status', (req, res) => {
    const setupComplete = getSetting(db, 'setupComplete') === '1';
    const snapshot = !setupComplete ? readSnapshot(config.photosRoot) : null;
    res.json({
      appName: APP_NAME,
      needsSetup: !setupComplete,
      restoreAvailable: Boolean(snapshot),
      restorePreview: snapshot
        ? { children: snapshot.children.length, photos: snapshot.photos.length, exportedAt: snapshot.exportedAt }
        : null,
      authEnabled: authEnabled(db),
      authed: isAuthed(db, req),
      photosRoot: config.photosRoot,
    });
  });

  api.post('/system/setup', (req, res) => {
    if (getSetting(db, 'setupComplete') === '1') return res.status(409).json({ error: 'already set up' });
    const { password, child } = req.body ?? {};
    if (!child?.name || !child?.birthDate) return res.status(400).json({ error: 'child name and birthDate are required' });
    const newChild: Child = {
      id: crypto.randomUUID(),
      name: String(child.name),
      birthDate: String(child.birthDate),
      color: String(child.color ?? '#6366f1'),
      createdAt: new Date().toISOString(),
    };
    db.prepare(
      'INSERT INTO children (id, name, birthDate, color, createdAt) VALUES (@id, @name, @birthDate, @color, @createdAt)',
    ).run(newChild);
    if (password) setPassword(db, String(password));
    setSetting(db, 'setupComplete', '1');
    snapshots.schedule();
    const token = createSession(db);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true, child: newChild });
  });

  api.post('/system/restore', (req, res) => {
    if (getSetting(db, 'setupComplete') === '1') return res.status(409).json({ error: 'already set up' });
    const snapshot = readSnapshot(config.photosRoot);
    if (!snapshot) return res.status(404).json({ error: 'no metadata.json found in PHOTOS_ROOT/_meta' });
    const result = applySnapshot(db, config.photosRoot, snapshot);
    snapshots.schedule();
    const token = createSession(db);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax' });
    res.json(result);
  });

  api.post('/system/rebuild', async (_req, res) => {
    try {
      const result = await rebuildIndex(db, config.photosRoot);
      snapshots.schedule();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  api.get('/system/disk', async (_req, res) => {
    let free = 0;
    let total = 0;
    try {
      const stat = await fs.promises.statfs(config.photosRoot);
      free = stat.bavail * stat.bsize;
      total = stat.blocks * stat.bsize;
    } catch {
      // statfs unavailable on some platforms; report zeros rather than fail
    }
    const lib = db
      .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(sizeBytes), 0) AS bytes FROM photos')
      .get() as { count: number; bytes: number };
    const activeCount = (
      db.prepare("SELECT COUNT(*) AS count FROM photos WHERE status = 'active'").get() as { count: number }
    ).count;
    let lastSnapshotAt: string | null = null;
    try {
      lastSnapshotAt = fs.statSync(metadataPath(config.photosRoot)).mtime.toISOString();
    } catch {
      /* no snapshot yet */
    }
    res.json({
      photosRoot: config.photosRoot,
      dataDir: config.dataDir,
      freeBytes: free,
      totalBytes: total,
      libraryBytes: lib.bytes,
      photoCount: activeCount,
      lastSnapshotAt,
    });
  });

  // ---- auth -----------------------------------------------------------------

  api.post('/auth/login', (req, res) => {
    const stored = getSetting(db, 'passwordHash');
    if (!stored) return res.json({ ok: true });
    const password = String(req.body?.password ?? '');
    if (!verifyPassword(password, stored)) return res.status(401).json({ error: 'wrong password' });
    const token = createSession(db);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true });
  });

  api.post('/auth/logout', (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) destroySession(db, token);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  api.post('/auth/password', (req, res) => {
    const { password, currentPassword } = req.body ?? {};
    const stored = getSetting(db, 'passwordHash');
    if (stored && !verifyPassword(String(currentPassword ?? ''), stored)) {
      return res.status(403).json({ error: 'current password is wrong' });
    }
    setPassword(db, password ? String(password) : null);
    snapshots.schedule();
    if (password) {
      const token = createSession(db);
      res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax' });
    }
    res.json({ ok: true, authEnabled: authEnabled(db) });
  });

  // ---- children -------------------------------------------------------------

  api.get('/children', (_req, res) => res.json(listChildren(db)));

  api.post('/children', (req, res) => {
    const { name, birthDate, color } = req.body ?? {};
    if (!name || !birthDate) return res.status(400).json({ error: 'name and birthDate are required' });
    const child: Child = {
      id: crypto.randomUUID(),
      name: String(name),
      birthDate: String(birthDate),
      color: String(color ?? '#6366f1'),
      createdAt: new Date().toISOString(),
    };
    db.prepare(
      'INSERT INTO children (id, name, birthDate, color, createdAt) VALUES (@id, @name, @birthDate, @color, @createdAt)',
    ).run(child);
    snapshots.schedule();
    res.status(201).json(child);
  });

  api.patch('/children/:id', (req, res) => {
    const child = childById(req.params.id);
    if (!child) return res.status(404).json({ error: 'child not found' });
    const { name, birthDate, color } = req.body ?? {};
    db.prepare('UPDATE children SET name = ?, birthDate = ?, color = ? WHERE id = ?').run(
      String(name ?? child.name),
      birthDate !== undefined ? String(birthDate) : child.birthDate,
      String(color ?? child.color),
      child.id,
    );
    snapshots.schedule();
    res.json(childById(child.id));
  });

  api.delete('/children/:id', (req, res) => {
    const child = childById(req.params.id);
    if (!child) return res.status(404).json({ error: 'child not found' });
    const count = (
      db.prepare('SELECT COUNT(*) AS count FROM photo_children WHERE childId = ?').get(child.id) as { count: number }
    ).count;
    if (count > 0) {
      return res.status(409).json({ error: `child has ${count} photos; reassign or delete them first` });
    }
    db.prepare('DELETE FROM children WHERE id = ?').run(child.id);
    snapshots.schedule();
    res.json({ ok: true });
  });

  // ---- photos ---------------------------------------------------------------

  api.get('/photos', (req, res) => {
    const { child, from, to, tag, milestone, folder } = req.query;
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize ?? 100)));

    const where: string[] = ["p.status = 'active'"];
    const params: Record<string, unknown> = {};
    if (child) {
      where.push('p.id IN (SELECT photoId FROM photo_children WHERE childId = @child)');
      params.child = String(child);
    }
    if (from) {
      where.push('p.takenAt >= @from');
      params.from = String(from);
    }
    if (to) {
      where.push('p.takenAt <= @to');
      params.to = String(to);
    }
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(p.tags) WHERE json_each.value = @tag)');
      params.tag = String(tag);
    }
    if (milestone === '*') {
      where.push("p.milestone IS NOT NULL AND p.milestone != ''");
    } else if (milestone) {
      where.push('p.milestone = @milestone');
      params.milestone = String(milestone);
    }
    if (folder) {
      where.push("p.relPath LIKE @folder || '/%'");
      params.folder = String(folder);
    }

    const clause = where.join(' AND ');
    const total = (
      db.prepare(`SELECT COUNT(*) AS count FROM photos p WHERE ${clause}`).get(params) as { count: number }
    ).count;
    const rows = db
      .prepare(
        `SELECT p.* FROM photos p WHERE ${clause}
         ORDER BY p.takenAt DESC, p.id DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as any[];
    res.json({ total, page, pageSize, photos: rows.map((r) => rowToPhoto(db, r)) });
  });

  api.get('/photos/:id', (req, res) => {
    const photo = getPhoto(db, req.params.id);
    if (!photo) return res.status(404).json({ error: 'photo not found' });
    res.json(photo);
  });

  api.patch('/photos/:id', (req, res) => {
    const photo = getPhoto(db, req.params.id);
    if (!photo) return res.status(404).json({ error: 'photo not found' });
    const { caption, tags, milestone, takenAt, childIds } = req.body ?? {};
    if (childIds !== undefined) {
      const ids = validChildIds(childIds);
      if (!ids) return res.status(400).json({ error: 'childIds must be a non-empty array of existing child ids' });
      setPhotoChildren(db, photo.id, ids);
    }
    const newTakenAt = takenAt !== undefined ? new Date(String(takenAt)) : null;
    if (newTakenAt && Number.isNaN(newTakenAt.getTime())) {
      return res.status(400).json({ error: 'invalid takenAt' });
    }
    // A manual date edit updates metadata only; the original file is never
    // renamed or moved after ingest.
    db.prepare(
      `UPDATE photos SET caption = ?, tags = ?, milestone = ?, takenAt = ?, takenAtSource = ? WHERE id = ?`,
    ).run(
      caption !== undefined ? String(caption) : photo.caption,
      tags !== undefined ? JSON.stringify(Array.isArray(tags) ? tags.map(String) : []) : JSON.stringify(photo.tags),
      milestone !== undefined ? (milestone ? String(milestone) : null) : photo.milestone,
      newTakenAt ? newTakenAt.toISOString() : photo.takenAt,
      newTakenAt ? 'manual' : photo.takenAtSource,
      photo.id,
    );
    snapshots.schedule();
    res.json(getPhoto(db, photo.id));
  });

  api.delete('/photos/:id', (req, res) => {
    const photo = getPhoto(db, req.params.id);
    if (!photo || photo.status !== 'active') return res.status(404).json({ error: 'photo not found' });
    trashPhoto(db, config.photosRoot, photo);
    snapshots.schedule();
    res.json({ ok: true, trashed: photo.id });
  });

  api.get('/photos/:id/thumb', async (req, res) => {
    const photo = getPhoto(db, req.params.id);
    if (!photo) return res.status(404).json({ error: 'photo not found' });
    const size = normalizeSize(req.query.size);
    try {
      const file = await getThumbnail(
        thumbsDir,
        config.photosRoot,
        photo.status === 'trashed' ? `_trash/${photo.filename}` : photo.relPath,
        photo.contentHash,
        size,
        photo.mimeType,
      );
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.sendFile(file);
    } catch (err) {
      if (err instanceof ThumbnailError) {
        // Client shows a labelled placeholder for undecodable files (e.g.
        // HEIC without a working decoder) instead of a broken image.
        return res.status(422).json({ error: err.message, placeholder: true });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  api.get('/photos/:id/original', (req, res) => {
    const photo = getPhoto(db, req.params.id);
    if (!photo) return res.status(404).json({ error: 'photo not found' });
    const file =
      photo.status === 'trashed'
        ? path.join(config.photosRoot, '_trash', photo.filename)
        : path.join(config.photosRoot, photo.relPath);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'original file missing on disk' });
    res.setHeader('Content-Type', photo.mimeType);
    if (req.query.download !== undefined) {
      res.setHeader('Content-Disposition', `attachment; filename="${photo.filename}"`);
    }
    res.sendFile(file);
  });

  // ---- calendar -------------------------------------------------------------

  api.get('/calendar', (req, res) => {
    const year = Number(req.query.year);
    const month = Number(req.query.month); // 1-12
    if (!year || !month) return res.status(400).json({ error: 'year and month are required' });
    const params: Record<string, unknown> = {
      prefix: `${year}-${String(month).padStart(2, '0')}`,
    };
    let childClause = '';
    if (req.query.child) {
      childClause = 'AND p.id IN (SELECT photoId FROM photo_children WHERE childId = @child)';
      params.child = String(req.query.child);
    }
    const rows = db
      .prepare(
        `SELECT substr(p.takenAt, 1, 10) AS day, COUNT(*) AS count
         FROM photos p
         WHERE p.status = 'active' AND substr(p.takenAt, 1, 7) = @prefix ${childClause}
         GROUP BY day`,
      )
      .all(params) as { day: string; count: number }[];
    res.json({ days: Object.fromEntries(rows.map((r) => [r.day, r.count])) });
  });

  // ---- folders --------------------------------------------------------------

  api.get('/folders', (req, res) => {
    const rel = String(req.query.path ?? '')
      .replace(/\\/g, '/')
      .replace(/\.\./g, '')
      .replace(/^\/+|\/+$/g, '');
    const abs = path.join(config.photosRoot, rel);
    if (!abs.startsWith(config.photosRoot)) return res.status(400).json({ error: 'invalid path' });
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return res.status(404).json({ error: 'folder not found' });
    }
    const dirs: string[] = [];
    const files: { name: string; photo: Photo | null }[] = [];
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (rel === '' && (entry.name === '_meta' || entry.name === '_trash')) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else if (mimeForFile(entry.name)) {
        const fileRel = rel ? `${rel}/${entry.name}` : entry.name;
        const row = db
          .prepare("SELECT * FROM photos WHERE relPath = ? AND status = 'active'")
          .get(fileRel) as any;
        files.push({ name: entry.name, photo: row ? rowToPhoto(db, row) : null });
      }
    }
    dirs.sort();
    files.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path: rel, dirs, files });
  });

  // ---- trash ----------------------------------------------------------------

  api.get('/trash', (_req, res) => {
    const rows = db
      .prepare("SELECT * FROM photos WHERE status = 'trashed' ORDER BY trashedAt DESC")
      .all() as any[];
    res.json(rows.map((r) => rowToPhoto(db, r)));
  });

  api.post('/trash/:id/restore', (req, res) => {
    const photo = getPhoto(db, req.params.id);
    if (!photo || photo.status !== 'trashed') return res.status(404).json({ error: 'not in trash' });
    const child = childById(photo.childIds[0] ?? '');
    const restored = restorePhoto(db, config.photosRoot, photo, child?.name ?? 'Unsorted');
    snapshots.schedule();
    res.json(restored);
  });

  api.delete('/trash/:id', (req, res) => {
    const photo = getPhoto(db, req.params.id);
    if (!photo || photo.status !== 'trashed') return res.status(404).json({ error: 'not in trash' });
    purgePhoto(db, config.photosRoot, photo);
    snapshots.schedule();
    res.json({ ok: true });
  });

  // ---- upload ---------------------------------------------------------------

  api.post('/upload', upload.array('files'), async (req, res) => {
    const files = (req.files ?? []) as Express.Multer.File[];
    const cleanup = () => files.forEach((f) => fs.rmSync(f.path, { force: true }));
    let childIds: string[] | null = null;
    let lastModified: Record<string, number> = {};
    let tags: string[] = [];
    try {
      childIds = validChildIds(JSON.parse(String(req.body.childIds ?? '[]')));
      lastModified = JSON.parse(String(req.body.lastModified ?? '{}'));
      tags = JSON.parse(String(req.body.tags ?? '[]')).map(String);
    } catch {
      cleanup();
      return res.status(400).json({ error: 'malformed upload fields' });
    }
    if (!childIds) {
      cleanup();
      return res.status(400).json({ error: 'at least one valid childId is required' });
    }
    if (files.length === 0) return res.status(400).json({ error: 'no files' });
    const caption = String(req.body.caption ?? '');
    const folderChild = childById(childIds[0])!;

    const results = [];
    for (const file of files) {
      // Browsers send originalname as latin1; recover UTF-8 names.
      const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const result = await ingestFile(db, config.photosRoot, {
        sourcePath: file.path,
        originalName,
        childIds,
        childName: folderChild.name,
        caption,
        tags,
        fallbackMtimeMs: lastModified[originalName] ?? lastModified[file.originalname],
        keepSource: false,
      });
      if (result.outcome === 'added') {
        results.push({ name: originalName, outcome: 'added', photo: result.photo });
      } else if (result.outcome === 'duplicate') {
        results.push({ name: originalName, outcome: 'duplicate', existingId: result.existingId });
      } else {
        results.push({ name: originalName, outcome: 'error', reason: result.reason });
      }
    }
    snapshots.schedule();
    res.json({ results });
  });

  // ---- bulk import ----------------------------------------------------------

  api.post('/import/scan', (req, res) => {
    const sourcePath = String(req.body?.sourcePath ?? '');
    if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
      return res.status(400).json({ error: 'sourcePath must be an existing folder on the server' });
    }
    res.json(importJobs.startScan(db, sourcePath));
  });

  api.post('/import/run', (req, res) => {
    const sourcePath = String(req.body?.sourcePath ?? '');
    const mode = req.body?.mode === 'move' ? 'move' : 'copy';
    if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
      return res.status(400).json({ error: 'sourcePath must be an existing folder on the server' });
    }
    const childIds = validChildIds(req.body?.childIds);
    if (!childIds) return res.status(400).json({ error: 'at least one valid childId is required' });
    const folderChild = childById(childIds[0])!;
    res.json(importJobs.startImport(db, config.photosRoot, snapshots, sourcePath, childIds, folderChild.name, mode));
  });

  api.get('/import/jobs/:id', (req, res) => {
    const job = importJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json(job);
  });

  // ---- export / import ------------------------------------------------------

  api.get('/export/metadata', (_req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="${APP_NAME.toLowerCase()}-metadata.json"`);
    res.json(buildSnapshot(db));
  });

  api.post('/export/import', (req, res) => {
    const { snapshot, confirm } = req.body ?? {};
    if (
      !snapshot ||
      typeof snapshot.formatVersion !== 'number' ||
      !Array.isArray(snapshot.children) ||
      !Array.isArray(snapshot.photos)
    ) {
      return res.status(400).json({ error: 'not a valid metadata export' });
    }
    if (!confirm) {
      return res.json({
        preview: true,
        children: snapshot.children.length,
        photos: snapshot.photos.length,
        exportedAt: snapshot.exportedAt ?? null,
      });
    }
    const result = applySnapshot(db, config.photosRoot, snapshot);
    snapshots.schedule();
    res.json(result);
  });

  api.get('/export/zip', (req, res) => {
    const { child, from, to } = req.query;
    const where: string[] = ["p.status = 'active'"];
    const params: Record<string, unknown> = {};
    if (child) {
      where.push('p.id IN (SELECT photoId FROM photo_children WHERE childId = @child)');
      params.child = String(child);
    }
    if (from) {
      where.push('p.takenAt >= @from');
      params.from = String(from);
    }
    if (to) {
      where.push('p.takenAt <= @to');
      params.to = String(to);
    }
    const rows = db
      .prepare(`SELECT relPath FROM photos p WHERE ${where.join(' AND ')} ORDER BY takenAt`)
      .all(params) as { relPath: string }[];

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${APP_NAME.toLowerCase()}-export.zip"`);
    // store (no recompression): originals are already compressed, and this
    // streams thousands of files without buffering them in memory.
    const archive = archiver('zip', { store: true });
    archive.on('error', () => res.destroy());
    archive.pipe(res);
    for (const row of rows) {
      const abs = path.join(config.photosRoot, row.relPath);
      if (fs.existsSync(abs)) archive.file(abs, { name: row.relPath });
    }
    void archive.finalize();
  });

  // ---- backup (phase two) ----------------------------------------------------

  const backups = new BackupManager(db, config, snapshots);
  backups.recoverInterrupted();
  backups.startScheduler();

  api.get('/backup/targets', async (_req, res) => {
    const targets = backups.listTargets();
    const out = [];
    for (const target of targets) {
      const instance = backups.instantiate(target);
      out.push({
        ...target,
        config: target.kind === 'local' ? target.config : {}, // never leak token-adjacent config
        connected: await instance.isConnected().catch(() => false),
        activeRun: backups.activeRun(target.id),
        lastRun: backups.listRuns(target.id, 1)[0] ?? null,
        fileCount: (
          db.prepare('SELECT COUNT(*) AS c FROM backup_files WHERE targetId = ?').get(target.id) as { c: number }
        ).c,
      });
    }
    res.json(out);
  });

  api.post('/backup/targets', (req, res) => {
    try {
      res.status(201).json(backups.createTarget(req.body ?? {}));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  api.patch('/backup/targets/:id', (req, res) => {
    try {
      res.json(backups.updateTarget(req.params.id, req.body ?? {}));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  api.delete('/backup/targets/:id', (req, res) => {
    const target = backups.getTarget(req.params.id);
    if (!target) return res.status(404).json({ error: 'target not found' });
    if (target.kind === 'gdrive') {
      (backups.instantiate(target) as GoogleDriveTarget).disconnect();
    }
    backups.deleteTarget(target.id);
    res.json({ ok: true });
  });

  api.post('/backup/targets/:id/run', (req, res) => {
    try {
      res.json(backups.startRun(req.params.id));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  api.get('/backup/targets/:id/runs', (req, res) => {
    res.json(backups.listRuns(req.params.id));
  });

  api.get('/backup/runs/:id', (req, res) => {
    const run = backups.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.json(run);
  });

  api.post('/backup/targets/:id/verify', async (req, res) => {
    try {
      const sampleRate = Number(req.body?.sampleRate ?? 0.01);
      res.json(await backups.verify(req.params.id, Math.min(1, Math.max(0.0001, sampleRate))));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ---- backup: Google Drive OAuth --------------------------------------------

  const pendingOAuth = new Map<string, { verifier: string; targetId: string }>();

  api.get('/backup/gdrive/status', (_req, res) => {
    res.json({ clientIdSet: Boolean(process.env.GOOGLE_CLIENT_ID) });
  });

  api.get('/backup/gdrive/auth-url', (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return res.status(400).json({ error: 'GOOGLE_CLIENT_ID is not set on the server — see the README.' });
    }
    const target = backups.getTarget(String(req.query.targetId ?? ''));
    if (!target || target.kind !== 'gdrive') return res.status(404).json({ error: 'target not found' });
    const state = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    pendingOAuth.set(state, { verifier, targetId: target.id });
    const redirectUri = `${req.protocol}://${req.get('host')}/api/backup/gdrive/callback`;
    res.json({ url: buildAuthUrl(clientId, redirectUri, state, challenge) });
  });

  api.get('/backup/gdrive/callback', async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;
    const pending = state ? pendingOAuth.get(state) : undefined;
    if (error || !code || !pending) {
      return res.redirect(`/#/backup?connect_error=${encodeURIComponent(error ?? 'missing code or state')}`);
    }
    pendingOAuth.delete(state);
    try {
      const redirectUri = `${req.protocol}://${req.get('host')}/api/backup/gdrive/callback`;
      const { refreshToken } = await exchangeCode(
        process.env.GOOGLE_CLIENT_ID!,
        process.env.GOOGLE_CLIENT_SECRET,
        code,
        redirectUri,
        pending.verifier,
      );
      const target = backups.getTarget(pending.targetId);
      if (!target) throw new Error('target was deleted during the consent flow');
      (backups.instantiate(target) as GoogleDriveTarget).setRefreshToken(refreshToken);
      res.redirect('/#/backup?connected=1');
    } catch (err) {
      res.redirect(`/#/backup?connect_error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  // ---- static client + health ----------------------------------------------

  app.get('/healthz', (_req, res) => res.json({ ok: true, app: APP_NAME }));

  // Generated so the app name lives in exactly one place (shared/appName.ts).
  app.get('/manifest.webmanifest', (_req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.json({
      name: APP_NAME,
      short_name: APP_NAME,
      start_url: '/',
      display: 'standalone',
      background_color: '#0f172a',
      theme_color: '#0f172a',
      icons: [
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  });

  const clientDir = path.resolve(import.meta.dirname, '../client');
  if (fs.existsSync(path.join(clientDir, 'index.html'))) {
    app.use(express.static(clientDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  const close = () => {
    snapshots.flush();
    backups.stop();
    clearInterval(purgeTimer);
    db.close();
  };

  return { app, db, config, snapshots, backups, close };
}
