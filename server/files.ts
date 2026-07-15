import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';
import type { TakenAtSource } from '../shared/types.js';

export const MEDIA_EXTENSIONS: Record<string, string> = {
  // images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  // videos (stored as-is, played natively; poster frames via ffmpeg)
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** Back-compat alias; the map now also covers video and gif. */
export const IMAGE_EXTENSIONS = MEDIA_EXTENSIONS;

export function mimeForFile(filename: string): string | null {
  return MEDIA_EXTENSIONS[path.extname(filename).toLowerCase()] ?? null;
}

export function isVideoMime(mimeType: string): boolean {
  return mimeType.startsWith('video/');
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export interface TakenAtResult {
  takenAt: string;
  source: TakenAtSource;
}

/**
 * EXIF DateTimeOriginal first; fall back to the provided mtime (the source
 * file's mtime for bulk imports, the browser-reported lastModified for
 * uploads, or the temp file's mtime as a last resort).
 */
export async function resolveTakenAt(filePath: string, fallbackMtimeMs?: number): Promise<TakenAtResult> {
  try {
    const exif = await exifr.parse(filePath, { pick: ['DateTimeOriginal', 'CreateDate'] });
    const date: Date | undefined = exif?.DateTimeOriginal ?? exif?.CreateDate;
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      return { takenAt: date.toISOString(), source: 'exif' };
    }
  } catch {
    // unreadable/absent EXIF is normal; fall through to mtime
  }
  const mtimeMs = fallbackMtimeMs ?? fs.statSync(filePath).mtimeMs;
  return { takenAt: new Date(mtimeMs).toISOString(), source: 'file' };
}

export interface MediaProbe {
  takenAt: string;
  source: TakenAtSource;
  width: number;
  height: number;
  durationSec: number | null;
}

/**
 * Single entry point for reading a file's date, dimensions and (for video)
 * duration. Images go through EXIF/sharp; video through ffprobe. Any failure
 * degrades to sensible defaults so ingest never blocks on a quirky file.
 */
export async function probeMedia(
  filePath: string,
  mimeType: string,
  fallbackMtimeMs?: number,
): Promise<MediaProbe> {
  if (isVideoMime(mimeType)) {
    const { probeVideo } = await import('./media.js');
    let width = 0;
    let height = 0;
    let durationSec: number | null = null;
    let containerDate: string | null = null;
    try {
      const probe = await probeVideo(filePath);
      width = probe.width;
      height = probe.height;
      durationSec = probe.durationSec;
      containerDate = probe.createdAt;
    } catch {
      // no ffprobe / unreadable container: keep defaults, fall back to mtime
    }
    if (containerDate) return { takenAt: containerDate, source: 'container', width, height, durationSec };
    const mtimeMs = fallbackMtimeMs ?? fs.statSync(filePath).mtimeMs;
    return { takenAt: new Date(mtimeMs).toISOString(), source: 'file', width, height, durationSec };
  }
  const [{ takenAt, source }, { width, height }] = await Promise.all([
    resolveTakenAt(filePath, fallbackMtimeMs),
    imageDimensions(filePath),
  ]);
  return { takenAt, source, width, height, durationSec: null };
}

export async function imageDimensions(filePath: string): Promise<{ width: number; height: number }> {
  try {
    const meta = await sharp(filePath).metadata();
    // Swap for EXIF orientations that rotate 90°, so the UI gets display size.
    const rotated = (meta.orientation ?? 1) >= 5;
    const width = (rotated ? meta.height : meta.width) ?? 0;
    const height = (rotated ? meta.width : meta.height) ?? 0;
    return { width, height };
  } catch {
    return { width: 0, height: 0 };
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD_HHMMSS_<hash8>.<ext>, using local time of the takenAt instant. */
export function canonicalFilename(takenAt: string, contentHash: string, originalName: string): string {
  const d = new Date(takenAt);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  let ext = path.extname(originalName).toLowerCase();
  if (ext === '.jpeg') ext = '.jpg';
  if (ext === '.heif') ext = '.heic';
  return `${date}_${time}_${contentHash.slice(0, 8)}${ext}`;
}

/** Keep folder names safe on Windows and Linux while staying human-readable. */
export function safeFolderName(name: string): string {
  const cleaned = name.replace(/[<>:"\/\\|?*]|[\u0000-\u001f]/g, '').trim().replace(/\.+$/, '');
  return cleaned || 'Unnamed';
}

/** PHOTOS_ROOT/<Child>/<YYYY>/<YYYY-MM>/<filename>, relative part only. */
export function canonicalRelPath(childName: string, takenAt: string, filename: string): string {
  const d = new Date(takenAt);
  const year = String(d.getFullYear());
  const month = `${year}-${pad(d.getMonth() + 1)}`;
  return [safeFolderName(childName), year, month, filename].join('/');
}

/**
 * Move (same volume) or copy+unlink a file into its canonical location.
 * Never overwrites: the content hash in the name makes collisions
 * effectively identical files, but we still refuse to clobber.
 */
export function placeFile(photosRoot: string, sourcePath: string, relPath: string, keepSource: boolean): void {
  const target = path.join(photosRoot, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    if (!keepSource) fs.unlinkSync(sourcePath);
    return;
  }
  if (keepSource) {
    fs.copyFileSync(sourcePath, target);
    return;
  }
  try {
    fs.renameSync(sourcePath, target);
  } catch {
    fs.copyFileSync(sourcePath, target);
    fs.unlinkSync(sourcePath);
  }
}

export function walkImages(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('_meta') || entry.name.startsWith('_trash') || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkImages(full, out);
    else if (entry.isFile() && mimeForFile(entry.name)) out.push(full);
  }
  return out;
}
