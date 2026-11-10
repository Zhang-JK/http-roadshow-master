import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { getSettings, type DB } from './db.js';
import type { ToolDef, ToolOutput } from './fileTools.js';
import { compactHistory, DEFAULT_CONTEXT_TOKENS, estimateTokens, fitMaxTokens, inputBudget, MIN_OUTPUT_TOKENS, requestTokens } from './context.js';
import { liveCalls, recordCall, type LiveCall } from './calls.js';
import { activeProxy, directDispatcher } from './proxy.js';

export const DEFAULT_IDLE_TIMEOUT_SEC = 600;
export const DEFAULT_MAX_CALL_MINUTES = 120;

export interface Endpoint {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  weight: number;
  enabled: number;
  extra_body: string;
  /** Requests sent to this endpoint at the same time (0 = no limit); more wait in our own queue. */
  max_concurrency: number;
  /** 0: connect directly, ignoring HTTPS_PROXY / HTTP_PROXY (models deployed locally). */
  use_proxy: number;
  last_test_at: number | null;
  last_test_ok: number | null;
  last_test_message: string | null;
  created_at: number;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  onDelta?: (chunk: string, totalChars: number) => void;
  onReasoning?: (totalChars: number) => void;
  signal?: AbortSignal;
  /** Abort when the endpoint sends nothing (no headers, no stream data) for this long. */
  idleTimeoutMs?: number;
  /** Hard cap on one request, however steadily it streams. */
  timeoutMs?: number;
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none';
  /** Treat an empty reply as a valid answer instead of an endpoint failure. */
  allowEmpty?: boolean;
  /** The model's context window; max_tokens is reduced (and long input compacted) to fit it. */
  contextTokens?: number;
  /** The job the call belongs to: the call is recorded and shown live. */
  jobId?: string;
  stage?: string;
  /** Output so far (text, reasoning, tool arguments): characters and estimated tokens. */
  onStream?: (p: { chars: number; tokens: number }) => void;
}

export interface ChatResult {
  text: string;
  endpointId: number;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
  finishReason?: string;
  toolCalls?: ToolCall[];
  /** When the first output (text, reasoning or tool call) arrived. */
  firstTokenAt?: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    public status?: number,
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
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? 'auto';
  }
  if (stream) body.stream_options = { include_usage: true };

  // Slow (e.g. self-hosted) models can stream for a long time, so a request is only cut off when the
  // endpoint goes silent, or when it reaches the overall cap. A non-streamed reply arrives in one piece,
  // so only the cap applies to it.
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_SEC * 1000;
  const capMs = opts.timeoutMs ?? DEFAULT_MAX_CALL_MINUTES * 60_000;
  const timer = new AbortController();
  let timedOut = '';
  let received = 0;
  const expire = (why: string) => {
    timedOut = why;
    timer.abort(new Error(why));
  };
  let idle: NodeJS.Timeout | undefined;
  const alive = () => {
    if (!stream) return;
    clearTimeout(idle);
    idle = setTimeout(
      () => expire(`接入点 ${ep.name} 已 ${Math.round(idleMs / 1000)} 秒没有返回任何数据${received ? `（已收到 ${received.toLocaleString()} 字符）` : '（尚未开始输出）'}，已中止。模型较慢或输入较长时可在「模型接入 → 生成设置」中调大「无响应超时」`),
      idleMs,
    );
  };
  const cap = setTimeout(
    () => expire(`接入点 ${ep.name} 单次调用超过 ${Math.round(capMs / 60_000)} 分钟上限${received ? `（已收到 ${received.toLocaleString()} 字符）` : ''}，已中止。可在「模型接入 → 生成设置」中调大「单次调用上限」或减小「最大输出 tokens」`),
    capMs,
  );
  const signal = opts.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal;
  const failure = (e: unknown, what: string) =>
    timedOut ? new LlmError(timedOut, true) : opts.signal?.aborted ? (e as Error) : new LlmError(`${what}: ${(e as Error).message}`, true);
  alive();
  try {
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
        ...(ep.use_proxy === 0 ? { dispatcher: directDispatcher() } : {}),
      } as RequestInit);
    } catch (e) {
      const err = failure(e, `无法连接接入点 ${ep.name}`);
      if (err instanceof LlmError && !timedOut) {
        const proxy = ep.use_proxy !== 0 && activeProxy();
        const cause = (e as { cause?: Error }).cause?.message;
        if (proxy) err.message += `。请求经过系统代理 ${proxy}；模型部署在本机或内网、代理访问不到时，请在「模型接入」中关闭这个接入点的「使用系统代理」`;
        else if (cause) err.message += `（${cause}）`;
      }
      throw err;
    }
    alive();
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
      throw new LlmError(`接入点 ${ep.name} 返回 HTTP ${res.status}: ${text.slice(0, 500)}`, retryable, res.status);
    }
    const result: ChatResult = { text: '', endpointId: ep.id, model: ep.model };
    if (!stream) {
      let data: any;
      try {
        data = await res.json();
      } catch (e) {
        throw failure(e, `接入点 ${ep.name} 响应读取失败`);
      }
      if (data.error) throw new LlmError(`接入点 ${ep.name} 错误: ${JSON.stringify(data.error).slice(0, 500)}`, true);
      result.text = data.choices?.[0]?.message?.content ?? '';
      const calls = data.choices?.[0]?.message?.tool_calls;
      if (Array.isArray(calls) && calls.length) result.toolCalls = calls;
      result.finishReason = data.choices?.[0]?.finish_reason;
      applyUsage(result, data.usage);
      return result;
    }
    return await readStream(ep, res, result, opts, (n) => {
      received = n;
      alive();
    }).catch((e) => {
      throw e instanceof LlmError ? e : failure(e, `接入点 ${ep.name} 连接中断`);
    });
  } finally {
    clearTimeout(idle);
    clearTimeout(cap);
  }
}

