import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export interface VersionInfo {
  version: string;
  commit: string;
  source: string;
  ref: string;
  builtAt: string;
}

let cachedVersion: VersionInfo | null = null;

/** VERSION.json is written by deploy.sh at build time; dev checkouts fall back to package.json + git. */
export function versionInfo(): VersionInfo {
  if (cachedVersion) return cachedVersion;
  const file = path.join(config.appRoot, 'VERSION.json');
  try {
    cachedVersion = { version: '', commit: '', source: '', ref: '', builtAt: '', ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    return cachedVersion!;
  } catch {
    /* not a deployed release */
  }
  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(config.appRoot, 'package.json'), 'utf8')).version ?? version;
  } catch {
    /* ignore */
  }
  cachedVersion = { version: `${version}-dev`, commit: '', source: 'dev', ref: '', builtAt: '' };
  return cachedVersion;
}

export const deployScript = () => (config.baseDir ? path.join(config.baseDir, 'deploy.sh') : null);
export const isManaged = () => {
  const s = deployScript();
  return !!s && fs.existsSync(s);
};

export interface CheckResult {
  source: string;
  ref: string;
  current: string;
  currentVersion: string;
  latest: string;
  latestLabel: string;
  updateAvailable: boolean;
  error: string;
  checkedAt: number;
}

let lastCheck: CheckResult | null = null;
export const getLastCheck = () => lastCheck;

export function checkForUpdates(): Promise<CheckResult> {
  const script = deployScript();
  if (!script || !isManaged()) return Promise.reject(new Error('当前实例不是通过 deploy.sh 部署的，无法在线检查更新'));
  return new Promise((resolve, reject) => {
    execFile('bash', [script, 'check', '--json'], { timeout: 60_000, env: process.env }, (err, stdout, stderr) => {
      const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
      if (line) {
        try {
          lastCheck = JSON.parse(line);
          return resolve(lastCheck!);
        } catch {
          /* fall through */
        }
      }
      reject(new Error((stderr || err?.message || '检查更新失败').replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-500)));
    });
  });
}

export interface UpdateStatus {
  state: 'idle' | 'running' | 'success' | 'failed' | 'rolled_back';
  message: string;
  from: string;
  to: string;
  updatedAt: number;
}

export function updateStatus(): UpdateStatus {
  if (!config.runDir) return { state: 'idle', message: '', from: '', to: '', updatedAt: 0 };
  try {
    return JSON.parse(fs.readFileSync(path.join(config.runDir, 'update-status.json'), 'utf8'));
  } catch {
    return { state: 'idle', message: '', from: '', to: '', updatedAt: 0 };
  }
}

/** Starts `deploy.sh update` fully detached so it survives the app restart it triggers. */
export function startUpdate(force: boolean): void {
  const script = deployScript();
  if (!script || !isManaged()) throw new Error('当前实例不是通过 deploy.sh 部署的，无法在线更新');
  const st = updateStatus();
  if (st.state === 'running' && Date.now() - st.updatedAt < 30 * 60_000) throw new Error('已有更新任务正在进行中');
  if (config.runDir) {
    fs.writeFileSync(
      path.join(config.runDir, 'update-status.json'),
      JSON.stringify({ state: 'running', message: '准备更新', from: versionInfo().version, to: '', updatedAt: Date.now() }),
    );
  }
  const args = [script, 'update', '--yes', ...(force ? ['--force'] : [])];
  const child = spawn('bash', args, { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}

export function deployLogTail(lines = 200): string {
  if (!config.baseDir) return '';
  const file = path.join(config.baseDir, 'shared', 'logs', 'deploy.log');
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    return buf
      .toString('utf8')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split('\n')
      .slice(-lines)
      .join('\n');
  } catch {
    return '';
  }
}

/** Applied before the database is opened: deploy.sh rollback leaves a marker pointing at the pre-update backup. */
export function applyPendingRestore(dbFile: string) {
  if (!config.runDir) return;
  const marker = path.join(config.runDir, 'restore-db');
  if (!fs.existsSync(marker)) return;
  const backup = fs.readFileSync(marker, 'utf8').trim();
  if (backup && fs.existsSync(backup)) {
    for (const suffix of ['-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
    fs.copyFileSync(backup, dbFile);
    console.log(`[restore] 已从备份恢复数据库：${backup}`);
  }
  fs.rmSync(marker, { force: true });
}

export function writePidFile() {
  if (!config.runDir) return;
  fs.mkdirSync(config.runDir, { recursive: true });
  fs.writeFileSync(path.join(config.runDir, 'app.pid'), String(process.pid));
}

export function startPeriodicCheck(intervalMs = 6 * 3600_000) {
  if (!isManaged()) return;
  const run = () => checkForUpdates().catch(() => {});
  setTimeout(run, 60_000).unref();
  setInterval(run, intervalMs).unref();
}
