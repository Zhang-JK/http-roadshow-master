import * as cheerio from 'cheerio';
import type { DB } from './db.js';
import { assignIds, cloneDoc, pageText, parseFragment, parseFullHtmlRaw, replacePage, type DeckDoc, type DeckPage } from './deck.js';
import { sliceText, type FileTools, type ToolDef, type ToolOutput } from './fileTools.js';
import { chatWithTools, type ChatMessage, type ChatOptions, type ChatResult, type ContentPart } from './llm.js';
import { inspectLayout, renderContactSheets, renderPageImages, type PageReport } from './render.js';

type Resolver = (html: string) => string;

/** Top-level <section> elements of a snippet, as pages. */
function splitSections(html: string): DeckPage[] {
  const $ = cheerio.load(html, null, false);
  const pages: DeckPage[] = [];
  $('section').each((_, el) => {
    if ($(el).parents('section').length) return;
    pages.push({ id: $(el).attr('data-page-id') ?? '', html: $.html(el) });
  });
  return pages;
}

/**
 * The model's work in progress for one job. It lives only in memory: the draft tools edit this object
 * and nothing else, and the job saves it as a new version once the review is over.
 * In fragment mode (page/element edits) only the pages that replace the target page are editable.
 */
export class Draft {
  edits = 0;

  private constructor(
    readonly mode: 'doc' | 'fragment',
    private doc: DeckDoc,
    private pages: DeckPage[] = [],
    private extraCss = '',
    readonly targetPageId?: string,
  ) {}

  static fromDocument(text: string, base: Pick<DeckDoc, 'width' | 'height' | 'title'>): Draft {
    const doc = parseFullHtmlRaw(text, base);
    return new Draft('doc', doc);
  }

  static fromFragment(text: string, snapshot: DeckDoc, pageId: string): Draft {
    const frag = parseFragment(text);
    if (!snapshot.pages.some((p) => p.id === pageId)) throw new Error('目标页面不存在');
    return new Draft('fragment', snapshot, frag.pages, frag.css, pageId);
  }

  /** The draft as it would be saved, with ids assigned; page n of the model is pages[n - 1]. */
  view(): DeckDoc {
    if (this.mode === 'doc') return assignIds(cloneDoc(this.doc));
    return replacePage(this.doc, this.targetPageId!, this.pages, this.extraCss);
  }

  private get firstEditable(): number {
    return this.mode === 'doc' ? 1 : this.doc.pages.findIndex((p) => p.id === this.targetPageId) + 1;
  }

  get pageCount(): number {
    return this.mode === 'doc' ? this.doc.pages.length : this.doc.pages.length - 1 + this.pages.length;
  }

  /** 1-based page numbers the model may change. */
  editablePages(): number[] {
    const n = this.mode === 'doc' ? this.doc.pages.length : this.pages.length;
    return Array.from({ length: n }, (_, i) => this.firstEditable + i);
  }

  isEditable(page: number): boolean {
    return this.editablePages().includes(page);
  }

  pageSource(page: number): string {
    if (page < 1 || page > this.pageCount) throw new Error(`页码超出范围（共 ${this.pageCount} 页）`);
    if (this.mode === 'doc') return this.doc.pages[page - 1].html;
    const first = this.firstEditable;
    if (page < first) return this.doc.pages[page - 1].html;
    if (page < first + this.pages.length) return this.pages[page - first].html;
    return this.doc.pages[page - this.pages.length].html;
  }

  cssSource(): string {
    if (this.mode === 'doc') return this.doc.css;
    return `/* ===== 共享样式（只读） ===== */\n${this.doc.css}\n/* ===== 本次追加样式（可用 page=0 修改） ===== */\n${this.extraCss}`;
  }

  private editableCss(): string {
    return this.mode === 'doc' ? this.doc.css : this.extraCss;
  }

  private setCss(css: string) {
    if (this.mode === 'doc') this.doc = { ...this.doc, css };
    else this.extraCss = css;
    this.edits++;
  }

  /** Replace one editable page with one or more sections (splitting a crowded page is allowed). */
  setPage(page: number, html: string) {
    if (!this.isEditable(page)) throw new Error(`第 ${page} 页是只读的，本次只能修改第 ${this.describeEditable()} 页`);
    const sections = splitSections(html);
    if (!sections.length) throw new Error('内容中没有 <section> 页面元素，未做修改');
    const old = splitSections(this.pageSource(page))[0];
    if (old?.id && !sections[0].id) {
      const $ = cheerio.load(sections[0].html, null, false);
      $('section').first().attr('data-page-id', old.id);
      sections[0] = { id: old.id, html: $.html() };
    }
    if (this.mode === 'doc') {
      const pages = [...this.doc.pages];
      pages.splice(page - 1, 1, ...sections);
      this.doc = { ...this.doc, pages };
    } else {
      this.pages.splice(page - this.firstEditable, 1, ...sections);
    }
    this.edits++;
  }

