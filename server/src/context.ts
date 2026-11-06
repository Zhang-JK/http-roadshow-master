/**
 * Keeping requests inside the model's context window: a rough token estimate, the output budget
 * that still fits, and compaction of long tool conversations (old tool results, written content and
 * screenshots are replaced by short notes, the oldest rounds are folded into an action log).
 */
import type { ChatMessage, ContentPart } from './llm.js';
import type { ToolDef } from './fileTools.js';

export const DEFAULT_CONTEXT_TOKENS = 200_000;
/** What an attached image costs; providers vary, this errs on the high side for 1–2 MP images. */
export const IMAGE_TOKENS = 1_600;
/** Room left for the provider's own framing and estimation error. */
const MARGIN = 0.06;
/** Output is never squeezed below this; below it the input is compacted instead. */
export const MIN_OUTPUT_TOKENS = 4_096;

/** CJK characters are about one token each, other text about 3.5 characters per token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/g)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
}

function partTokens(p: ContentPart): number {
  return p.type === 'text' ? estimateTokens(p.text) : IMAGE_TOKENS;
}

export function messageTokens(m: ChatMessage): number {
  let n = 6;
  if (typeof m.content === 'string') n += estimateTokens(m.content);
  else if (Array.isArray(m.content)) for (const p of m.content) n += partTokens(p);
  for (const tc of m.tool_calls ?? []) n += 12 + estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments);
  return n;
}

export function requestTokens(messages: ChatMessage[], tools?: ToolDef[]): number {
  const t = tools?.length ? estimateTokens(JSON.stringify(tools)) : 0;
  return messages.reduce((n, m) => n + messageTokens(m), t);
}

/** The usable input budget when `output` tokens are reserved for the reply. */
export function inputBudget(contextTokens: number, output: number): number {
  return Math.floor(contextTokens * (1 - MARGIN)) - output;
}

/** max_tokens for a request: the requested amount, reduced so input plus output fit the context. */
export function fitMaxTokens(contextTokens: number, promptTokens: number, requested?: number): number | undefined {
  const room = Math.floor(contextTokens * (1 - MARGIN)) - promptTokens;
  if (!requested) return room < 64_000 ? Math.max(MIN_OUTPUT_TOKENS, room) : undefined;
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(requested, room));
}

const IMAGE_NOTE = '［早先的图片已省略以节省上下文；需要时请重新调用 render_pages / view_page 查看］';
const keepHead = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function stubToolResult(content: string): string {
  if (content.length <= 600) return content;
  return `${keepHead(content, 300)}\n［此工具结果共 ${content.length} 字符，为节省上下文已省略其余部分；需要时请重新调用工具获取最新内容］`;
}

/** Large string arguments of an executed call are cut down; the JSON stays valid. */
function stubArguments(args: string): string {
  if (args.length <= 800) return args;
  try {
    const v = JSON.parse(args) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const s = typeof x === 'string' ? x : JSON.stringify(x);
      out[k] = s && s.length > 300 ? `${s.slice(0, 120)}…［已执行，省略 ${s.length} 字符］` : x;
    }
    return JSON.stringify(out);
  } catch {
    return JSON.stringify({ note: `［已执行，省略 ${args.length} 字符的参数］` });
  }
}

function withoutImages(m: ChatMessage): ChatMessage {
  if (!Array.isArray(m.content) || !m.content.some((p) => p.type === 'image_url')) return m;
  const parts: ContentPart[] = [];
  let dropped = 0;
  for (const p of m.content) {
    if (p.type === 'image_url') dropped++;
    else parts.push(p);
  }
  if (dropped) parts.push({ type: 'text', text: IMAGE_NOTE });
  return { ...m, content: parts };
}

/** A round is an assistant message with tool calls plus the tool results and image message after it. */
interface Round {
  start: number;
  end: number;
}

function rounds(history: ChatMessage[], from: number): Round[] {
  const out: Round[] = [];
  for (let i = from; i < history.length; i++) {
    if (history[i].role !== 'assistant' || !history[i].tool_calls?.length) continue;
    let end = i + 1;
    while (end < history.length && history[end].role === 'tool') end++;
    if (end < history.length && history[end].role === 'user' && Array.isArray(history[end].content) && isToolImages(history[end])) end++;
    out.push({ start: i, end });
    i = end - 1;
  }
  return out;
}

const isToolImages = (m: ChatMessage) =>
  Array.isArray(m.content) && m.content[0]?.type === 'text' && m.content[0].text.startsWith('以下是上述工具调用返回的图片');

function describeCall(name: string, args: string): string {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(args);
  } catch {
    /* summary only */
  }
  const bits = ['path', 'page', 'pages', 'selector', 'contains', 'query', 'file_id', 'after', 'to']
    .filter((k) => a[k] !== undefined && a[k] !== '')
    .map((k) => `${k}=${keepHead(typeof a[k] === 'string' ? (a[k] as string) : JSON.stringify(a[k]), 40)}`);
  return `${name}(${bits.join(', ')})`;
}

export interface CompactResult {
  messages: ChatMessage[];
  tokens: number;
  /** What was done, for logs and tests. */
  steps: string[];
}

