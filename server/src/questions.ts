/**
 * Questions from the model to the user. A job asks through a tool, waits (paused) until someone
 * answers in the editor, skips, or the wait times out, and goes on with the answer as the tool result.
 * Pending questions live in memory, like the job itself.
 */
import { nanoid } from 'nanoid';
import type { Draft } from './draft.js';
import type { FileTools, ToolDef } from './fileTools.js';

export interface PendingQuestion {
  id: string;
  jobId: string;
  projectId: string;
  kind: 'ask' | 'scope';
  text: string;
  options: string[];
  askedAt: number;
  expiresAt: number;
}

export interface Answer {
  /** The chosen option or the typed reply; null when skipped or unanswered. */
  text: string | null;
  choice?: number;
  userId?: number;
  timedOut?: boolean;
}

/** One asked question and its outcome, kept with the job. */
export interface QaEntry {
  kind: 'ask' | 'scope';
  question: string;
  options: string[];
  answer: string | null;
  timedOut?: boolean;
  userId?: number;
  at: number;
}

const waiting = new Map<string, { q: PendingQuestion; resolve: (a: Answer) => void; timer: NodeJS.Timeout }>();

export function askQuestion(
  job: { id: string; projectId: string },
  q: Pick<PendingQuestion, 'kind' | 'text' | 'options'>,
  timeoutMs: number,
): Promise<Answer> {
  const jobId = job.id;
  cancelQuestion(jobId);
  const now = Date.now();
  const question: PendingQuestion = { ...q, id: nanoid(10), jobId, projectId: job.projectId, askedAt: now, expiresAt: now + timeoutMs };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(jobId);
      resolve({ text: null, timedOut: true });
    }, timeoutMs);
    waiting.set(jobId, { q: question, resolve, timer });
  });
}

export function pendingQuestion(jobId: string): PendingQuestion | undefined {
  return waiting.get(jobId)?.q;
}

/** Projects with a job waiting for an answer. */
export function projectsAsking(): Set<string> {
  return new Set([...waiting.values()].map((w) => w.q.projectId));
}

/** Delivers an answer (null = skip); false when the question is no longer waiting. */
export function answerQuestion(jobId: string, questionId: string, answer: Answer): boolean {
  const w = waiting.get(jobId);
  if (!w || w.q.id !== questionId) return false;
  clearTimeout(w.timer);
  waiting.delete(jobId);
  w.resolve(answer);
  return true;
}

export function cancelQuestion(jobId: string) {
  const w = waiting.get(jobId);
  if (!w) return;
  clearTimeout(w.timer);
  waiting.delete(jobId);
  w.resolve({ text: null });
}

export const MAX_QUESTIONS = 3;

/** Words with which a request already asks for every occurrence ("全部改成…", "统一", "all"). */
const ALL_WORDS = /全部|所有|每一?页|统一|一并|一起|都改|都换|都要|处处|全文|整份|全局|everywhere|throughout|\ball\b|\bevery\b/i;

export function asksForAll(prompt: string): boolean {
  return ALL_WORDS.test(prompt);
}

export interface AskToolsOptions {
  /** Puts a question to the user; omitted when asking is switched off. */
  ask?: (q: Pick<PendingQuestion, 'kind' | 'text' | 'options'>) => Promise<Answer>;
  timeoutMinutes: number;
  onAsked?: (entry: QaEntry) => void;
  /** Page and element edits: the draft whose scope extend_scope may widen, and the user's request. */
  draft?: Draft;
  prompt?: string;
}

const askDef = (minutes: number): ToolDef => ({
  type: 'function',
  function: {
    name: 'ask_user',
    description: `向用户提问并等待回答（任务暂停，最多等待 ${minutes} 分钟；用户也可能跳过）。只在关键信息含糊、猜错会导致大量返工时使用，例如：不确定面向投资人还是客户、要求前后矛盾、上传的资料与描述不一致、修改要求可以有几种明显不同的理解。一次只问一个简短的问题，尽量给出 2–4 个具体选项（用户也可以自己输入）。能根据需求、README 或常识自行决定的细节不要问。每个任务最多提问 ${MAX_QUESTIONS} 次。`,
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问题，简短具体' },
        options: { type: 'array', items: { type: 'string' }, description: '2–4 个可选答案（可选）' },
      },
      required: ['question'],
    },
  },
});

const scopeDef: ToolDef = {
  type: 'function',
  function: {
    name: 'extend_scope',
    description:
      '本次修改只开放了用户选中的页面/元素。完成局部修改后，如果发现其他页面有同类内容也应该一起改（例如同一个项目/公司名称、同一个 Logo 或图标的颜色、同样的标题样式、同一个数字口径），调用它请求把修改范围扩大到这些页面（同时开放共享样式文件）。用户的修改要求已明确说“全部/所有/统一”等时会直接开放；否则系统会询问用户，由用户决定。',
    parameters: {
      type: 'object',
      properties: {
        pages: { type: 'array', items: { type: 'integer' }, description: '有同类内容、需要开放的页码（不填则开放全部页面）' },
        summary: { type: 'string', description: '发现了什么，例如“第 3、5、8 页也有「ACME 科技」”' },
        question: { type: 'string', description: '给用户的问题（可选，默认根据 summary 生成）' },
      },
      required: ['summary'],
    },
  },
};

