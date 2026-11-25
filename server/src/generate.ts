/**
 * Staged generation of a multi-file project: one call writes the README (requirements, style guide,
 * page plan) and the style files, then the pages are written a few per call, several calls at once.
 * No single reply has to hold the whole deck, and a reply cut off by the output limit only loses the
 * file it was writing. Each batch then looks at its own rendered pages and fixes them; the self-check
 * and delivery check run on the whole deck afterwards.
 */
import * as cheerio from 'cheerio';
import type { DeckDoc, DeckPage } from './deck.js';
import { ADDITIONS_CSS, appendCss, checkPath, cssFiles, joinCssFiles, parseFileBlocks, plannedPages, README, type FileBlock } from './files.js';
import type { ChatMessage, ChatResult, ContentPart } from './llm.js';
import {
  buildPagesPrompt,
  buildPlanPrompt,
  pageReviewNote,
  type AssetRef,
  type DeckBrief,
  type PlannedPage,
  type TemplateBrief,
} from './prompts.js';

export const MAX_PLANNED_PAGES = 60;

/** Times a reply missing required files is sent back to the model before the step gives up. */
export const MAX_PLAN_FIXES = 3;

/** Replies without a page before it is left to the delivery check. */
const MAX_PAGE_MISSES = 3;

/** Tries of a page batch whose model call fails, before the batch is given up for this run. */
export const PAGE_BATCH_TRIES = 3;

/** Looks at each batch's rendered pages: one review, and a second only if layout errors are left. */
export const PAGE_REVIEW_ROUNDS = 2;

/**
 * Style sheets written without <file> tags (```css blocks), named by the styles/*.css path mentioned
 * just before each block, else theme.css then components.css.
 */
export function looseCss(text: string): FileBlock[] {
  const out: FileBlock[] = [];
  const defaults = ['styles/theme.css', 'styles/components.css'];
  text = text.replace(/<file\b[\s\S]*?<\/file\s*>/gi, '');
  for (const m of text.matchAll(/```css[ \t]*\n([\s\S]*?)```/gi)) {
    const before = text.slice(Math.max(0, m.index! - 300), m.index!);
    const named = [...before.matchAll(/styles\/[\w.-]+\.css/g)].at(-1)?.[0];
    const path = named && !out.some((b) => b.path === named) ? named : defaults.find((d) => !out.some((b) => b.path === d)) ?? `styles/extra-${out.length}.css`;
    if (m[1].trim()) out.push({ path, content: m[1].trim(), complete: true });
  }
  return out;
}

/** A style sheet cut off by the output limit, kept up to its last complete rule. */
function salvageCss(b: FileBlock): FileBlock | null {
  const end = b.content.lastIndexOf('}');
  if (end < 200) return null;
  const css = b.content.slice(0, end + 1);
  const open = (css.match(/{/g) ?? []).length - (css.match(/}/g) ?? []).length;
  return open === 0 ? { ...b, content: css, complete: true } : null;
}

/** How one page just written looks: a screenshot and what the automatic layout check found. */
export interface PageLook {
  /** data: URL */
  image?: string;
  issues: { severity: 'error' | 'warning'; message: string }[];
}

export interface GenerateDeps {
  /**
   * One model call (with the read-only reference tools when there are uploads); must not throw on
   * truncation. 'review' continues a page batch's conversation with how its pages rendered.
   */
  call: (messages: ChatMessage[], stage: string, step: 'plan' | 'pages' | 'review') => Promise<ChatResult>;
  /**
   * Renders the pages of `doc` (just written, without ids yet), one look per page in order. When
   * given, each batch shows the model how its pages rendered and takes its corrections.
   */
  lookAt?: (doc: DeckDoc) => Promise<PageLook[]>;
  onStage?: (stage: string) => void;
  pagesPerCall: number;
  /** Page batches written at the same time (1: one after another). */
  parallel?: number;
  /** Pause before a failed page batch is tried again; doubles with each try. */
  retryDelayMs?: number;
  /** Continue a generation saved by onCheckpoint. */
  resume?: GenerateState;
  /** Called before each model call once there is work worth keeping. */
  onCheckpoint?: (state: GenerateState) => void;
}

