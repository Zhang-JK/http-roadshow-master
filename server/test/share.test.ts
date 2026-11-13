import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startMockLlm } from './mockLlm.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-share-'));
process.env.DATA_DIR = tmp;

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockLlm>>;
let admin = '';
let alice = '';
let projectId = '';
let emptyId = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (res: any) => String([res.headers['set-cookie']].flat()[0]).split(';')[0];

async function req(method: string, url: string, cookie: string, payload?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, json: res.json() as any, headers: res.headers };
}

async function waitJob(id: string) {
  for (let i = 0; i < 300; i++) {
    const { json } = await req('GET', `/api/jobs/${id}`, admin);
    if (json.job.status === 'done' || json.job.status === 'error') return json.job;
    await sleep(100);
  }
  throw new Error('job timeout');
}

beforeAll(async () => {
  mock = await startMockLlm();
  const { openDb } = await import('../src/db.js');
  const { buildApp } = await import('../src/app.js');
  app = await buildApp(openDb(path.join(tmp, 'test.db')), { serveWeb: false });
  admin = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } }));
  await req('POST', '/api/users', admin, { username: 'alice', password: 'alice123', displayName: '爱丽丝' });
  alice = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'alice123' } }));
  // Created before any model is set up: its generation fails and it has nothing to show.
  const empty = await req('POST', '/api/projects', admin, { type: 'template', style: '简约', name: '空模板' });
  emptyId = empty.json.project.id;
  await waitJob(empty.json.job.id);
  await req('POST', '/api/llm/endpoints', admin, { name: 'local', baseUrl: mock.url, apiKey: 'good-key', model: 'mock-vision' });
  await req('PUT', '/api/settings', admin, { selfCheck: false });
  const r = await req('POST', '/api/projects', admin, { type: 'template', style: '简约', name: '分享模板' });
  projectId = r.json.project.id;
  expect((await waitJob(r.json.job.id)).status).toBe('done');
});

afterAll(async () => {
  await app.close();
  await mock.close();
  const { closeBrowser } = await import('../src/render.js');
  await closeBrowser();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('share links', () => {
  let token = '';

  it('only signed-in users create a link; it stays the same until reset', async () => {
    expect((await req('POST', `/api/projects/${projectId}/share`, '')).status).toBe(401);
    expect((await req('GET', `/api/projects/${projectId}`, admin)).json.project.share).toBeNull();
    const r = await req('POST', `/api/projects/${projectId}/share`, admin);
    expect(r.status).toBe(200);
    token = r.json.share.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(r.json.share).toMatchObject({ sharedBy: '管理员' });
    expect(r.json.share.sharedAt).toBeGreaterThan(0);
    const again = await req('POST', `/api/projects/${projectId}/share`, alice);
    expect(again.json.share).toMatchObject({ token, sharedBy: '管理员' });
    expect((await req('GET', `/api/projects/${projectId}`, alice)).json.project.share).toMatchObject({ token, sharedBy: '管理员' });
    const listed = (await req('GET', '/api/projects?type=template', alice)).json.projects;
    expect(listed.find((p: any) => p.id === projectId).share.token).toBe(token);
    expect(listed.find((p: any) => p.id === emptyId).share).toBeNull();
  });

  it('anyone with the link sees the current version, without the README or the project id', async () => {
    const r = await req('GET', `/api/share/${token}`, '');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json.canEdit).toBe(false);
    expect(r.json.project).toMatchObject({ type: 'template', name: '分享模板', versionNo: 1 });
    expect(r.json.project.id).toBeUndefined();
    expect(r.json.doc.pages.length).toBeGreaterThan(0);
    expect(r.json.doc.pages[0].html).toContain('<section');
    expect(r.json.doc).toMatchObject({ width: 1920, height: 1080 });
    expect(r.json.doc.readme).toBeUndefined();
    expect(JSON.stringify(r.json)).not.toContain('修改记录');
    // Nothing else opens up without signing in.
    expect((await req('GET', `/api/projects/${projectId}`, '')).status).toBe(401);
    expect((await req('GET', `/api/projects/${projectId}/files`, '')).status).toBe(401);
  });

  it('a signed-in visitor gets the project id and can edit; the link shows the edit', async () => {
    const r = await req('GET', `/api/share/${token}`, alice);
    expect(r.json).toMatchObject({ canEdit: true, project: { id: projectId } });
    expect((await req('PATCH', `/api/projects/${projectId}`, alice, { name: '分享模板（改）' })).status).toBe(200);
    const after = await req('GET', `/api/share/${token}`, '');
    expect(after.json.project).toMatchObject({ name: '分享模板（改）', versionNo: 2 });
  });

  it('resetting the link stops the old one; closing it stops all', async () => {
    const reset = await req('POST', `/api/projects/${projectId}/share`, alice, { reset: true });
    expect(reset.json.share.token).not.toBe(token);
    expect(reset.json.share.sharedBy).toBe('爱丽丝');
    expect((await req('GET', `/api/share/${token}`, '')).status).toBe(404);
    expect((await req('GET', `/api/share/${reset.json.share.token}`, '')).json.project.name).toBe('分享模板（改）');

    expect((await req('DELETE', `/api/projects/${projectId}/share`, '')).status).toBe(401);
    expect((await req('DELETE', `/api/projects/${projectId}/share`, admin)).json.share).toBeNull();
    const gone = await req('GET', `/api/share/${reset.json.share.token}`, '');
    expect(gone.status).toBe(404);
    expect(gone.json.error).toBe('分享链接无效或已被关闭');
    expect((await req('GET', `/api/projects/${projectId}`, admin)).json.project.share).toBeNull();
  });

  it('unknown or malformed tokens are not found; a project without content shares no doc', async () => {
    expect((await req('GET', '/api/share/nope', '')).status).toBe(404);
    expect((await req('GET', `/api/share/${'x'.repeat(24)}`, '')).status).toBe(404);
    expect((await req('POST', '/api/projects/missing/share', admin)).status).toBe(404);
    const s = await req('POST', `/api/projects/${emptyId}/share`, admin);
    const r = await req('GET', `/api/share/${s.json.share.token}`, '');
    expect(r.status).toBe(200);
    expect(r.json.doc).toBeNull();
    expect(r.json.project).toMatchObject({ name: '空模板', status: 'error', versionNo: 0 });
  });

  it('deleting the project ends its link', async () => {
    const s = await req('POST', `/api/projects/${emptyId}/share`, admin);
    expect((await req('DELETE', `/api/projects/${emptyId}`, admin)).status).toBe(200);
    expect((await req('GET', `/api/share/${s.json.share.token}`, '')).status).toBe(404);
  });
});