  deletePage(page: number) {
    if (!this.isEditable(page)) throw new Error(`第 ${page} 页是只读的`);
    if (this.editablePages().length <= 1) throw new Error('至少需要保留一页');
    if (this.mode === 'doc') this.doc = { ...this.doc, pages: this.doc.pages.filter((_, i) => i !== page - 1) };
    else this.pages.splice(page - this.firstEditable, 1);
    this.edits++;
  }

  /** Exact find/replace inside one editable page (or the CSS when page is 0). */
  replace(page: number, oldText: string, newText: string, all: boolean): number {
    if (!oldText) throw new Error('old_text 不能为空');
    const source = page === 0 ? this.editableCss() : this.pageSource(page);
    if (page !== 0 && !this.isEditable(page)) throw new Error(`第 ${page} 页是只读的，本次只能修改第 ${this.describeEditable()} 页`);
    const count = source.split(oldText).length - 1;
    if (!count) throw new Error('没有找到 old_text（必须与源码逐字一致，包括空格与引号）；请先用 read_draft 查看源码');
    if (count > 1 && !all) throw new Error(`old_text 出现了 ${count} 次；请提供更长的上下文使其唯一，或设置 replace_all=true`);
    const next = all ? source.split(oldText).join(newText) : source.replace(oldText, () => newText);
    if (page === 0) this.setCss(next);
    else this.setPage(page, next);
    return all ? count : 1;
  }

  /** Accept a complete re-output in the final answer; returns false when the text holds no usable HTML. */
  replaceFromText(text: string): boolean {
    if (!/<section/i.test(text)) return false;
    try {
      if (this.mode === 'doc') {
        if (!/<(html|!doctype|body)/i.test(text)) return false;
        this.doc = parseFullHtmlRaw(text, this.doc);
      } else {
        const frag = parseFragment(text);
        this.pages = frag.pages;
        this.extraCss = frag.css;
      }
      this.edits++;
      return true;
    } catch {
      return false;
    }
  }

  /** The final document: the whole draft, or the edited pages applied onto the latest saved document. */
  result(latest?: DeckDoc): DeckDoc {
    if (this.mode === 'doc') return assignIds(cloneDoc(this.doc));
    return replacePage(latest ?? this.doc, this.targetPageId!, this.pages, this.extraCss);
  }

  describeEditable(): string {
    const pages = this.editablePages();
    return pages.length > 1 ? `${pages[0]}–${pages.at(-1)}` : String(pages[0]);
  }
}

export interface IssueCount {
  errors: number;
  warnings: number;
}

export function countIssues(reports: PageReport[]): IssueCount {
  const all = reports.flatMap((r) => r.issues);
  return { errors: all.filter((i) => i.severity === 'error').length, warnings: all.filter((i) => i.severity === 'warning').length };
}

/** Human-readable layout report; page numbers are positions in the given view. */
export function formatReport(view: DeckDoc, reports: PageReport[], pages?: number[]): string {
  const byId = new Map(reports.map((r) => [r.pageId, r]));
  const numbers = pages ?? view.pages.map((_, i) => i + 1);
  const lines: string[] = [];
  let errors = 0;
  let warnings = 0;
  for (const n of numbers) {
    const r = byId.get(view.pages[n - 1]?.id);
    if (!r?.issues.length) continue;
    lines.push(`第 ${n} 页：`);
    for (const i of r.issues) {
      if (i.severity === 'error') errors++;
      else warnings++;
      lines.push(`  ${i.severity === 'error' ? '✗' : '△'} ${i.message}`);
    }
  }
  const scope = pages ? `检查了第 ${numbers.join('、')} 页` : `共 ${view.pages.length} 页`;
  if (!lines.length) return `${scope}，自动检查未发现布局问题。`;
  return `${scope}，发现 ✗ 错误 ${errors} 处、△ 提醒 ${warnings} 处：\n${lines.join('\n')}`;
}

const MAX_RENDER_PAGES = 4;
const intParam = { type: 'integer' } as const;

