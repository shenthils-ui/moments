import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE, ServerHandle, ffmpegAvailable, makeJpeg, makeVideo } from './helpers';

/**
 * Timeline enhancements: the date-jump navigator, the photo/video filter,
 * and the "More" menu.
 */

let root: string;
let server: ServerHandle;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-e2e-enh-'));
  server = new ServerHandle(path.join(root, 'photos'), path.join(root, 'data'));
  await server.start();

  await fetch(`${BASE}/api/system/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ child: { name: 'Mila', birthDate: '2023-01-15', color: '#f472b6' } }),
  });
  const children = await (await fetch(`${BASE}/api/children`)).json();
  const childId = children[0].id;

  const upload = async (file: string) => {
    const form = new FormData();
    form.set('childIds', JSON.stringify([childId]));
    form.set('files', new Blob([fs.readFileSync(file)], { type: 'application/octet-stream' }), path.basename(file));
    const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`upload failed ${res.status}`);
  };

  // photos in two different months, plus a video in a third (if ffmpeg)
  const may = path.join(root, 'src', 'may.jpg');
  const feb = path.join(root, 'src', 'feb.jpg');
  await makeJpeg(may, '2023:05:10 10:00:00');
  await makeJpeg(feb, '2024:02:20 10:00:00');
  await upload(may);
  await upload(feb);
  if (ffmpegAvailable) {
    const vid = path.join(root, 'src', 'clip.webm');
    makeVideo(vid, 1, '2024-08-01T10:00:00.000000Z');
    await upload(vid);
  }
});

test.afterAll(async () => {
  await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

test('date-jump navigator jumps the timeline to a chosen month', async ({ page }) => {
  await page.goto(BASE);
  // newest first: Feb 2024 (or Aug 2024 video) is on top, May 2023 lower
  await expect(page.locator('[data-testid=month-group]').first()).toBeVisible();

  await page.getByTestId('date-jump-button').click();
  const panel = page.getByTestId('date-jump-panel');
  await expect(panel).toBeVisible();
  // expand the 2023 year, then jump to May 2023
  await panel.getByRole('button', { name: /2023/ }).click();
  await panel.getByTestId('date-jump-month').filter({ hasText: 'May' }).click();

  await expect(page.getByText('jumped to')).toBeVisible();
  // May 2023 is now the first group shown
  await expect(page.locator('[data-testid=month-group]').first()).toContainText('May 2023');

  await page.getByRole('button', { name: '↑ newest' }).click();
  await expect(page.getByText('jumped to')).toHaveCount(0);
});

test('the photo/video filter narrows the timeline', async ({ page }) => {
  test.skip(!ffmpegAvailable, 'needs a video fixture');
  await page.goto(BASE);
  const filter = page.getByTestId('kind-filter');

  await filter.getByRole('button', { name: 'Videos' }).click();
  await expect(page.locator('[data-testid=photo-tile]')).toHaveCount(1);
  await expect(page.locator('[data-testid=photo-tile]').first()).toContainText('▶');

  await filter.getByRole('button', { name: 'Photos' }).click();
  await expect(page.locator('[data-testid=photo-tile]')).toHaveCount(2);
});

test('the More menu links to the secondary screens', async ({ page }) => {
  await page.goto(`${BASE}/#/more`);
  await expect(page.getByRole('heading', { name: 'More' })).toBeVisible();
  await page.getByRole('link', { name: /Folders/ }).click();
  await expect(page.getByRole('heading', { name: 'Folders' })).toBeVisible();
});
