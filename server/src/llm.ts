import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { DB } from './db.js';
import { config } from './config.js';

export interface Endpoint {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  weight: number;
  enabled: number;
  extra_body: string;
  last_test_at: number | null;
  last_test_ok: number | null;
  last_test_message: string | null;
  created_at: number;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  onDelta?: (chunk: string, totalChars: number) => void;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  endpointId: number;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
  finishReason?: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

export function listEnabledEndpoints(db: DB): Endpoint[] {
  return db.prepare('SELECT * FROM llm_endpoints WHERE enabled = 1 ORDER BY id').all() as Endpoint[];
}

/**
 * Weighted rendezvous hashing: each user is pinned to one endpoint so that the provider-side
 * prompt cache stays warm; when endpoints are added/removed only a minimal share of users move.
 * Returns endpoints ordered by preference (first = primary, the rest = failover order).
 */
export function rankEndpointsForUser<T extends { id: number; weight: number }>(endpoints: T[], userKey: string): T[] {
  const scored = endpoints.map((ep) => {
    const h = crypto.createHash('sha256').update(`${userKey}:${ep.id}`).digest();
    const u = (h.readUInt32BE(0) + 1) / 4294967297;
    const score = -Math.max(ep.weight, 0.0001) / Math.log(u);
    return { ep, score };
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.ep);
}

function chatUrl(baseUrl: string) {
  const b = baseUrl.replace(/\/+$/, '');
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
}

function parseExtra(ep: Endpoint): Record<string, unknown> {
  try {
    const v = JSON.parse(ep.extra_body || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export async function chatWithEndpoint(
  ep: Endpoint,
  messages: ChatMessage[],
  userKey: string,
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const stream = !!opts.onDelta;
  const body: Record<string, unknown> = {
    model: ep.model,
    messages,
    stream,
    user: userKey,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...parseExtra(ep),
  };
  if (stream) body.stream_options = { include_usage: true };
  const timeout = AbortSignal.timeout(config.llmTimeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(chatUrl(ep.base_url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ep.api_key}`,
        'HTTP-Referer': 'https://roadshow-studio.local',
        'X-Title': 'Roadshow Studio',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new LlmError(`无法连接接入点 ${ep.name}: ${(e as Error).message}`, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
    throw new LlmError(`接入点 ${ep.name} 返回 HTTP ${res.status}: ${text.slice(0, 500)}`, retryable);
  }
  const result: ChatResult = { text: '', endpointId: ep.id, model: ep.model };
  if (!stream) {
    const data = (await res.json()) as any;
    if (data.error) throw new LlmError(`接入点 ${ep.name} 错误: ${JSON.stringify(data.error).slice(0, 500)}`, true);
    result.text = data.choices?.[0]?.message?.content ?? '';
    result.finishReason = data.choices?.[0]?.finish_reason;
    applyUsage(result, data.usage);
    return result;
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let data: any;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      if (data.error) throw new LlmError(`接入点 ${ep.name} 流式错误: ${JSON.stringify(data.error).slice(0, 500)}`, true);
      const delta = data.choices?.[0]?.delta?.content;
      if (delta) {
        result.text += delta;
        opts.onDelta!(delta, result.text.length);
      }
      const fr = data.choices?.[0]?.finish_reason;
      if (fr) result.finishReason = fr;
      if (data.usage) applyUsage(result, data.usage);
    }
  }
  if (!result.text) throw new LlmError(`接入点 ${ep.name} 返回了空内容`, true);
  return result;
}

function applyUsage(result: ChatResult, usage: any) {
  if (!usage) return;
  result.promptTokens = usage.prompt_tokens;
  result.completionTokens = usage.completion_tokens;
  if (typeof usage.cost === 'number') result.cost = usage.cost;
}

export async function chat(db: DB, userId: number, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const endpoints = listEnabledEndpoints(db);
  if (!endpoints.length) throw new LlmError('尚未配置任何可用的大模型接入点，请联系管理员在「模型接入」中添加', false);
  const userKey = `rs-user-${userId}`;
  const ranked = rankEndpointsForUser(endpoints, userKey);
  const errors: string[] = [];
  for (const ep of ranked) {
    try {
      return await chatWithEndpoint(ep, messages, userKey, opts);
    } catch (e) {
      errors.push((e as Error).message);
      if (e instanceof LlmError && !e.retryable) break;
      if (opts.signal?.aborted) break;
    }
  }
  throw new LlmError(errors.join('\n'), false);
}

function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface TestResult {
  ok: boolean;
  textOk: boolean;
  visionOk: boolean;
  latencyMs: number;
  message: string;
  reply?: string;
}

/** Connectivity test: a text round-trip plus a vision check (identify the colour of a solid image). */
export async function testEndpoint(ep: Endpoint): Promise<TestResult> {
  const started = Date.now();
  const colors: [string, [number, number, number]][] = [
    ['red', [230, 20, 20]],
    ['green', [20, 180, 40]],
    ['blue', [20, 40, 230]],
    ['yellow', [250, 220, 0]],
  ];
  const [name, rgb] = colors[Math.floor(Math.random() * colors.length)];
  const png = solidPng(64, 64, rgb).toString('base64');
  try {
    const r = await chatWithEndpoint(
      ep,
      [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Connectivity test. Look at the attached image: it is filled with one single colour. Reply with exactly one lowercase English word: red, green, blue or yellow.',
            },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
          ],
        },
      ],
      'rs-connectivity-test',
      { maxTokens: 2000 },
    );
    const reply = r.text.trim().toLowerCase();
    const visionOk = reply.includes(name);
    return {
      ok: visionOk,
      textOk: true,
      visionOk,
      latencyMs: Date.now() - started,
      reply: r.text.slice(0, 200),
      message: visionOk
        ? `连通正常，多模态识别正确（${name}）`
        : `文本连通正常，但多模态识别失败：期望 ${name}，模型回复 “${r.text.slice(0, 80)}”。该模型可能不支持图像输入`,
    };
  } catch (e) {
    const msg = (e as Error).message;
    const visionRejected = /image|vision|modal/i.test(msg);
    return {
      ok: false,
      textOk: false,
      visionOk: false,
      latencyMs: Date.now() - started,
      message: visionRejected ? `模型拒绝了图像输入（不支持多模态）: ${msg}` : msg,
    };
  }
}
