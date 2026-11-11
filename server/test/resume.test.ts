import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startMockLlm, type MockCall } from './mockLlm.js';
import type { DeckDoc } from '../src/deck.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-resume-'));
process.env.DATA_DIR = tmp;

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockLlm>>;
let admin = '';
let alice = '';
let db: import('../src/db.js').DB;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (res: any) => String([res.headers['set-cookie']].flat()[0]).split(';')[0];

async function req(method: string, url: string, cookie: string, payload?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
  return { status: res.statusCode, json: res.json() as any };
}

async function waitJob(id: string) {
  for (let i = 0; i < 600; i++) {
    const { json } = await req('GET', `/api/jobs/${id}`, admin);
    if (json.job.status === 'done' || json.job.status === 'error') return json.job;
    await sleep(100);
  }
  throw new Error('job timeout');
}

const savedDoc = (id: string) => JSON.parse((db.prepare('SELECT doc FROM projects WHERE id = ?').get(id) as { doc: string }).doc) as DeckDoc;
const checkpoints = (jobId?: string) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM job_checkpoints${jobId ? ' WHERE job_id = ?' : ''}`).get(...(jobId ? [jobId] : [])) as { c: number }).c;
const isPlan = (c: MockCall) => c.text.includes('本次只输出 README.md 与样式文件');
const isPages = (c: MockCall) => c.text.includes('【本批任务】');
const batchOf = (c: MockCall) => c.text.match(/本批是第 ([\d–]+) 页/)?.[1];
/** The first round of a tool edit: the request alone, before any tool result or delivery check. */
const isEditStart = (c: MockCall, marker: string) =>
  c.text.includes(marker) &&
  !c.body.messages.some((m: any) => m.role === 'tool') &&
  !String(c.body.messages.at(-1)?.content ?? '').includes('【交付检查】');
const failedJob = async (projectId: string, jobId: string) =>
  (await req('GET', `/api/projects/${projectId}/versions`, alice)).json.failedJobs.find((j: any) => j.id === jobId);

beforeAll(async () => {
  mock = await startMockLlm();
  const { openDb } = await import('../src/db.js');
  const { buildApp } = await import('../src/app.js');
  db = openDb(path.join(tmp, 'test.db'));
  app = await buildApp(db, { serveWeb: false });
  admin = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } }));
  await req('POST', '/api/users', admin, { username: 'alice', password: 'alice123', displayName: '爱丽丝' });
  alice = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'alice123' } }));
  await req('POST', '/api/llm/endpoints', admin, { name: 'local', baseUrl: mock.url, apiKey: 'good-key', model: 'mock-vision' });
  await req('PUT', '/api/settings', admin, { selfCheck: false });
});

afterAll(async () => {
  await app.close();
  await mock.close();
  const { closeBrowser } = await import('../src/render.js');
  await closeBrowser();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('continuing a failed job where it stopped', () => {
  let projectId = '';

  it('a generation that lost its model between page batches continues with the remaining pages', async () => {
    const before = mock.calls.length;
    const r = await req('POST', '/api/projects', alice, { type: 'template', style: '简约', name: '断线模板', notes: 'MANY_PAGES OFFLINE_AT_PAGES' });
    projectId = r.json.project.id;
    const failed = await waitJob(r.json.job.id);
    expect(failed.status).toBe('error');
    expect(failed.error).toContain('model offline (MOCK)');
    expect(mock.offline).toBe(true);
    const listed = await failedJob(projectId, failed.id);
    expect(listed.resume).toMatchObject({ label: '已完成规划与 3/7 页' });
    expect(listed.resume.savedAt).toBeGreaterThan(0);
    expect(checkpoints(failed.id)).toBe(1);

    // Still offline: continuing fails again at the same place and keeps the progress.
    expect((await req('POST', `/api/jobs/${failed.id}/resume`, admin)).status).toBe(200);
    const again = await waitJob(failed.id);
    expect(again).toMatchObject({ status: 'error', resumeCount: 1 });
    expect((await failedJob(projectId, failed.id)).resume.label).toBe('已完成规划与 3/7 页');

    mock.setOnline();
    await sleep(300);
    const resumed = await req('POST', `/api/jobs/${failed.id}/resume`, admin);
    expect(resumed.status).toBe(200);
    expect(resumed.json.job).toMatchObject({ id: failed.id, status: 'running', resumeCount: 2, userId: failed.userId });
    expect((await req('GET', `/api/projects/${projectId}`, alice)).json.project.status).toBe('generating');
    const done = await waitJob(failed.id);
    expect(done.status).toBe('done');
    expect(done.error).toBeNull();

    // The plan and the first batch were written once; nothing was started over.
    const calls = mock.calls.slice(before);
    expect(calls.filter(isPlan)).toHaveLength(1);
    expect(calls.filter(isPages).map(batchOf)).toEqual(['1–3', '4–6', '7']);
    const doc = savedDoc(projectId);
    expect(doc.pages.map((p) => p.file)).toEqual(['pages/cover.html', ...[1, 2, 3, 4, 5, 6].map((i) => `pages/content-${i}.html`)]);
    expect(doc.pages.map((p) => p.html.match(/第(\d)页标题/)![1])).toEqual(['1', '2', '3', '4', '5', '6', '7']);

    // One history entry for the change: the version, by its requester; its progress is gone.
    const h = await req('GET', `/api/projects/${projectId}/versions`, alice);
    expect(h.json.failedJobs).toEqual([]);
    expect(h.json.versions).toHaveLength(1);
    expect(h.json.versions[0]).toMatchObject({ jobId: failed.id, userName: '爱丽丝', versionNo: 1 });
    expect(checkpoints(failed.id)).toBe(0);
    // The time it sat failed is not counted.
    const row = db.prepare('SELECT created_at, finished_at, prior_ms, resumed_at FROM jobs WHERE id = ?').get(failed.id) as any;
    expect(row.prior_ms).toBeGreaterThan(0);
    expect(done.durationMs).toBeLessThan(row.finished_at - row.created_at - 250);
    expect(h.json.versions[0].durationMs).toBe(done.durationMs);
    expect((await req('POST', `/api/jobs/${failed.id}/resume`, admin)).status).toBe(409);
  });

  it('single-call generation continues a cut-off reply from the part already written', async () => {
    await req('PUT', '/api/settings', admin, { generateMode: 'single' });
    try {
      const before = mock.calls.length;
      const r = await req('POST', '/api/projects', alice, { type: 'template', style: '简约', name: '单次断线', notes: 'TRUNCATE_SINGLE OFFLINE_AT_CONTINUE' });
      const failed = await waitJob(r.json.job.id);
      expect(failed.status).toBe('error');
      expect((await failedJob(r.json.project.id, failed.id)).resume.label).toMatch(/^已输出 1 段（约 \d+ 字符）$/);
      mock.setOnline();
      expect((await req('POST', `/api/jobs/${failed.id}/resume`, alice)).status).toBe(200);
      expect((await waitJob(failed.id)).status).toBe('done');
      const calls = mock.calls.slice(before);
      const first = calls.filter((c) => c.text.includes('TRUNCATE_SINGLE') && !String(c.body.messages.at(-1).content).includes('请从中断处继续输出'));
      // The first part (and the delivery check's README fix) only: the long reply was not written again.
      expect(first.filter((c) => !c.text.includes('【交付检查】'))).toHaveLength(1);
      expect(savedDoc(r.json.project.id).pages).toHaveLength(3);
    } finally {
      await req('PUT', '/api/settings', admin, { generateMode: 'files' });
    }
  });

  it('a tool edit continues its conversation with the edits made so far', async () => {
    const before = mock.calls.length;
    const e = await req('POST', `/api/projects/${projectId}/edit`, alice, { prompt: '改主色 OFFLINE_IN_EDIT', scope: 'global' });
    const failed = await waitJob(e.json.job.id);
    expect(failed.status).toBe('error');
    expect((await failedJob(projectId, failed.id)).resume.label).toBe('已进行 1 轮修改（1 处改动）');
    mock.setOnline();
    expect((await req('POST', `/api/jobs/${failed.id}/resume`, admin)).status).toBe(200);
    const done = await waitJob(failed.id);
    expect(done.status).toBe('done');
    const calls = mock.calls.slice(before);
    expect(calls.filter((c) => isEditStart(c, 'OFFLINE_IN_EDIT'))).toHaveLength(1);
    // The continued round got the first round's tool results.
    const next = calls.find((c) => c.text.includes('OFFLINE_IN_EDIT') && c.body.messages.some((m: any) => m.role === 'tool'))!;
    expect(next.body.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content).join('\n')).toContain('--brand');
    expect(savedDoc(projectId).css, savedDoc(projectId).css).toMatch(/--brand:\s*#111827/);
    const h = await req('GET', `/api/projects/${projectId}/versions`, alice);
    expect(h.json.versions[0]).toMatchObject({ jobId: failed.id, versionNo: 2, userName: '爱丽丝', prompt: '改主色 OFFLINE_IN_EDIT' });
    expect(h.json.failedJobs).toEqual([]);
  });

  it('an edit that failed in the delivery check continues there, not from the edit', async () => {
    // A project of its own: the README keeps a log of edit requests, which the mock reads as well.
    const created = await req('POST', '/api/projects', alice, { type: 'template', style: '简约', name: '交付检查断线' });
    expect((await waitJob(created.json.job.id)).status).toBe('done');
    const id = created.json.project.id as string;
    const before = mock.calls.length;
    const checksBefore = mock.checkCalls.length;
    const e = await req('POST', `/api/projects/${id}/edit`, alice, { prompt: '删掉一页 DELETE_LAST OFFLINE_IN_CHECK', scope: 'global' });
    const failed = await waitJob(e.json.job.id);
    expect(failed.status).toBe('error');
    expect(failed.error).toContain('交付检查');
    expect((await failedJob(id, failed.id)).resume.label).toBe('修改已完成，交付检查第 1 轮');
    expect(mock.checkCalls.length).toBe(checksBefore);
    mock.setOnline();
    expect((await req('POST', `/api/jobs/${failed.id}/resume`, alice)).status).toBe(200);
    const done = await waitJob(failed.id);
    expect(done.status).toBe('done');
    expect(done.review.check).toMatchObject({ errors: 0, fixes: 1 });
    expect(mock.calls.slice(before).filter((c) => isEditStart(c, 'OFFLINE_IN_CHECK'))).toHaveLength(1);
    expect(mock.checkCalls.slice(checksBefore)[0].text).toContain('✗ README.md：「页面规划」列出的 pages/content-2.html 不存在');
    const doc = savedDoc(id);
    expect(doc.pages.map((p) => p.file).filter(Boolean)).not.toContain('pages/content-2.html');
    expect(doc.readme).not.toContain('pages/content-2.html ｜');
  });

  it('only the latest change of a project keeps its progress', async () => {
    // A fails with progress; B, started later, fails at once: A can no longer continue, B has nothing to continue.
    const a = await waitJob((await req('POST', `/api/projects/${projectId}/edit`, alice, { prompt: 'A OFFLINE_IN_EDIT', scope: 'global' })).json.job.id);
    expect((await failedJob(projectId, a.id)).resume).not.toBeNull();
    const b = await waitJob((await req('POST', `/api/projects/${projectId}/edit`, alice, { prompt: 'B 普通修改', scope: 'global' })).json.job.id);
    expect(b.status).toBe('error');
    expect((await failedJob(projectId, a.id)).resume).toBeNull();
    expect((await failedJob(projectId, b.id)).resume).toBeNull();
    expect(checkpoints()).toBe(0);
    const r = await req('POST', `/api/jobs/${a.id}/resume`, alice);
    expect(r.status).toBe(409);
    expect(r.json.error).toContain('只有项目中最近一次失败的修改可以继续');
    mock.setOnline();

    // C fails with progress, then a version is saved by hand: C is no longer the latest change.
    const c = await waitJob((await req('POST', `/api/projects/${projectId}/edit`, alice, { prompt: 'C OFFLINE_IN_EDIT', scope: 'global' })).json.job.id);
    expect((await failedJob(projectId, c.id)).resume).not.toBeNull();
    mock.setOnline();
    const page = savedDoc(projectId).pages[0];
    const eid = page.html.match(/<h1[^>]*data-eid="(e[0-9a-z]+)"/)![1];
    const t = await req('PUT', `/api/projects/${projectId}/pages/${page.id}/elements/${eid}/text`, alice, { text: '手改标题' });
    expect(t.status).toBe(200);
    expect((await failedJob(projectId, c.id)).resume).toBeNull();
    expect((await req('POST', `/api/jobs/${c.id}/resume`, alice)).status).toBe(409);

    // A failure retried from scratch: the new job is the latest, the old one's progress is dropped.
    const d = await waitJob((await req('POST', `/api/projects/${projectId}/edit`, alice, { prompt: 'D OFFLINE_IN_EDIT', scope: 'global' })).json.job.id);
    expect(checkpoints(d.id)).toBe(1);
    mock.setOnline();
    const retry = await req('POST', `/api/jobs/${d.id}/retry`, alice);
    expect(retry.status).toBe(200);
    expect(checkpoints(d.id)).toBe(0);
    const rj = await waitJob(retry.json.job.id);
    expect(rj.status, rj.error).toBe('done');
    expect(checkpoints()).toBe(0);
  });

  it('two users continuing the same job at once start it once', async () => {
    const e = await waitJob((await req('POST', `/api/projects/${projectId}/edit`, alice, { prompt: 'E OFFLINE_IN_EDIT', scope: 'global' })).json.job.id);
    mock.setOnline();
    const [x, y] = await Promise.all([req('POST', `/api/jobs/${e.id}/resume`, alice), req('POST', `/api/jobs/${e.id}/resume`, admin)]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const done = await waitJob(e.id);
    expect(done, done.error).toMatchObject({ status: 'done', resumeCount: 1 });
    expect((await req('POST', `/api/jobs/does-not-exist/resume`, alice)).status).toBe(404);
  });

  it('a failure before any progress offers no continuing', async () => {
    const ep = (await req('GET', '/api/llm/endpoints', admin)).json.endpoints.find((x: any) => x.name === 'local');
    await req('PUT', `/api/llm/endpoints/${ep.id}`, admin, { baseUrl: mock.brokenUrl });
    try {
      const r = await req('POST', '/api/projects', alice, { type: 'template', style: '简约', name: '一开始就断' });
      const failed = await waitJob(r.json.job.id);
      expect(failed.status).toBe('error');
      expect((await failedJob(r.json.project.id, failed.id)).resume).toBeNull();
      expect((await req('POST', `/api/jobs/${failed.id}/resume`, alice)).status).toBe(409);
    } finally {
      await req('PUT', `/api/llm/endpoints/${ep.id}`, admin, { baseUrl: mock.url });
    }
  });

  it('the admin session list counts how often a job continued', async () => {
    const past = await req('GET', '/api/admin/sessions?status=history', admin);
    const s = past.json.sessions.find((x: any) => x.projectName === '断线模板' && x.kind === 'create');
    expect(s).toMatchObject({ status: 'done', resumeCount: 2 });
  });
});

describe('checkpoints across a restart', () => {
  it('a job interrupted by a restart can continue; older progress is dropped', async () => {
    const { openDb } = await import('../src/db.js');
    const { saveCheckpoint, resumableJobs } = await import('../src/checkpoint.js');
    const file = path.join(tmp, 'restart.db');
    const first = openDb(file);
    first.prepare(`INSERT INTO projects (id, type, name, created_at, updated_at) VALUES ('p1', 'deck', 'P', 0, 0), ('p2', 'deck', 'Q', 0, 0)`).run();
    const job = (id: string, project: string, status: string, at: number) =>
      first.prepare(`INSERT INTO jobs (id, project_id, user_id, kind, status, created_at, updated_at) VALUES (?, ?, 1, 'edit', ?, ?, ?)`).run(id, project, status, at, at);
    job('old', 'p1', 'error', 1000);
    job('running', 'p1', 'running', 2000);
    job('p2-running', 'p2', 'running', 1000);
    job('p2-newer', 'p2', 'pending', 3000);
    for (const id of ['old', 'running', 'p2-running']) saveCheckpoint(first, id, `进度 ${id}`, { gen: { step: 'pages' } });
    first.close();

    const again = openDb(file);
    expect((again.prepare(`SELECT status FROM jobs WHERE id = 'running'`).get() as any).status).toBe('error');
    const kept = (again.prepare('SELECT job_id FROM job_checkpoints ORDER BY job_id').all() as { job_id: string }[]).map((r) => r.job_id);
    expect(kept).toEqual(['running']);
    expect([...resumableJobs(again, ['old', 'running', 'p2-running']).keys()]).toEqual(['running']);
    again.close();
  });
});
