import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { purgeExpiredSessions } from '../server/auth.js';
import { writeSnapshotNow } from '../server/metadata.js';
import { completeSetup, makeEnv, makeJpeg, type TestEnv } from './helpers.js';

let env: TestEnv;
let agent: request.Agent;
let childId: string;

beforeEach(async () => {
  env = makeEnv();
  agent = request.agent(env.ctx.app);
  childId = await completeSetup(agent);
});

afterEach(() => env.cleanup());

async function uploadFile(file: string, opts: { lastModified?: number } = {}) {
  const req = agent
    .post('/api/upload')
    .field('childIds', JSON.stringify([childId]))
    .attach('files', file);
  if (opts.lastModified) {
    req.field('lastModified', JSON.stringify({ [path.basename(file)]: opts.lastModified }));
  }
  return req.expect(200);
}

describe('upload pipeline', () => {
  it('extracts the EXIF DateTimeOriginal and files the photo under child/year/month', async () => {
    const file = path.join(env.root, 'src', 'beach.jpg');
    await makeJpeg(file, '2023:05:01 10:30:00');
    const res = await uploadFile(file);
    expect(res.body.results).toHaveLength(1);
    const photo = res.body.results[0].photo;
    expect(res.body.results[0].outcome).toBe('added');
    expect(photo.takenAtSource).toBe('exif');
    expect(photo.takenAt.startsWith('2023-05-01T10:30:00')).toBe(true);
    expect(photo.relPath).toMatch(/^Mila\/2023\/2023-05\/2023-05-01_\d{6}_[0-9a-f]{8}\.jpg$/);
    expect(fs.existsSync(path.join(env.photosRoot, photo.relPath))).toBe(true);
    // original is byte-identical: never recompressed
    expect(fs.readFileSync(path.join(env.photosRoot, photo.relPath))).toEqual(fs.readFileSync(file));
  });

  it('falls back to the provided file mtime when EXIF is absent', async () => {
    const file = path.join(env.root, 'src', 'noexif.jpg');
    await makeJpeg(file);
    const mtime = new Date('2021-11-20T08:00:00Z').getTime();
    const res = await uploadFile(file, { lastModified: mtime });
    const photo = res.body.results[0].photo;
    expect(photo.takenAtSource).toBe('file');
    expect(photo.takenAt).toBe('2021-11-20T08:00:00.000Z');
    expect(photo.relPath).toContain('/2021/2021-11/');
  });

  it('skips exact duplicates by content hash and reports them', async () => {
    const file = path.join(env.root, 'src', 'dup.jpg');
    await makeJpeg(file, '2023:06:10 12:00:00');
    const first = await uploadFile(file);
    expect(first.body.results[0].outcome).toBe('added');
    const second = await uploadFile(file);
    expect(second.body.results[0].outcome).toBe('duplicate');
    expect(second.body.results[0].existingId).toBe(first.body.results[0].photo.id);
    const list = await agent.get('/api/photos').expect(200);
    expect(list.body.total).toBe(1);
  });

  it('rejects uploads without a valid child', async () => {
    const file = path.join(env.root, 'src', 'x.jpg');
    await makeJpeg(file);
    await agent
      .post('/api/upload')
      .field('childIds', JSON.stringify([]))
      .attach('files', file)
      .expect(400);
  });
});

describe('photo metadata', () => {
  it('updates caption, tags, milestone and manual date', async () => {
    const file = path.join(env.root, 'src', 'meta.jpg');
    await makeJpeg(file, '2023:07:01 09:00:00');
    const uploaded = await uploadFile(file);
    const id = uploaded.body.results[0].photo.id;
    const res = await agent
      .patch(`/api/photos/${id}`)
      .send({ caption: 'First steps!', tags: ['walking', 'park'], milestone: 'first steps', takenAt: '2023-07-02T10:00:00Z' })
      .expect(200);
    expect(res.body.caption).toBe('First steps!');
    expect(res.body.tags).toEqual(['walking', 'park']);
    expect(res.body.milestone).toBe('first steps');
    expect(res.body.takenAt).toBe('2023-07-02T10:00:00.000Z');
    expect(res.body.takenAtSource).toBe('manual');
    // manual date edits never move the file on disk
    expect(fs.existsSync(path.join(env.photosRoot, res.body.relPath))).toBe(true);
    expect(res.body.relPath).toContain('/2023-07-01_');
  });

  it('filters photos by tag and milestone', async () => {
    const a = path.join(env.root, 'src', 'a.jpg');
    const b = path.join(env.root, 'src', 'b.jpg');
    await makeJpeg(a, '2023:01:20 08:00:00');
    await makeJpeg(b, '2023:02:20 08:00:00');
    const ra = await uploadFile(a);
    await uploadFile(b);
    await agent.patch(`/api/photos/${ra.body.results[0].photo.id}`).send({ tags: ['beach'], milestone: 'first swim' });
    const byTag = await agent.get('/api/photos?tag=beach').expect(200);
    expect(byTag.body.total).toBe(1);
    const byMilestone = await agent.get('/api/photos?milestone=*').expect(200);
    expect(byMilestone.body.total).toBe(1);
  });
});

