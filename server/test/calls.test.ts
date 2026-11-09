import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startMockLlm } from './mockLlm.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-calls-'));
process.env.DATA_DIR = tmp;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('parallel requests across endpoints', () => {
  let server: http.Server;
  let base = '';
  const running = new Map<string, number>();
  const peak = new Map<string, number>();
  const served: string[] = [];
  let db: import('../src/db.js').DB;
  let n = 0;

  beforeAll(async () => {
    // A slow streaming "model": 150 ms before the first token, then 5 chunks 60 ms apart (50 tokens).
    server = http.createServer(async (req, res) => {
      for await (const _ of req);
      const name = req.url!.split('/')[1];
      if (name === 'fail') {
        res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'busy' } }));
        return;
      }
      served.push(name);
      running.set(name, (running.get(name) ?? 0) + 1);
      peak.set(name, Math.max(peak.get(name) ?? 0, running.get(name)!));
      await sleep(150);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let i = 0; i < 5; i++) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `第${i}段。` } }] })}\n\n`);
        await sleep(60);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 50 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      running.set(name, running.get(name)! - 1);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { openDb } = await import('../src/db.js');
    db = openDb(path.join(tmp, 'calls.db'));
    db.prepare(`INSERT INTO projects (id, type, name, created_at, updated_at) VALUES ('p1', 'deck', 'P', 0, 0)`).run();
  });
  afterAll(() => server.close());

  const endpoints = (...eps: { name: string; max?: number }[]) => {
    db.prepare('DELETE FROM llm_endpoints').run();
    for (const e of eps) {
      db.prepare(`INSERT INTO llm_endpoints (name, base_url, api_key, model, max_concurrency, created_at) VALUES (?, ?, 'k', 'm', ?, 0)`).run(
        e.name,
        `${base}/${e.name}/v1`,
        e.max ?? 0,
      );
    }
    peak.clear();
    served.length = 0;
  };
  const newJob = () => {
    const id = `job${++n}`;
    db.prepare(`INSERT INTO jobs (id, project_id, user_id, kind, status, created_at, updated_at) VALUES (?, 'p1', 1, 'edit', 'running', ?, ?)`).run(
      id,
      Date.now(),
      Date.now(),
    );
    return id;
  };
  const ask = async (jobId: string, signal?: AbortSignal) => {
    const { chat } = await import('../src/llm.js');
    return chat(db, 1, [{ role: 'user', content: '你好' }], { jobId, stage: '测试', onDelta: () => {}, signal });
  };

  it('runs requests of the same user in parallel, even on one endpoint', async () => {
    endpoints({ name: 'one' });
    const r = await Promise.all([ask(newJob()), ask(newJob())]);
    expect(r.map((x) => x.text)).toEqual(['第0段。第1段。第2段。第3段。第4段。', '第0段。第1段。第2段。第3段。第4段。']);
    expect(peak.get('one')).toBe(2);
  });

  it('spreads requests over endpoints and queues them at the parallel limit', async () => {
    endpoints({ name: 'a', max: 1 }, { name: 'b', max: 1 });
    const { jobStats } = await import('../src/calls.js');
    const ids = [newJob(), newJob(), newJob()];
    const all = Promise.all(ids.map((id) => ask(id)));
    await sleep(80);
    const live = jobStats(db, ids);
    expect(ids.filter((id) => live.get(id)!.live?.queued)).toHaveLength(1);
    expect(ids.filter((id) => live.get(id)!.live && !live.get(id)!.live!.queued)).toHaveLength(2);
    await all;
    expect(peak.get('a')).toBe(1);
    expect(peak.get('b')).toBe(1);
    expect(new Set(served)).toEqual(new Set(['a', 'b']));
    const calls = db.prepare(`SELECT * FROM llm_calls WHERE job_id IN (?, ?, ?) ORDER BY queued_ms`).all(...ids) as any[];
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.status === 'ok' && c.stage === '测试' && c.prompt_tokens === 10 && c.completion_tokens === 50 && !c.estimated)).toBe(true);
    // The queued call waited for a whole call (~450 ms) before its own idle timeout could start.
    expect(calls[2].queued_ms).toBeGreaterThan(300);
    expect(calls[0].first_token_at - calls[0].started_at).toBeGreaterThanOrEqual(140);

    const stats = jobStats(db, ids).get(ids[0])!;
    expect(stats).toMatchObject({ calls: 1, failedCalls: 0, promptTokens: 10, completionTokens: 50, estimated: false, live: null });
    // 50 tokens over the ~300 ms from first token to the end of the stream.
    expect(stats.tokensPerSec).toBeGreaterThan(80);
    expect(stats.tokensPerSec).toBeLessThan(400);
  });

  it('records a failed attempt and moves on to the next endpoint', async () => {
    endpoints({ name: 'fail' }, { name: 'ok' });
    const id = newJob();
    // Whichever endpoint is preferred, the busy one fails and the other answers.
    const r = await ask(id);
    expect(r.text).toContain('第4段');
    const rows = db.prepare('SELECT status FROM llm_calls WHERE job_id = ? ORDER BY id').all(id) as any[];
    expect(rows.map((x) => x.status).at(-1)).toBe('ok');
    const { jobStats } = await import('../src/calls.js');
    expect(jobStats(db, [id]).get(id)!.failedCalls).toBe(rows.length - 1);
  });

  it('a queued request can be cancelled and frees nothing it did not take', async () => {
    endpoints({ name: 'solo', max: 1 });
    const { inflightCount } = await import('../src/llm.js');
    const first = ask(newJob());
    const ctl = new AbortController();
    const second = ask(newJob(), ctl.signal);
    await sleep(30);
    ctl.abort(new Error('用户取消'));
    await expect(second).rejects.toThrow();
    await first;
    const id = (db.prepare(`SELECT id FROM llm_endpoints WHERE name = 'solo'`).get() as any).id;
    expect(inflightCount(id)).toBe(0);
    expect(peak.get('solo')).toBe(1);
  });
});

describe('job history, retry and sessions', () => {
  let app: FastifyInstance;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let admin = '';
  let alice = '';
  let epId = 0;
  let projectId = '';
  let failedId = '';
  let apiDb: import('../src/db.js').DB;

  const cookieOf = (res: any) => String([res.headers['set-cookie']].flat()[0]).split(';')[0];
  const req = async (method: string, url: string, cookie: string, payload?: unknown) => {
    const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
    return { status: res.statusCode, json: res.json() as any };
  };
  const waitJob = async (id: string) => {
    for (let i = 0; i < 300; i++) {
      const { json } = await req('GET', `/api/jobs/${id}`, admin);
      if (json.job.status === 'done' || json.job.status === 'error') return json.job;
      await sleep(100);
    }
    throw new Error('job timeout');
  };

  beforeAll(async () => {
    mock = await startMockLlm();
    const { openDb } = await import('../src/db.js');
    const { buildApp } = await import('../src/app.js');
    apiDb = openDb(path.join(tmp, 'api.db'));
    app = await buildApp(apiDb, { serveWeb: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } });
    admin = cookieOf(login);
    await req('POST', '/api/users', admin, { username: 'alice', password: 'alice123', displayName: '爱丽丝' });
    alice = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'alice123' } }));
    // The only endpoint is down at first, so the generation fails.
    const ep = await req('POST', '/api/llm/endpoints', admin, { name: '坏', baseUrl: mock.brokenUrl, model: 'mock', apiKey: 'good-key', maxConcurrency: 2 });
    epId = ep.json.endpoint.id;
  });
  afterAll(async () => {
    await app?.close();
    const { closeBrowser } = await import('../src/render.js');
    await closeBrowser();
    await mock?.close();
  });

  it('stores the parallel limit of an endpoint', async () => {
    const list = await req('GET', '/api/llm/endpoints', admin);
    expect(list.json.endpoints[0]).toMatchObject({ maxConcurrency: 2, inflight: 0 });
    await req('PUT', `/api/llm/endpoints/${epId}`, admin, { maxConcurrency: 999 });
    expect((await req('GET', '/api/llm/endpoints', admin)).json.endpoints[0].maxConcurrency).toBe(64);
  });

  it('a failed generation shows in the history with its error', async () => {
    const r = await req('POST', '/api/projects', alice, { type: 'template', name: '失败模板', style: '简洁' });
    expect(r.status).toBe(200);
    projectId = r.json.project.id;
    const job = await waitJob(r.json.job.id);
    expect(job.status).toBe('error');
    expect(job.finishedAt).toBeGreaterThan(0);
    expect(job.stats.failedCalls).toBeGreaterThan(0);
    failedId = job.id;
    const h = await req('GET', `/api/projects/${projectId}/versions`, admin);
    expect(h.json.versions).toHaveLength(0);
    expect(h.json.failedJobs).toHaveLength(1);
    expect(h.json.failedJobs[0]).toMatchObject({ id: failedId, kind: 'create', userName: '爱丽丝', retriedBy: null });
    expect(h.json.failedJobs[0].error).toContain('down');
  });

  it('any user can retry a failed request once', async () => {
    await req('PUT', `/api/llm/endpoints/${epId}`, admin, { baseUrl: mock.url });
    const r = await req('POST', `/api/jobs/${failedId}/retry`, admin);
    expect(r.status).toBe(200);
    expect(r.json.job).toMatchObject({ retryOf: failedId, kind: 'create' });
    expect((await req('POST', `/api/jobs/${failedId}/retry`, alice)).status).toBe(409);
    const done = await waitJob(r.json.job.id);
    expect(done.status).toBe('done');
    expect(done.stats.calls).toBeGreaterThan(1);
    expect(done.stats.promptTokens).toBeGreaterThan(0);
    expect(done.stats.completionTokens).toBeGreaterThan(0);

    const h = await req('GET', `/api/projects/${projectId}/versions`, alice);
    expect(h.json.failedJobs[0].retriedBy).toBe(r.json.job.id);
    expect(h.json.versions[0]).toMatchObject({ jobId: r.json.job.id, versionNo: 1 });
    expect(h.json.versions[0].durationMs).toBeGreaterThan(0);
    expect(h.json.versions[0].stats.calls).toBe(done.stats.calls);
    // A finished project is no longer generated again by retrying its creation.
    apiDb.prepare(`UPDATE jobs SET retried_by = NULL WHERE id = ?`).run(failedId);
    expect((await req('POST', `/api/jobs/${failedId}/retry`, alice)).status).toBe(409);
  });

  it('retries a failed edit with the same request', async () => {
    await req('PUT', `/api/llm/endpoints/${epId}`, admin, { baseUrl: mock.brokenUrl });
    const e = await req('POST', `/api/projects/${projectId}/edit`, alice, { prompt: '把标题改成蓝色', scope: 'global' });
    const failed = await waitJob(e.json.job.id);
    expect(failed.status).toBe('error');
    await req('PUT', `/api/llm/endpoints/${epId}`, admin, { baseUrl: mock.url });
    const r = await req('POST', `/api/jobs/${failed.id}/retry`, admin);
    expect(r.json.job.request).toMatchObject({ prompt: '把标题改成蓝色', scope: 'global' });
    expect((await waitJob(r.json.job.id)).status).toBe('done');
    const h = await req('GET', `/api/projects/${projectId}/versions`, alice);
    expect(h.json.versions[0]).toMatchObject({ versionNo: 2, userName: '管理员', prompt: '把标题改成蓝色' });
    expect((await req('POST', `/api/jobs/does-not-exist/retry`, alice)).status).toBe(404);
  });

  it('admins see live and past sessions with their calls', async () => {
    expect((await req('GET', '/api/admin/sessions', alice)).status).toBe(403);
    const live = await req('GET', '/api/admin/sessions?status=active', admin);
    expect(live.json).toMatchObject({ total: 0, liveCount: 0, sessions: [] });
    const past = await req('GET', '/api/admin/sessions?status=history', admin);
    expect(past.json.total).toBe(4);
    const [latest] = past.json.sessions;
    expect(latest).toMatchObject({ kind: 'edit', status: 'done', projectName: '失败模板', userName: '管理员', prompt: '把标题改成蓝色' });
    expect(latest.endpoints).toEqual(['坏']);
    expect(latest.stats.completionTokens).toBeGreaterThan(0);
    expect(past.json.last24h.calls).toBeGreaterThan(4);
    const calls = await req('GET', `/api/admin/sessions/${latest.id}/calls`, admin);
    expect(calls.json.calls.length).toBe(latest.stats.calls);
    expect(calls.json.calls[0]).toMatchObject({ endpoint: '坏', model: 'mock', status: 'ok' });
    expect(calls.json.calls[0].stage).toBeTruthy();

    const usage = await req('GET', '/api/llm/usage', admin);
    expect(usage.json.models[0]).toMatchObject({ endpoint: '坏', inflight: 0, maxConcurrency: 64 });
    expect(usage.json.models[0].calls).toBeGreaterThan(4);
    expect(usage.json.models[0].failedCalls).toBeGreaterThan(0);
    expect(usage.json.usage.length).toBeGreaterThan(0);
    expect('tokensPerSec' in usage.json.usage[0]).toBe(true);
  });

  it('the dashboard marks projects with a running job', async () => {
    const e = await req('POST', `/api/projects/${projectId}/edit`, alice, { prompt: '再改一下', scope: 'global' });
    const list = await req('GET', '/api/projects', alice);
    expect(list.json.projects.find((p: any) => p.id === projectId).busy).toBe(1);
    await waitJob(e.json.job.id);
    expect((await req('GET', '/api/projects', alice)).json.projects.find((p: any) => p.id === projectId).busy).toBe(0);
  });

});