function draftToolDefs(draft: Draft): ToolDef[] {
  const pageParam = { type: 'integer', description: '页码（从 1 开始）' };
  const defs: ToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'render_pages',
        description: `在无头浏览器中渲染草稿的指定页面并返回截图（默认缩小一半，full_size=true 为原尺寸），同时给出这些页的自动布局检查结果。一次最多 ${MAX_RENDER_PAGES} 页。`,
        parameters: {
          type: 'object',
          properties: { pages: { type: 'array', items: intParam, description: '页码列表' }, full_size: { type: 'boolean' } },
          required: ['pages'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_layout',
        description: '重新渲染整份草稿并运行自动布局检查（文字超出页面、内容被裁切、文字重叠、图片无法加载、字号过小、空白页），返回文字报告。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_draft',
        description: '读取草稿源码。不传 page 返回页面目录；page=0 返回 CSS；page=n 返回第 n 页的 <section> HTML。长内容按 offset 分段读取。',
        parameters: { type: 'object', properties: { page: intParam, offset: intParam, max_chars: intParam } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'replace_in_draft',
        description:
          '在草稿某一页（page=0 表示 CSS）的源码中做精确替换：old_text 必须与源码逐字一致且唯一（或设 replace_all=true）。这是最省 token 的修改方式。只修改草稿，不会改动任何参考文件。',
        parameters: {
          type: 'object',
          properties: { page: intParam, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } },
          required: ['page', 'old_text', 'new_text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'rewrite_page',
        description:
          '用新的 HTML 整体替换草稿第 n 页。html 中可包含多个 <section class="slide">，用于把内容过多的一页拆成几页。保留原有的 data-eid 属性。',
        parameters: { type: 'object', properties: { page: pageParam, html: { type: 'string' } }, required: ['page', 'html'] },
      },
    },
  ];
  if (draft.mode === 'doc') {
    defs.push({
      type: 'function',
      function: { name: 'delete_page', description: '删除草稿中的第 n 页。', parameters: { type: 'object', properties: { page: pageParam }, required: ['page'] } },
    });
  }
  return defs;
}

export const DRAFT_TOOL_NAMES = new Set(['render_pages', 'check_layout', 'read_draft', 'replace_in_draft', 'rewrite_page', 'delete_page']);

/** Tools over the in-memory draft: rendering and inspection are read-only; edits change only the draft. */
export function createDraftTools(draft: Draft, resolver: Resolver): FileTools {
  const pageNo = (v: unknown) => Math.floor(Number(v));
  return {
    defs: draftToolDefs(draft),
    async execute(name, args): Promise<ToolOutput> {
      try {
        switch (name) {
          case 'render_pages': {
            const raw = Array.isArray(args.pages) ? args.pages : [args.pages];
            const pages = [...new Set(raw.map(pageNo))].filter((n) => n >= 1 && n <= draft.pageCount).slice(0, MAX_RENDER_PAGES);
            if (!pages.length) return { content: `错误：请给出有效页码（共 ${draft.pageCount} 页）` };
            const view = draft.view();
            const ids = pages.map((n) => view.pages[n - 1].id);
            const [shots, reports] = await Promise.all([
              renderPageImages(view, resolver, { pageIds: ids, type: 'jpeg', scale: args.full_size ? 1 : 0.5 }),
              inspectLayout(view, resolver, ids),
            ]);
            return {
              content: `已渲染第 ${pages.join('、')} 页（${args.full_size ? '原尺寸' : '缩小一半'}，截图见下一条消息）。\n${formatReport(view, reports, pages)}`,
              images: shots.map((s) => ({
                label: `草稿第 ${pages[ids.indexOf(s.pageId)]} 页`,
                url: `data:image/jpeg;base64,${s.image.toString('base64')}`,
              })),
            };
          }
          case 'check_layout': {
            const view = draft.view();
            const pages = draft.mode === 'fragment' ? draft.editablePages() : undefined;
            const reports = await inspectLayout(view, resolver, pages?.map((n) => view.pages[n - 1].id));
            return { content: formatReport(view, reports, pages) };
          }
          case 'read_draft': {
            if (args.page === undefined || args.page === null) {
              const view = draft.view();
              const lines = view.pages.map((p, i) => {
                const title = pageText(p).split('\n')[0]?.slice(0, 40) ?? '';
                return `第 ${i + 1} 页［${draft.isEditable(i + 1) ? '可修改' : '只读'}］${draft.pageSource(i + 1).length} 字符：${title}`;
              });
              return { content: `草稿共 ${view.pages.length} 页，CSS ${draft.cssSource().length} 字符（read_draft page=0）。\n${lines.join('\n')}` };
            }
            const n = pageNo(args.page);
            const text = n === 0 ? draft.cssSource() : draft.pageSource(n);
            return { content: sliceText(text, args.offset, args.max_chars, n === 0 ? '草稿 CSS' : `草稿第 ${n} 页${draft.isEditable(n) ? '' : '（只读）'}`) };
          }
          case 'replace_in_draft': {
            const n = pageNo(args.page);
            const count = draft.replace(n, String(args.old_text ?? ''), String(args.new_text ?? ''), Boolean(args.replace_all));
            return { content: `已在草稿${n === 0 ? ' CSS ' : `第 ${n} 页`}替换 ${count} 处。建议用 render_pages 复查效果。` };
          }
          case 'rewrite_page': {
            const n = pageNo(args.page);
            const before = draft.pageCount;
            draft.setPage(n, String(args.html ?? ''));
            const added = draft.pageCount - before;
            return { content: `已重写草稿第 ${n} 页${added > 0 ? `，并拆分出 ${added} 个新页面（后续页码顺延）` : ''}。建议用 render_pages 复查效果。` };
          }
          case 'delete_page': {
            if (draft.mode !== 'doc') break;
            const n = pageNo(args.page);
            draft.deletePage(n);
            return { content: `已删除草稿第 ${n} 页，后续页码前移；现共 ${draft.pageCount} 页。` };
          }
        }
      } catch (e) {
        return { content: `错误：${(e as Error).message}` };
      }
      return { content: `错误：没有名为 ${name} 的工具` };
    },
  };
}

/** One tool set dispatching to several; unknown names go to the last one (which reports the error). */
export function combineTools(...sets: (FileTools | undefined)[]): FileTools {
  const list = sets.filter((s): s is FileTools => !!s);
  return {
    defs: list.flatMap((s) => s.defs),
    execute(name, args) {
      const owner = list.find((s) => s.defs.some((d) => d.function.name === name)) ?? list.at(-1)!;
      return owner.execute(name, args);
    },
  };
}

const KEEP_PROMPT_IMAGES = 6;

/** The original prompt without most of its images (the review can re-open reference files through tools). */
function trimPromptImages(messages: ChatMessage[], canReopen: boolean): ChatMessage[] {
  let kept = 0;
  let dropped = 0;
  const out = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const parts: ContentPart[] = [];
    for (const p of m.content) {
      if (p.type === 'image_url') {
        if (kept < KEEP_PROMPT_IMAGES) {
          kept++;
          parts.push(p);
        } else dropped++;
      } else parts.push(p);
    }
    return { ...m, content: parts };
  });
  if (dropped) {
    const last = [...out].reverse().find((m) => m.role === 'user' && Array.isArray(m.content));
    (last!.content as ContentPart[]).push({
      type: 'text',
      text: `（为节省上下文，自检阶段省略了原提示中的 ${dropped} 张参考图片${canReopen ? '；需要时可用 view_page 重新查看参考文件' : ''}）`,
    });
  }
  return out;
}