/**
 * Shrinks a conversation to `budget` tokens. The first `keepHead` messages (system prompt and task)
 * and the most recent `keepRounds` tool rounds are kept as they are for as long as possible.
 */
export function compactHistory(history: ChatMessage[], budget: number, opts: { keepHead?: number; keepRounds?: number; tools?: ToolDef[] } = {}): CompactResult {
  const head = Math.min(opts.keepHead ?? 2, history.length);
  const keepRounds = opts.keepRounds ?? 2;
  let msgs = [...history];
  const steps: string[] = [];
  const size = () => requestTokens(msgs, opts.tools);
  if (size() <= budget) return { messages: msgs, tokens: size(), steps };

  const protectedFrom = () => {
    const rs = rounds(msgs, head);
    return rs.length > keepRounds ? rs[rs.length - keepRounds].start : rs[0]?.start ?? msgs.length;
  };

  // 1. Images from tool rounds before the protected tail.
  let cut = protectedFrom();
  msgs = msgs.map((m, i) => (i >= head && i < cut ? withoutImages(m) : m));
  steps.push('images');
  if (size() <= budget) return { messages: msgs, tokens: size(), steps };

  // 2. Old tool results and the content of executed writes.
  msgs = msgs.map((m, i) => {
    if (i < head || i >= cut) return m;
    if (m.role === 'tool' && typeof m.content === 'string') return { ...m, content: stubToolResult(m.content) };
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return { ...m, tool_calls: m.tool_calls.map((tc) => ({ ...tc, function: { ...tc.function, arguments: stubArguments(tc.function.arguments) } })) };
    }
    return m;
  });
  steps.push('results');
  if (size() <= budget) return { messages: msgs, tokens: size(), steps };

  // 3. Fold the oldest rounds into one note, oldest first, until it fits (the last round always stays).
  const log: string[] = [];
  for (;;) {
    const rs = rounds(msgs, head);
    if (rs.length <= 1 || size() <= budget) break;
    const r = rs[0];
    for (const tc of msgs[r.start].tool_calls ?? []) log.push(describeCall(tc.function.name, tc.function.arguments));
    const note = msgs[r.start].content;
    if (typeof note === 'string' && note.trim()) log.push(`说明：${keepHead(note.trim(), 120)}`);
    msgs.splice(r.start, r.end - r.start);
  }
  if (log.length) {
    const existing = msgs.findIndex((m, i) => i >= head && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('［上下文压缩］'));
    const prev = existing >= 0 ? (msgs[existing].content as string).split('\n').slice(1) : [];
    const lines = [...prev, ...log].slice(-60);
    const text = `［上下文压缩］为控制上下文长度，早先的工具调用已从对话中移除（已执行，结果已生效于草稿）。按顺序为：\n${lines.join('\n')}`;
    if (existing >= 0) msgs[existing] = { role: 'user', content: text };
    else msgs.splice(head, 0, { role: 'user', content: text });
    steps.push('rounds');
  }
  if (size() <= budget) return { messages: msgs, tokens: size(), steps };

  // 4. Everything else: drop all images and stub the protected rounds as well.
  cut = msgs.length;
  msgs = msgs.map((m, i) => {
    const n = withoutImages(m);
    if (i < head) return n;
    if (n.role === 'tool' && typeof n.content === 'string') return { ...n, content: stubToolResult(n.content) };
    if (n.role === 'assistant' && n.tool_calls?.length) {
      return { ...n, tool_calls: n.tool_calls.map((tc) => ({ ...tc, function: { ...tc.function, arguments: stubArguments(tc.function.arguments) } })) };
    }
    return n;
  });
  steps.push('all');
  if (size() <= budget) return { messages: msgs, tokens: size(), steps };

  // 5. The task itself is too long: shorten its largest text from the middle.
  for (let i = 0; i < head && size() > budget; i++) {
    const m = msgs[i];
    const over = size() - budget;
    if (typeof m.content === 'string') msgs[i] = { ...m, content: shortenMiddle(m.content, over) };
    else if (Array.isArray(m.content)) {
      const parts = [...m.content];
      const j = parts.reduce((best, p, k) => (p.type === 'text' && p.text.length > ((parts[best] as { text?: string }).text?.length ?? -1) ? k : best), 0);
      const p = parts[j];
      if (p.type === 'text') parts[j] = { type: 'text', text: shortenMiddle(p.text, over) };
      msgs[i] = { ...m, content: parts };
    }
  }
  steps.push('prompt');
  return { messages: msgs, tokens: size(), steps };
}

function shortenMiddle(text: string, overTokens: number): string {
  const ratio = text.length / Math.max(1, estimateTokens(text));
  const remove = Math.min(text.length - 2000, Math.ceil((overTokens + 500) * ratio));
  if (remove <= 0) return text;
  const keep = text.length - remove;
  const a = Math.floor(keep * 0.6);
  return `${text.slice(0, a)}\n……［内容过长，为适应模型上下文已省略中间约 ${remove} 字符；需要时请用工具读取］……\n${text.slice(text.length - (keep - a))}`;
}
