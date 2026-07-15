import { spawn } from 'node:child_process';
import sharp from 'sharp';

/**
 * Video handling uses ffmpeg + ffprobe. Binaries are resolved in this order,
 * so it works everywhere without the user installing anything:
 *   1. FFMPEG_PATH / FFPROBE_PATH env vars (explicit override),
 *   2. the bundled ffmpeg-static / ffprobe-static packages (Windows/Mac dev
 *      and start.bat), if their prebuilt binary was downloaded,
 *   3. a system ffmpeg / ffprobe on PATH (used by the Docker image, which
 *      apt-installs ffmpeg).
 * If none is found, video ingest still stores the original untouched; only
 * the poster thumbnail is skipped (the UI shows a labelled placeholder).
 */

let ffmpegPath: string | null | undefined;
let ffprobePath: string | null | undefined;

async function resolveBinary(
  envVar: string,
  staticModule: string,
  fallbackName: string,
): Promise<string> {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  try {
    const mod: any = await import(staticModule);
    const p = staticModule === 'ffprobe-static' ? mod.path ?? mod.default?.path : mod.default ?? mod;
    if (typeof p === 'string' && p.length > 0) return p;
  } catch {
    // package not installed / binary not downloaded — fall through to PATH
  }
  return fallbackName;
}

async function ffmpeg(): Promise<string> {
  if (ffmpegPath === undefined) ffmpegPath = await resolveBinary('FFMPEG_PATH', 'ffmpeg-static', 'ffmpeg');
  return ffmpegPath!;
}

async function ffprobe(): Promise<string> {
  if (ffprobePath === undefined) ffprobePath = await resolveBinary('FFPROBE_PATH', 'ffprobe-static', 'ffprobe');
  return ffprobePath!;
}

function run(bin: string, args: string[], wantStdout: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', wantStdout ? 'pipe' : 'ignore', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout?.on('data', (c) => out.push(c));
    proc.stderr?.on('data', (c) => err.push(c));
    proc.on('error', reject); // binary missing / not executable
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${bin} exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`));
    });
  });
}

export interface VideoProbe {
  width: number;
  height: number;
  durationSec: number | null;
  /** Recording time from container metadata, ISO, if present. */
  createdAt: string | null;
}

export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const bin = await ffprobe();
  const json = await run(
    bin,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    true,
  );
  const data = JSON.parse(json.toString());
  const video = (data.streams ?? []).find((s: any) => s.codec_type === 'video');
  const durationRaw = Number(data.format?.duration ?? video?.duration);
  const created =
    data.format?.tags?.creation_time ?? video?.tags?.creation_time ?? null;
  const createdDate = created ? new Date(created) : null;
  // account for rotation metadata so the UI gets display dimensions
  const rotation = Math.abs(Number(video?.tags?.rotate ?? video?.side_data_list?.[0]?.rotation ?? 0)) % 180;
  const w = Number(video?.width ?? 0);
  const h = Number(video?.height ?? 0);
  const swap = rotation === 90;
  return {
    width: swap ? h : w,
    height: swap ? w : h,
    durationSec: Number.isFinite(durationRaw) ? Math.round(durationRaw) : null,
    createdAt: createdDate && !Number.isNaN(createdDate.getTime()) ? createdDate.toISOString() : null,
  };
}

/**
 * Extract a poster frame as a resized JPEG. Tries ~1s in (past a black lead
 * frame); falls back to the very first frame for very short clips.
 */
export async function videoPoster(filePath: string, size: number): Promise<Buffer> {
  const bin = await ffmpeg();
  const extract = (seek: string) =>
    run(bin, ['-ss', seek, '-i', filePath, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], true);
  let raw: Buffer;
  try {
    raw = await extract('00:00:01');
    if (raw.length === 0) raw = await extract('00:00:00');
  } catch {
    raw = await extract('00:00:00');
  }
  if (raw.length === 0) throw new Error('ffmpeg produced no frame');
  return sharp(raw).resize(size, size, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
}
