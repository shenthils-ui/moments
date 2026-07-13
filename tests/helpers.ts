import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp, type AppContext } from '../server/app.js';

export interface TestEnv {
  ctx: AppContext;
  photosRoot: string;
  dataDir: string;
  root: string;
  cleanup: () => void;
}

export function makeEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-test-'));
  const photosRoot = path.join(root, 'photos');
  const dataDir = path.join(root, 'data');
  const ctx = createApp({ photosRoot, dataDir, port: 0 });
  return {
    ctx,
    photosRoot,
    dataDir,
    root,
    cleanup: () => {
      ctx.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

let seed = 0;

/**
 * Generate a small unique JPEG; when exifDate is given ("YYYY:MM:DD HH:MM:SS")
 * it is written as EXIF DateTimeOriginal in the Exif sub-IFD.
 */
export async function makeJpeg(file: string, exifDate?: string, color?: { r: number; g: number; b: number }): Promise<void> {
  seed++;
  const background = color ?? { r: (seed * 37) % 256, g: (seed * 101) % 256, b: (seed * 173) % 256 };
  let pipeline = sharp({
    create: { width: 64, height: 48, channels: 3, background },
  });
  if (exifDate) {
    pipeline = pipeline.withExif({ IFD2: { DateTimeOriginal: exifDate } });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await pipeline.jpeg().toFile(file);
}

export async function completeSetup(agent: any, childName = 'Mila', birthDate = '2023-01-15'): Promise<string> {
  const res = await agent
    .post('/api/system/setup')
    .send({ child: { name: childName, birthDate, color: '#f472b6' } })
    .expect(200);
  return res.body.child.id as string;
}
