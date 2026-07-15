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

/** Read only the embedded EXIF capture date; null when absent/unreadable. */
async function exifDate(filePath: string): Promise<Date | null> {
  try {
    const exif = await exifr.parse(filePath, { pick: ['DateTimeOriginal', 'CreateDate'] });
    const date: Date | undefined = exif?.DateTimeOriginal ?? exif?.CreateDate;
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
  } catch {
    // unreadable/absent EXIF is normal
  }
  return null;
}

/**
 * Recover a capture date embedded in a filename — the common case for
 * screenshots and photos pasted/copied off a phone, whose file time has been
 * reset to the copy time. Handles the widespread camera/app conventions:
 *   IMG_20230514_130502, PXL_20230514_130502123, VID_20230514_...,
 *   Screenshot_20230514-130502, IMG-20230514-WA0001 (WhatsApp),
 *   2023-05-14 13.05.02, 2023_05_14, 20230514_130502, 20230514.
 * Interpreted in the server's local time. Returns null if no plausible date
 * is present (and never mistakes a resolution like 1920x1080 for a date).
 */
const NAME_DATE_RE =
  /(?:^|[^\d])(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_ T]?([01]\d|2[0-3])[-_.:]?([0-5]\d)(?:[-_.:]?([0-5]\d))?)?/;

export function parseDateFromName(name: string): Date | null {
  const m = name.match(NAME_DATE_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
  // reject impossible dates and anything in the future (a bad parse)
  if (Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 24 * 3600 * 1000) return null;
  if (date.getFullYear() < 1990) return null;
  return date;
}

/**
 * Resolve a capture date in priority order: embedded metadata (EXIF for
 * images, container creation_time for video) → a date parsed from the
 * original filename → the file's modified time as a last resort.
 */
export async function resolveCaptureDate(
  filePath: string,
  mimeType: string,
  originalName: string,
  fallbackMtimeMs?: number,
): Promise<TakenAtResult> {
  let embedded: Date | null = null;
  if (isVideoMime(mimeType)) {
    try {
      const { probeVideo } = await import('./media.js');
      const probe = await probeVideo(filePath);
      embedded = probe.createdAt ? new Date(probe.createdAt) : null;
    } catch {
      /* no ffprobe */
    }
    if (embedded) return { takenAt: embedded.toISOString(), source: 'container' };
  } else {
    embedded = await exifDate(filePath);
    if (embedded) return { takenAt: embedded.toISOString(), source: 'exif' };
  }
  const fromName = parseDateFromName(originalName);
  if (fromName) return { takenAt: fromName.toISOString(), source: 'filename' };
  const mtimeMs = fallbackMtimeMs ?? fs.statSync(filePath).mtimeMs;
  return { takenAt: new Date(mtimeMs).toISOString(), source: 'file' };
}

/** Back-compat: EXIF then file time (used where no original name is known). */
export async function resolveTakenAt(filePath: string, fallbackMtimeMs?: number): Promise<TakenAtResult> {
  const date = await exifDate(filePath);
  if (date) return { takenAt: date.toISOString(), source: 'exif' };
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
 * duration. Date resolution is EXIF/container → filename → file time (see
 * resolveCaptureDate). Any failure degrades to sensible defaults so ingest
 * never blocks on a quirky file.
 */
export async function probeMedia(
  filePath: string,
  mimeType: string,
  originalName: string,
  fallbackMtimeMs?: number,
): Promise<MediaProbe> {
  if (isVideoMime(mimeType)) {
    let width = 0;
    let height = 0;
    let durationSec: number | null = null;
    try {
      const { probeVideo } = await import('./media.js');
      const probe = await probeVideo(filePath);
      width = probe.width;
      height = probe.height;
      durationSec = probe.durationSec;
    } catch {
      // no ffprobe / unreadable container: keep defaults
    }
    const { takenAt, source } = await resolveCaptureDate(filePath, mimeType, originalName, fallbackMtimeMs);
    return { takenAt, source, width, height, durationSec };
  }
  const [{ takenAt, source }, { width, height }] = await Promise.all([
    resolveCaptureDate(filePath, mimeType, originalName, fallbackMtimeMs),
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
