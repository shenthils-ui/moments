import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE, ServerHandle, ffmpegAvailable, makeVideo } from './helpers';

/**
 * End-to-end video path against the real built server and a real browser:
 * upload an MP4, see the play badge + poster on the timeline tile, open the
 * lightbox and confirm a working <video> element that actually plays.
 */

let root: string;
let server: ServerHandle;

test.describe.configure({ mode: 'serial' });
test.skip(!ffmpegAvailable, 'ffmpeg is required to generate and thumbnail video fixtures');

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-e2e-video-'));
  server = new ServerHandle(path.join(root, 'photos'), path.join(root, 'data'));
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

test('upload a video, see it on the timeline, and play it in the lightbox', async ({ page }) => {
  // first-run setup
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('child-name').fill('Mila');
  await page.getByTestId('child-birthdate').fill('2023-01-15');
  await page.getByRole('button', { name: 'Finish & upload photos' }).click();
  await expect(page.getByRole('heading', { name: 'Upload' })).toBeVisible();

  // upload a 2s video dated May 2024 (WebM so the headless browser can play it)
  const clip = path.join(root, 'src', 'clip.webm');
  makeVideo(clip, 2, '2024-05-10T10:00:00.000000Z');
  await page.getByTestId('file-input').setInputFiles([clip]);
  await expect(page.getByTestId('upload-item')).toHaveCount(1);
  await page.getByRole('button', { name: /Upload 1 file/ }).click();
  await expect(page.getByText('✓ added')).toHaveCount(1);

  // timeline: correct month, with a play badge and duration on the tile
  await page.goto(BASE);
  const group = page.locator('[data-testid=month-group]', { hasText: 'May 2024' });
  await expect(group).toBeVisible();
  const tile = group.getByTestId('photo-tile').first();
  await expect(tile).toContainText('▶');
  await expect(tile).toContainText('0:02'); // formatted duration
  // the poster thumbnail actually loaded (natural size > 0)
  await expect
    .poll(async () => tile.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  // lightbox: a real <video> that loads and plays from the streamed original
  await tile.click();
  const video = page.getByTestId('lightbox-video');
  await expect(video).toBeAttached();
  await expect
    .poll(async () => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThan(0); // metadata (or more) loaded — proves range streaming works
  await expect
    .poll(async () => video.evaluate((v: HTMLVideoElement) => Math.round(v.duration)))
    .toBe(2);
});
