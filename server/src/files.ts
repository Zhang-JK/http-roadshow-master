/**
 * The project as files: README.md (the generation statement), styles/*.css and one pages/*.html per
 * page. Stored inside the DeckDoc so everything else (rendering, history, exports) keeps working:
 * the CSS files are sections of doc.css between file markers, each page carries its file name.
 */
import type { DeckDoc, DeckPage } from './deck.js';

export const README = 'README.md';
export const ADDITIONS_CSS = 'styles/additions.css';
const DEFAULT_CSS = 'styles/main.css';

export interface CssFile {
  path: string;
  css: string;
}

const MARK_RE = /^\/\* ==== file: (\S+) ==== \*\/[ \t]*$/gm;
const mark = (path: string) => `/* ==== file: ${path} ==== */`;

export type FileKind = 'readme' | 'css' | 'page';

/** Normalises a project path and tells what it is; throws for anything outside the project layout. */
export function checkPath(raw: string): { path: string; kind: FileKind } {
  const p = String(raw ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '');
  if (p.toLowerCase() === 'readme.md') return { path: README, kind: 'readme' };
  if (/^styles\/[A-Za-z0-9][\w.-]*\.css$/.test(p)) return { path: p, kind: 'css' };
  if (/^pages\/[A-Za-z0-9][\w.-]*\.html$/.test(p)) return { path: p, kind: 'page' };
  throw new Error(`文件路径无效：${raw}。只能是 README.md、styles/名称.css 或 pages/名称.html（名称用英文字母、数字、- 或 _）`);
}

export function cssFiles(css: string): CssFile[] {
  const marks = [...css.matchAll(MARK_RE)];
  if (!marks.length) return css.trim() ? [{ path: DEFAULT_CSS, css: css.trim() }] : [];
  const files: CssFile[] = [];
  const head = css.slice(0, marks[0].index).trim();
  if (head) files.push({ path: DEFAULT_CSS, css: head });
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : css.length;
    const body = css.slice(m.index! + m[0].length, end).trim();
    const existing = files.find((f) => f.path === m[1]);
    if (existing) existing.css = `${existing.css}\n${body}`.trim();
    else files.push({ path: m[1], css: body });
  });
  return files;
}

export function joinCssFiles(files: CssFile[]): string {
  return files.map((f) => `${mark(f.path)}\n${f.css.trim()}`).join('\n\n');
}

/** Add CSS to one file (created at the end when missing). */
export function appendCss(css: string, path: string, extra: string): string {
  const files = cssFiles(css);
  const f = files.find((x) => x.path === path);
  if (f) f.css = `${f.css}\n${extra.trim()}`.trim();
  else files.push({ path, css: extra.trim() });
  return joinCssFiles(files);
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'page'
  );
}

/** Pages keep their file names; pages without one (or with a duplicate) get a name from their layout. */
export function nameFiles(pages: DeckPage[]): DeckPage[] {
  const used = new Set<string>();
  const valid = (f?: string) => {
    if (!f) return undefined;
    try {
      const c = checkPath(f);
      return c.kind === 'page' ? c.path : undefined;
    } catch {
      return undefined;
    }
  };
  for (const p of pages) {
    const f = valid(p.file);
    if (f && !used.has(f)) used.add(f);
  }
  const taken = new Set<string>();
  return pages.map((p) => {
    let f = valid(p.file);
    if (f && !taken.has(f)) {
      taken.add(f);
      return { ...p, file: f };
    }
    const layout = p.html.match(/<section\b[^>]*\bdata-layout="([^"]+)"/i)?.[1] ?? 'page';
    const base = `pages/${slug(layout)}`;
    let n = 1;
    f = `${base}.html`;
    while (used.has(f) || taken.has(f)) f = `${base}-${++n}.html`;
    taken.add(f);
    used.add(f);
    return { ...p, file: f };
  });
}

export interface FileBlock {
  path: string;
  content: string;
  /** False when the reply was cut off inside this file. */
  complete: boolean;
}

/**
 * Files in a model reply, written as <file path="...">…</file>. A code fence around the content is
 * removed. The last file may be unterminated when the reply hit the output limit.
 */
