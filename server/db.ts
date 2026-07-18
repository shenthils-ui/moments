import Database from 'better-sqlite3';
import path from 'node:path';
import type { Child, Photo, TakenAtSource, PhotoStatus, MediaKind } from '../shared/types.js';

export type DB = Database.Database;

const SCHEMA_VERSION = 4;

const MIGRATIONS: Record<number, (db: DB) => void> = {
  1: (db) => {
    db.exec(`
      CREATE TABLE children (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        birthDate TEXT,
        color TEXT NOT NULL DEFAULT '#6366f1',
        createdAt TEXT NOT NULL
      );
      CREATE TABLE photos (
        id TEXT PRIMARY KEY,
        contentHash TEXT NOT NULL UNIQUE,
        takenAt TEXT NOT NULL,
        takenAtSource TEXT NOT NULL,
        relPath TEXT NOT NULL,
        filename TEXT NOT NULL,
        mimeType TEXT NOT NULL,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        sizeBytes INTEGER NOT NULL DEFAULT 0,
        caption TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        milestone TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        trashedAt TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE INDEX idx_photos_takenAt ON photos(takenAt);
      CREATE INDEX idx_photos_status ON photos(status);
      CREATE TABLE photo_children (
        photoId TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
        childId TEXT NOT NULL REFERENCES children(id),
        PRIMARY KEY (photoId, childId)
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token TEXT PRIMARY KEY,
        createdAt TEXT NOT NULL
      );
    `);
  },
  2: (db) => {
    db.exec(`
      CREATE TABLE backup_targets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        displayName TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        schedule TEXT NOT NULL DEFAULT '{"mode":"manual"}',
        mirrorDeletions INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE backup_files (
        targetId TEXT NOT NULL REFERENCES backup_targets(id) ON DELETE CASCADE,
        relPath TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        sizeBytes INTEGER NOT NULL DEFAULT 0,
        uploadedAt TEXT NOT NULL,
        verifiedAt TEXT,
        PRIMARY KEY (targetId, relPath)
      );
      CREATE INDEX idx_backup_files_hash ON backup_files(targetId, contentHash);
      CREATE TABLE backup_runs (
        id TEXT PRIMARY KEY,
        targetId TEXT NOT NULL REFERENCES backup_targets(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        finishedAt TEXT,
        total INTEGER NOT NULL DEFAULT 0,
        processed INTEGER NOT NULL DEFAULT 0,
        uploaded INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        failures TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX idx_backup_runs_target ON backup_runs(targetId, startedAt);
    `);
  },
  3: (db) => {
    // Video support: store duration alongside dimensions. Media kind is
    // derived from mimeType at read time, so no column is needed for it.
    db.exec(`ALTER TABLE photos ADD COLUMN durationSec INTEGER;`);
  },
  4: (db) => {
    db.exec(`ALTER TABLE photos ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;`);
    db.exec(`CREATE INDEX idx_photos_favorite ON photos(favorite);`);
  },
};

export function openDb(dataDir: string): DB {
  const db = new Database(path.join(dataDir, 'library.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  let version = db.pragma('user_version', { simple: true }) as number;
  while (version < SCHEMA_VERSION) {
    const next = version + 1;
    const step = MIGRATIONS[next];
    if (!step) throw new Error(`No migration to schema version ${next}`);
    const run = db.transaction(() => {
      step(db);
      db.pragma(`user_version = ${next}`);
    });
    run();
    version = next;
  }
}

// ---- row mapping -----------------------------------------------------------

interface PhotoRow {
  id: string;
  contentHash: string;
  takenAt: string;
  takenAtSource: TakenAtSource;
  relPath: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  durationSec: number | null;
  sizeBytes: number;
  caption: string;
  tags: string;
  milestone: string | null;
  favorite: number;
  status: PhotoStatus;
  trashedAt: string | null;
  createdAt: string;
}

export function mediaKind(mimeType: string): MediaKind {
  return mimeType.startsWith('video/') ? 'video' : 'photo';
}

export function rowToPhoto(db: DB, row: PhotoRow): Photo {
  const childIds = (
    db.prepare('SELECT childId FROM photo_children WHERE photoId = ?').all(row.id) as { childId: string }[]
  ).map((r) => r.childId);
  return {
    ...row,
    tags: JSON.parse(row.tags),
    childIds,
    kind: mediaKind(row.mimeType),
    durationSec: row.durationSec ?? null,
    favorite: Boolean(row.favorite),
  };
}

export function getPhoto(db: DB, id: string): Photo | null {
  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id) as PhotoRow | undefined;
  return row ? rowToPhoto(db, row) : null;
}

export function insertPhoto(db: DB, photo: Photo): void {
  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO photos (id, contentHash, takenAt, takenAtSource, relPath, filename, mimeType,
         width, height, durationSec, sizeBytes, caption, tags, milestone, favorite, status, trashedAt, createdAt)
       VALUES (@id, @contentHash, @takenAt, @takenAtSource, @relPath, @filename, @mimeType,
         @width, @height, @durationSec, @sizeBytes, @caption, @tags, @milestone, @favorite, @status, @trashedAt, @createdAt)`,
    ).run({
      ...photo,
      tags: JSON.stringify(photo.tags),
      durationSec: photo.durationSec ?? null,
      favorite: photo.favorite ? 1 : 0,
    });
    const link = db.prepare('INSERT INTO photo_children (photoId, childId) VALUES (?, ?)');
    for (const childId of photo.childIds) link.run(photo.id, childId);
  });
  insert();
}

export function setPhotoChildren(db: DB, photoId: string, childIds: string[]): void {
  const update = db.transaction(() => {
    db.prepare('DELETE FROM photo_children WHERE photoId = ?').run(photoId);
    const link = db.prepare('INSERT INTO photo_children (photoId, childId) VALUES (?, ?)');
    for (const childId of childIds) link.run(photoId, childId);
  });
  update();
}

export function listChildren(db: DB): Child[] {
  return db.prepare('SELECT * FROM children ORDER BY createdAt').all() as Child[];
}

export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(db: DB, key: string, value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}

export function allSettings(db: DB): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
