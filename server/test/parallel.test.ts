import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Endpoint } from '../src/llm.js';
import { startMockLlm } from './mockLlm.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-parallel-'));
process.env.DATA_DIR = tmp;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Test "models", chosen by the first path segment; each answers after 80 ms in 4 chunks 30 ms apart.
 *   slots-K   processes K requests at a time, the others wait for a free slot before any response
 *   early-K   the same, but sends the response headers at once and only the tokens wait
 *   limit-K   rejects requests beyond K with HTTP 429
 *   fail      always HTTP 503
 *   free-*    no limit
 */
function startModels() {
  const active = new Map<string, number>();
  const waiting = new Map<string, (() => void)[]>();
  const peak = new Map<string, number>();
  const served = new Map<string, number>();
  const server = http.createServer(async (req, res) => {
    for await (const _ of req);
    const name = req.url!.split('/')[1];
    const [kind, k] = [name.split('-')[0], Number(name.split('-')[1])];
    const limited = kind === 'slots' || kind === 'early' || kind === 'limit';
    if (kind === 'fail') return void res.writeHead(503).end(JSON.stringify({ error: { message: 'down' } }));
    if (kind === 'limit' && (active.get(name) ?? 0) >= k) return void res.writeHead(429).end(JSON.stringify({ error: { message: 'too many requests' } }));
    if (kind === 'early') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
    }
    if (limited && (active.get(name) ?? 0) >= k) await new Promise<void>((r) => waiting.set(name, [...(waiting.get(name) ?? []), r]));
    else active.set(name, (active.get(name) ?? 0) + 1);
    peak.set(name, Math.max(peak.get(name) ?? 0, active.get(name)!));
    served.set(name, (served.get(name) ?? 0) + 1);
    await sleep(80);
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < 4; i++) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${i * 25 + 1} … ${i * 25 + 25} ` } }] })}\n\n`);
      await sleep(30);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
    const next = waiting.get(name)?.shift();
    if (next) next();
    else active.set(name, active.get(name)! - 1);
  });
  return { server, peak, served };
}

