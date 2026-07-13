import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE, ServerHandle, makeJpeg } from './helpers';

/**
 * Phase-two verification against the REAL server process and a
 * LocalFolderTarget: interruption/resume with a hard kill, and the full
 * disaster drill (lose everything local, restore from the mirror alone).
 */

const PHOTO_COUNT = 30;

let root: string;
let server: ServerHandle;
let mirror: string;
let targetId: string;

test.describe.configure({ mode: 'serial' });

async function api(pathname: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) throw new Error(`${pathname}: ${res.status} ${await res.text()}`);
  return res.json();
}

function mirrorJpegs(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jpg')) out.push(full);
    }
  };
  if (fs.existsSync(mirror)) walk(mirror);
  return out;
}

test.beforeAll(async () => {
  test.setTimeout(180000);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-e2e-backup-'));
  mirror = path.join(root, 'mirror');
  // slow each backup file op so the kill lands mid-run
  server = new ServerHandle(path.join(root, 'photos'), path.join(root, 'data'), {
    BACKUP_FILE_DELAY_MS: '150',
  });
  await server.start();

  // library: one child, PHOTO_COUNT photos with EXIF dates, a caption + milestone
  await api('/api/system/setup', {
    method: 'POST',
    body: JSON.stringify({ child: { name: 'Mila', birthDate: '2023-01-15', color: '#f472b6' } }),
  });
  const children = await api('/api/children');
  for (let i = 0; i < PHOTO_COUNT; i++) {
    const file = path.join(root, 'src', `photo-${i}.jpg`);
    await makeJpeg(file, `2024:03:${String((i % 27) + 1).padStart(2, '0')} 10:00:00`);
    const form = new FormData();
    form.set('childIds', JSON.stringify([children[0].id]));
    form.set('files', new Blob([fs.readFileSync(file)], { type: 'image/jpeg' }), `photo-${i}.jpg`);
    const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  }
  const photos = await api('/api/photos?pageSize=500');
  await api(`/api/photos/${photos.photos[0].id}`, {
    method: 'PATCH',
    body: JSON.stringify({ caption: 'survives the disaster', milestone: 'first backup' }),
  });
});

test.afterAll(async () => {
  await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a backup target is added and a run started from the Backup screen', async ({ page }) => {
  await page.goto(`${BASE}/#/backup`);
  await expect(page.getByText('No backup targets yet')).toBeVisible();
  await page.getByRole('button', { name: '💽 Local folder / USB / NAS share' }).click();
  await page.getByTestId('backup-path').fill(mirror);
  await page.getByRole('button', { name: 'Add folder target' }).click();
  await expect(page.getByText('connected')).toBeVisible();

  const targets = await api('/api/backup/targets');
  targetId = targets[0].id;

  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByTestId('backup-progress')).toBeVisible();
});

test('a run interrupted by a hard process kill resumes after restart and completes', async ({ page }) => {
  test.setTimeout(180000);
  // wait until the run is genuinely mid-way, then pull the plug
  await expect
    .poll(async () => (await api(`/api/backup/targets`))[0].activeRun?.uploaded ?? 0, { timeout: 60000 })
    .toBeGreaterThan(3);
  await server.kill(); // SIGKILL: no flush, no cleanup — like a power cut

  const uploadedBefore = mirrorJpegs().length;
  expect(uploadedBefore).toBeGreaterThan(0);
  expect(uploadedBefore).toBeLessThan(PHOTO_COUNT);

  await server.start(); // boot marks the run interrupted and resumes it

  await expect
    .poll(
      async () => {
        const target = (await api('/api/backup/targets'))[0];
        return !target.activeRun && target.lastRun?.state === 'done' ? mirrorJpegs().length : -1;
      },
      { timeout: 120000 },
    )
    .toBe(PHOTO_COUNT);

  // the interruption is visible in history, and the mirror is complete
  const runs = await api(`/api/backup/targets/${targetId}/runs`);
  expect(runs.some((r: any) => r.state === 'interrupted')).toBe(true);
  expect(fs.existsSync(path.join(mirror, '_meta', 'metadata.json'))).toBe(true);

  await page.goto(`${BASE}/#/backup`);
  await expect(page.getByTestId('last-run')).toContainText('done');
});

test('verify reports no drift on the healthy mirror', async ({ page }) => {
  await page.goto(`${BASE}/#/backup`);
  await page.getByRole('button', { name: /Verify backup/ }).click();
  await expect(page.getByTestId('verify-result')).toContainText('no drift', { timeout: 30000 });
});

test('DISASTER DRILL: local disk lost entirely; the mirror alone restores everything', async ({ page }) => {
  test.setTimeout(180000);
  await server.stop();

  // total local loss: photos AND app data are gone
  fs.rmSync(server.photosRoot, { recursive: true, force: true });
  fs.rmSync(server.dataDir, { recursive: true, force: true });

  // "download the folder from the backup and point a fresh install at it"
  fs.cpSync(mirror, server.photosRoot, { recursive: true });
  await server.start();

  await page.goto(BASE);
  await expect(page.getByText(`An existing Moments library was found here: ${PHOTO_COUNT} photos, 1 child`)).toBeVisible();
  await page.getByRole('button', { name: 'Restore this library' }).click();
  await expect(page.getByText('Library restored')).toBeVisible();
  await expect(page.getByText(`${PHOTO_COUNT} photos and 1 child are back.`)).toBeVisible();
  // every referenced file must actually exist in the restored tree
  await expect(page.getByText(/files referenced in the metadata were not found/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Moments' }).click();

  // photos, caption, milestone and child all came back from the mirror alone
  const photos = await api('/api/photos?pageSize=500');
  expect(photos.total).toBe(PHOTO_COUNT);
  const captioned = photos.photos.find((p: any) => p.caption === 'survives the disaster');
  expect(captioned).toBeTruthy();
  expect(captioned.milestone).toBe('first backup');
  const children = await api('/api/children');
  expect(children).toHaveLength(1);
  expect(children[0].name).toBe('Mila');
  expect(children[0].birthDate).toBe('2023-01-15');

  await expect(page.locator('[data-testid=month-group]', { hasText: 'March 2024' })).toBeVisible();
  await expect(page.getByTestId('photo-tile').first()).toBeVisible();
});