const YES = /^(是|好|对|要|改|可以|全部|一起|都|yes|y|ok)/i;
const NO = /只改|不|别|否|no\b|仅/i;

/**
 * ask_user (when asking is on) and, for page and element edits, extend_scope. Answers come back as the
 * tool result; a skipped or unanswered question tells the model to go on with its best judgement.
 */
export function createAskTools(opts: AskToolsOptions): FileTools | undefined {
  const { ask, draft, prompt = '' } = opts;
  const defs: ToolDef[] = [];
  if (ask) defs.push(askDef(opts.timeoutMinutes));
  if (draft?.mode === 'fragment') defs.push(scopeDef);
  if (!defs.length) return undefined;
  let asked = 0;
  const put = async (kind: 'ask' | 'scope', text: string, options: string[]): Promise<Answer> => {
    asked++;
    const a = await ask!({ kind, text, options });
    opts.onAsked?.({ kind, question: text, options, answer: a.text, timedOut: a.timedOut, userId: a.userId, at: Date.now() });
    return a;
  };
  return {
    defs,
    async execute(name, args) {
      if (name === 'ask_user') {
        if (!ask) return { content: '错误：提问功能已关闭，请按你的最佳判断继续。' };
        const question = String(args.question ?? '').trim().slice(0, 500);
        if (!question) return { content: '错误：question 不能为空' };
        if (asked >= MAX_QUESTIONS) return { content: `已达到本任务的提问上限（${MAX_QUESTIONS} 次），请按你的最佳判断继续，并在最终总结中说明所做的假设。` };
        const options = (Array.isArray(args.options) ? args.options : []).map((o) => String(o).trim().slice(0, 100)).filter(Boolean).slice(0, 6);
        const a = await put('ask', question, options);
        if (a.text) return { content: `用户回答：「${a.text}」` };
        return {
          content: a.timedOut
            ? `用户在 ${opts.timeoutMinutes} 分钟内没有回答。请按你的最佳判断继续，并在最终总结中说明所做的假设。`
            : '用户跳过了这个问题。请按你的最佳判断继续，并在最终总结中说明所做的假设。',
        };
      }
      if (name === 'extend_scope' && draft?.mode === 'fragment') {
        const all = Array.from({ length: draft.pageCount }, (_, i) => i + 1);
        const wanted = (Array.isArray(args.pages) ? args.pages.map((p) => Math.floor(Number(p))) : all).filter((n) => n >= 1 && n <= draft.pageCount);
        const pages = wanted.length ? [...new Set(wanted)].sort((a, b) => a - b) : all;
        const summary = String(args.summary ?? '').trim().slice(0, 300) || '其他页面也有同类内容';
        const where = pages.length === draft.pageCount ? '全部页面' : `第 ${pages.join('、')} 页`;
        const open = () => {
          draft.extendScope(pages);
          return `已开放${where}以及共享样式文件的修改权限，请用工具把这些页面中的同类内容一并修改（只改同类内容，其他保持不变），完成后用一两句话总结。`;
        };
        if (asksForAll(prompt)) return { content: `用户的修改要求已明确包含所有同类内容。${open()}` };
        if (!ask) return { content: '未开放：提问功能已关闭，且用户没有明确要求全部修改。请只保留选中内容的修改，并在总结中提醒用户其他页面也有同类内容。' };
        if (asked >= MAX_QUESTIONS) return { content: '已达到提问上限，未开放其他页面。请只保留选中内容的修改，并在总结中提醒用户。' };
        const question = String(args.question ?? '').trim().slice(0, 500) || `${summary}。要把${where}的同类内容一起修改吗？`;
        const a = await put('scope', question, ['全部修改', '只改选中的']);
        const yes = a.choice === 0 || (a.choice === undefined && !!a.text && YES.test(a.text.trim()) && !NO.test(a.text));
        if (yes) return { content: `用户同意一起修改。${open()}` };
        if (a.text) return { content: `用户回答：「${a.text}」。未开放其他页面：只保留选中内容的修改${a.choice === 1 ? '' : '（如用户的回答另有要求，在总结中说明）'}，然后结束。` };
        return { content: `${a.timedOut ? '用户没有及时回答' : '用户跳过了这个问题'}，未开放其他页面。请只保留选中内容的修改，并在总结中提醒用户其他页面也有同类内容。` };
      }
      return { content: `错误：没有名为 ${name} 的工具` };
    },
  };
}
