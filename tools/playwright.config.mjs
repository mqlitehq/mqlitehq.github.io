import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['demo.spec.mjs', 'navigation.spec.mjs'],
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node serve.mjs 4173',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
