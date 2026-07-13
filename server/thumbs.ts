import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ALLOWED_SIZES = [256, 1024];

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

async function writeThumb(pipeline: sharp.Sharp, size: number, target: string): Promise<void> {
  const tmp = target + `.${process.pid}.tmp`;
  try {
    await pipeline
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(tmp);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Thumbnails are a derived cache in DATA_DIR/cache/thumbs, keyed by content
 * hash + size, regenerated on demand. Never stored inside PHOTOS_ROOT.
 *
 * HEIC: sharp handles it when the build supports HEIF; otherwise (typical
 * prebuilt sharp lacks HEVC) we retry with the libheif WASM decoder. If
 * both fail the caller gets a ThumbnailError and the UI shows a labelled
 * placeholder — never a broken image.
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
  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    await writeThumb(sharp(source).rotate(), size, cached); // rotate() applies EXIF orientation
    return cached;
  } catch (sharpErr) {
    const isHeic = mimeType === 'image/heic' || mimeType === 'image/heif';
    if (!isHeic) throw new ThumbnailError(`thumbnail generation failed: ${(sharpErr as Error).message}`);
    try {
      await writeThumb(await decodeHeicWasm(source), size, cached);
      return cached;
    } catch (wasmErr) {
      throw new ThumbnailError(`HEIC decode failed: ${(wasmErr as Error).message}`);
    }
  }
}
