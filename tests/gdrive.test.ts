import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GoogleDriveTarget } from '../server/backup/gdrive.js';
import { NotConnectedError } from '../server/backup/types.js';
import { DriveMock } from './driveMock.js';
import { completeSetup, makeEnv, makeJpeg, type TestEnv } from './helpers.js';

let mock: DriveMock;
let env: TestEnv;

beforeAll(async () => {
  mock = new DriveMock();
  await mock.start();
  Object.assign(process.env, mock.env(), { GOOGLE_CLIENT_ID: 'test-client-id' });
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  env = makeEnv();
  mock.files.clear();
  mock.validRefreshTokens = new Set(['rt-valid']);
  mock.revokeNextRefresh = false;
  mock.expireTokensAfterFirstUse = false;
});

afterEach(() => env.cleanup());

function makeTarget(id = crypto.randomUUID()): GoogleDriveTarget {
  return new GoogleDriveTarget(id, 'Drive', env.dataDir, {});
}

async function writeTempFile(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(env.root, 'tmp-src', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

describe('GoogleDriveTarget against a mock Drive server', () => {
  it('is disconnected without a refresh token and connects once one is set', async () => {
    const target = makeTarget();
    expect(await target.isConnected()).toBe(false);
    await expect(target.connect()).rejects.toThrow(NotConnectedError);

    target.setRefreshToken('rt-valid');
    await target.connect();
    expect(await target.isConnected()).toBe(true);
    // root folder was created exactly once, and the state file is private
    const folders = [...mock.files.values()].filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
    expect(folders.map((f) => f.name)).toEqual(['Moments Backup']);
    const stateFile = path.join(env.dataDir, 'backup', `gdrive-${target.id}.json`);
    expect((fs.statSync(stateFile).mode & 0o777).toString(8)).toBe('600');
  });

  it('uploads small files multipart with verified size + md5, and updates in place', async () => {
    const target = makeTarget();
    target.setRefreshToken('rt-valid');
    await target.connect();

    const bytes = Buffer.from('hello moments');
    const local = await writeTempFile('small.jpg', bytes);
    const result = await target.putFile('Mila/2023/2023-05/small.jpg', local, sha256(bytes));
    expect(result.sizeBytes).toBe(bytes.length);
    expect(result.checksumVerified).toBe(true);

    const uploaded = [...mock.files.values()].find((f) => f.name === 'small.jpg')!;
    expect(uploaded.content!.equals(bytes)).toBe(true);
    expect(uploaded.appProperties?.momentsHash).toBe(sha256(bytes));
    // folder chain Mila/2023/2023-05 exists under the root
    const folderNames = [...mock.files.values()].filter((f) => f.mimeType.includes('folder')).map((f) => f.name);
    expect(folderNames).toEqual(expect.arrayContaining(['Moments Backup', 'Mila', '2023', '2023-05']));

    // second put to the same relPath updates the SAME file (no duplicates)
    const bytes2 = Buffer.from('hello again');
    const local2 = await writeTempFile('small2.jpg', bytes2);
    await target.putFile('Mila/2023/2023-05/small.jpg', local2, sha256(bytes2));
    const named = [...mock.files.values()].filter((f) => f.name === 'small.jpg');
    expect(named).toHaveLength(1);
    expect(named[0].content!.equals(bytes2)).toBe(true);
  });

  it('uploads files above 5 MB via a resumable session in chunks', async () => {
    const target = makeTarget();
    target.setRefreshToken('rt-valid');
    await target.connect();

    const big = crypto.randomBytes(20 * 1024 * 1024); // 3 chunks at 8 MiB
    const local = await writeTempFile('big.jpg', big);
    const result = await target.putFile('Mila/big.jpg', local, sha256(big));
    expect(result.sizeBytes).toBe(big.length);
    expect(result.checksumVerified).toBe(true);
    const uploaded = [...mock.files.values()].find((f) => f.name === 'big.jpg')!;
    expect(uploaded.content!.equals(big)).toBe(true);
    expect(mock.resumableSessions.size).toBe(0); // session completed and cleaned up
  }, 30000);

  it('lists remote hashes across pages and computes stat()', async () => {
    const target = makeTarget();
    target.setRefreshToken('rt-valid');
    await target.connect();

    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const bytes = crypto.randomBytes(64);
      hashes.push(sha256(bytes));
      await target.putFile(`Mila/file-${i}.jpg`, await writeTempFile(`file-${i}.jpg`, bytes), sha256(bytes));
    }
    // mock pages at 2 items, so this exercises pagination
    const remote = await target.listRemoteHashes();
    for (const hash of hashes) expect(remote.has(hash)).toBe(true);

    const stat = await target.stat();
    expect(stat.fileCount).toBe(5);
    expect(stat.bytes).toBe(5 * 64);
  });

  it('deleteFile removes the remote file', async () => {
    const target = makeTarget();
    target.setRefreshToken('rt-valid');
    await target.connect();
    const bytes = Buffer.from('delete me');
    await target.putFile('Mila/x.jpg', await writeTempFile('x.jpg', bytes), sha256(bytes));
    expect([...mock.files.values()].some((f) => f.name === 'x.jpg')).toBe(true);
    await target.deleteFile('Mila/x.jpg');
    expect([...mock.files.values()].some((f) => f.name === 'x.jpg')).toBe(false);
  });

  it('recovers transparently from access-token expiry mid-flight', async () => {
    const target = makeTarget();
    target.setRefreshToken('rt-valid');
    await target.connect();
    mock.expireTokensAfterFirstUse = true; // every token dies after one use

    const bytes = Buffer.from('expiry survivor');
    await target.putFile('Mila/expiry.jpg', await writeTempFile('e.jpg', bytes), sha256(bytes));
    expect([...mock.files.values()].some((f) => f.name === 'expiry.jpg')).toBe(true);
    expect(mock.tokenRequests).toBeGreaterThan(1);
  });

  it('a revoked refresh token surfaces as a clear reconnect state', async () => {
    const target = makeTarget();
    target.setRefreshToken('rt-valid');
    await target.connect();

    mock.revokeNextRefresh = true;
    const fresh = new GoogleDriveTarget(target.id, 'Drive', env.dataDir, {}); // no cached access token
    await expect(fresh.connect()).rejects.toThrow(/revoked — reconnect/);
    expect(fresh.hasCredentials()).toBe(false); // credentials cleared: UI offers reconnect
  });

  it('mirrors the library end-to-end through the backup engine, second run uploads zero', async () => {
    const agent = request.agent(env.ctx.app);
    const childId = await completeSetup(agent);
    const photo = path.join(env.root, 'src', 'p.jpg');
    await makeJpeg(photo, '2023:03:03 10:00:00');
    await agent.post('/api/upload').field('childIds', JSON.stringify([childId])).attach('files', photo).expect(200);

    const created = await agent
      .post('/api/backup/targets')
      .send({ kind: 'gdrive', displayName: 'My Drive' })
      .expect(201);
    // simulate a completed OAuth consent for this target
    new GoogleDriveTarget(created.body.id, 'My Drive', env.dataDir, {}).setRefreshToken('rt-valid');

    const started = await agent.post(`/api/backup/targets/${created.body.id}/run`).expect(200);
    let run: any;
    for (let i = 0; i < 200; i++) {
      run = (await agent.get(`/api/backup/runs/${started.body.id}`).expect(200)).body;
      if (run.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(run.state).toBe('done');
    expect(run.uploaded).toBe(2); // photo + metadata.json
    expect(run.failed).toBe(0);
    const names = [...mock.files.values()].filter((f) => f.content).map((f) => f.name);
    expect(names).toContain('metadata.json');

    const second = await agent.post(`/api/backup/targets/${created.body.id}/run`).expect(200);
    let run2: any;
    for (let i = 0; i < 200; i++) {
      run2 = (await agent.get(`/api/backup/runs/${second.body.id}`).expect(200)).body;
      if (run2.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(run2.uploaded).toBe(0);
    expect(run2.skipped).toBe(2);
  });
});