export function parseFileBlocks(text: string): FileBlock[] {
  const out: FileBlock[] = [];
  const re = /<file\s+path\s*=\s*["']([^"']+)["']\s*>/gi;
  const starts = [...text.matchAll(re)];
  starts.forEach((m, i) => {
    const from = m.index! + m[0].length;
    const limit = i + 1 < starts.length ? starts[i + 1].index! : text.length;
    const seg = text.slice(from, limit);
    const close = seg.search(/<\/file\s*>/i);
    let content = close >= 0 ? seg.slice(0, close) : seg;
    content = content.replace(/^\s*```[\w-]*[ \t]*\n/, '').replace(/\n?```\s*$/, '');
    out.push({ path: m[1], content: content.replace(/^\n+|\s+$/g, ''), complete: close >= 0 });
  });
  return out;
}

/** The planned pages listed in the README's page plan (lines naming pages/*.html), in order. */
export function plannedPages(readme: string): { path: string; line: string }[] {
  const seen = new Set<string>();
  const out: { path: string; line: string }[] = [];
  for (const line of readme.split('\n')) {
    const m = line.match(/pages\/[A-Za-z0-9][\w.-]*\.html/);
    if (!m || seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ path: m[0], line: line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, '').trim() });
  }
  return out;
}

export interface TreeEntry {
  path: string;
  kind: FileKind;
  chars: number;
  page?: number;
  title?: string;
}

const firstText = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);

export function fileTree(doc: DeckDoc): TreeEntry[] {
  const entries: TreeEntry[] = [];
  entries.push({ path: README, kind: 'readme', chars: (doc.readme ?? '').length });
  for (const f of cssFiles(doc.css)) entries.push({ path: f.path, kind: 'css', chars: f.css.length });
  nameFiles(doc.pages).forEach((p, i) => entries.push({ path: p.file!, kind: 'page', chars: p.html.length, page: i + 1, title: firstText(p.html) }));
  return entries;
}

const EDIT_LOG = '## 修改记录';
const MAX_LOG = 30;

/** The README without its edit log (which the system maintains). */
export function readmeBody(readme: string): string {
  const at = readme.indexOf(EDIT_LOG);
  if (at < 0) return readme.trim();
  const rest = readme.slice(at + EDIT_LOG.length);
  const next = rest.search(/\n##\s/);
  return `${readme.slice(0, at)}${next >= 0 ? rest.slice(next) : ''}`.trim();
}

/** Appends one line to the README's edit log, keeping the most recent entries. */
export function logEdit(readme: string, line: string): string {
  const entry = `- ${line.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
  const at = readme.indexOf(EDIT_LOG);
  if (at < 0) return `${readme.trimEnd()}\n\n${EDIT_LOG}\n${entry}\n`;
  const before = readme.slice(0, at + EDIT_LOG.length);
  const rest = readme.slice(at + EDIT_LOG.length);
  const next = rest.search(/\n##\s/);
  const body = (next >= 0 ? rest.slice(0, next) : rest).split('\n').filter((l) => l.trim().startsWith('- '));
  const tail = next >= 0 ? rest.slice(next) : '\n';
  return `${before}\n${[...body, entry].slice(-MAX_LOG).join('\n')}\n${tail.replace(/^\n+/, '\n')}`;
}

/** README for projects made before README existed, from the brief they were created with. */
export function readmeFromBrief(type: 'template' | 'deck', name: string, brief: Record<string, unknown> | undefined): string {
  const labels: Record<string, string> = {
    style: '设计风格',
    purpose: '用途',
    audience: '受众',
    colors: '配色',
    pageCount: '页数',
    content: '内容',
    notes: '其他要求',
  };
  const lines = Object.entries(brief ?? {})
    .filter(([k, v]) => k !== 'name' && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `- ${labels[k] ?? k}：${String(v).slice(0, 2000)}`);
  return `# ${name}\n\n${type === 'template' ? '路演模板' : '路演材料'}（早期版本创建，由系统根据创建时的需求整理）\n\n## 需求\n${lines.join('\n') || '- 未记录'}\n`;
}