function reviewPrompt(draft: Draft, view: DeckDoc, report: string): string {
  const scope =
    draft.mode === 'fragment'
      ? `\n本次只能修改第 ${draft.describeEditable()} 页（以及 page=0 的追加样式）；其他页面只读，仅供对照风格。`
      : '';
  return `【自检阶段】你的初稿已在无头浏览器（Chrome，画幅 ${view.width}×${view.height}）中渲染。下面是页面缩略图总览与自动布局检查报告。
请像设计师交付前一样自检并修复：
1. 报告中的「✗ 错误」（文字超出页面、内容被裁切、图片无法加载等）必须修复；「△ 提醒」请判断是否需要处理（例如有意叠放的装饰大字可以保留）。
2. 对照缩略图检查视觉问题：拥挤或大片空白、对比度不足、元素错位、各页风格不统一、与要求或参考不符。
3. 用 render_pages 渲染指定页看细节（可 full_size），用 read_draft 查看源码，用 replace_in_draft（精确替换片段，最省）或 rewrite_page 修改；改完用 render_pages 或 check_layout 复查。
4. 修改只作用于草稿；参考文件始终只读。
5. 确认无误后，直接用一两句话总结你做了哪些修改（或“无需修改”），不要再输出完整 HTML。${scope}

【自动布局检查】
${report}`;
}

