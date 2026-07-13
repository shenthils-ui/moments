import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeSetup, makeEnv, makeJpeg, type TestEnv } from './helpers.js';

let env: TestEnv;
let agent: request.Agent;
let childId: string;
let mirror: string;

beforeEach(async () => {
  env = makeEnv();
  agent = request.agent(env.ctx.app);
  childId = await completeSetup(agent);
  mirror = path.join(env.root, 'mirror');
});

afterEach(() => env.cleanup());

async function uploadPhoto(name: string, exifDate: string): Promise<string> {
  const file = path.join(env.root, 'src', name);
  await makeJpeg(file, exifDate);
  const res = await agent
    .post('/api/upload')
    .field('childIds', JSON.stringify([childId]))
    .attach('files', file)
    .expect(200);
  expect(res.body.results[0].outcome).toBe('added');
  return res.body.results[0].photo.id;
}

async function createTarget(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await agent
    .post('/api/backup/targets')
    .send({ kind: 'local', displayName: 'USB disk', config: { path: mirror }, ...extra })
    .expect(201);
  return res.body.id as string;
}

async function runAndWait(targetId: string) {
  const started = await agent.post(`/api/backup/targets/${targetId}/run`).expect(200);
  for (let i = 0; i < 200; i++) {
    const res = await agent.get(`/api/backup/runs/${started.body.id}`).expect(200);
    if (res.body.state !== 'running') return res.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not finish');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function relSet(dir: string): Set<string> {
  return new Set(walk(dir).map((f) => path.relative(dir, f).split(path.sep).join('/')));
}

describe('backup mirror (LocalFolderTarget)', () => {
  it('a full run mirrors the exact tree including _meta/metadata.json', async () => {
    await uploadPhoto('one.jpg', '2023:05:01 10:00:00');
    const two = await uploadPhoto('two.jpg', '2024:01:15 12:00:00');
    await agent.patch(`/api/photos/${two}`).send({ caption: 'mirrored caption', milestone: 'first word' });
    const targetId = await createTarget();

    const run = await runAndWait(targetId);
    expect(run.state).toBe('done');
    expect(run.uploaded).toBe(3); // two photos + metadata.json
    expect(run.failed).toBe(0);

    // exact same tree: every active photo byte-identical, plus the snapshot
    const localPhotos = relSet(env.photosRoot);
    localPhotos.delete('_meta/metadata.json'); // compared separately below
    const remote = relSet(mirror);
    for (const rel of localPhotos) {
      expect(remote.has(rel), `missing at mirror: ${rel}`).toBe(true);
      expect(fs.readFileSync(path.join(mirror, rel))).toEqual(fs.readFileSync(path.join(env.photosRoot, rel)));
    }
    const meta = JSON.parse(fs.readFileSync(path.join(mirror, '_meta/metadata.json'), 'utf8'));
    expect(meta.photos).toHaveLength(2);
    expect(meta.photos.find((p: any) => p.id === two).caption).toBe('mirrored caption');
    expect(meta.children[0].name).toBe('Mila');
  });

  it('a second run uploads ZERO files', async () => {
    await uploadPhoto('one.jpg', '2023:05:01 10:00:00');
    const targetId = await createTarget();
    await runAndWait(targetId);

    const second = await runAndWait(targetId);
    expect(second.state).toBe('done');
    expect(second.uploaded).toBe(0);
    expect(second.skipped).toBe(2); // photo + unchanged metadata.json
  });

  it('adding one photo then re-running uploads exactly one file (plus the changed snapshot)', async () => {
    await uploadPhoto('one.jpg', '2023:05:01 10:00:00');
    const targetId = await createTarget();
    await runAndWait(targetId);

    await uploadPhoto('two.jpg', '2024:02:02 09:00:00');
    const run = await runAndWait(targetId);
    expect(run.state).toBe('done');
    // metadata.json changed too (it now lists the new photo)
    expect(run.uploaded).toBe(2);
    expect(run.skipped).toBe(1);

    const photoFiles = walk(mirror).filter((f) => f.endsWith('.jpg'));
    expect(photoFiles).toHaveLength(2);
  });

  it('deleting a photo locally does NOT delete it at the target by default', async () => {
    const id = await uploadPhoto('keepme.jpg', '2023:06:06 10:00:00');
    const targetId = await createTarget();
    await runAndWait(targetId);
    const before = walk(mirror).filter((f) => f.endsWith('.jpg'));
    expect(before).toHaveLength(1);

    await agent.delete(`/api/photos/${id}`).expect(200); // to trash
    const run = await runAndWait(targetId);
    expect(run.state).toBe('done');
    expect(run.deleted).toBe(0);
    expect(walk(mirror).filter((f) => f.endsWith('.jpg'))).toHaveLength(1);

    // even a permanent purge does not delete at the target while
    // mirror-deletions is off
    await agent.delete(`/api/trash/${id}`).expect(200);
    const run2 = await runAndWait(targetId);
    expect(run2.deleted).toBe(0);
    expect(walk(mirror).filter((f) => f.endsWith('.jpg'))).toHaveLength(1);
  });

  it('mirror-deletions only removes files whose photo was purged from trash, never trashed ones', async () => {
    const trashed = await uploadPhoto('trashme.jpg', '2023:07:07 10:00:00');
    const purged = await uploadPhoto('purgeme.jpg', '2023:08:08 10:00:00');
    const targetId = await createTarget({ mirrorDeletions: true });
    await runAndWait(targetId);
    expect(walk(mirror).filter((f) => f.endsWith('.jpg'))).toHaveLength(2);

    await agent.delete(`/api/photos/${trashed}`).expect(200); // in trash: retained
    await agent.delete(`/api/photos/${purged}`).expect(200);
    await agent.delete(`/api/trash/${purged}`).expect(200); // purged: eligible

    const run = await runAndWait(targetId);
    expect(run.state).toBe('done');
    expect(run.deleted).toBe(1);
    expect(walk(mirror).filter((f) => f.endsWith('.jpg'))).toHaveLength(1);
  });

  it('verify reports drift when a mirrored file is corrupted', async () => {
    await uploadPhoto('one.jpg', '2023:05:01 10:00:00');
    await uploadPhoto('two.jpg', '2023:05:02 10:00:00');
    const targetId = await createTarget();
    await runAndWait(targetId);

    const clean = await agent.post(`/api/backup/targets/${targetId}/verify`).send({ sampleRate: 1 }).expect(200);
    expect(clean.body.sampled).toBe(3);
    expect(clean.body.ok).toBe(3);
    expect(clean.body.missing).toEqual([]);

    const victim = walk(mirror).find((f) => f.endsWith('.jpg'))!;
    fs.writeFileSync(victim, 'silently corrupted');
    const drift = await agent.post(`/api/backup/targets/${targetId}/verify`).send({ sampleRate: 1 }).expect(200);
    expect(drift.body.missing).toHaveLength(1);

    // the next run heals the mirror: the corrupted file hash is absent, so
    // the original is uploaded again
    const heal = await runAndWait(targetId);
    expect(heal.uploaded).toBeGreaterThanOrEqual(1);
    const healed = await agent.post(`/api/backup/targets/${targetId}/verify`).send({ sampleRate: 1 }).expect(200);
    expect(healed.body.missing).toEqual([]);
  });

  it('an unusable target fails the run with a clear error instead of hanging', async () => {
    await uploadPhoto('one.jpg', '2023:05:01 10:00:00');
    const file = path.join(env.root, 'not-a-folder');
    fs.writeFileSync(file, 'occupied');
    const res = await agent
      .post('/api/backup/targets')
      .send({ kind: 'local', displayName: 'broken', config: { path: file } })
      .expect(201);
    const run = await runAndWait(res.body.id);
    expect(run.state).toBe('error');
    expect(run.error).toBeTruthy();
  });

  it('target CRUD: schedule and mirrorDeletions round-trip; deleting the target keeps mirror data', async () => {
    await uploadPhoto('one.jpg', '2023:05:01 10:00:00');
    const targetId = await createTarget();
    const patched = await agent
      .patch(`/api/backup/targets/${targetId}`)
      .send({ schedule: { mode: 'daily', at: '03:30' }, mirrorDeletions: true, displayName: 'NAS share' })
      .expect(200);
    expect(patched.body.schedule).toEqual({ mode: 'daily', at: '03:30' });
    expect(patched.body.mirrorDeletions).toBe(true);
    expect(patched.body.displayName).toBe('NAS share');

    await runAndWait(targetId);
    const mirrored = walk(mirror).length;
    expect(mirrored).toBeGreaterThan(0);
    await agent.delete(`/api/backup/targets/${targetId}`).expect(200);
    expect((await agent.get('/api/backup/targets').expect(200)).body).toHaveLength(0);
    expect(walk(mirror)).toHaveLength(mirrored); // mirror untouched
  });
});
