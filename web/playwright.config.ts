import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

const chrome = ['/usr/local/bin/google-chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8799',
    viewport: { width: 1600, height: 1000 },
    launchOptions: { executablePath: process.env.CHROME_PATH ?? chrome, args: ['--no-sandbox'] },
    acceptDownloads: true,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: '../server/node_modules/.bin/tsx e2e/server.ts',
    url: 'http://127.0.0.1:8799/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
  },
});
