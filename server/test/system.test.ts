import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-sys-'));
const base = path.join(tmp, 'base');
const runDir = path.join(base, 'shared', 'run');
fs.mkdirSync(path.join(base, 'shared', 'logs'), { recursive: true });
fs.mkdirSync(runDir, { recursive: true });
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.RS_BASE_DIR = base;
process.env.RS_RUN_DIR = runDir;

// Stand-in for the installed deploy tool: records invocations and reports a pending update.
fs.writeFileSync(
  path.join(base, 'deploy.sh'),
  `#!/usr/bin/env bash
echo "$*" >> "${base}/calls.txt"
case "$1" in
  check) echo "noise"; echo '{"source":"git","ref":"repo#main","current":"aaa","currentVersion":"1.0.0+aaa","latest":"bbb","latestLabel":"main@bbb","updateAvailable":true,"error":"","checkedAt":1}' ;;
  update) echo "[deploy] building" >> "${base}/shared/logs/deploy.log"
          printf '{"state":"success","message":"已更新到 1.1.0","from":"1.0.0","to":"1.1.0","updatedAt":2}' > "${runDir}/update-status.json" ;;
esac
`,
  { mode: 0o755 },
);

let app: FastifyInstance;
let admin = '';
let user = '';

async function req(method: string, url: string, cookie: string, payload?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
  return { status: res.statusCode, json: res.json() };
}
async function login(username: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return String(res.headers['set-cookie']).split(';')[0];
}

beforeAll(async () => {
  const { openDb } = await import('../src/db.js');
  const { buildApp } = await import('../src/app.js');
  app = await buildApp(openDb(path.join(tmp, 'test.db')), { serveWeb: false });
  admin = await login('admin', 'admin123');
  await req('POST', '/api/users', admin, { username: 'u1', password: 'pass1234' });
  user = await login('u1', 'pass1234');
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('system update API', () => {
  it('health reports the running version', async () => {
    const r = await req('GET', '/api/health', '');
    expect(r.json.ok).toBe(true);
    expect(r.json.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('info is managed and admin-only for details', async () => {
    const a = await req('GET', '/api/system/info', admin);
    expect(a.json).toMatchObject({ managed: true, baseDir: base, updateAvailable: false });
    const u = await req('GET', '/api/system/info', user);
    expect(u.status).toBe(200);
    expect(u.json.baseDir).toBeUndefined();
    expect((await req('POST', '/api/system/check', user)).status).toBe(403);
    expect((await req('POST', '/api/system/update', user)).status).toBe(403);
    expect((await req('GET', '/api/system/update-log', user)).status).toBe(403);
  });

  it('check runs deploy.sh check --json and caches the result', async () => {
    const r = await req('POST', '/api/system/check', admin);
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ updateAvailable: true, latestLabel: 'main@bbb' });
    expect((await req('GET', '/api/system/info', user)).json.updateAvailable).toBe(true);
    expect(fs.readFileSync(path.join(base, 'calls.txt'), 'utf8')).toContain('check --json');
  });

  it('update spawns deploy.sh update detached and exposes status + log', async () => {
    const r = await req('POST', '/api/system/update', admin, { force: true });
    expect(r.json.started).toBe(true);
    let log: any;
    for (let i = 0; i < 50; i++) {
      log = (await req('GET', '/api/system/update-log', admin)).json;
      if (log.status.state === 'success') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(log.status).toMatchObject({ state: 'success', to: '1.1.0' });
    expect(log.log).toContain('[deploy] building');
    expect(fs.readFileSync(path.join(base, 'calls.txt'), 'utf8')).toContain('update --yes --force');
  });

  it('refuses a second update while one is running', async () => {
    fs.writeFileSync(path.join(runDir, 'update-status.json'), JSON.stringify({ state: 'running', message: 'x', from: '', to: '', updatedAt: Date.now() }));
    const r = await req('POST', '/api/system/update', admin);
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('正在进行');
  });

  it('restores the database from a rollback marker before opening it', async () => {
    const { applyPendingRestore } = await import('../src/system.js');
    const db = path.join(tmp, 'restore.db');
    const backup = path.join(tmp, 'backup.db');
    fs.writeFileSync(db, 'new');
    fs.writeFileSync(db + '-wal', 'wal');
    fs.writeFileSync(backup, 'old');
    fs.writeFileSync(path.join(runDir, 'restore-db'), backup);
    applyPendingRestore(db);
    expect(fs.readFileSync(db, 'utf8')).toBe('old');
    expect(fs.existsSync(db + '-wal')).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'restore-db'))).toBe(false);
  });
});
