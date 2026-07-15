import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeSetup, makeEnv, type TestEnv } from './helpers.js';

// Video tests need ffmpeg to generate fixtures and to make posters. Where it
// isn't installed we skip rather than fail (the same graceful-degradation the
// app itself uses). ffmpeg is present in CI and the Docker image.
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

let env: TestEnv;
let agent: request.Agent;
let childId: string;

beforeEach(async () => {
  env = makeEnv();
  agent = request.agent(env.ctx.app);
  childId = await completeSetup(agent);
});

afterEach(() => env.cleanup());

function makeVideo(file: string, seconds: number, creationTime?: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=15`, '-pix_fmt', 'yuv420p'];
  if (creationTime) args.push('-metadata', `creation_time=${creationTime}`);
  args.push(file);
  execFileSync('ffmpeg', args, { stdio: 'ignore' });
}

function makeGif(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=5', file], { stdio: 'ignore' });
}

async function upload(file: string) {
  return agent.post('/api/upload').field('childIds', JSON.stringify([childId])).attach('files', file).expect(200);
}

describe.skipIf(!ffmpegAvailable)('video support', () => {
  it('ingests a video: stored untouched, kind=video, duration + container date extracted', async () => {
    const file = path.join(env.root, 'src', 'clip.mp4');
    makeVideo(file, 2, '2023-05-01T10:00:00.000000Z');
    const res = await upload(file);
    const photo = res.body.results[0].photo;

    expect(res.body.results[0].outcome).toBe('added');
    expect(photo.kind).toBe('video');
    expect(photo.mimeType).toBe('video/mp4');
    expect(photo.durationSec).toBe(2);
    expect(photo.width).toBe(320);
    expect(photo.height).toBe(240);
    expect(photo.takenAtSource).toBe('container');
    expect(photo.takenAt.startsWith('2023-05-01T10:00:00')).toBe(true);
    expect(photo.relPath).toMatch(/^Mila\/2023\/2023-05\/.*\.mp4$/);
    // original stored byte-for-byte, never re-encoded
    expect(fs.readFileSync(path.join(env.photosRoot, photo.relPath))).toEqual(fs.readFileSync(file));
  });

  it('falls back to file mtime when the container has no creation time', async () => {
    const file = path.join(env.root, 'src', 'nodate.mp4');
    makeVideo(file, 1);
    const mtime = new Date('2021-09-09T08:00:00Z').getTime();
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
    const res = await agent
      .post('/api/upload')
      .field('childIds', JSON.stringify([childId]))
      .field('lastModified', JSON.stringify({ 'nodate.mp4': mtime }))
      .attach('files', file)
      .expect(200);
    const photo = res.body.results[0].photo;
    expect(photo.kind).toBe('video');
    expect(photo.takenAtSource).toBe('file');
    expect(photo.takenAt).toBe('2021-09-09T08:00:00.000Z');
  });

  it('generates a JPEG poster thumbnail for a video', async () => {
    const file = path.join(env.root, 'src', 'poster.mp4');
    makeVideo(file, 2);
    const photo = (await upload(file)).body.results[0].photo;
    const thumb = await agent.get(`/api/photos/${photo.id}/thumb?size=256`).expect(200);
    expect(thumb.headers['content-type']).toContain('image/jpeg');
    expect((thumb.body as Buffer).subarray(0, 3).toString('hex')).toBe('ffd8ff');
  });

  it('serves the original video with byte-range support for seeking', async () => {
    const file = path.join(env.root, 'src', 'range.mp4');
    makeVideo(file, 2);
    const photo = (await upload(file)).body.results[0].photo;
    const full = await agent.get(`/api/photos/${photo.id}/original`).expect(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    const ranged = await agent.get(`/api/photos/${photo.id}/original`).set('Range', 'bytes=0-99').expect(206);
    expect(ranged.headers['content-range']).toMatch(/^bytes 0-99\//);
  });

  it('filters the library by media kind', async () => {
    const vid = path.join(env.root, 'src', 'v.mp4');
    const img = path.join(env.root, 'src', 'p.gif');
    makeVideo(vid, 1);
    makeGif(img);
    await upload(vid);
    await upload(img);
    expect((await agent.get('/api/photos?kind=video').expect(200)).body.total).toBe(1);
    expect((await agent.get('/api/photos?kind=photo').expect(200)).body.total).toBe(1);
    expect((await agent.get('/api/photos').expect(200)).body.total).toBe(2);
  });

  it('survives a rebuild-from-folders with video metadata intact', async () => {
    const file = path.join(env.root, 'src', 'rebuild.mp4');
    makeVideo(file, 2, '2022-03-03T12:00:00.000000Z');
    await upload(file);

    env.ctx.close();
    fs.rmSync(env.dataDir, { recursive: true, force: true });
    fs.rmSync(path.join(env.photosRoot, '_meta'), { recursive: true, force: true });
    const { createApp } = await import('../server/app.js');
    env.ctx = createApp({ photosRoot: env.photosRoot, dataDir: env.dataDir, port: 0 });
    const fresh = request.agent(env.ctx.app);
    const rebuilt = await fresh.post('/api/system/rebuild').expect(200);
    expect(rebuilt.body.added).toBe(1);
    const photos = (await fresh.get('/api/photos').expect(200)).body.photos;
    expect(photos[0].kind).toBe('video');
    expect(photos[0].durationSec).toBe(2);
  });
});

describe.skipIf(!ffmpegAvailable)('gif support', () => {
  it('ingests a GIF as an image and thumbnails it', async () => {
    const file = path.join(env.root, 'src', 'anim.gif');
    makeGif(file);
    const photo = (await upload(file)).body.results[0].photo;
    expect(photo.outcome ?? 'added').toBeTruthy();
    expect(photo.kind).toBe('photo');
    expect(photo.mimeType).toBe('image/gif');
    expect(photo.relPath.endsWith('.gif')).toBe(true);
    const thumb = await agent.get(`/api/photos/${photo.id}/thumb`).expect(200);
    expect(thumb.headers['content-type']).toContain('image/jpeg');
    // original gif preserved for animation
    expect(fs.readFileSync(path.join(env.photosRoot, photo.relPath))).toEqual(fs.readFileSync(file));
  });
});