describe('trash', () => {
  it('moves deleted originals to _trash and restores them', async () => {
    const file = path.join(env.root, 'src', 'trashme.jpg');
    await makeJpeg(file, '2023:03:03 15:00:00');
    const uploaded = await uploadFile(file);
    const photo = uploaded.body.results[0].photo;

    await agent.delete(`/api/photos/${photo.id}`).expect(200);
    expect(fs.existsSync(path.join(env.photosRoot, photo.relPath))).toBe(false);
    expect(fs.existsSync(path.join(env.photosRoot, '_trash', photo.filename))).toBe(true);

    const trash = await agent.get('/api/trash').expect(200);
    expect(trash.body).toHaveLength(1);

    const restored = await agent.post(`/api/trash/${photo.id}/restore`).expect(200);
    expect(restored.body.status).toBe('active');
    expect(fs.existsSync(path.join(env.photosRoot, restored.body.relPath))).toBe(true);
    expect(fs.existsSync(path.join(env.photosRoot, '_trash', photo.filename))).toBe(false);
    const list = await agent.get('/api/photos').expect(200);
    expect(list.body.total).toBe(1);
  });
});

describe('bulk import', () => {
  async function waitForJob(id: string) {
    for (let i = 0; i < 100; i++) {
      const res = await agent.get(`/api/import/jobs/${id}`).expect(200);
      if (res.body.state !== 'running') return res.body;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('job did not finish');
  }

  it('dry-run reports counts, date range and duplicates; real run imports', async () => {
    const source = path.join(env.root, 'old-export');
    await makeJpeg(path.join(source, 'a.jpg'), '2020:01:05 10:00:00');
    await makeJpeg(path.join(source, 'nested', 'b.jpg'), '2022:09:15 18:30:00');
    // duplicate of a.jpg (identical bytes)
    fs.copyFileSync(path.join(source, 'a.jpg'), path.join(source, 'nested', 'a-copy.jpg'));

    const scan = await agent.post('/api/import/scan').send({ sourcePath: source }).expect(200);
    const scanResult = await waitForJob(scan.body.id);
    expect(scanResult.total).toBe(3);
    expect(scanResult.duplicates).toBe(1);
    expect(scanResult.earliest.startsWith('2020-01-05')).toBe(true);
    expect(scanResult.latest.startsWith('2022-09-15')).toBe(true);

    const run = await agent
      .post('/api/import/run')
      .send({ sourcePath: source, childIds: [childId], mode: 'copy' })
      .expect(200);
    const runResult = await waitForJob(run.body.id);
    expect(runResult.added).toBe(2);
    expect(runResult.duplicates).toBe(1);
    // copy mode leaves the source untouched
    expect(fs.existsSync(path.join(source, 'a.jpg'))).toBe(true);

    const list = await agent.get('/api/photos').expect(200);
    expect(list.body.total).toBe(2);
  });
});

describe('export / import round-trip', () => {
  it('round-trips metadata losslessly through export then replace-all import', async () => {
    const file = path.join(env.root, 'src', 'rt.jpg');
    await makeJpeg(file, '2023:04:04 11:00:00');
    const uploaded = await uploadFile(file);
    await agent
      .patch(`/api/photos/${uploaded.body.results[0].photo.id}`)
      .send({ caption: 'round trip', tags: ['x'], milestone: 'sitting' });

    const exported = (await agent.get('/api/export/metadata').expect(200)).body;

    // preview (no confirm) must not change anything
    const preview = await agent.post('/api/export/import').send({ snapshot: exported }).expect(200);
    expect(preview.body.preview).toBe(true);

    // wipe metadata by importing an empty snapshot, then restore from export
    await agent
      .post('/api/export/import')
      .send({ snapshot: { ...exported, children: [], photos: [] }, confirm: true })
      .expect(200);
    expect((await agent.get('/api/photos').expect(200)).body.total).toBe(0);

    await agent.post('/api/export/import').send({ snapshot: exported, confirm: true }).expect(200);
    const reExported = (await agent.get('/api/export/metadata').expect(200)).body;
    expect(reExported.children).toEqual(exported.children);
    expect(reExported.photos).toEqual(exported.photos);
    const photos = (await agent.get('/api/photos').expect(200)).body.photos;
    expect(photos[0].caption).toBe('round trip');
    expect(photos[0].milestone).toBe('sitting');
  });
});

describe('metadata snapshot + restore (NAS migration path)', () => {
  it('a fresh install pointed at an existing PHOTOS_ROOT restores everything', async () => {
    const file = path.join(env.root, 'src', 'snap.jpg');
    await makeJpeg(file, '2023:08:08 08:00:00');
    const uploaded = await uploadFile(file);
    await agent.patch(`/api/photos/${uploaded.body.results[0].photo.id}`).send({ caption: 'keep me' });
    writeSnapshotNow(env.ctx.db, env.photosRoot);

    // simulate: same PHOTOS_ROOT, brand new DATA_DIR (fresh install)
    env.ctx.close();
    fs.rmSync(env.dataDir, { recursive: true, force: true });
    const { createApp } = await import('../server/app.js');
    env.ctx = createApp({ photosRoot: env.photosRoot, dataDir: env.dataDir, port: 0 });
    const fresh = request.agent(env.ctx.app);

    const status = await fresh.get('/api/system/status').expect(200);
    expect(status.body.needsSetup).toBe(true);
    expect(status.body.restoreAvailable).toBe(true);
    expect(status.body.restorePreview.photos).toBe(1);

    const restore = await fresh.post('/api/system/restore').expect(200);
    expect(restore.body.photos).toBe(1);
    expect(restore.body.missingFiles).toEqual([]);

    const photos = (await fresh.get('/api/photos').expect(200)).body.photos;
    expect(photos[0].caption).toBe('keep me');
    const children = (await fresh.get('/api/children').expect(200)).body;
    expect(children[0].name).toBe('Mila');
  });

  it('rebuild-index reconstructs the photo list from folders alone', async () => {
    const file = path.join(env.root, 'src', 'rb.jpg');
    await makeJpeg(file, '2023:09:09 09:00:00');
    await uploadFile(file);

    // lose the database AND metadata.json: worst case
    env.ctx.close();
    fs.rmSync(env.dataDir, { recursive: true, force: true });
    fs.rmSync(path.join(env.photosRoot, '_meta'), { recursive: true, force: true });
    const { createApp } = await import('../server/app.js');
    env.ctx = createApp({ photosRoot: env.photosRoot, dataDir: env.dataDir, port: 0 });
    const fresh = request.agent(env.ctx.app);

    const rebuilt = await fresh.post('/api/system/rebuild').expect(200);
    expect(rebuilt.body.added).toBe(1);
    expect(rebuilt.body.childrenCreated).toEqual(['Mila']);
    const photos = (await fresh.get('/api/photos').expect(200)).body.photos;
    expect(photos).toHaveLength(1);
    expect(photos[0].takenAt.startsWith('2023-09-09')).toBe(true);
  });
});

describe('auth', () => {
  it('everything is open with auth off, and locked including images with auth on', async () => {
    const file = path.join(env.root, 'src', 'auth.jpg');
    await makeJpeg(file, '2023:10:10 10:00:00');
    const uploaded = await uploadFile(file);
    const photoId = uploaded.body.results[0].photo.id;

    // auth off: an unauthenticated client can read
    const anon = request.agent(env.ctx.app);
    await anon.get('/api/photos').expect(200);
    await anon.get(`/api/photos/${photoId}/thumb`).expect(200);

    // enable the family password
    await agent.post('/api/auth/password').send({ password: 'hunter2' }).expect(200);

    const locked = request.agent(env.ctx.app);
    await locked.get('/api/photos').expect(401);
    await locked.get(`/api/photos/${photoId}/thumb`).expect(401);
    await locked.get(`/api/photos/${photoId}/original`).expect(401);
    // status stays reachable so the login screen can render
    await locked.get('/api/system/status').expect(200);

    await locked.post('/api/auth/login').send({ password: 'nope' }).expect(401);
    await locked.post('/api/auth/login').send({ password: 'hunter2' }).expect(200);
    await locked.get('/api/photos').expect(200);
    await locked.get(`/api/photos/${photoId}/original`).expect(200);

    await locked.post('/api/auth/logout').expect(200);
    await locked.get('/api/photos').expect(401);

    // disable the password again (needs the current one)
    await agent.post('/api/auth/password').send({ password: null, currentPassword: 'hunter2' }).expect(200);
    await request.agent(env.ctx.app).get('/api/photos').expect(200);
  });

  it('expires stale sessions instead of honouring them forever', async () => {
    await agent.post('/api/auth/password').send({ password: 'hunter2' }).expect(200);
    const client = request.agent(env.ctx.app);
    await client.post('/api/auth/login').send({ password: 'hunter2' }).expect(200);
    await client.get('/api/photos').expect(200);

    // age every session past the TTL, as if 61 days passed
    const old = new Date(Date.now() - 61 * 24 * 3600 * 1000).toISOString();
    env.ctx.db.prepare('UPDATE sessions SET createdAt = ?').run(old);

    await client.get('/api/photos').expect(401); // stale token rejected on use
    await client.post('/api/auth/login').send({ password: 'hunter2' }).expect(200); // fresh login works again
    // the daily bulk purge clears every remaining expired token
    const swept = purgeExpiredSessions(env.ctx.db);
    expect(swept).toBeGreaterThan(0);
    const stale = env.ctx.db
      .prepare('SELECT COUNT(*) AS c FROM sessions WHERE createdAt < ?')
      .get(new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString()) as { c: number };
    expect(stale.c).toBe(0);
  });
});

describe('misc', () => {
  it('serves calendar day counts and disk info', async () => {
    const file = path.join(env.root, 'src', 'cal.jpg');
    await makeJpeg(file, '2023:12:24 18:00:00');
    await uploadFile(file);
    const cal = await agent.get('/api/calendar?year=2023&month=12').expect(200);
    expect(cal.body.days['2023-12-24']).toBe(1);
    const disk = await agent.get('/api/system/disk').expect(200);
    expect(disk.body.photoCount).toBe(1);
    expect(disk.body.libraryBytes).toBeGreaterThan(0);
  });

  it('streams a zip export of originals', async () => {
    const file = path.join(env.root, 'src', 'zip.jpg');
    await makeJpeg(file, '2023:02:02 02:00:00');
    await uploadFile(file);
    const res = await agent.get('/api/export/zip').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
  });

  it('browses the real folder tree', async () => {
    const file = path.join(env.root, 'src', 'fold.jpg');
    await makeJpeg(file, '2023:11:11 11:00:00');
    await uploadFile(file);
    const root = await agent.get('/api/folders').expect(200);
    expect(root.body.dirs).toEqual(['Mila']);
    const month = await agent.get('/api/folders?path=Mila/2023/2023-11').expect(200);
    expect(month.body.files).toHaveLength(1);
    expect(month.body.files[0].photo).not.toBeNull();
  });

  it('folder filter matches names with LIKE metacharacters literally', async () => {
    // two children whose folder names differ only by an underscore vs. any
    // char: a naive LIKE would let one match the other.
    const under = (await agent.post('/api/children').send({ name: '100_days', birthDate: '2023-01-01' }).expect(201))
      .body.id;
    const other = (await agent.post('/api/children').send({ name: '100Xdays', birthDate: '2023-01-01' }).expect(201))
      .body.id;
    const a = path.join(env.root, 'src', 'under.jpg');
    const b = path.join(env.root, 'src', 'other.jpg');
    await makeJpeg(a, '2023:05:05 10:00:00');
    await makeJpeg(b, '2023:05:05 11:00:00');
    await agent.post('/api/upload').field('childIds', JSON.stringify([under])).attach('files', a).expect(200);
    await agent.post('/api/upload').field('childIds', JSON.stringify([other])).attach('files', b).expect(200);

    const res = await agent.get('/api/photos?folder=100_days').expect(200);
    expect(res.body.total).toBe(1); // only the literal "100_days" folder, not "100Xdays"
    expect(res.body.photos[0].relPath.startsWith('100_days/')).toBe(true);
  });
});