/** How far a staged generation got. */
export type GenerateState =
  | { step: 'plan'; doc: DeckDoc; early: FileBlock[]; messages: ChatMessage[]; attempt: number }
  | { step: 'pages'; doc: DeckDoc; done: string[]; skipped: string[]; size: number; lastCut: boolean; misses?: Record<string, number> };

/** A short description of a saved generation, for the user deciding whether to continue it. */
export function describeGenerateState(s: GenerateState): string {
  if (s.step === 'plan') return '已写出部分 README 与样式';
  const planned = Math.min(plannedPages(s.doc.readme ?? '').length, MAX_PLANNED_PAGES);
  return `已完成规划与 ${s.done.length}/${planned} 页`;
}

export interface GenerateInput {
  base: DeckDoc;
  kind: 'template' | 'deck';
  brief: TemplateBrief | DeckBrief;
  template: DeckDoc | null;
  assets: AssetRef[];
}

/** One page file's content as pages: <style> blocks move to the additions file, bare markup is wrapped. */
function toPages(path: string, content: string): { pages: DeckPage[]; css: string } {
  const $ = cheerio.load(content, null, false);
  const css = $('style')
    .map((_, el) => $(el).text())
    .get()
    .join('\n')
    .trim();
  $('style').remove();
  let sections = $('section').filter((_, el) => $(el).parents('section').length === 0);
  if (!sections.length) {
    if (!$.root().text().trim() && !$('*').length) return { pages: [], css };
    $.root().children().wrapAll('<section class="slide"></section>');
    sections = $('section').first();
  }
  const pages = sections.map((i, el) => ({ id: $(el).attr('data-page-id') ?? '', html: $.html(el), file: i === 0 ? path : undefined })).get();
  return { pages, css };
}

const pathOf = (b: FileBlock) => {
  try {
    return checkPath(b.path);
  } catch {
    return undefined;
  }
};

function continueMessages(messages: ChatMessage[], reply: string, note: string): ChatMessage[] {
  return [...messages, { role: 'assistant', content: reply || '（无输出）' }, { role: 'user', content: note }];
}

