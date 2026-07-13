import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { BASE, ServerHandle, makeJpeg } from './helpers';

/**
 * Phase-one verification against the REAL built server (dist/), driving the
 * real browser. Tests run in order and share one library; the suite ends
 * with the recovery drill.
 */

const now = new Date();
const thisMonth = `${now.getFullYear()}:${String(now.getMonth() + 1).padStart(2, '0')}`;
const thisMonthDay5 = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-05`;

let root: string;
let server: ServerHandle;
const files = { a: '', b: '', dupA: '', c: '', importSrc: '' };
const externalRequests: string[] = [];
let requestCount = 0;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-e2e-'));
  files.a = path.join(root, 'src', 'a.jpg');
  files.b = path.join(root, 'src', 'b.jpg');
  files.dupA = path.join(root, 'src', 'a-duplicate.jpg');
  files.c = path.join(root, 'src', 'c.jpg');
  files.importSrc = path.join(root, 'import-src');
  await makeJpeg(files.a, '2023:05:20 10:00:00');
  await makeJpeg(files.b, '2022:10:10 09:00:00'); // before birth -> pregnancy
  fs.copyFileSync(files.a, files.dupA); // identical bytes, different name
  await makeJpeg(files.c, `${thisMonth}:05 12:00:00`);
  await makeJpeg(path.join(files.importSrc, 'd.jpg'), '2021:03:03 08:00:00');
  await makeJpeg(path.join(files.importSrc, 'nested', 'e.jpg'), '2021:04:04 08:00:00');
  fs.copyFileSync(files.a, path.join(files.importSrc, 'a-again.jpg'));

  server = new ServerHandle(path.join(root, 'photos'), path.join(root, 'data'));
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

// Every network request in every test is recorded; the last test asserts
// none ever left localhost (no CDN, no fonts, no analytics — nothing).
test.beforeEach(({ page }) => {
  page.on('request', (req) => {
    requestCount++;
    const url = req.url();
    if (!url.startsWith(BASE) && !/^(data|blob|about):/.test(url)) externalRequests.push(url);
  });
});

async function openFirstPhotoInMonth(page: Page, monthTitle: string) {
  const group = page.locator('[data-testid=month-group]', { hasText: monthTitle });
  await group.locator('[data-testid=photo-tile]').first().click();
  await expect(page.getByTestId('lightbox')).toBeVisible();
}

test('first-run wizard creates a child', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByText('Welcome to Moments')).toBeVisible();
  await expect(page.getByTestId('photos-root')).toContainText(server.photosRoot);

  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByRole('button', { name: 'Continue' }).click(); // no password
  await page.getByTestId('child-name').fill('Mila');
  await page.getByTestId('child-birthdate').fill('2023-01-15');
  await page.getByRole('button', { name: 'Finish & upload photos' }).click();
  await expect(page.getByRole('heading', { name: 'Upload' })).toBeVisible();
});

test('uploading two EXIF-dated JPEGs plus one exact duplicate yields two photos and one skip', async ({ page }) => {
  await page.goto(`${BASE}/#/upload`);
  await page.getByTestId('file-input').setInputFiles([files.a, files.b, files.dupA]);
  await expect(page.getByTestId('upload-item')).toHaveCount(3);
  await page.getByRole('button', { name: 'Upload 3 photos' }).click();
  await expect(page.getByText('✓ added')).toHaveCount(2);
  await expect(page.getByText('≡ duplicate')).toHaveCount(1);
});

test('timeline groups by month with computed ages, including a pregnancy label', async ({ page }) => {
  await page.goto(BASE);
  const may = page.locator('[data-testid=month-group]', { hasText: 'May 2023' });
  await expect(may).toBeVisible();
  await expect(may.getByTestId('age-label')).toHaveText('Mila, 4m');

  const oct = page.locator('[data-testid=month-group]', { hasText: 'October 2022' });
  await expect(oct).toBeVisible();
  await expect(oct.getByTestId('age-label')).toHaveText('Mila, pregnancy');
});

test('a caption edit survives a full server process restart', async ({ page }) => {
  await page.goto(BASE);
  await openFirstPhotoInMonth(page, 'May 2023');
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('caption-input').fill('Beach day');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: '✕ Close' }).click();

  await server.restart(); // kills the node process; nothing survives but disk

  await page.goto(BASE);
  await openFirstPhotoInMonth(page, 'May 2023');
  await expect(page.getByText('Beach day')).toBeVisible();
  await expect(page.getByTestId('photo-path')).toContainText('Mila/2023/2023-05/');
  await page.getByRole('button', { name: '✕ Close' }).click();
});

