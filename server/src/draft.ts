import * as cheerio from 'cheerio';
import type { DB } from './db.js';
import { assignIds, cloneDoc, parseFragment, parseFullHtmlRaw, replacePage, type DeckDoc, type DeckPage } from './deck.js';
import {
  countInPage,
  editCss,
  editInPage,
  findCssRules,
  findInPage,
  hasCssRule,
  listMatches,
  tooMany,
  type CssEdit,
  type ElementEdit,
  type ElementMatch,
  type ElementTarget,
} from './domEdit.js';
import { sliceText, type FileTools, type ToolDef, type ToolOutput } from './fileTools.js';
import { ADDITIONS_CSS, checkPath, cssFiles, fileTree, joinCssFiles, nameFiles, parseFileBlocks, README } from './files.js';
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

function withoutIds(html: string): string {
  const $ = cheerio.load(html, null, false);
  $('[data-eid]').removeAttr('data-eid');
  $('[data-page-id]').removeAttr('data-page-id');
  return $.html();
}

/**
 * The model's work in progress for one job. It lives only in memory: the draft tools edit this object
 * and nothing else, and the job saves it as a new version once the review is over.
 * In fragment mode (page/element edits) only the pages that replace the target page are editable.
 */
export class Draft {
  edits = 0;

  /** README changes in fragment mode, applied onto the latest saved document. */
  private readmeEdit?: string;

  private constructor(
    readonly mode: 'doc' | 'fragment',
    private doc: DeckDoc,
    private pages: DeckPage[] = [],
    private extraCss = '',
    readonly targetPageId?: string,
  ) {}

  static fromDocument(text: string, base: Pick<DeckDoc, 'width' | 'height' | 'title'> & { readme?: string }): Draft {
    const doc = parseFullHtmlRaw(text, base);
    return new Draft('doc', { ...doc, readme: base.readme });
  }

  /** Start from the saved document, to be changed with the tools (whole-document edits). */
  static ofDocument(snapshot: DeckDoc): Draft {
    return new Draft('doc', cloneDoc(snapshot));
  }

  /** Start from one saved page, to be changed with the tools (page and element edits). */
  static ofPage(snapshot: DeckDoc, pageId: string): Draft {
    const page = snapshot.pages.find((p) => p.id === pageId);
    if (!page) throw new Error('目标页面不存在');
    return new Draft('fragment', snapshot, [{ ...page }], '', pageId);
  }

  static fromFragment(text: string, snapshot: DeckDoc, pageId: string): Draft {
    const frag = parseFragment(text);
    if (!snapshot.pages.some((p) => p.id === pageId)) throw new Error('目标页面不存在');
    return new Draft('fragment', snapshot, frag.pages, frag.css, pageId);
  }

  /** The draft as it would be saved, with ids assigned; page n of the model is pages[n - 1]. */
  view(): DeckDoc {
    if (this.mode === 'doc') return assignIds(cloneDoc(this.doc));
    return { ...replacePage(this.doc, this.targetPageId!, this.pages, this.extraCss), readme: this.readme };
  }

  get readme(): string {
    return this.mode === 'fragment' && this.readmeEdit !== undefined ? this.readmeEdit : this.doc.readme ?? '';
  }

  setReadme(text: string) {
    if (this.mode === 'doc') this.doc = { ...this.doc, readme: text };
    else this.readmeEdit = text;
    this.edits++;
  }

  /** Page number of a page file in the current draft. */
  pageOf(path: string): number | undefined {
    const i = this.view().pages.findIndex((p) => p.file === path);
    return i >= 0 ? i + 1 : undefined;
  }

  /** Page number from a `path` (pages/x.html) or `page` argument. */
  resolvePage(path: unknown, page: unknown): number | undefined {
    if (typeof path === 'string' && path.trim()) {
      const c = checkPath(path);
      if (c.kind !== 'page') throw new Error(`${c.path} 不是页面文件`);
      const n = this.pageOf(c.path);
      if (!n) throw new Error(`草稿中没有 ${c.path}；用 read_draft（不带参数）查看文件列表`);
      return n;
    }
    return page === undefined || page === null || page === '' ? undefined : Math.floor(Number(page));
  }

  listFiles(): string {
    const view = this.view();
    const lines = fileTree(view).map((e) => {
      if (e.kind === 'readme') return `${e.path}（${e.chars} 字符）— 需求与风格说明（生成说明），修改前先读；用户的要求改变了风格、受众或页面规划时同步更新`;
      if (e.kind === 'css') {
        const ro = this.mode === 'fragment' ? (e.path === ADDITIONS_CSS ? '［可追加本页样式］' : '［共享，只读］') : '';
        return `${e.path}（${e.chars} 字符）${ro}`;
      }
      return `${e.path} — 第 ${e.page} 页［${this.isEditable(e.page!) ? '可修改' : '只读'}］${e.chars} 字符：${e.title}`;
    });
    if (this.mode === 'fragment' && !lines.some((l) => l.startsWith(ADDITIONS_CSS))) lines.push(`${ADDITIONS_CSS}（尚未创建）［可追加本页样式］`);
    return `项目文件（共 ${view.pages.length} 页；页面按下面的顺序组成材料）：\n${lines.join('\n')}`;
  }

