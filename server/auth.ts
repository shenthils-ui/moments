import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { type DB, getSetting, setSetting } from './db.js';

export const SESSION_COOKIE = 'moments_session';

// Sessions are long-lived (this is a family app on a trusted network), but
// not eternal: stale tokens are rejected and swept so the table can't grow
// without bound and a leaked cookie doesn't stay valid for years.
export const SESSION_TTL_DAYS = 60;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 3600 * 1000;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function authEnabled(db: DB): boolean {
  return getSetting(db, 'passwordHash') !== null;
}

export function createSession(db: DB): string {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, createdAt) VALUES (?, ?)').run(token, new Date().toISOString());
  return token;
}

export function destroySession(db: DB, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function isAuthed(db: DB, req: Request): boolean {
  if (!authEnabled(db)) return true;
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return false;
  const row = db.prepare('SELECT createdAt FROM sessions WHERE token = ?').get(token) as
    | { createdAt: string }
    | undefined;
  if (!row) return false;
  if (Date.now() - new Date(row.createdAt).getTime() > SESSION_TTL_MS) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token); // expired: sweep it now
    return false;
  }
  return true;
}

/** Remove expired sessions; called at boot and on a daily timer. */
export function purgeExpiredSessions(db: DB): number {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString();
  const info = db.prepare('DELETE FROM sessions WHERE createdAt < ?').run(cutoff);
  return info.changes;
}

/**
 * When the family password is set, everything under /api except the auth
 * endpoints themselves (and system status, which the login screen needs)
 * requires a session cookie — including image and download URLs.
 */
export function requireAuth(db: DB) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/auth/') || req.path === '/system/status') return next();
    if (isAuthed(db, req)) return next();
    res.status(401).json({ error: 'authentication required' });
  };
}

export function setPassword(db: DB, password: string | null): void {
  if (password === null) {
    setSetting(db, 'passwordHash', null);
    db.prepare('DELETE FROM sessions').run();
  } else {
    setSetting(db, 'passwordHash', hashPassword(password));
  }
}
