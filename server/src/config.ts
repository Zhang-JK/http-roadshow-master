import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'));
fs.mkdirSync(dataDir, { recursive: true });

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/usr/local/bin/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find((c) => fs.existsSync(c));
}

const appRoot = path.resolve(import.meta.dirname, '../..');

export const config = {
  port: Number(process.env.PORT ?? 9090),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir,
  dbFile: process.env.DB_FILE ?? path.join(dataDir, 'roadshow.db'),
  assetDir: path.join(dataDir, 'assets'),
  webDist: path.resolve(process.env.WEB_DIST ?? path.join(process.cwd(), '../web/dist')),
  adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'admin123',
  sessionDays: Number(process.env.SESSION_DAYS ?? 14),
  chromePath: findChrome(),
  appRoot,
  /** Origin used in links handed to MCP clients; defaults to the request's Host. */
  publicUrl: process.env.PUBLIC_URL?.replace(/\/+$/, '') || undefined,
  /** Set by deploy.sh; when absent the app was not installed by the deploy tool and cannot self-update. */
  baseDir: process.env.RS_BASE_DIR,
  runDir: process.env.RS_RUN_DIR,
};

fs.mkdirSync(config.assetDir, { recursive: true });