async function readStream(ep: Endpoint, res: Response, result: ChatResult, opts: ChatOptions, onData: (chars: number) => void): Promise<ChatResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let reasoningChars = 0;
  let toolChars = 0;
  let tokens = 0;
  const calls: ToolCall[] = [];
  const out = (chunk: string) => {
    if (!chunk) return;
    result.firstTokenAt ??= Date.now();
    tokens += estimateTokens(chunk);
  };
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
      const reasoning = data.choices?.[0]?.delta?.reasoning ?? data.choices?.[0]?.delta?.reasoning_content;
      if (reasoning) {
        out(reasoning);
        reasoningChars += reasoning.length;
        opts.onReasoning?.(reasoningChars);
      }
      const delta = data.choices?.[0]?.delta?.content;
      if (delta) {
        out(delta);
        result.text += delta;
        opts.onDelta!(delta, result.text.length);
      }
      for (const tc of data.choices?.[0]?.delta?.tool_calls ?? []) {
        const i = typeof tc.index === 'number' ? tc.index : calls.length;
        const c = (calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) {
          out(tc.function.name);
          c.function.name += tc.function.name;
        }
        if (tc.function?.arguments) {
          out(tc.function.arguments);
          toolChars += tc.function.arguments.length;
          c.function.arguments += tc.function.arguments;
        }
      }
      const fr = data.choices?.[0]?.finish_reason;
      if (fr) result.finishReason = fr;
      if (data.usage) applyUsage(result, data.usage);
    }
    onData(result.text.length + reasoningChars + toolChars);
    if (tokens) opts.onStream?.({ chars: result.text.length + reasoningChars + toolChars, tokens });
  }
  const toolCalls = calls.filter((c) => c && c.function.name);
  if (toolCalls.length) {
    toolCalls.forEach((c, i) => (c.id ||= `call_${i}_${Date.now()}`));
    result.toolCalls = toolCalls;
    return result;
  }
  if (!result.text && !opts.allowEmpty) throw new LlmError(`接入点 ${ep.name} 返回了空内容`, true);
  return result;
}

export function callTimeouts(db: DB): Pick<ChatOptions, 'idleTimeoutMs' | 'timeoutMs' | 'contextTokens'> {
  const s = getSettings(db);
  return {
    idleTimeoutMs: (Number(s.llmIdleTimeoutSec) || DEFAULT_IDLE_TIMEOUT_SEC) * 1000,
    timeoutMs: (Number(s.llmMaxCallMinutes) || DEFAULT_MAX_CALL_MINUTES) * 60_000,
    contextTokens: Number(s.contextTokens) || DEFAULT_CONTEXT_TOKENS,
  };
}

