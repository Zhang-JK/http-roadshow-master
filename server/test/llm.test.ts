import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatWithEndpoint, listEnabledEndpoints, type Endpoint } from '../src/llm.js';

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
    id: 1, name: 'local', base_url: `${base}/${mode}/v1`, api_key: 'k', model: 'm', priority: 1, enabled: 1,
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

describe('endpoint priority', () => {
  it('starts existing endpoints in the order of their old weights, heaviest first', async () => {
    const { MIGRATIONS, openDb } = await import('../src/db.js');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-priority-')), 'old.db');
    let db = openDb(file);
    // Back to the schema before endpoints had a priority.
    const version = MIGRATIONS.findIndex((m) => m.includes('ADD COLUMN priority')) + 1;
    db.prepare('DELETE FROM _migrations WHERE version = ?').run(version);
    db.exec('ALTER TABLE llm_endpoints DROP COLUMN priority');
    const insert = db.prepare(`INSERT INTO llm_endpoints (name, base_url, api_key, model, weight, created_at) VALUES (?, 'http://x', 'k', 'm', ?, 0)`);
    for (const [name, weight] of [['a', 1], ['b', 5], ['c', 1], ['d', 3]] as const) insert.run(name, weight);
    db.close();

    db = openDb(file);
    const rows = db.prepare('SELECT name, priority FROM llm_endpoints ORDER BY id').all();
    expect(rows).toEqual([
      { name: 'a', priority: 3 },
      { name: 'b', priority: 1 },
      { name: 'c', priority: 4 },
      { name: 'd', priority: 2 },
    ]);
    expect(listEnabledEndpoints(db).map((e) => e.name)).toEqual(['b', 'd', 'a', 'c']);
    db.close();
  });
});