describe('parallel capacity test', () => {
  const models = startModels();
  let base = '';
  let db: import('../src/db.js').DB;

  beforeAll(async () => {
    await new Promise<void>((r) => models.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(models.server.address() as AddressInfo).port}`;
    const { openDb } = await import('../src/db.js');
    db = openDb(path.join(tmp, 'parallel.db'));
  });
  afterAll(() => {
    models.server.closeAllConnections();
    models.server.close();
  });

  /** The only enabled endpoint, pointing at one of the test models. */
  const endpoint = (name: string, maxConcurrency = 0): Endpoint => {
    db.prepare('DELETE FROM llm_endpoints').run();
    const id = db
      .prepare(`INSERT INTO llm_endpoints (name, base_url, api_key, model, max_concurrency, created_at) VALUES (?, ?, 'k', 'm', ?, 0)`)
      .run(name, `${base}/${name}/v1`, maxConcurrency).lastInsertRowid;
    return db.prepare('SELECT * FROM llm_endpoints WHERE id = ?').get(id) as Endpoint;
  };
  const probe = async (ep: Endpoint) => {
    const { testParallel } = await import('../src/llm.js');
    return testParallel(ep, { idleTimeoutMs: 10_000, timeoutMs: 60_000 });
  };

  it.each([1, 2, 3, 4, 5])('finds an endpoint that answers %i requests at a time', async (k) => {
    const r = await probe(endpoint(`slots-${k}`));
    expect(r.maxParallel).toBe(k);
    expect(models.peak.get(`slots-${k}`)).toBe(k);
    expect(r.busy).toBe(0);
    const parallel = r.levels.slice(0, k);
    expect(parallel.map((l) => l.n)).toEqual([1, 2, 3, 4, 5].slice(0, k));
    for (const l of parallel) expect(l).toMatchObject({ ok: l.n, concurrent: l.n, queued: false, error: undefined });
    if (k < 5) {
      // One more request than slots: all succeed, but the extra one only starts after another has finished.
      expect(r.levels).toHaveLength(k + 1);
      expect(r.levels[k]).toMatchObject({ n: k + 1, ok: k + 1, concurrent: k, queued: true });
      expect(r.levels[k].wallMs).toBeGreaterThanOrEqual(r.levels[0].wallMs * 1.5);
      expect(r.suggested).toBe(k);
      expect(r.message).toContain(`建议把并发上限设为 ${k}`);
      expect(models.served.get(`slots-${k}`)).toBe(((k + 1) * (k + 2)) / 2);
    } else {
      expect(r.levels).toHaveLength(5);
      expect(r.suggested).toBe(0);
      expect(r.message).toContain('一般无需设置并发上限');
      expect(models.served.get('slots-5')).toBe(15);
    }
  });

  it('detects queueing when the endpoint sends headers at once and only the tokens wait', async () => {
    const r = await probe(endpoint('early-2'));
    expect(r).toMatchObject({ maxParallel: 2, suggested: 2 });
    expect(r.levels.map((l) => l.queued)).toEqual([false, false, true]);
  });

  it('stops at the first level with a rejected request', async () => {
    const r = await probe(endpoint('limit-3'));
    expect(r).toMatchObject({ maxParallel: 3, suggested: 3 });
    expect(r.levels).toHaveLength(4);
    expect(r.levels[3]).toMatchObject({ n: 4, ok: 3, queued: false });
    expect(r.levels[3].error).toMatch(/HTTP 429/);
    expect(r.message).toContain('有 1 个失败，最多可同时处理 3 个');
  });

  it('reports an endpoint that fails even a single request', async () => {
    const r = await probe(endpoint('fail'));
    expect(r).toMatchObject({ maxParallel: 0, suggested: null });
    expect(r.levels).toEqual([expect.objectContaining({ n: 1, ok: 0, concurrent: 0, maxFirstTokenMs: null })]);
    expect(r.message).toMatch(/^单个请求就失败了：.*HTTP 503/);
  });

  it('tests up to 5 requests, bypassing the endpoint\'s own parallel limit, and notes requests already running', async () => {
    const { chat, inflightCount } = await import('../src/llm.js');
    const ep = endpoint('free-a', 1);
    const running = chat(db, 1, [{ role: 'user', content: '你好' }], { onDelta: () => {} });
    await sleep(20);
    const r = await probe(ep);
    await running;
    expect(r).toMatchObject({ maxParallel: 5, suggested: 0, busy: 1 });
    expect(r.levels.map((l) => [l.n, l.concurrent])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
    expect(models.peak.get('free-a')).toBe(5);
    expect(models.served.get('free-a')).toBe(16);
    expect(inflightCount(ep.id)).toBe(0);
  });

  it.each([1, 2, 3, 4, 5])('never sends more than a parallel limit of %i requests at once', async (k) => {
    const { chat, inflightCount } = await import('../src/llm.js');
    const ep = endpoint(`free-cap${k}`, k);
    const replies = await Promise.all(Array.from({ length: 7 }, (_, i) => chat(db, i + 1, [{ role: 'user', content: '你好' }], { onDelta: () => {} })));
    expect(replies.every((x) => x.text.startsWith('1 … 25'))).toBe(true);
    expect(models.served.get(`free-cap${k}`)).toBe(7);
    expect(models.peak.get(`free-cap${k}`)).toBe(k);
    expect(inflightCount(ep.id)).toBe(0);
  });
});

describe('endpoint network options over the API', () => {
  let app: FastifyInstance;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let apiDb: import('../src/db.js').DB;
  let admin = '';
  let alice = '';
  let epId = 0;

  const cookieOf = (res: any) => String([res.headers['set-cookie']].flat()[0]).split(';')[0];
  const req = async (method: string, url: string, cookie: string, payload?: unknown) => {
    const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
    return { status: res.statusCode, json: res.json() as any };
  };

  beforeAll(async () => {
    mock = await startMockLlm();
    const { openDb } = await import('../src/db.js');
    const { buildApp } = await import('../src/app.js');
    apiDb = openDb(path.join(tmp, 'api.db'));
    app = await buildApp(apiDb, { serveWeb: false });
    admin = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } }));
    await req('POST', '/api/users', admin, { username: 'alice', password: 'alice123', displayName: '爱丽丝' });
    alice = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'alice123' } }));
    epId = (await req('POST', '/api/llm/endpoints', admin, { name: '本地', baseUrl: mock.url, model: 'mock', apiKey: 'good-key' })).json.endpoint.id;
  });
  afterAll(async () => {
    await app?.close();
    await mock?.close();
  });

  it('uses the system proxy by default and stores the choice per endpoint', async () => {
    const list = await req('GET', '/api/llm/endpoints', admin);
    expect(list.json.systemProxy).toBeNull();
    expect(list.json.endpoints[0]).toMatchObject({ id: epId, useProxy: true });
    expect((await req('PUT', `/api/llm/endpoints/${epId}`, admin, { useProxy: false })).status).toBe(200);
    expect((await req('GET', '/api/llm/endpoints', admin)).json.endpoints[0].useProxy).toBe(false);
    expect((apiDb.prepare('SELECT use_proxy FROM llm_endpoints WHERE id = ?').get(epId) as any).use_proxy).toBe(0);
    const other = await req('POST', '/api/llm/endpoints', admin, { name: '直连', baseUrl: mock.url, model: 'mock', apiKey: 'good-key', useProxy: false });
    expect(other.json.endpoint.useProxy).toBe(false);
    await req('DELETE', `/api/llm/endpoints/${other.json.endpoint.id}`, admin);
    // Testing a configuration before saving it honours the option too.
    const adhoc = await req('POST', '/api/llm/test', admin, { name: 't', baseUrl: mock.url, model: 'mock', apiKey: 'good-key', useProxy: false });
    expect(adhoc.json.result.ok).toBe(true);
  });

  it('runs the parallel test for admins only and one at a time per endpoint', async () => {
    expect((await req('POST', `/api/llm/endpoints/${epId}/parallel-test`, alice)).status).toBe(403);
    expect((await req('POST', '/api/llm/endpoints/9999/parallel-test', admin)).status).toBe(404);
    const [a, b] = await Promise.all([
      req('POST', `/api/llm/endpoints/${epId}/parallel-test`, admin),
      sleep(20).then(() => req('POST', `/api/llm/endpoints/${epId}/parallel-test`, admin)),
    ]);
    expect(b.status).toBe(409);
    expect(a.status).toBe(200);
    expect(a.json.result).toMatchObject({ maxParallel: 5, suggested: 0, busy: 0 });
    expect(a.json.result.levels.map((l: any) => [l.n, l.ok, l.concurrent, l.queued])).toEqual([
      [1, 1, 1, false],
      [2, 2, 2, false],
      [3, 3, 3, false],
      [4, 4, 4, false],
      [5, 5, 5, false],
    ]);
    // Test requests are not usage.
    expect((apiDb.prepare('SELECT COUNT(*) AS n FROM llm_calls').get() as any).n).toBe(0);
    // The test is repeatable once finished.
    expect((await req('POST', `/api/llm/endpoints/${epId}/parallel-test`, admin)).status).toBe(200);
  });
});