/** The endpoint rejected the request as too long for the model (input + max_tokens over the window). */
export function isContextError(e: unknown): boolean {
  if (!(e instanceof LlmError) || (e.status !== 400 && e.status !== 413 && e.status !== 422)) return false;
  return /context|maximum.{0,40}tokens|max_tokens|too long|too large|token limit|exceed|上下文|长度/i.test(e.message);
}

function applyUsage(result: ChatResult, usage: any) {
  if (!usage) return;
  result.promptTokens = usage.prompt_tokens;
  result.completionTokens = usage.completion_tokens;
  if (typeof usage.cost === 'number') result.cost = usage.cost;
}

/** Requests in flight per endpoint, and jobs waiting for a free slot. */
const inflight = new Map<number, number>();
const waiters = new Set<() => void>();

export function inflightCount(endpointId: number): number {
  return inflight.get(endpointId) ?? 0;
}

function release(endpointId: number) {
  inflight.set(endpointId, Math.max(0, inflightCount(endpointId) - 1));
  for (const w of [...waiters]) w();
}

/**
 * The endpoint for one call. Requests run in parallel across endpoints: the user's preferred
 * endpoint (rendezvous hashing, which keeps the prompt cache warm) is used while it is idle;
 * otherwise the least loaded endpoint (relative to its weight) with a free slot. When every endpoint
 * is at its parallel limit the call waits here, before any timeout starts, until a slot frees up.
 */