test('calendar shows per-day counts and opens a day', async ({ page }) => {
  // one photo in the current month so the default calendar view has data
  await page.goto(`${BASE}/#/upload`);
  await page.getByTestId('file-input').setInputFiles([files.c]);
  await page.getByRole('button', { name: 'Upload 1 photo' }).click();
  await expect(page.getByText('✓ added')).toHaveCount(1);

  await page.goto(`${BASE}/#/calendar`);
  const day5 = page.getByRole('button', { name: '5 1', exact: true });
  await expect(day5).toBeVisible();
  await day5.click();
  await expect(page.getByTestId('photo-tile')).toHaveCount(1);
});

test('milestones view lists milestone photos in age order', async ({ page }) => {
  await page.goto(BASE);
  await openFirstPhotoInMonth(page, 'May 2023');
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByPlaceholder('first steps').fill('first laugh');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: '✕ Close' }).click();

  await page.goto(`${BASE}/#/milestones`);
  const row = page.getByTestId('milestone-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('first laugh');
  await expect(row).toContainText('4m');
});

test('folders view browses the real on-disk tree', async ({ page }) => {
  await page.goto(`${BASE}/#/folders`);
  await page.getByTestId('folder-tile').filter({ hasText: 'Mila' }).click();
  await page.getByTestId('folder-tile').filter({ hasText: '2023' }).first().click();
  await page.getByTestId('folder-tile').filter({ hasText: '2023-05' }).click();
  await expect(page.locator('img')).toHaveCount(1);
});

test('deleting moves to trash; trash view renders and restores', async ({ page }) => {
  await page.goto(BASE);
  await openFirstPhotoInMonth(page, 'October 2022');
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Delete…' }).click();
  await page.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.getByTestId('lightbox')).toBeHidden();
  await expect(page.locator('[data-testid=month-group]', { hasText: 'October 2022' })).toHaveCount(0);

  // the original file is now in _trash on disk
  expect(fs.readdirSync(path.join(server.photosRoot, '_trash')).length).toBe(1);

  await page.goto(`${BASE}/#/trash`);
  const row = page.getByTestId('trash-row');
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Trash is empty')).toBeVisible();

  await page.goto(BASE);
  await expect(page.locator('[data-testid=month-group]', { hasText: 'October 2022' })).toBeVisible();
});

test('bulk import: dry-run preview, then import with progress', async ({ page }) => {
  await page.goto(`${BASE}/#/import`);
  await page.getByTestId('source-path').fill(files.importSrc);
  await page.getByRole('button', { name: 'Dry run' }).click();

  const scan = page.getByTestId('scan-result');
  await expect(scan).toBeVisible({ timeout: 15000 });
  await expect(scan).toContainText('3 images found');
  await expect(scan).toContainText('1 already in the library');
  // range spans every scanned file, including the duplicate (EXIF May 2023)
  await expect(scan).toContainText('Mar 3, 2021');
  await expect(scan).toContainText('May 20, 2023');

  await page.getByRole('button', { name: 'Import 2 photos' }).click();
  const result = page.getByTestId('import-result');
  await expect(result).toBeVisible({ timeout: 15000 });
  await expect(result).toContainText('2 imported, 1 duplicates skipped');

  await page.goto(BASE);
  await expect(page.locator('[data-testid=month-group]', { hasText: 'March 2021' })).toBeVisible();
  await expect(page.locator('[data-testid=month-group]', { hasText: 'April 2021' })).toBeVisible();
});

test('RECOVERY DRILL: delete DATA_DIR, restart, restore — everything comes back', async ({ page }) => {
  await server.stop();
  fs.rmSync(server.dataDir, { recursive: true, force: true }); // db, thumbs, all of it
  await server.start();

  await page.goto(BASE);
  await expect(page.getByText('An existing Moments library was found here: 5 photos, 1 child')).toBeVisible();
  await page.getByRole('button', { name: 'Restore this library' }).click();
  await expect(page.getByText('Library restored')).toBeVisible();
  await expect(page.getByText('5 photos and 1 child are back.')).toBeVisible();
  await page.getByRole('button', { name: 'Open Moments' }).click();

  // photos, captions, milestones and the child are all back
  await expect(page.locator('[data-testid=month-group]', { hasText: 'May 2023' })).toBeVisible();
  await expect(page.locator('[data-testid=month-group]', { hasText: 'October 2022' })).toBeVisible();
  await expect(page.locator('[data-testid=month-group]', { hasText: 'March 2021' })).toBeVisible();
  await openFirstPhotoInMonth(page, 'May 2023');
  const lightbox = page.getByTestId('lightbox');
  await expect(lightbox.getByText('Beach day')).toBeVisible();
  await expect(lightbox.getByText('★ first laugh')).toBeVisible();
  await page.getByRole('button', { name: '✕ Close' }).click();

  await page.goto(`${BASE}/#/settings`);
  await expect(page.getByText('Mila')).toBeVisible();
  await expect(page.getByText('born Jan 15, 2023')).toBeVisible();
});

test('ZERO requests ever left localhost across the entire suite', async () => {
  expect(requestCount).toBeGreaterThan(50); // sanity: we actually exercised the app
  expect(externalRequests).toEqual([]);
});
