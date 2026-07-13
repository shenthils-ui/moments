import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    // The suite manages its own server process (it needs to kill and
    // restart it for the persistence and recovery drills).
    baseURL: 'http://localhost:3210',
    // Use a system-provided Chromium when the environment points at one
    // (e.g. CI images with a preinstalled browser at a fixed path).
    ...(process.env.CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } } : {}),
  },
});