/** The model's closing remark, without any tool-call markup it may have written out as text. */
function cleanSummary(text: string): string | undefined {
  const cut = text.search(/<\/?(parameter|invoke|function|tool_call|replace_in_draft|rewrite_page|render_pages|read_draft|check_layout|delete_page)\b/i);
  const s = (cut >= 0 ? text.slice(0, cut) : text).replace(/<\/?[a-z_]+>/gi, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 300) : undefined;
}

export interface ReviewLog {
  before: IssueCount;
  after: IssueCount;
  passes: number;
  toolCalls: number;
  edits: number;
  summary?: string;
  error?: string;
}

export interface ReviewOptions extends ChatOptions {
  draft: Draft;
  resolver: Resolver;
  prompt: ChatMessage[];
  fileTools?: FileTools;
  maxRounds: number;
  onTool?: (name: string, args: Record<string, unknown>) => void;
  onStage?: (stage: string) => void;
  onUsage?: (u: ChatResult) => void;
}

/**
 * Agent loop after the first draft: render it, inspect the layout, and let the model look at its own
 * pages and fix them with the draft tools until it is satisfied (bounded by maxRounds). If errors are
 * still detected afterwards it gets one more pass. Failures here never fail the job: the draft as it
 * stands is kept.
 */
export async function reviewDraft(db: DB, userId: number, opts: ReviewOptions): Promise<ReviewLog> {
  const { draft, resolver, prompt, fileTools, maxRounds, onTool, onStage, onUsage, ...chatOpts } = opts;
  const focus = () => (draft.mode === 'fragment' ? draft.editablePages() : undefined);
  const inspect = async () => {
    const view = draft.view();
    const pages = focus();
    const reports = await inspectLayout(view, resolver, pages?.map((n) => view.pages[n - 1].id));
    return { view, reports, text: formatReport(view, reports, pages) };
  };
  const log: ReviewLog = { before: { errors: 0, warnings: 0 }, after: { errors: 0, warnings: 0 }, passes: 0, toolCalls: 0, edits: 0 };
  try {
    onStage?.('自检：渲染并检查初稿');
    const first = await inspect();
    log.before = log.after = countIssues(first.reports);
    const labels = first.view.pages.map((_, i) => `第 ${i + 1} 页${draft.mode === 'fragment' && !draft.isEditable(i + 1) ? '（只读）' : ''}`);
    const sheets = await renderContactSheets(first.view, resolver, { labels });
    const images: ContentPart[] = sheets.flatMap((s, i) => [
      { type: 'text' as const, text: sheets.length > 1 ? `缩略图总览 ${i + 1}/${sheets.length}：` : '缩略图总览：' },
      { type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${s.toString('base64')}` } },
    ]);
    const draftChars = draft.view().pages.reduce((n, p) => n + p.html.length, 0);
    let messages: ChatMessage[] = [
      ...trimPromptImages(prompt, !!fileTools),
      {
        role: 'assistant',
        content: `（我已输出初稿：共 ${first.view.pages.length} 页，HTML 约 ${draftChars} 字符。初稿已保存为草稿，可用 read_draft 查看源码。）`,
      },
      { role: 'user', content: [{ type: 'text', text: reviewPrompt(draft, first.view, first.text) }, ...images] },
    ];
    const tools = combineTools(createDraftTools(draft, resolver), fileTools);
    let report = first;
    for (let pass = 0; pass < 2; pass++) {
      log.passes++;
      onStage?.('自检：模型检查草稿');
      const r = await chatWithTools(db, userId, messages, {
        ...chatOpts,
        tools: tools.defs,
        execute: tools.execute,
        onTool: (name, args) => {
          log.toolCalls++;
          onTool?.(name, args);
        },
        onRound: onUsage,
        maxRounds: pass === 0 ? maxRounds : Math.max(2, Math.ceil(maxRounds / 2)),
        maxImages: 16,
        allowEmptyFinal: true,
      });
      if (r.text && draft.replaceFromText(r.text)) log.summary = '（模型重新输出了完整内容）';
      else if (r.text) log.summary = cleanSummary(r.text);
      onStage?.('自检：复查布局');
      report = await inspect();
      log.after = countIssues(report.reports);
      if (!log.after.errors || pass > 0) break;
      messages = [
        ...r.history,
        {
          role: 'user',
          content: `【自动复查】草稿中仍检测到以下问题，请继续修复（若确属有意设计，可说明理由后结束）：\n${report.text}`,
        },
      ];
    }
  } catch (e) {
    log.error = (e as Error).message;
  }
  log.edits = draft.edits;
  return log;
}
