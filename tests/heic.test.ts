import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeSetup, makeEnv, type TestEnv } from './helpers.js';

const REAL_HEIC = path.join(__dirname, 'fixtures', 'sample.heic');

let env: TestEnv;
let agent: request.Agent;
let childId: string;

beforeEach(async () => {
  env = makeEnv();
  agent = request.agent(env.ctx.app);
  childId = await completeSetup(agent);
});

afterEach(() => env.cleanup());

describe('HEIC handling', () => {
  it('stores an undecodable .heic original and serves a placeholder response, never a broken UI', async () => {
    // junk bytes with a .heic name: original must still be stored untouched
    const file = path.join(env.root, 'src', 'broken.heic');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from('not really a heic file at all'));

    const res = await agent
      .post('/api/upload')
      .field('childIds', JSON.stringify([childId]))
      .attach('files', file)
      .expect(200);
    expect(res.body.results[0].outcome).toBe('added');
    const photo = res.body.results[0].photo;
    expect(photo.mimeType).toBe('image/heic');
    expect(fs.readFileSync(path.join(env.photosRoot, photo.relPath))).toEqual(fs.readFileSync(file));

    const thumb = await agent.get(`/api/photos/${photo.id}/thumb`);
    expect(thumb.status).toBe(422);
    expect(thumb.body.placeholder).toBe(true);

    // the original stays downloadable regardless
    await agent.get(`/api/photos/${photo.id}/original`).expect(200);
  });

  it.skipIf(!fs.existsSync(REAL_HEIC))(
    'decodes a real HEIC thumbnail via the WASM fallback',
    { timeout: 120000 },
    async () => {
      const res = await agent
        .post('/api/upload')
        .field('childIds', JSON.stringify([childId]))
        .attach('files', REAL_HEIC)
        .expect(200);
      expect(res.body.results[0].outcome).toBe('added');
      const photo = res.body.results[0].photo;

      const thumb = await agent.get(`/api/photos/${photo.id}/thumb?size=256`).expect(200);
      expect(thumb.headers['content-type']).toContain('image/jpeg');
      expect(Number(thumb.headers['content-length'])).toBeGreaterThan(500);
    },
  );
});