export async function generateFiles(input: GenerateInput, deps: GenerateDeps): Promise<DeckDoc> {
  const { base, kind, brief, template, assets } = input;
  const resume = deps.resume;
  let doc: DeckDoc = resume?.doc ?? {
    ...base,
    head: template?.head ?? base.head,
    css: template ? joinCssFiles(cssFiles(template.css)) : '',
    pages: [],
    readme: '',
  };
  const early: FileBlock[] = resume?.step === 'plan' ? resume.early : [];
  const planOf = () => plannedPages(doc.readme ?? '').slice(0, MAX_PLANNED_PAGES);

  // Step 1: README and styles.
  let plan: PlannedPage[] = resume?.step === 'pages' ? planOf() : [];
  let messages = resume?.step === 'plan' ? resume.messages : buildPlanPrompt(doc, kind, brief, template, assets);
  for (let attempt = resume?.step === 'plan' ? resume.attempt : 0; resume?.step !== 'pages'; attempt++) {
    if (attempt) deps.onCheckpoint?.({ step: 'plan', doc, early, messages, attempt });
    const r = await deps.call(messages, attempt ? '规划：补全 README 与样式文件' : '规划：编写 README 与样式文件', 'plan');
    const parsed = parseFileBlocks(r.text);
    const blocks = parsed.flatMap((b) => {
      if (b.complete) return [b];
      const c = pathOf(b);
      const kept = c?.kind === 'css' ? salvageCss(b) : null;
      return kept ? [kept] : [];
    });
    if (!blocks.some((b) => pathOf(b)?.kind === 'css') && !cssFiles(doc.css).length) blocks.push(...looseCss(r.text));
    for (const b of blocks) {
      const c = pathOf(b);
      if (!c) continue;
      if (c.kind === 'readme') doc.readme = `${b.content.trim()}\n`;
      else if (c.kind === 'css') {
        const files = cssFiles(doc.css).filter((f) => f.path !== c.path);
        doc.css = joinCssFiles([...files, { path: c.path, css: b.content }]);
      } else early.push({ ...b, path: c.path });
    }
    plan = planOf();
    const missing: string[] = [];
    if (!doc.readme) missing.push(README);
    else if (!plan.length) missing.push(`${README}（「页面规划」中没有找到 pages/名称.html 格式的条目，请按格式重写整个 README）`);
    if (!doc.css.trim()) missing.push('styles/theme.css 与 styles/components.css');
    if (!missing.length) break;
    if (attempt >= MAX_PLAN_FIXES) {
      // Without a page plan there is nothing to write; missing style sheets are left to the delivery check,
      // which sends them back to the model with the draft tools.
      if (doc.readme && plan.length) break;
      throw new Error(
        `模型 ${attempt + 1} 次都没有按要求输出${missing.join('、')}（已交回模型补全 ${attempt} 次），请重试（或在「模型接入 → 生成设置」中改用单次生成）`,
      );
    }
    const cut = r.finishReason === 'length' ? '回复达到最大输出长度被截断' : '缺少文件或格式不对';
    messages = continueMessages(
      messages,
      r.text,
      `你上一条回复没有完成（${cut}）。请只输出还缺少的文件：${missing.join('、')}。每个文件完整输出，用 <file path="…"> … </file> 包裹。`,
    );
  }

  // Step 2: pages, a few per call, in plan order.
  const order = new Map(plan.map((p, i) => [p.path, i]));
  const done = new Set<string>();
  const rankOf = new WeakMap<DeckPage, number>();
  const addFile = (path: string, content: string) => {
    const { pages, css } = toPages(path, content);
    if (css) doc.css = appendCss(doc.css, ADDITIONS_CSS, css);
    if (!pages.length) return false;
    const rank = order.get(path) ?? plan.length;
    pages.forEach((p, i) => rankOf.set(p, rank + i / 1000));
    const at = doc.pages.findIndex((p) => (rankOf.get(p) ?? plan.length) > rank);
    const list = [...doc.pages];
    list.splice(at < 0 ? list.length : at, 0, ...pages);
    doc = { ...doc, pages: list };
    done.add(path);
    return true;
  };
  let size = Math.max(1, deps.pagesPerCall);
  let lastCut = false;
  // Pages the model failed to write MAX_PAGE_MISSES times: left to the delivery check, which reports them as missing.
  const skipped = new Set<string>();
  /** Replies with nothing usable when the page was asked for on its own. */
  const misses = new Map<string, number>();
  if (resume?.step === 'pages') {
    resume.done.forEach((p) => done.add(p));
    resume.skipped.forEach((p) => skipped.add(p));
    ({ size, lastCut } = resume);
    for (const [p, n] of Object.entries(resume.misses ?? {})) misses.set(p, n);
    // Each file's pages follow its first page, which names the file.
    let rank = plan.length;
    let n = 0;
    for (const p of doc.pages) {
      if (p.file) [rank, n] = [order.get(p.file) ?? plan.length, 0];
      rankOf.set(p, rank + n++ / 1000);
    }
  } else for (const b of early) if (order.has(b.path) && !done.has(b.path)) addFile(b.path, b.content);

  // Every page is planned, so batches are independent: up to `parallel` of them are written at once.
  const parallel = Math.max(1, deps.parallel ?? 1);
  const writing = new Map<PlannedPage[], Promise<void>>();
  const inFlight = () => [...writing.keys()].flat();
  const label = (batch: PlannedPage[]) => {
    const from = plan.indexOf(batch[0]) + 1;
    return `${from}${batch.length > 1 ? `–${from + batch.length - 1}` : ''}`;
  };
  const save = () => deps.onCheckpoint?.({ step: 'pages', doc, done: [...done], skipped: [...skipped], size, lastCut, misses: Object.fromEntries(misses) });
  const report = () => {
    const batches = [...writing.keys()];
    if (batches.length > 1) deps.onStage?.(`生成页面：第 ${batches.map(label).join('、')} 页同时进行（已完成 ${done.size}/${plan.length} 页）`);
    else if (batches.length) deps.onStage?.(`生成页面：第 ${label(batches[0])} 页（共 ${plan.length} 页）`);
  };
  /** Batches whose calls failed on every try; the other batches carry on without them. */
  const failures: { batch: PlannedPage[]; error: unknown }[] = [];
  const failedPages = () => new Set(failures.flatMap((f) => f.batch.map((p) => p.path)));
  const nextBatch = (): PlannedPage[] | undefined => {
    const busy = new Set([...inFlight().map((p) => p.path), ...failedPages()]);
    const queue = plan.filter((p) => !done.has(p.path) && !skipped.has(p.path) && !busy.has(p.path));
    if (!queue.length) return undefined;
    if (misses.get(queue[0].path)) return [queue[0]];
    // What is left is spread over the free workers, at most `size` consecutive pages per call.
    const per = Math.max(1, Math.min(size, Math.ceil(queue.length / (parallel - writing.size))));
    const batch = [queue[0]];
    for (const p of queue.slice(1)) {
      if (batch.length >= per || misses.get(p.path) || plan.indexOf(p) !== plan.indexOf(batch.at(-1)!) + 1) break;
      batch.push(p);
    }
    return batch;
  };
  /** A failed call (model offline, overloaded, network) is tried again after a pause; only this batch waits. */
  const callBatch = async (batch: PlannedPage[]) => {
    const stage = `生成页面：第 ${label(batch)} 页（共 ${plan.length} 页）`;
    for (let attempt = 1; ; attempt++) {
      const others = inFlight().filter((p) => !batch.includes(p));
      const messages = buildPagesPrompt(doc, kind, brief, template, assets, batch, plan, others);
      try {
        return { r: await deps.call(messages, attempt > 1 ? `${stage}（第 ${attempt} 次尝试）` : stage, 'pages'), messages, stage };
      } catch (e) {
        if (attempt >= PAGE_BATCH_TRIES) throw e;
        await new Promise((r) => setTimeout(r, (deps.retryDelayMs ?? 0) * 2 ** (attempt - 1)));
      }
    }
  };
  /** The pages written from one planned file (a file may hold several). */
  const pagesOf = (path: string) => {
    const rank = order.get(path) ?? plan.length;
    return doc.pages.filter((p) => {
      const r = rankOf.get(p);
      return r !== undefined && r >= rank && r < rank + 1;
    });
  };
  const replaceFile = (path: string, content: string) => {
    if (!toPages(path, content).pages.length) return false;
    const old = new Set(pagesOf(path));
    doc = { ...doc, pages: doc.pages.filter((p) => !old.has(p)) };
    done.delete(path);
    return addFile(path, content);
  };
  /**
   * The batch's own conversation goes on: the model sees screenshots of the pages it just wrote and
   * the layout check, and rewrites the pages that need it. Its other pages and the other batches are
   * untouched; if rendering or the call fails, the pages stay as written (the whole-draft check follows).
   */
  const reviewBatch = async (batch: PlannedPage[], messages: ChatMessage[], reply: string, stage: string) => {
    if (!deps.lookAt) return;
    const files = batch.filter((p) => done.has(p.path)).map((p) => p.path);
    let convo = messages;
    let last = reply;
    for (let round = 1; round <= PAGE_REVIEW_ROUNDS; round++) {
      const shown = files.flatMap((path) => pagesOf(path).map((page, k, all) => ({ page, label: all.length > 1 ? `${path}（第 ${k + 1} 屏）` : path })));
      if (!shown.length) return;
      let looks: PageLook[];
      try {
        looks = await deps.lookAt({ ...doc, pages: shown.map((s) => s.page) });
      } catch {
        return;
      }
      const errors = looks.flatMap((l) => l.issues).filter((i) => i.severity === 'error').length;
      if (round > 1 && !errors) return;
      const parts: ContentPart[] = [{ type: 'text', text: pageReviewNote(shown.map((s, i) => ({ label: s.label, issues: looks[i]?.issues ?? [] })), round, kind === 'deck') }];
      shown.forEach((s, i) => {
        const image = looks[i]?.image;
        if (image) parts.push({ type: 'text', text: `【${s.label}】` }, { type: 'image_url', image_url: { url: image } });
      });
      convo = [...convo, { role: 'assistant', content: last || '（无输出）' }, { role: 'user', content: parts }];
      let r: ChatResult;
      try {
        r = await deps.call(convo, `${stage}：检查渲染效果${round > 1 ? `（第 ${round} 轮）` : ''}`, 'review');
      } catch {
        return;
      }
      let changed = 0;
      for (const b of parseFileBlocks(r.text).filter((x) => x.complete)) {
        const c = pathOf(b);
        if (c?.kind === 'css') {
          doc.css = appendCss(doc.css, c.path === ADDITIONS_CSS ? ADDITIONS_CSS : c.path, b.content);
          changed++;
        } else if (c?.kind === 'page' && files.includes(c.path) && replaceFile(c.path, b.content)) changed++;
      }
      if (!changed) return;
      last = r.text;
    }
  };
  const write = async (batch: PlannedPage[]) => {
    const { r, messages, stage } = await callBatch(batch);
    const blocks = parseFileBlocks(r.text).filter((b) => b.complete);
    let got = 0;
    const strays: FileBlock[] = [];
    for (const b of blocks) {
      const c = pathOf(b);
      if (c?.kind === 'css') doc.css = appendCss(doc.css, c.path === ADDITIONS_CSS ? ADDITIONS_CSS : c.path, b.content);
      else if (c?.kind === 'page' && batch.some((p) => p.path === c.path) && !done.has(c.path)) got += addFile(c.path, b.content) ? 1 : 0;
      else if (!c || c.kind === 'page') strays.push(b);
    }
    // Pages written under other names fill the planned files of this batch that are still missing, in order.
    for (const b of strays) {
      const slot = batch.find((p) => !done.has(p.path));
      if (!slot) break;
      got += addFile(slot.path, b.content) ? 1 : 0;
    }
    if (got) {
      if (r.finishReason === 'length' && got < batch.length) size = Math.max(1, Math.min(size, got));
      await reviewBatch(batch, messages, r.text, stage);
      return;
    }
    if (batch.length > 1) {
      size = 1;
      return;
    }
    const n = (misses.get(batch[0].path) ?? 0) + 1;
    misses.set(batch[0].path, n);
    if (n >= MAX_PAGE_MISSES) {
      skipped.add(batch[0].path);
      lastCut = r.finishReason === 'length';
    }
  };
  // A batch that still fails does not hold up the others: every other page is written first, then the
  // step fails with that progress saved, and continuing writes only the failed pages.
  for (;;) {
    while (writing.size < parallel) {
      const batch = nextBatch();
      if (!batch) break;
      save();
      writing.set(
        batch,
        write(batch).then(
          () => void writing.delete(batch),
          (error) => {
            writing.delete(batch);
            failures.push({ batch, error });
          },
        ),
      );
    }
    if (!writing.size) break;
    report();
    await Promise.race(writing.values());
  }
  if (failures.length) {
    save();
    const pages = failures.map((f) => label(f.batch)).join('、');
    const why = failures[0].error instanceof Error ? failures[0].error.message : String(failures[0].error);
    throw new Error(`第 ${pages} 页生成失败（每批已尝试 ${PAGE_BATCH_TRIES} 次），其余页面已完成并保存：${why}`);
  }
  if (!doc.pages.length) {
    throw new Error(`模型多次都没有输出任何页面${lastCut ? '（回复达到最大输出长度被截断，请提高「最大输出 tokens」）' : ''}，生成中止`);
  }
  return doc;
}