  readFile(path: string): string {
    const c = checkPath(path);
    if (c.kind === 'readme') return this.readme;
    if (c.kind === 'page') {
      const n = this.pageOf(c.path);
      if (!n) throw new Error(`草稿中没有 ${c.path}`);
      return this.pageSource(n);
    }
    const shared = cssFiles(this.doc.css).find((f) => f.path === c.path)?.css;
    if (this.mode === 'doc') {
      if (shared === undefined) throw new Error(`没有样式文件 ${c.path}`);
      return shared;
    }
    if (c.path === ADDITIONS_CSS) return `${shared ? `/* ===== 已有内容（只读） ===== */\n${shared}\n` : ''}/* ===== 本次追加（write_file 写入的内容会替换这一部分） ===== */\n${this.extraCss}`;
    if (shared === undefined) throw new Error(`没有样式文件 ${c.path}`);
    return shared;
  }

  /** Create or overwrite one project file. New page files go after page `after` (default: at the end). */
  writeFile(path: string, content: string, after?: number): string {
    const c = checkPath(path);
    if (c.kind === 'readme') {
      if (!content.trim()) throw new Error('README.md 不能为空');
      this.setReadme(content.trim() + '\n');
      return `已写入 ${README}`;
    }
    if (c.kind === 'css') {
      if (/<\/?(style|section|html)\b/i.test(content)) throw new Error('样式文件中只能写 CSS，不要包含 <style> 等 HTML 标签');
      if (this.mode === 'fragment') {
        if (c.path !== ADDITIONS_CSS) throw new Error(`共享样式文件只读（会影响所有页面）。本页需要的新规则请写入 ${ADDITIONS_CSS}，或用 edit_elements 的 style`);
        this.setCss(content);
        return `已写入 ${ADDITIONS_CSS} 的本次追加部分`;
      }
      const files = cssFiles(this.doc.css);
      const f = files.find((x) => x.path === c.path);
      if (f) f.css = content;
      else files.push({ path: c.path, css: content });
      this.setCss(joinCssFiles(files));
      return `已${f ? '覆盖' : '新建'} ${c.path}`;
    }
    const n = this.pageOf(c.path);
    if (n) {
      const before = this.pageCount;
      this.setPage(n, content);
      const added = this.pageCount - before;
      return `已覆盖 ${c.path}（第 ${n} 页）${added > 0 ? `，并拆分出 ${added} 个新页面（文件名自动生成，后续页码顺延）` : ''}`;
    }
    const at = after ?? (this.mode === 'doc' ? this.doc.pages.length : this.editablePages().at(-1)!);
    const added = this.insertPages(at, content, c.path);
    return `已新建 ${c.path}，插在第 ${at} 页之后（${added > 1 ? `共 ${added} 页，` : ''}现共 ${this.pageCount} 页）`;
  }

  deleteFile(path: string): string {
    const c = checkPath(path);
    if (c.kind === 'readme') throw new Error('README.md 不能删除；需要修改时请用 write_file 或 replace_in_draft');
    if (c.kind === 'page') {
      const n = this.pageOf(c.path);
      if (!n) throw new Error(`草稿中没有 ${c.path}`);
      this.deletePage(n);
      return `已删除 ${c.path}（原第 ${n} 页），后续页码前移；现共 ${this.pageCount} 页`;
    }
    if (this.mode === 'fragment') throw new Error('共享样式文件只读');
    const files = cssFiles(this.doc.css);
    if (!files.some((f) => f.path === c.path)) throw new Error(`没有样式文件 ${c.path}`);
    this.setCss(joinCssFiles(files.filter((f) => f.path !== c.path)));
    return `已删除 ${c.path}`;
  }

  /** Exact find/replace inside one file. */
  replaceInFile(path: string, oldText: string, newText: string, all: boolean): number {
    const c = checkPath(path);
    if (c.kind === 'page') {
      const n = this.pageOf(c.path);
      if (!n) throw new Error(`草稿中没有 ${c.path}`);
      return this.replace(n, oldText, newText, all);
    }
    if (c.kind === 'css' && this.mode === 'fragment') {
      if (c.path !== ADDITIONS_CSS) throw new Error(`共享样式文件只读；本页的样式请写入 ${ADDITIONS_CSS} 或用 edit_elements 的 style`);
      return this.replace(0, oldText, newText, all);
    }
    const source = this.readFile(c.path);
    const next = replaceText(source, oldText, newText, all);
    if (c.kind === 'readme') this.setReadme(next.text);
    else {
      const files = cssFiles(this.doc.css).map((f) => (f.path === c.path ? { ...f, css: next.text } : f));
      this.setCss(joinCssFiles(files));
    }
    return next.count;
  }

