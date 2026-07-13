#!/usr/bin/env node
/**
 * Full phase-one verification: type checks, build, API tests, and the
 * Playwright suite (wizard, upload+EXIF+dedupe, timeline ages, restart
 * persistence, all views, bulk import, the recovery drill, and the
 * zero-external-requests check). Run after every change.
 *
 *   node scripts/verify.mjs
 *
 * Set CHROMIUM_PATH to a Chromium binary to reuse a system-installed
 * browser instead of Playwright's own download.
 */
import { spawnSync } from 'node:child_process';

const steps = [
  ['type-check server', ['npx', 'tsc', '-p', 'tsconfig.server.json', '--noEmit']],
  ['type-check client + tests', ['npx', 'tsc', '-p', 'tsconfig.json', '--noEmit']],
  ['build', ['npm', 'run', 'build']],
  ['API tests (vitest + supertest)', ['npx', 'vitest', 'run']],
  ['end-to-end tests (Playwright)', ['npx', 'playwright', 'test']],
];

for (const [name, cmd] of steps) {
  console.log(`\n=== ${name} ===`);
  const res = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) {
    console.error(`\nFAILED at: ${name}`);
    process.exit(res.status ?? 1);
  }
}

console.log('\nAll phase-one verification passed.');
