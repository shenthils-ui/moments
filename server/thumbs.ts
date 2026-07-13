import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ALLOWED_SIZES = [256, 1024];

let sharpSupportsHeif: boolean | null = null;

async function checkSharpHeif(): Promise<boolean> {
  if (sharpSupportsHeif !== null) return sharpSupportsHeif;
  sharpSupportsHeif = Boolean((sharp.format as any)?.heif?.input?.file);
  return sharpSupportsHeif;
}

/** Decode HEIC via the libheif WASM decoder; returns raw RGBA for sharp. */
async function decodeHeicWasm(filePath: string): Promise<sharp.Sharp> {
  const { default: heicDecode } = await import('heic-decode');
  const buffer = fs.readFileSync(filePath);
  const { width, height, data } = await heicDecode({ buffer: new Uint8Array(buffer) });
  return sharp(Buffer.from(data.buffer), { raw: { width, height, channels: 4 } });
}

export function normalizeSize(size: unknown): number {
  const n = Number(size);
  return ALLOWED_SIZES.includes(n) ? n : 256;
}

export class ThumbnailError extends Error {}

/**
 * Thumbnails are a derived cache in DATA_DIR/cache/thumbs, keyed by content
 * hash + size, regenerated on demand. Never stored inside PHOTOS_ROOT.
 */
export async function getThumbnail(
  cacheDir: string,
  photosRoot: string,
  relPath: string,
  contentHash: string,
  size: number,
  mimeType: string,
): Promise<string> {
  const cached = path.join(cacheDir, `${contentHash}_${size}.jpg`);
  if (fs.existsSync(cached)) return cached;

  const source = path.join(photosRoot, relPath);
  if (!fs.existsSync(source)) throw new ThumbnailError('original missing');

  let pipeline: sharp.Sharp;
  const isHeic = mimeType === 'image/heic' || mimeType === 'image/heif';
  if (isHeic && !(await checkSharpHeif())) {
    try {
      pipeline = await decodeHeicWasm(source);
    } catch (err) {
      throw new ThumbnailError(`HEIC decode failed: ${(err as Error).message}`);
    }
  } else {
    pipeline = sharp(source).rotate(); // rotate() applies EXIF orientation
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = cached + `.${process.pid}.tmp`;
  try {
    await pipeline
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(tmp);
    fs.renameSync(tmp, cached);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new ThumbnailError(`thumbnail generation failed: ${(err as Error).message}`);
  }
  return cached;
}
