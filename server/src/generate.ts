/**
 * Staged generation of a multi-file project: one call writes the README (requirements, style guide,
 * page plan) and the style files, then the pages are written a few per call. No single reply has to
 * hold the whole deck, and a reply cut off by the output limit only loses the file it was writing.
 */
import * as cheerio from 'cheerio';
import type { DeckDoc, DeckPage } from './deck.js';
import { ADDITIONS_CSS, appendCss, checkPath, cssFiles, joinCssFiles, parseFileBlocks, plannedPages, README, type FileBlock } from './files.js';
import type { ChatMessage, ChatResult } from './llm.js';
import { buildPagesPrompt, buildPlanPrompt, type AssetRef, type DeckBrief, type PlannedPage, type TemplateBrief } from './prompts.js';

export const MAX_PLANNED_PAGES = 60;

export interface GenerateDeps {
  /** One model call (with the read-only reference tools when there are uploads); must not throw on truncation. */
  call: (messages: ChatMessage[], stage: string) => Promise<ChatResult>;
  onStage?: (stage: string) => void;
  pagesPerCall: number;
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
  let doc: DeckDoc = {
    ...base,
    head: template?.head ?? base.head,
    css: template ? joinCssFiles(cssFiles(template.css)) : '',
    pages: [],
    readme: '',
  };
  const early: FileBlock[] = [];

  // Step 1: README and styles.
  let messages = buildPlanPrompt(doc, kind, brief, template, assets);
  let plan: PlannedPage[] = [];
  for (let attempt = 0; ; attempt++) {
    const r = await deps.call(messages, attempt ? '规划：补全 README 与样式文件' : '规划：编写 README 与样式文件');
    const blocks = parseFileBlocks(r.text);
    for (const b of blocks.filter((x) => x.complete)) {
      const c = pathOf(b);
      if (!c) continue;
      if (c.kind === 'readme') doc.readme = `${b.content.trim()}\n`;
      else if (c.kind === 'css') {
        const files = cssFiles(doc.css).filter((f) => f.path !== c.path);
        doc.css = joinCssFiles([...files, { path: c.path, css: b.content }]);
      } else early.push({ ...b, path: c.path });
    }
    plan = plannedPages(doc.readme ?? '').slice(0, MAX_PLANNED_PAGES);
    const missing: string[] = [];
    if (!doc.readme) missing.push(README);
    else if (!plan.length) missing.push(`${README}（「页面规划」中没有找到 pages/名称.html 格式的条目，请按格式重写整个 README）`);
    if (!doc.css.trim()) missing.push('styles/theme.css 与 styles/components.css');
    if (!missing.length) break;
    if (attempt >= 2) throw new Error(`模型没有按要求输出${missing.join('、')}，请重试（或在「模型接入 → 生成设置」中改用单次生成）`);
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
  for (const b of early) if (order.has(b.path) && !done.has(b.path)) addFile(b.path, b.content);

  let size = Math.max(1, deps.pagesPerCall);
  let failures = 0;
  for (;;) {
    const queue = plan.filter((p) => !done.has(p.path));
    if (!queue.length) break;
    const batch = queue.slice(0, size);
    const from = plan.indexOf(batch[0]) + 1;
    const stage = `生成页面：第 ${from}${batch.length > 1 ? `–${from + batch.length - 1}` : ''} 页（共 ${plan.length} 页）`;
    deps.onStage?.(stage);
    const r = await deps.call(buildPagesPrompt(doc, kind, brief, template, assets, batch, plan), stage);
    const blocks = parseFileBlocks(r.text).filter((b) => b.complete);
    let got = 0;
    const strays: FileBlock[] = [];
    for (const b of blocks) {
      const c = pathOf(b);
      if (c?.kind === 'css') doc.css = appendCss(doc.css, c.path === ADDITIONS_CSS ? ADDITIONS_CSS : c.path, b.content);
      else if (c?.kind === 'page' && batch.some((p) => p.path === c.path) && !done.has(c.path)) got += addFile(c.path, b.content) ? 1 : 0;
      else if (!c || c.kind === 'page') strays.push(b);
    }
    // Pages written under other names fill the planned files that are still missing, in order.
    for (const b of strays) {
      const slot = batch.find((p) => !done.has(p.path));
      if (!slot || !/<section/i.test(b.content)) break;
      got += addFile(slot.path, b.content) ? 1 : 0;
    }
    if (got) {
      failures = 0;
      if (r.finishReason === 'length' && got < batch.length) size = Math.max(1, got);
      continue;
    }
    failures++;
    if (size > 1) size = 1;
    else if (failures >= 3) {
      throw new Error(
        `模型连续 ${failures} 次没有输出页面 ${batch[0].path}${r.finishReason === 'length' ? '（回复达到最大输出长度被截断，请提高「最大输出 tokens」）' : ''}，生成中止`,
      );
    }
  }
  return doc;
}