async function acquireEndpoint(
  candidates: Endpoint[],
  signal: AbortSignal | undefined,
  onQueue: () => void,
): Promise<Endpoint> {
  for (;;) {
    const free = candidates.filter((ep) => !ep.max_concurrency || inflightCount(ep.id) < ep.max_concurrency);
    if (free.length) {
      const load = (ep: Endpoint) => inflightCount(ep.id) / Math.max(ep.weight, 0.0001);
      const ep = inflightCount(free[0].id) === 0 ? free[0] : free.reduce((best, e) => (load(e) < load(best) ? e : best), free[0]);
      inflight.set(ep.id, inflightCount(ep.id) + 1);
      return ep;
    }
    onQueue();
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        waiters.delete(wake);
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        waiters.delete(wake);
        reject(signal!.reason ?? new Error('已取消'));
      };
      waiters.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

export async function chat(db: DB, userId: number, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const endpoints = listEnabledEndpoints(db);
  if (!endpoints.length) throw new LlmError('尚未配置任何可用的大模型接入点，请联系管理员在「模型接入」中添加', false);
  const userKey = `rs-user-${userId}`;
  const ranked = rankEndpointsForUser(endpoints, userKey);
  opts = { ...callTimeouts(db), ...opts };
  const ctx = opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const budget = inputBudget(ctx, Math.min(opts.maxTokens ?? MIN_OUTPUT_TOKENS, 16_000));
  if (requestTokens(messages, opts.tools) > budget) messages = compactHistory(messages, budget, { tools: opts.tools }).messages;
  const fitted: ChatOptions = { ...opts, maxTokens: fitMaxTokens(ctx, requestTokens(messages, opts.tools), opts.maxTokens) };
  const errors: string[] = [];
  const tried = new Set<number>();
  const jobId = opts.jobId;
  while (tried.size < ranked.length) {
    const queuedAt = Date.now();
    const ep = await acquireEndpoint(
      ranked.filter((e) => !tried.has(e.id)),
      opts.signal,
      () => {
        if (jobId && !liveCalls.get(jobId)?.queuedSince) {
          liveCalls.set(jobId, { endpointId: 0, endpointName: '', model: '', stage: opts.stage, queuedSince: queuedAt, tokens: 0 });
        }
      },
    );
    tried.add(ep.id);
    let o = fitted;
    let msgs = messages;
    let err: unknown;
    try {
      for (let attempt = 0; ; attempt++) {
        const startedAt = Date.now();
        const live = { endpointId: ep.id, endpointName: ep.name, model: ep.model, stage: opts.stage, startedAt, tokens: 0 } as LiveCall;
        if (jobId) liveCalls.set(jobId, live);
        const record = (r: Partial<ChatResult>, e?: unknown) => {
          if (!jobId) return;
          const outText = (r.text ?? '') + (r.toolCalls ?? []).map((c) => c.function.name + c.function.arguments).join('');
          const estimated = (r.completionTokens === undefined || r.promptTokens === undefined) && !(e && !live.firstTokenAt);
          recordCall(db, {
            jobId,
            userId,
            endpointId: ep.id,
            model: ep.model,
            stage: opts.stage,
            queuedMs: attempt ? 0 : startedAt - queuedAt,
            startedAt,
            firstTokenAt: r.firstTokenAt ?? live.firstTokenAt,
            endedAt: Date.now(),
            // A request rejected before any output was not processed by the model: it used no tokens.
            promptTokens: r.promptTokens ?? (e && !live.firstTokenAt ? 0 : requestTokens(msgs, o.tools)),
            completionTokens: r.completionTokens ?? (e ? live.tokens : estimateTokens(outText)),
            estimated,
            status: e ? 'error' : 'ok',
            error: e ? (e as Error).message : undefined,
          });
        };
        const tracked: ChatOptions = {
          ...o,
          onStream: (p) => {
            live.firstTokenAt ??= Date.now();
            live.tokens = p.tokens;
            o.onStream?.(p);
          },
        };
        try {
          const r = await chatWithEndpoint(ep, msgs, userKey, tracked);
          record(r);
          return r;
        } catch (e) {
          record({}, e);
          // Too long for this endpoint's model: ask for less output, and shrink the input as well.
          if (isContextError(e) && attempt < 3) {
            const out = Math.max(MIN_OUTPUT_TOKENS, Math.floor((o.maxTokens ?? 32_000) / 2));
            msgs = compactHistory(msgs, Math.floor(requestTokens(msgs, o.tools) * 0.8), { tools: o.tools }).messages;
            o = { ...o, maxTokens: out };
            continue;
          }
          err = e;
          break;
        }
      }
    } finally {
      if (jobId) liveCalls.delete(jobId);
      release(ep.id);
    }
    errors.push((err as Error).message);
    if (err instanceof LlmError && !err.retryable) break;
    if (opts.signal?.aborted) break;
  }
  throw new LlmError(errors.join('\n'), false);
}

export interface ToolLoopOptions extends ChatOptions {
  tools: ToolDef[];
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolOutput>;
  /** Called before each tool runs (for progress display). */
  onTool?: (name: string, args: Record<string, unknown>, round: number) => void;
  maxRounds?: number;
  maxImages?: number;
  /** Accept an empty final answer (when the tools themselves produce the result). */
  allowEmptyFinal?: boolean;
  /** Called with every round's result, so usage is accounted even if a later round fails. */
  onRound?: (r: ChatResult) => void;
  /** Called when the conversation had to be compacted to fit the context window. */
  onCompact?: (steps: string[]) => void;
}

export interface ToolLoopResult extends ChatResult {
  toolRounds: number;
  toolCallCount: number;
  /** The conversation including every tool round and the final assistant message. */
  history: ChatMessage[];
}

/**
 * Lets the model call (read-only) tools until it produces a final answer. Images returned by tools
 * are forwarded in a user message right after the tool results, since tool messages are text-only.
 * The last round disables tools so the model has to answer.
 */
export async function chatWithTools(db: DB, userId: number, messages: ChatMessage[], opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const { tools, execute, onTool, maxRounds = 10, maxImages = 24, allowEmptyFinal, onRound, onCompact, ...chatOpts } = opts;
  let history = [...messages];
  const ctx = chatOpts.contextTokens ?? callTimeouts(db).contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  // Room kept for each reply: tool calls are short, but a rewritten page or file can be long.
  const budget = inputBudget(ctx, Math.min(chatOpts.maxTokens ?? 24_000, 24_000));
  const total = { promptTokens: 0, completionTokens: 0, cost: 0, hasCost: false };
  let imagesLeft = maxImages;
  let toolCallCount = 0;
  for (let round = 0; ; round++) {
    const last = round >= maxRounds;
    if (last && round > 0) {
      history.push({ role: 'user', content: '（工具调用次数已用完：不要再调用或模拟调用任何工具，请直接给出最终答复。）' });
    }
    if (requestTokens(history, tools) > budget) {
      const c = compactHistory(history, budget, { keepHead: messages.length, tools });
      history = c.messages;
      onCompact?.(c.steps);
    }
    const r = await chat(db, userId, history, { ...chatOpts, contextTokens: ctx, tools, toolChoice: last ? 'none' : 'auto', allowEmpty: allowEmptyFinal });
    onRound?.(r);
    total.promptTokens += r.promptTokens ?? 0;
    total.completionTokens += r.completionTokens ?? 0;
    if (typeof r.cost === 'number') {
      total.cost += r.cost;
      total.hasCost = true;
    }
    const sum = {
      promptTokens: total.promptTokens || undefined,
      completionTokens: total.completionTokens || undefined,
      cost: total.hasCost ? total.cost : undefined,
      toolRounds: round,
      toolCallCount,
    };
    if (!r.toolCalls?.length || last) {
      if (!r.text && !allowEmptyFinal) throw new LlmError('模型在调用工具后没有给出最终结果', true);
      history.push({ role: 'assistant', content: r.text });
      return { ...r, ...sum, history };
    }
    history.push({ role: 'assistant', content: r.text || null, tool_calls: r.toolCalls });
    const images: ContentPart[] = [];
    for (const tc of r.toolCalls) {
      toolCallCount++;
      let args: Record<string, unknown> = {};
      let out: ToolOutput;
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        onTool?.(tc.function.name, args, round + 1);
        out = await execute(tc.function.name, args);
      } catch (e) {
        out = {
          content:
            r.finishReason === 'length'
              ? '错误：回复达到「最大输出 tokens」上限被截断，这个工具调用的参数不完整，未执行。请把修改拆成更小的步骤（例如每次只写一个文件或一页，或用 edit_elements / replace_in_draft 做局部修改）。'
              : `错误：工具参数无法解析（${(e as Error).message}），请传入合法的 JSON 参数`,
        };
      }
      let content = out.content;
      for (const img of out.images ?? []) {
        if (imagesLeft <= 0) {
          content += '\n（本次任务可查看的图片数量已达上限，请根据已有信息完成任务）';
          break;
        }
        imagesLeft--;
        images.push({ type: 'text', text: `${img.label}：` }, { type: 'image_url', image_url: { url: img.url } });
      }
      history.push({ role: 'tool', tool_call_id: tc.id, content });
    }
    if (images.length) history.push({ role: 'user', content: [{ type: 'text', text: '以下是上述工具调用返回的图片：' }, ...images] });
  }
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
export async function testEndpoint(ep: Endpoint, timeoutMs = DEFAULT_IDLE_TIMEOUT_SEC * 1000): Promise<TestResult> {
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
      { maxTokens: 2000, timeoutMs },
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

export const PARALLEL_TEST_MAX = 5;

export interface ParallelLevel {
  /** Requests sent at the same time. */
  n: number;
  ok: number;
  /** Requests that had started answering before the first one finished. */
  concurrent: number;
  /** The endpoint answered some of the requests only after others had finished, in two runs in a row. */
  queued: boolean;
  /** The first run looked queued, so the level was run again (its numbers are from the second run). */
  rechecked?: boolean;
  wallMs: number;
  /** Longest wait for a first token, from the moment the requests were sent. */
  maxFirstTokenMs: number | null;
  error?: string;
}

export interface ParallelTestResult {
  /** Most requests the endpoint answered at the same time, all successfully (0: not even one). */
  maxParallel: number;
  /** Value for the parallel limit: 0 = no limit needed up to the tested maximum; null when nothing worked. */
  suggested: number | null;
  levels: ParallelLevel[];
  message: string;
  /** Requests from running jobs on this endpoint when the test started (they skew the result). */
  busy: number;
  /** Each request asked the model to count from 1 to this. */
  count: number;
}

const PARALLEL_COUNT = 100;
const PARALLEL_COUNT_MAX = 600;

/**
 * Sends 1, 2, … up to `max` identical requests at once and stops at the first level where a request
 * fails or the endpoint queues them (a request only starts answering after another has finished,
 * and the level takes clearly longer than a single request). Bypasses the endpoint's parallel limit.
 *
 * Hosted APIs answer the short request fast while their first token sometimes takes a second or two
 * longer than usual, which would look like queueing. So when a single request generates for less
 * than `minGenerationMs` (or 4× its wait for the first token), the answer is lengthened, and a level
 * that looks queued is run again: a fluke rarely repeats, real queueing always does.
 */
export async function testParallel(
  ep: Endpoint,
  opts: { idleTimeoutMs: number; timeoutMs: number; max?: number; minGenerationMs?: number },
): Promise<ParallelTestResult> {
  const max = opts.max ?? PARALLEL_TEST_MAX;
  const minGenerationMs = opts.minGenerationMs ?? 3000;
  const busy = inflightCount(ep.id);
  const levels: ParallelLevel[] = [];
  let count = PARALLEL_COUNT;
  const one = async (sentAt: number, i: number) => {
    try {
      const prompt = `Parallel test: count from 1 to ${count}, separated by single spaces. Output only the numbers.`;
      const r = await chatWithEndpoint(ep, [{ role: 'user', content: prompt }], `rs-parallel-test-${i}`, {
        maxTokens: Math.max(2048, count * 4),
        temperature: 0,
        onDelta: () => {},
        allowEmpty: true,
        idleTimeoutMs: opts.idleTimeoutMs,
        timeoutMs: opts.timeoutMs,
      });
      const end = Date.now();
      return { ok: true as const, first: (r.firstTokenAt ?? end) - sentAt, end: end - sentAt };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  };
  const run = async (n: number): Promise<ParallelLevel> => {
    const sentAt = Date.now();
    const runs = await Promise.all(Array.from({ length: n }, (_, i) => one(sentAt, i)));
    const done = runs.flatMap((r) => (r.ok ? [r] : []));
    const firstEnd = Math.min(...done.map((r) => r.end));
    const wallMs = Date.now() - sentAt;
    const concurrent = done.filter((r) => r.first <= firstEnd).length;
    const base = levels[0]?.wallMs ?? wallMs;
    return {
      n,
      ok: done.length,
      concurrent,
      queued: done.length === n && concurrent < n && wallMs >= base * 1.5 && wallMs - base >= 100,
      wallMs,
      maxFirstTokenMs: done.length ? Math.max(...done.map((r) => r.first)) : null,
      error: runs.find((r) => !r.ok)?.error,
    };
  };
  let maxParallel = 0;
  let message = '';
  let suggested: number | null = null;
  for (let n = 1; n <= max; n++) {
    let level = await run(n);
    if (n === 1 && level.ok) {
      const first = level.maxFirstTokenMs!;
      const want = Math.max(minGenerationMs, 4 * first);
      const generated = level.wallMs - first;
      if (generated < want) {
        count = Math.min(PARALLEL_COUNT_MAX, Math.ceil((PARALLEL_COUNT * want) / Math.max(generated, 1) / 50) * 50);
        level = await run(1);
      }
    }
    if (level.queued) level = { ...(await run(n)), rechecked: true };
    const { concurrent, wallMs } = level;
    const base = levels[0]?.wallMs ?? wallMs;
    levels.push(level);
    if (level.ok < n) {
      suggested = maxParallel || null;
      message =
        n === 1
          ? `单个请求就失败了：${level.error}`
          : `同时发送 ${n} 个请求时有 ${n - level.ok} 个失败，最多可同时处理 ${maxParallel} 个。失败原因：${level.error}`;
      break;
    }
    if (level.queued) {
      suggested = maxParallel;
      message = `同时发送 ${n} 个请求都成功了，但接入点同时只处理了 ${concurrent} 个，其余在服务端排队（连续两次结果相同，用时是单个请求的 ${(wallMs / base).toFixed(1)} 倍）。建议把并发上限设为 ${maxParallel}，多出的请求在本地排队，不会因服务端排队触发无响应超时`;
      break;
    }
    maxParallel = n;
  }
  if (maxParallel === max) {
    suggested = 0;
    message = `同时发送 ${max} 个请求都能并行处理（测试到 ${max} 个为止），一般无需设置并发上限`;
  }
  return { maxParallel, suggested, levels, message, busy, count };
}
