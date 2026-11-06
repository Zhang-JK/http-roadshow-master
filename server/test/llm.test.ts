import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatWithEndpoint, rankEndpointsForUser, type Endpoint } from '../src/llm.js';

describe('timeouts for slow models', () => {
  const sse = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      for await (const _ of req);
      const mode = req.url!.split('/')[1];
      if (mode === 'prefill') await sleep(1500);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (mode === 'slow') {
        // 1.6 s in total, far longer than the idle timeout, but never silent for long.
        for (let i = 0; i < 8 && !res.destroyed; i++) {
          res.write(sse(`片段${i}`));
          await sleep(200);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else if (mode === 'prefill') {
        res.end(sse('终于开始') + 'data: [DONE]\n\n');
      } else if (mode === 'stall') {
        res.write(sse('开头'));
      } else if (mode === 'endless') {
        while (!res.destroyed) {
          res.write(sse('x'));
          await sleep(50);
        }
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const ep = (mode: string): Endpoint => ({
    id: 1, name: 'local', base_url: `${base}/${mode}/v1`, api_key: 'k', model: 'm', weight: 1, enabled: 1,
    extra_body: '{}', last_test_at: null, last_test_ok: null, last_test_message: null, created_at: 0,
  });
  const run = (mode: string, idleTimeoutMs: number, timeoutMs: number) =>
    chatWithEndpoint(ep(mode), [{ role: 'user', content: 'hi' }], 'u', { onDelta: () => {}, idleTimeoutMs, timeoutMs });

  it('keeps a long but steady stream alive', async () => {
    const r = await run('slow', 600, 10_000);
    expect(r.text).toBe(Array.from({ length: 8 }, (_, i) => `片段${i}`).join(''));
  });

  it('aborts when the model goes silent mid-stream', async () => {
    const started = Date.now();
    await expect(run('stall', 400, 10_000)).rejects.toThrow(/没有返回任何数据（已收到 2 字符）/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('counts a slow prefill (no response headers yet) as silence', async () => {
    await expect(run('prefill', 500, 10_000)).rejects.toThrow(/没有返回任何数据（尚未开始输出）/);
    expect((await run('prefill', 3000, 10_000)).text).toBe('终于开始');
  });

  it('stops an endless stream at the overall cap', async () => {
    await expect(run('endless', 5000, 700)).rejects.toThrow(/单次调用超过 .* 分钟上限（已收到 \d+ 字符）/);
  });
});

describe('per-user sticky load balancing', () => {
  const eps = [
    { id: 1, weight: 1 },
    { id: 2, weight: 1 },
    { id: 3, weight: 1 },
  ];

  it('is deterministic for a user and returns all endpoints as failover order', () => {
    const a = rankEndpointsForUser(eps, 'rs-user-7').map((e) => e.id);
    const b = rankEndpointsForUser([...eps].reverse(), 'rs-user-7').map((e) => e.id);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([1, 2, 3]);
  });

  it('spreads users roughly evenly and respects weights', () => {
    const count = (list: typeof eps) => {
      const c: Record<number, number> = {};
      for (let u = 0; u < 3000; u++) {
        const id = rankEndpointsForUser(list, `rs-user-${u}`)[0].id;
        c[id] = (c[id] ?? 0) + 1;
      }
      return c;
    };
    const even = count(eps);
    for (const id of [1, 2, 3]) expect(even[id]).toBeGreaterThan(800);
    const weighted = count([{ id: 1, weight: 3 }, { id: 2, weight: 1 }]);
    expect(weighted[1] / 3000).toBeGreaterThan(0.68);
    expect(weighted[1] / 3000).toBeLessThan(0.82);
  });

  it('only moves users of a removed endpoint (cache-friendly)', () => {
    let moved = 0;
    for (let u = 0; u < 1000; u++) {
      const before = rankEndpointsForUser(eps, `rs-user-${u}`)[0].id;
      const after = rankEndpointsForUser(eps.filter((e) => e.id !== 3), `rs-user-${u}`)[0].id;
      if (before !== 3 && before !== after) moved++;
    }
    expect(moved).toBe(0);
  });
});