  /** Pages in the order of the given page files; pages not listed keep their place after them. */
  reorder(paths: string[]): void {
    if (this.mode !== 'doc') return;
    const named = nameFiles(this.doc.pages);
    const rank = new Map<string, number>();
    paths.forEach((p, i) => {
      try {
        rank.set(checkPath(p).path, i);
      } catch {
        /* not a page path */
      }
    });
    const pages = named
      .map((p, i) => ({ p, key: rank.get(p.file!) ?? 1e6 + i }))
      .sort((a, b) => a.key - b.key)
      .map((x) => x.p);
    if (pages.some((p, i) => p !== named[i])) {
      this.doc = { ...this.doc, pages };
      this.edits++;
    }
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
    sections[0].file = this.pageFile(page);
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

  private pageFile(page: number): string | undefined {
    if (this.mode === 'doc') return this.doc.pages[page - 1]?.file;
    const first = this.firstEditable;
    if (page >= first && page < first + this.pages.length) return this.pages[page - first].file;
    return undefined;
  }

  /** Exact find/replace inside one editable page (or the editable CSS when page is 0). */
  replace(page: number, oldText: string, newText: string, all: boolean): number {
    const source = page === 0 ? this.editableCss() : this.pageSource(page);
    if (page !== 0 && !this.isEditable(page)) throw new Error(`第 ${page} 页是只读的，本次只能修改第 ${this.describeEditable()} 页`);
    const next = replaceText(source, oldText, newText, all);
    if (page === 0) this.setCss(next.text);
    else this.setPage(page, next.text);
    return next.count;
  }

  /** The same exact replacement in every editable page; returns the count per page. */
  replaceEverywhere(oldText: string, newText: string): { page: number; count: number }[] {
    if (!oldText) throw new Error('old_text 不能为空');
    const hits = this.editablePages()
      .map((page) => ({ page, count: this.pageSource(page).split(oldText).length - 1 }))
      .filter((h) => h.count > 0);
    if (!hits.length) throw new Error('所有可修改的页面中都没有找到 old_text');
    for (const h of hits) this.setPage(h.page, this.pageSource(h.page).split(oldText).join(newText));
    return hits;
  }

  private pagesToSearch(page?: number): number[] {
    if (page === undefined || page === null || Number.isNaN(page)) return Array.from({ length: this.pageCount }, (_, i) => i + 1);
    if (page < 1 || page > this.pageCount) throw new Error(`页码超出范围（共 ${this.pageCount} 页）`);
    return [page];
  }

  findElements(target: ElementTarget, page?: number): (ElementMatch & { page: number; editable: boolean })[] {
    return this.pagesToSearch(page).flatMap((p) =>
      findInPage(this.pageSource(p), target).map((m) => ({ ...m, page: p, editable: this.isEditable(p) })),
    );
  }

  /** Apply a structured edit to matching elements of the editable pages (or of one page). */
  editElements(target: ElementTarget, edit: ElementEdit, all: boolean, page?: number): { page: number; count: number }[] {
    const pages = this.pagesToSearch(page);
    const counts = pages.map((p) => ({ page: p, count: countInPage(this.pageSource(p), target) })).filter((c) => c.count > 0);
    const locked = counts.filter((c) => !this.isEditable(c.page));
    const open = counts.filter((c) => this.isEditable(c.page));
    if (!open.length) {
      if (locked.length) throw new Error(`匹配的元素在第 ${locked.map((c) => c.page).join('、')} 页，该页是只读的；本次只能修改第 ${this.describeEditable()} 页`);
      throw new Error('没有匹配的元素；请先用 find_elements 或 read_draft 确认 data-eid / 选择器');
    }
    const total = open.reduce((n, c) => n + c.count, 0);
    const exact = !!target.eids?.length && total === target.eids.length;
    if (total > 1 && !all && !exact) throw tooMany(open.flatMap((c) => findInPage(this.pageSource(c.page), target).map((m) => ({ ...m, page: c.page }))));
    for (const c of open) this.setPage(c.page, editInPage(this.pageSource(c.page), target, edit, true).html);
    return open;
  }

  findCss(query: string): string[] {
    const shared = cssFiles(this.doc.css).flatMap((f) => findCssRules(f.css, query, `［${f.path}${this.mode === 'fragment' ? '，共享只读' : ''}］`));
    if (this.mode === 'doc') return shared;
    return [...shared, ...findCssRules(this.extraCss, query, `［${ADDITIONS_CSS} 本次追加］`)];
  }

  /** Edit one rule: in the file that has it, else (new rule) in `file` or the last style file. */
  editCss(edit: CssEdit, file?: string): ReturnType<typeof editCss> & { file: string } {
    if (this.mode === 'fragment') {
      if (hasCssRule(this.doc.css, edit.selector, edit.media) && !hasCssRule(this.extraCss, edit.selector, edit.media)) {
        throw new Error(
          `规则 ${edit.selector} 属于共享样式，修改会影响所有页面，而本次只能修改第 ${this.describeEditable()} 页：请用 edit_elements 的 style / add_class 修改本页元素，或新建一个只用于本页的 class`,
        );
      }
      const r = editCss(this.extraCss, edit);
      this.setCss(r.css);
      return { ...r, file: ADDITIONS_CSS };
    }
    const files = cssFiles(this.doc.css);
    let target = files.find((f) => hasCssRule(f.css, edit.selector, edit.media));
    if (!target) {
      const wanted = file ? checkPath(file) : undefined;
      if (wanted && wanted.kind !== 'css') throw new Error('file 必须是 styles/ 下的 .css 文件');
      target = files.find((f) => f.path === wanted?.path) ?? (wanted ? undefined : files.at(-1));
      if (!target) {
        target = { path: wanted?.path ?? 'styles/main.css', css: '' };
        files.push(target);
      }
    }
    const r = editCss(target.css, edit);
    target.css = r.css;
    this.setCss(joinCssFiles(files));
    return { ...r, file: target.path };
  }

  /** New pages after page `after` (0 = before the first); ids are dropped so the copies get fresh ones. */
  insertPages(after: number, html: string, file?: string): number {
    const sections: DeckPage[] = splitSections(html).map((s) => ({ id: '', html: withoutIds(s.html) }));
    if (!sections.length) throw new Error('内容中没有 <section class="slide"> 页面元素');
    if (file) sections[0].file = file;
    if (this.mode === 'doc') {
      if (after < 0 || after > this.doc.pages.length) throw new Error(`after 超出范围（0–${this.doc.pages.length}）`);
      const pages = [...this.doc.pages];
      pages.splice(after, 0, ...sections);
      this.doc = { ...this.doc, pages };
    } else {
      if (!this.isEditable(after)) throw new Error(`本次只能在第 ${this.describeEditable()} 页之后插入新页`);
      this.pages.splice(after - this.firstEditable + 1, 0, ...sections);
    }
    this.edits++;
    return sections.length;
  }

  duplicatePage(page: number): void {
    if (this.mode !== 'doc') throw new Error('只有修改整份材料时才能复制页面');
    this.insertPages(page, this.pageSource(page));
  }

  movePage(page: number, to: number): void {
    if (this.mode !== 'doc') throw new Error('只有修改整份材料时才能移动页面');
    const n = this.doc.pages.length;
    if (page < 1 || page > n || to < 1 || to > n) throw new Error(`页码超出范围（共 ${n} 页）`);
    const pages = [...this.doc.pages];
    const [p] = pages.splice(page - 1, 1);
    pages.splice(to - 1, 0, p);
    this.doc = { ...this.doc, pages };
    this.edits++;
  }

  /**
   * Accept content written out in the final answer: changed files as <file> blocks, or a complete
   * re-output. Returns false when the text holds nothing usable.
   */
  replaceFromText(text: string): boolean {
    const blocks = parseFileBlocks(text);
    const deletes = [...text.matchAll(/<delete\s+path\s*=\s*["']([^"']+)["']\s*\/?>/gi)].map((m) => m[1]);
    const order = text.match(/<order>([\s\S]*?)<\/order>/i)?.[1];
    if (blocks.some((b) => b.complete) || deletes.length || order) {
      const before = this.edits;
      for (const b of blocks.filter((x) => x.complete)) {
        try {
          this.writeFile(b.path, b.content);
        } catch {
          /* one bad file does not discard the others */
        }
      }
      for (const d of deletes) {
        try {
          this.deleteFile(d);
        } catch {
          /* already gone or read-only */
        }
      }
      if (order) this.reorder(order.split(/[\s,，、]+/).filter((x) => x.startsWith('pages/')));
      return this.edits > before;
    }
    if (!/<section/i.test(text)) return false;
    try {
      if (this.mode === 'doc') {
        if (!/<(html|!doctype|body)/i.test(text)) return false;
        const files = new Map(this.doc.pages.map((p) => [p.id, p.file]));
        const next = parseFullHtmlRaw(text, this.doc);
        this.doc = { ...next, readme: this.doc.readme, pages: next.pages.map((p) => ({ ...p, file: files.get(p.id) })) };
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
    const base = latest ?? this.doc;
    return { ...replacePage(base, this.targetPageId!, this.pages, this.extraCss), readme: this.readmeEdit ?? base.readme };
  }

  describeEditable(): string {
    const pages = this.editablePages();
    return pages.length > 1 ? `${pages[0]}–${pages.at(-1)}` : String(pages[0]);
  }
}

function replaceText(source: string, oldText: string, newText: string, all: boolean): { text: string; count: number } {
  if (!oldText) throw new Error('old_text 不能为空');
  const count = source.split(oldText).length - 1;
  if (!count) throw new Error('没有找到 old_text（必须与源码逐字一致，包括空格与引号）；请先用 read_draft 查看源码');
  if (count > 1 && !all) throw new Error(`old_text 出现了 ${count} 次；请提供更长的上下文使其唯一，或设置 replace_all=true`);
  return { text: all ? source.split(oldText).join(newText) : source.replace(oldText, () => newText), count: all ? count : 1 };
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
  const pathParam = { type: 'string', description: '文件路径，如 pages/cover.html（可代替 page）' };
  const defs: ToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'render_pages',
        description: `在无头浏览器中渲染草稿的指定页面并返回截图（默认缩小一半，full_size=true 为原尺寸），同时给出这些页的自动布局检查结果。一次最多 ${MAX_RENDER_PAGES} 页。`,
        parameters: {
          type: 'object',
          properties: {
            pages: { type: 'array', items: intParam, description: '页码列表' },
            paths: { type: 'array', items: { type: 'string' }, description: '或页面文件路径列表' },
            full_size: { type: 'boolean' },
          },
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
        description:
          '读取项目文件。不传参数返回文件列表（README.md、styles/*.css、pages/*.html 及页码）；path 读取指定文件；也可用 page=n 读第 n 页、page=0 读全部 CSS。长内容按 offset 分段读取。',
        parameters: { type: 'object', properties: { path: { type: 'string' }, page: intParam, offset: intParam, max_chars: intParam } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: `新建或整体覆盖一个项目文件：README.md（需求与风格说明）、styles/名称.css（只写 CSS）或 pages/名称.html（一个 <section class="slide">，覆盖时保留已有 data-eid）。新页面文件插在第 after 页之后（默认${draft.mode === 'doc' ? '放在最后' : '放在可修改的页面之后'}）。${
          draft.mode === 'fragment' ? `本次共享样式只读，本页新增的样式规则写入 ${ADDITIONS_CSS}。` : ''
        }只改一小部分时请用 edit_elements / edit_css / replace_in_draft，更省输出。`,
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, after: intParam }, required: ['path', 'content'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: `删除一个页面文件${draft.mode === 'doc' ? '或样式文件' : ''}（README.md 不能删除）。`,
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'find_elements',
        description:
          '在草稿中查找元素，返回所在页码、标签、class、data-eid 和文字摘要。selector 为 CSS 选择器（如 ".kpi-card h3"、"h1"、"[data-eid=\\"e1a2b3c4d\\"]"）；contains 按文字查找（返回包含该文字的最内层元素）。不传 page 则搜索所有页。',
        parameters: {
          type: 'object',
          properties: { selector: { type: 'string' }, contains: { type: 'string' }, page: pageParam, path: pathParam },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_elements',
        description:
          '结构化修改元素（最省 token，优先使用）。用 eids（data-eid 列表）、selector 或 contains 指定元素，可限定 page；匹配多个元素时需 all=true。修改项可组合：text 替换纯文字（元素含子元素时请改子元素）；html 替换内部 HTML；outer_html 替换整个元素；attrs 设置属性（值为 null 删除）；style 合并内联样式（值为 null 删除该属性）；add_class / remove_class；remove=true 删除元素；insert={position: before|after|prepend|append, html} 插入新内容。',
        parameters: {
          type: 'object',
          properties: {
            eids: { type: 'array', items: { type: 'string' } },
            selector: { type: 'string' },
            contains: { type: 'string' },
            page: pageParam,
            path: pathParam,
            all: { type: 'boolean' },
            text: { type: 'string' },
            html: { type: 'string' },
            outer_html: { type: 'string' },
            attrs: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
            style: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: '如 {"color": "#1e40af", "font-size": "48px"}' },
            add_class: { type: 'string' },
            remove_class: { type: 'string' },
            remove: { type: 'boolean' },
            insert: {
              type: 'object',
              properties: { position: { type: 'string', enum: ['before', 'after', 'prepend', 'append'] }, html: { type: 'string' } },
              required: ['position', 'html'],
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'find_css',
        description: '查找草稿 CSS 中选择器或属性包含 query 的规则（如 "kpi"、"--brand"、"font-size"），返回完整规则；比读取整份 CSS 更省。',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_css',
        description:
          '修改一条 CSS 规则：selector 与现有规则一致时修改它所在的样式文件，否则新建规则（放在 file 指定的样式文件，默认最后一个）；set 中的属性会被设置（值为 null 删除该属性，可带 !important）；remove=true 删除整条规则；media 指定 @media 条件（如 "(max-width: 800px)"）。修改 CSS 变量请用 selector=":root"。',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            file: { type: 'string', description: '新建规则时放入的样式文件，如 styles/components.css' },
            set: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: '如 {"--brand": "#111827", "border-radius": "24px"}' },
            remove: { type: 'boolean' },
            media: { type: 'string' },
          },
          required: ['selector'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'replace_in_draft',
        description:
          '在一个项目文件中做精确替换：用 path 指定文件（README.md、styles/x.css、pages/x.html），或用 page（page=0 表示可修改的 CSS）。old_text 必须与源码逐字一致且唯一（或设 replace_all=true）。all_pages=true 时在所有可修改的页面中全部替换（如统一改名）。只修改草稿，不会改动任何参考文件。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            page: intParam,
            old_text: { type: 'string' },
            new_text: { type: 'string' },
            replace_all: { type: 'boolean' },
            all_pages: { type: 'boolean' },
          },
          required: ['old_text', 'new_text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'rewrite_page',
        description:
          '用新的 HTML 整体替换草稿第 n 页（输出量大，只在需要重新设计整页时使用）。html 中可包含多个 <section class="slide">，用于把内容过多的一页拆成几页。保留原有的 data-eid 属性。',
        parameters: { type: 'object', properties: { page: pageParam, path: pathParam, html: { type: 'string' } }, required: ['html'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'insert_page',
        description: `在第 after 页之后插入新页面（html 为一个或多个 <section class="slide">${draft.mode === 'doc' ? '；after=0 插在最前面' : '；只能插在可修改的页面之后'}）。`,
        parameters: { type: 'object', properties: { after: intParam, html: { type: 'string' } }, required: ['after', 'html'] },
      },
    },
  ];
  if (draft.mode === 'doc') {
    defs.push(
      {
        type: 'function',
        function: { name: 'delete_page', description: '删除草稿中的第 n 页。', parameters: { type: 'object', properties: { page: pageParam, path: pathParam } } },
      },
      {
        type: 'function',
        function: {
          name: 'duplicate_page',
          description: '复制第 n 页，副本插在它后面（之后可用 edit_elements 修改副本）。',
          parameters: { type: 'object', properties: { page: pageParam, path: pathParam } },
        },
      },
      {
        type: 'function',
        function: {
          name: 'move_page',
          description: '把第 page 页移动到第 to 页的位置。',
          parameters: { type: 'object', properties: { page: pageParam, to: pageParam }, required: ['page', 'to'] },
        },
      },
    );
  }
  return defs;
}

export const DRAFT_TOOL_NAMES = new Set([
  'render_pages',
  'check_layout',
  'read_draft',
  'write_file',
  'delete_file',
  'find_elements',
  'edit_elements',
  'find_css',
  'edit_css',
  'replace_in_draft',
  'rewrite_page',
  'insert_page',
  'delete_page',
  'duplicate_page',
  'move_page',
]);

/** Tool names that change the draft (the rest only look at it). */
export const DRAFT_EDIT_TOOLS = new Set(['write_file', 'delete_file', 'edit_elements', 'edit_css', 'replace_in_draft', 'rewrite_page', 'insert_page', 'delete_page', 'duplicate_page', 'move_page']);

const asStrings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? v.split(/[,\s]+/).filter(Boolean) : undefined;

const asMap = (v: unknown): Record<string, string | null> | undefined => {
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      v = JSON.parse(v);
    } catch {
      throw new Error('无法解析对象参数（需要 JSON 对象）');
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, x === null ? null : String(x)]));
};

function targetOf(args: Record<string, unknown>): ElementTarget {
  return {
    eids: asStrings(args.eids),
    selector: typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : undefined,
    text: typeof args.contains === 'string' && args.contains ? args.contains : undefined,
  };
}

function editOf(args: Record<string, unknown>): ElementEdit {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
  let insert = args.insert as ElementEdit['insert'] | string | undefined;
  if (typeof insert === 'string') insert = JSON.parse(insert);
  return {
    text: str('text'),
    html: str('html'),
    outer_html: str('outer_html'),
    attrs: asMap(args.attrs),
    style: asMap(args.style),
    add_class: str('add_class'),
    remove_class: str('remove_class'),
    remove: args.remove === true,
    insert: insert && typeof insert === 'object' ? { position: insert.position, html: String(insert.html ?? '') } : undefined,
  };
}

const optPage = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Math.floor(Number(v)));

/** Tools over the in-memory draft: rendering and inspection are read-only; edits change only the draft. */
export function createDraftTools(draft: Draft, resolver: Resolver): FileTools {
  const pageNo = (v: unknown) => Math.floor(Number(v));
  const pageArg = (args: Record<string, unknown>) => {
    const n = draft.resolvePage(args.path, args.page);
    if (n === undefined || Number.isNaN(n)) throw new Error('请给出 page（页码）或 path（页面文件）');
    return n;
  };
  return {
    defs: draftToolDefs(draft),
    async execute(name, args): Promise<ToolOutput> {
      try {
        switch (name) {
          case 'render_pages': {
            const raw = [
              ...(Array.isArray(args.pages) ? args.pages : args.pages !== undefined ? [args.pages] : []).map(pageNo),
              ...(Array.isArray(args.paths) ? args.paths : typeof args.paths === 'string' ? [args.paths] : []).map((p) => draft.resolvePage(String(p), undefined)!),
            ];
            const pages = [...new Set(raw)].filter((n) => n >= 1 && n <= draft.pageCount).slice(0, MAX_RENDER_PAGES);
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
            if (typeof args.path === 'string' && args.path.trim()) {
              const path = checkPath(args.path).path;
              const n = draft.pageOf(path);
              const ro = n ? !draft.isEditable(n) : draft.mode === 'fragment' && path.startsWith('styles/') && path !== ADDITIONS_CSS;
              return { content: sliceText(draft.readFile(path), args.offset, args.max_chars, `${path}${n ? `（第 ${n} 页）` : ''}${ro ? '（只读）' : ''}`) };
            }
            if (args.page === undefined || args.page === null || args.page === '') return { content: draft.listFiles() };
            const n = pageNo(args.page);
            const text = n === 0 ? draft.cssSource() : draft.pageSource(n);
            return { content: sliceText(text, args.offset, args.max_chars, n === 0 ? '草稿 CSS' : `草稿第 ${n} 页${draft.isEditable(n) ? '' : '（只读）'}`) };
          }
          case 'write_file': {
            const after = args.after === undefined || args.after === null || args.after === '' ? undefined : pageNo(args.after);
            return { content: `${draft.writeFile(String(args.path ?? ''), String(args.content ?? ''), after)}。` };
          }
          case 'delete_file':
            return { content: `${draft.deleteFile(String(args.path ?? ''))}。` };
          case 'find_elements': {
            const target = targetOf(args);
            if (!target.selector && !target.text && !target.eids) return { content: '错误：请给出 selector 或 contains' };
            const found = draft.findElements(target, draft.resolvePage(args.path, optPage(args.page)));
            const locked = found.filter((m) => !m.editable).length;
            return { content: `${listMatches(found)}${locked && draft.mode === 'fragment' ? `\n（其中 ${locked} 个在只读页面上）` : ''}` };
          }
          case 'edit_elements': {
            const hits = draft.editElements(targetOf(args), editOf(args), args.all === true, draft.resolvePage(args.path, optPage(args.page)));
            const n = hits.reduce((s, h) => s + h.count, 0);
            return { content: `已修改 ${n} 个元素（第 ${hits.map((h) => h.page).join('、')} 页）。需要时用 render_pages 查看效果。` };
          }
          case 'find_css': {
            const rules = draft.findCss(String(args.query ?? ''));
            if (!rules.length) return { content: '没有匹配的 CSS 规则。' };
            const text = rules.join('\n');
            return { content: `共 ${rules.length} 条规则：\n${text.length > 6000 ? `${text.slice(0, 6000)}\n…（结果过长已截断，请用更具体的 query）` : text}` };
          }
          case 'edit_css': {
            const r = draft.editCss(
              { selector: String(args.selector ?? ''), media: typeof args.media === 'string' && args.media ? args.media : undefined, set: asMap(args.set), remove: args.remove === true },
              typeof args.file === 'string' && args.file.trim() ? args.file : undefined,
            );
            const verb = { updated: '已修改', created: '已新建', removed: '已删除' }[r.action];
            return { content: `${verb}规则（${r.file}）：${r.rule}` };
          }
          case 'insert_page': {
            const added = draft.insertPages(pageNo(args.after), String(args.html ?? ''));
            return { content: `已在第 ${pageNo(args.after)} 页之后插入 ${added} 页，后续页码顺延；现共 ${draft.pageCount} 页。` };
          }
          case 'duplicate_page': {
            const n = pageArg(args);
            draft.duplicatePage(n);
            return { content: `已复制第 ${n} 页，副本为第 ${n + 1} 页（${draft.view().pages[n].file}）；现共 ${draft.pageCount} 页。` };
          }
          case 'move_page': {
            draft.movePage(pageNo(args.page), pageNo(args.to));
            return { content: `已把第 ${pageNo(args.page)} 页移到第 ${pageNo(args.to)} 页。` };
          }
          case 'replace_in_draft': {
            if (args.all_pages === true) {
              const hits = draft.replaceEverywhere(String(args.old_text ?? ''), String(args.new_text ?? ''));
              return { content: `已替换 ${hits.reduce((s, h) => s + h.count, 0)} 处（${hits.map((h) => `第 ${h.page} 页 ${h.count} 处`).join('，')}）。` };
            }
            if (typeof args.path === 'string' && args.path.trim()) {
              const path = checkPath(args.path).path;
              const count = draft.replaceInFile(path, String(args.old_text ?? ''), String(args.new_text ?? ''), Boolean(args.replace_all));
              return { content: `已在 ${path} 中替换 ${count} 处。${path === README ? '' : '建议用 render_pages 复查效果。'}` };
            }
            const n = pageNo(args.page);
            const count = draft.replace(n, String(args.old_text ?? ''), String(args.new_text ?? ''), Boolean(args.replace_all));
            return { content: `已在草稿${n === 0 ? ' CSS ' : `第 ${n} 页`}替换 ${count} 处。建议用 render_pages 复查效果。` };
          }
          case 'rewrite_page': {
            const n = pageArg(args);
            const before = draft.pageCount;
            draft.setPage(n, String(args.html ?? ''));
            const added = draft.pageCount - before;
            return { content: `已重写草稿第 ${n} 页${added > 0 ? `，并拆分出 ${added} 个新页面（后续页码顺延）` : ''}。建议用 render_pages 复查效果。` };
          }
          case 'delete_page': {
            if (draft.mode !== 'doc') break;
            const n = pageArg(args);
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
      ? `\n本次只能修改第 ${draft.describeEditable()} 页（以及 ${ADDITIONS_CSS} 中本次追加的样式）；其他页面和共享样式只读，仅供对照风格。`
      : '';
  return `【自检阶段】你的初稿已在无头浏览器（Chrome，画幅 ${view.width}×${view.height}）中渲染。下面是页面缩略图总览与自动布局检查报告。
请像设计师交付前一样自检并修复：
1. 报告中的「✗ 错误」（文字超出页面、内容被裁切、图片无法加载等）必须修复；「△ 提醒」请判断是否需要处理（例如有意叠放的装饰大字可以保留）。
2. 对照缩略图检查视觉问题：拥挤或大片空白、对比度不足、元素错位、各页风格不统一、与要求或参考不符。
3. 用 render_pages 渲染指定页看细节（可 full_size），用 find_elements / read_draft（path 指定文件）/ find_css 查看源码；优先用 edit_elements（按 data-eid 改文字、样式、属性）、edit_css 或 replace_in_draft 做局部修改，只有需要重新排版整页时才用 rewrite_page；改完用 render_pages 或 check_layout 复查。
4. 修改只作用于草稿；参考文件始终只读。
5. 确认无误后，直接用一两句话总结你做了哪些修改（或“无需修改”），不要再输出完整 HTML。${scope}

【自动布局检查】
${report}`;
}

/** The model's closing remark, without any tool-call markup it may have written out as text. */
export function cleanSummary(text: string): string | undefined {
  const cut = text.search(new RegExp(`</?(parameter|invoke|function|tool_call|${[...DRAFT_TOOL_NAMES].join('|')})\\b`, 'i'));
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
  /** Skip the model's review when the automatic check finds no errors (small, already inspected edits). */
  skipIfClean?: boolean;
}

/**
 * Agent loop after the first draft: render it, inspect the layout, and let the model look at its own
 * pages and fix them with the draft tools until it is satisfied (bounded by maxRounds). If errors are
 * still detected afterwards it gets one more pass. Failures here never fail the job: the draft as it
 * stands is kept.
 */
export async function reviewDraft(db: DB, userId: number, opts: ReviewOptions): Promise<ReviewLog> {
  const { draft, resolver, prompt, fileTools, maxRounds, onTool, onStage, onUsage, skipIfClean, ...chatOpts } = opts;
  const editsBefore = draft.edits;
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
    if (skipIfClean && !log.before.errors) return log;
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
        content: `（初稿已完成：共 ${first.view.pages.length} 页，页面 HTML 约 ${draftChars} 字符，已保存为草稿；可用 read_draft 查看文件列表与源码。）`,
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
  log.edits = draft.edits - editsBefore;
  return log;
}
