import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compactHistory, estimateTokens, fitMaxTokens, IMAGE_TOKENS, inputBudget, MIN_OUTPUT_TOKENS, requestTokens } from '../src/context.js';
import type { ChatMessage } from '../src/llm.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ctx-'));
process.env.DATA_DIR = tmp;

const img = (n: number) => ({ type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${'A'.repeat(n)}` } });

/** A tool conversation: task, then `rounds` rounds each with a big written page, a big result and a screenshot. */
function conversation(rounds: number): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '任务：修改材料' },
  ];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: 'assistant',
      content: `第 ${i} 轮`,
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: `pages/p${i}.html`, content: 'x'.repeat(6000) }) } }],
    });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: `结果${i} ${'y'.repeat(4000)}` });
    msgs.push({ role: 'user', content: [{ type: 'text', text: '以下是上述工具调用返回的图片：' }, img(100)] });
  }
  return msgs;
}

/** Every tool message must directly follow the assistant message (or other tool messages) that called it. */
function wellFormed(msgs: ChatMessage[]) {
  const open = new Set<string>();
  for (const m of msgs) {
    if (m.role === 'assistant') {
      open.clear();
      for (const tc of m.tool_calls ?? []) open.add(tc.id);
    } else if (m.role === 'tool') {
      if (!open.has(m.tool_call_id!)) return false;
    } else open.clear();
  }
  return true;
}

describe('context budget', () => {
  it('estimates CJK as one token per character and other text at ~3.5 characters', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('a'.repeat(35))).toBe(10);
    expect(requestTokens([{ role: 'user', content: [{ type: 'text', text: '' }, img(10)] }])).toBe(6 + IMAGE_TOKENS);
  });

  it('fits max_tokens into what the context has left', () => {
    expect(fitMaxTokens(200_000, 50_000, 65_536)).toBe(65_536);
    expect(fitMaxTokens(200_000, 150_000, 65_536)).toBe(Math.floor(200_000 * 0.94) - 150_000);
    expect(fitMaxTokens(200_000, 199_000, 65_536)).toBe(MIN_OUTPUT_TOKENS);
    expect(fitMaxTokens(200_000, 10_000, undefined)).toBeUndefined();
  });

  it('leaves short conversations alone', () => {
    const msgs = conversation(2);
    const r = compactHistory(msgs, 1_000_000);
    expect(r.messages).toEqual(msgs);
    expect(r.steps).toEqual([]);
  });

  it('first drops old screenshots, then old results and written content, keeping recent rounds', () => {
    const msgs = conversation(6);
    const full = requestTokens(msgs);
    const r1 = compactHistory(msgs, full - 3 * IMAGE_TOKENS);
    expect(r1.steps).toEqual(['images']);
    expect(r1.messages.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))).toHaveLength(2);
    expect(JSON.stringify(r1.messages)).toContain('早先的图片已省略');

    const r2 = compactHistory(msgs, Math.floor(full * 0.5));
    expect(r2.steps).toEqual(['images', 'results']);
    expect(r2.tokens).toBeLessThanOrEqual(Math.floor(full * 0.5));
    const tool0 = r2.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c0')!;
    expect(tool0.content).toContain('已省略其余部分');
    const call0 = r2.messages.find((m) => m.tool_calls?.[0].id === 'c0')!;
    const args = JSON.parse(call0.tool_calls![0].function.arguments);
    expect(args.path).toBe('pages/p0.html');
    expect(args.content).toContain('已执行，省略 6000 字符');
    const last = r2.messages.find((m) => m.tool_calls?.[0].id === 'c5')!;
    expect(JSON.parse(last.tool_calls![0].function.arguments).content).toHaveLength(6000);
    expect(wellFormed(r2.messages)).toBe(true);
  });

  it('folds the oldest rounds into an action log when that is not enough', () => {
    const msgs = conversation(12);
    const r = compactHistory(msgs, 9_000);
    expect(r.steps).toContain('rounds');
    expect(r.tokens).toBeLessThanOrEqual(9_000);
    expect(r.messages.slice(0, 2)).toEqual(msgs.slice(0, 2));
    const note = r.messages[2];
    expect(note.role).toBe('user');
    expect(note.content).toMatch(/^［上下文压缩］/);
    expect(note.content).toContain('write_file(path=pages/p0.html)');
    expect(r.messages.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'c11' });
    expect(wellFormed(r.messages)).toBe(true);
    // Compacting again merges into the same note.
    const again = compactHistory([...r.messages, ...conversation(13).slice(-3)], 9_000);
    expect(again.messages.filter((m) => typeof m.content === 'string' && m.content.startsWith('［上下文压缩］'))).toHaveLength(1);
  });

  it('as a last resort shortens the task text from the middle', () => {
    const big: ChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: [{ type: 'text', text: `开头${'资料'.repeat(20_000)}结尾` }, img(10)] },
    ];
    const r = compactHistory(big, 8_000);
    expect(r.tokens).toBeLessThanOrEqual(8_000);
    const text = (r.messages[1].content as { type: string; text?: string }[]).find((p) => p.type === 'text')!.text!;
    expect(text.startsWith('开头')).toBe(true);
    expect(text.endsWith('结尾')).toBe(true);
    expect(text).toContain('为适应模型上下文已省略中间');
  });
});

describe('requests against a small context window', () => {
  let server: http.Server;
  let base = '';
  const bodies: any[] = [];
  let db: import('../src/db.js').DB;
  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      bodies.push(body);
      // This "model" rejects requests asking for more than 6000 output tokens, like a provider with a small window.
      if (req.url!.startsWith('/small') && body.max_tokens > 6000) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `This model's maximum context length is 20000 tokens. However, you requested ${body.max_tokens} tokens.` } }));
        return;
      }
      const tools = body.tools?.length && body.tool_choice !== 'none' && body.messages.filter((m: any) => m.role === 'tool').length < 8;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (tools) {
        const n = body.messages.filter((m: any) => m.role === 'tool').length;
        res.end(
          JSON.stringify({
            choices: [{ message: { content: null, tool_calls: [{ id: `t${n}`, type: 'function', function: { name: 'look', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
          }),
        );
      } else res.end(JSON.stringify({ choices: [{ message: { content: '完成' }, finish_reason: 'stop' }] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { openDb } = await import('../src/db.js');
    db = openDb(path.join(tmp, 'ctx.db'));
  });
  afterAll(() => {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const useEndpoint = (prefix: string) => {
    db.prepare('DELETE FROM llm_endpoints').run();
    db.prepare(`INSERT INTO llm_endpoints (name, base_url, api_key, model, created_at) VALUES ('e', ?, 'k', 'm', 0)`).run(`${base}/${prefix}/v1`);
  };

  it('retries with less output when the endpoint says the request is too long', async () => {
    useEndpoint('small');
    const { chat } = await import('../src/llm.js');
    bodies.length = 0;
    const r = await chat(db, 1, [{ role: 'user', content: 'hi' }], { maxTokens: 32_000, contextTokens: 200_000 });
    expect(r.text).toBe('完成');
    expect(bodies.map((b) => b.max_tokens)).toEqual([32_000, 16_000, 8_000, 4_096]);
  });

  it('clamps max_tokens to the window and compacts a long tool loop', async () => {
    useEndpoint('big');
    const { chatWithTools } = await import('../src/llm.js');
    bodies.length = 0;
    const steps: string[][] = [];
    const r = await chatWithTools(db, 1, [{ role: 'system', content: 's' }, { role: 'user', content: '任务' }], {
      tools: [{ type: 'function', function: { name: 'look', description: '', parameters: { type: 'object', properties: {} } } }],
      execute: async () => ({ content: '结果'.repeat(3000), images: [{ label: '图', url: 'data:image/jpeg;base64,AAAA' }] }),
      maxRounds: 20,
      maxTokens: 65_536,
      contextTokens: 30_000,
      onCompact: (s) => steps.push(s),
    });
    expect(r.text).toBe('完成');
    expect(steps.length).toBeGreaterThan(0);
    const budget = inputBudget(30_000, 24_000);
    for (const b of bodies) {
      expect(b.max_tokens).toBeLessThanOrEqual(Math.floor(30_000 * 0.94));
      expect(b.max_tokens).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
      expect(wellFormed(b.messages)).toBe(true);
    }
    expect(requestTokens(bodies.at(-1).messages)).toBeLessThanOrEqual(Math.max(budget, requestTokens(bodies[0].messages)) + 100);
  });
});
