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

test('the fixed date rail jumps the timeline to a chosen month', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); // desktop: rail is visible
  await page.goto(BASE);
  await expect(page.locator('[data-testid=month-group]').first()).toBeVisible();

  const rail = page.getByTestId('date-rail');
  await expect(rail).toBeVisible(); // always visible, not a dropdown
  // expand 2023 in the rail, then jump to May 2023
  await rail.getByRole('button', { name: /2023/ }).click();
  await rail.getByTestId('rail-month').filter({ hasText: 'May' }).click();

  await expect(page.getByText('jumped to')).toBeVisible();
  await expect(page.locator('[data-testid=month-group]').first()).toContainText('May 2023');

  await rail.getByRole('button', { name: /Today/ }).click();
  await expect(page.getByText('jumped to')).toHaveCount(0);
});

test('multi-select sets a new date on several photos at once', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  // select the whole Feb 2024 group and re-date to July 2020
  const feb = page.locator('[data-testid=month-group]', { hasText: 'February 2024' });
  await feb.getByRole('button', { name: 'select month' }).click();
  const bar = page.getByTestId('bulk-bar');
  await expect(bar).toContainText('1 selected');
  await bar.locator('input[type=date]').fill('2020-07-15');
  await bar.getByRole('button', { name: 'Apply' }).click();

  await expect(page.locator('[data-testid=month-group]', { hasText: 'February 2024' })).toHaveCount(0);
  await expect(page.locator('[data-testid=month-group]', { hasText: 'July 2020' })).toBeVisible();
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

test('favorite a photo, then filter to favorites; search by caption', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(BASE);
  // open the first photo and favorite it, adding a caption via edit
  await page.locator('[data-testid=photo-tile]').first().click();
  await page.getByTestId('favorite-toggle').click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('caption-input').fill('sunset at the lake');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: '✕ Close' }).click();

  // favorites filter shows exactly the one we starred
  await page.getByTestId('fav-toggle').click();
  await expect(page.locator('[data-testid=photo-tile]')).toHaveCount(1);
  await page.getByTestId('fav-toggle').click(); // off again

  // search matches the caption
  await page.getByTestId('search-input').fill('sunset');
  await expect(page.locator('[data-testid=photo-tile]')).toHaveCount(1);
  await page.getByTestId('search-input').fill('nomatchxyz');
  await expect(page.locator('[data-testid=photo-tile]')).toHaveCount(0);
});

test('the Settings nav item opens Settings, which links to the other tools', async ({ page }) => {
  await page.goto(BASE);
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  // Settings is the hub: it links out to folders, trash, import, backup
  await page.getByRole('link', { name: 'Browse folders on disk' }).click();
  await expect(page.getByRole('heading', { name: 'Folders' })).toBeVisible();
});
