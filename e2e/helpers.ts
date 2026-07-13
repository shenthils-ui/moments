import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const PORT = 3210;
export const BASE = `http://localhost:${PORT}`;

/**
 * Manages the REAL server process (node dist/server/index.js) so tests can
 * kill and restart it — required for the persistence test and the recovery
 * drill. Not an in-process app instance.
 */
export class ServerHandle {
  private proc: ChildProcess | null = null;

  constructor(
    public photosRoot: string,
    public dataDir: string,
  ) {}

  async start(): Promise<void> {
    if (this.proc) throw new Error('already running');
    this.proc = spawn('node', [path.resolve('dist/server/index.js')], {
      env: {
        ...process.env,
        PHOTOS_ROOT: this.photosRoot,
        DATA_DIR: this.dataDir,
        PORT: String(PORT),
        NO_QR: '1',
      },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(`${BASE}/healthz`);
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not become healthy');
  }

  /** Graceful stop (SIGTERM) so the metadata snapshot flushes, like a real shutdown. */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
      setTimeout(() => {
        proc.kill('SIGKILL');
      }, 5000).unref();
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}

let seed = 100;

/** Unique JPEG with optional EXIF DateTimeOriginal ("YYYY:MM:DD HH:MM:SS"). */
export async function makeJpeg(file: string, exifDate?: string): Promise<void> {
  seed++;
  let pipeline = sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: (seed * 37) % 256, g: (seed * 101) % 256, b: (seed * 173) % 256 },
    },
  });
  if (exifDate) pipeline = pipeline.withExif({ IFD2: { DateTimeOriginal: exifDate } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await pipeline.jpeg().toFile(file);
}
