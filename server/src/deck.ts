import * as cheerio from 'cheerio';
import type { AnyNode, Element, Text } from 'domhandler';
import { customAlphabet } from 'nanoid';
import { ADDITIONS_CSS, appendCss, cssFiles, nameFiles, readmeBody } from './files.js';

export interface DeckPage {
  id: string;
  html: string;
  /** Source file of the page, e.g. pages/cover.html. */
  file?: string;
}

export interface DeckDoc {
  title: string;
  width: number;
  height: number;
  head: string;
  /** All style files, separated by file markers (see files.ts). */
  css: string;
  pages: DeckPage[];
  /** README.md: the user's request, style guide and page plan; read before every later edit. */
  readme?: string;
}

export interface ElementInfo {
  eid: string;
  tag: string;
  classes: string;
  text: string;
  html: string;
}

export interface DiffSummary {
  pagesAdded: number[];
  pagesRemoved: string[];
  pagesChanged: number[];
  cssChanged: boolean;
  readmeChanged?: boolean;
  /** Style files added, changed or removed. */
  stylesChanged?: string[];
  elementsChanged: { eid: string; page: number; tag: string; text: string }[];
  elementsAdded: { eid: string; page: number; tag: string; text: string }[];
  elementsRemoved: { eid: string; tag: string; text: string }[];
  /** Text typed straight into one element in the editor, without the model. */
  textEdit?: { eid: string; page: number; before: string; after: string };
}

const shortId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);
export const newElementId = () => `e${shortId()}`;
export const newPageId = () => `p${shortId()}`;

const SKIP_TAGS = new Set(['script', 'style', 'br', 'wbr', 'template', 'noscript']);
const SVG_CHILD_SKIP = true;

export const ASPECTS: Record<string, { width: number; height: number; label: string }> = {
  '16:9': { width: 1920, height: 1080, label: '横向 16:9' },
  '4:3': { width: 1440, height: 1080, label: '横向 4:3' },
  '9:16': { width: 1080, height: 1920, label: '竖向 9:16' },
  'a4-landscape': { width: 1754, height: 1240, label: 'A4 横向' },
  'a4-portrait': { width: 1240, height: 1754, label: 'A4 竖向' },
  '1:1': { width: 1440, height: 1440, label: '方形 1:1' },
};

export function emptyDoc(title: string, width = 1920, height = 1080): DeckDoc {
  return { title, width, height, head: '', css: '', pages: [] };
}

function sanitize($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>) {
  root.find('script, iframe, object, embed').remove();
  root.find('*').each((_, el) => {
    const attribs = (el as Element).attribs ?? {};
    for (const name of Object.keys(attribs)) {
      if (/^on/i.test(name)) $(el).removeAttr(name);
      else if (/^(href|src|xlink:href)$/i.test(name) && /^\s*javascript:/i.test(attribs[name])) $(el).removeAttr(name);
    }
  });
}

/**
 * Ensure every element inside each slide carries a unique data-eid, and the slide a data-page-id.
 * Scripts and event handlers are removed unless keepScripts is set (drafts the delivery check still has to see).
 */
export function assignIds(doc: DeckDoc, opts: { keepScripts?: boolean } = {}): DeckDoc {
  const seen = new Set<string>();
  const pageSeen = new Set<string>();
  const pages = doc.pages.map((page) => {
    const $ = cheerio.load(page.html, null, false);
    let section = $('section').first();
    if (!section.length) {
      $.root().children().wrapAll('<section class="slide"></section>');
      section = $('section').first();
    }
    section.addClass('slide');
    let pid = section.attr('data-page-id') || page.id;
    if (!pid || pageSeen.has(pid)) pid = newPageId();
    pageSeen.add(pid);
    section.attr('data-page-id', pid);
    if (!opts.keepScripts) sanitize($, section);
    const visit = (el: Element, insideSvg: boolean) => {
      const tag = el.tagName?.toLowerCase();
      if (!tag || SKIP_TAGS.has(tag)) return;
      const isSvgChild = insideSvg && SVG_CHILD_SKIP;
      if (!isSvgChild) {
        let eid = el.attribs['data-eid'];
        if (!eid || seen.has(eid)) {
          eid = newElementId();
          el.attribs['data-eid'] = eid;
        }
        seen.add(eid);
      } else if (el.attribs['data-eid']) {
        delete el.attribs['data-eid'];
      }
      for (const child of el.children ?? []) {
        if (child.type === 'tag') visit(child as Element, insideSvg || tag === 'svg');
      }
    };
    const sectionEl = section.get(0) as Element;
    // The section itself is the page; it gets an eid too so it can be selected as "whole page background".
    visit(sectionEl, false);
    return { id: pid, html: $.html(section), file: page.file };
  });
  return { ...doc, pages: nameFiles(pages) };
}

export function extractHtmlBlock(text: string): string {
  const fenced = [...text.matchAll(/```(?:html|HTML)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (fenced.length) return fenced.sort((a, b) => b.length - a.length)[0];
  const openFence = text.match(/```(?:html|HTML)?\s*\n([\s\S]*)$/);
  if (openFence) return openFence[1];
  const start = text.search(/<(!doctype|html|head|style|section)/i);
  return start >= 0 ? text.slice(start) : text;
}

/** Parse a full HTML document produced by the model into a DeckDoc. */
export function parseFullHtml(raw: string, base: Pick<DeckDoc, 'width' | 'height' | 'title'>): DeckDoc {
  return assignIds(parseFullHtmlRaw(raw, base));
}

/** Like parseFullHtml, but keeps the markup exactly as written (no ids added, nothing sanitized). */
export function parseFullHtmlRaw(raw: string, base: Pick<DeckDoc, 'width' | 'height' | 'title'>): DeckDoc {
  const html = extractHtmlBlock(raw);
  const $ = cheerio.load(html);
  const css = $('style')
    .filter((_, el) => $(el).closest('section').length === 0)
    .map((_, el) => $(el).text())
    .get()
    .filter((s) => !s.includes('/* rs-base */'))
    .join('\n')
    .trim();
  const head = $('head link[rel="stylesheet"], head link[rel="preconnect"]')
    .map((_, el) => $.html(el))
    .get()
    .join('\n');
  let sections = $('section.slide');
  if (!sections.length) sections = $('body > section');
  if (!sections.length) sections = $('section');
  const pages: DeckPage[] = [];
  sections.each((_, el) => {
    if ($(el).parents('section').length) return;
    pages.push({ id: $(el).attr('data-page-id') ?? '', html: $.html(el) });
  });
  if (!pages.length) throw new Error('模型输出中没有找到 <section class="slide"> 页面');
  const title = $('title').first().text().trim() || base.title;
  return { title, width: base.width, height: base.height, head, css, pages };
}

/** Parse a fragment response (one or more sections and optional extra CSS). */
export function parseFragment(raw: string): { pages: DeckPage[]; css: string } {
  const html = extractHtmlBlock(raw);
  const $ = cheerio.load(html);
  const css = $('style')
    .filter((_, el) => $(el).closest('section').length === 0)
    .map((_, el) => $(el).text())
    .get()
    .join('\n')
    .trim();
  const pages: DeckPage[] = [];
  $('section').each((_, el) => {
    if ($(el).parents('section').length) return;
    pages.push({ id: $(el).attr('data-page-id') ?? '', html: $.html(el) });
  });
  if (!pages.length) throw new Error('模型输出中没有找到 <section> 页面片段');
  return { pages, css };
}

export const BASE_CSS = (w: number, h: number) => `/* rs-base */
html,body{margin:0;padding:0}
body{background:#d9dce3}
.slide{width:${w}px;height:${h}px;position:relative;overflow:hidden;box-sizing:border-box;margin:0 auto 32px;break-after:page;page-break-after:always}
.slide *{box-sizing:border-box}
@page{size:${w}px ${h}px;margin:0}
@media print{body{background:none}.slide{margin:0}}`;

const PRESENTER_SCRIPT = `
<script>
(function(){
  var slides=[].slice.call(document.querySelectorAll('section.slide'));var i=0,on=false;
  var bar=document.createElement('div');bar.className='rs-bar';bar.innerHTML='按 <b>F</b> 或点击此处进入演示模式，方向键翻页，Esc 退出';
  document.body.appendChild(bar);bar.onclick=function(){enter()};
  function fit(){var s=slides[0];if(!s)return;var k=Math.min(innerWidth/s.offsetWidth,innerHeight/s.offsetHeight);
    slides.forEach(function(el,j){el.style.display=j===i?'':'none';el.style.transform='scale('+k+')';});}
  function enter(){on=true;document.body.classList.add('rs-present');i=0;fit();if(document.documentElement.requestFullscreen)document.documentElement.requestFullscreen().catch(function(){});}
  function exit(){on=false;document.body.classList.remove('rs-present');slides.forEach(function(el){el.style.display='';el.style.transform='';});}
  addEventListener('resize',function(){if(on)fit()});
  addEventListener('keydown',function(e){
    if(e.key==='f'||e.key==='F'){on?exit():enter();return;}
    if(!on)return;
    if(e.key==='Escape'){exit();}
    else if(['ArrowRight','ArrowDown','PageDown',' '].indexOf(e.key)>=0){i=Math.min(slides.length-1,i+1);fit();e.preventDefault();}
    else if(['ArrowLeft','ArrowUp','PageUp'].indexOf(e.key)>=0){i=Math.max(0,i-1);fit();e.preventDefault();}
  });
  document.addEventListener('click',function(e){if(on&&e.target!==bar){i=(i+1)%slides.length;fit();}});
})();
</script>
<style>
.rs-bar{position:fixed;right:16px;bottom:16px;background:rgba(17,24,39,.85);color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 12px;border-radius:8px;cursor:pointer;z-index:99999}
body.rs-present{background:#000;overflow:hidden}
body.rs-present .rs-bar{display:none}
body.rs-present .slide{position:fixed;left:50%;top:50%;margin:0;transform-origin:center center;translate:-50% -50%}
@media print{.rs-bar{display:none}}
</style>`;

export interface AssembleOptions {
  pageIds?: string[];
  extraHead?: string;
  extraBody?: string;
  presenter?: boolean;
  assetResolver?: (html: string) => string;
  /** Link these style files instead of inlining doc.css (source bundle export). */
  cssHrefs?: string[];
}

export function assembleHtml(doc: DeckDoc, opts: AssembleOptions = {}): string {
  const pages = opts.pageIds ? doc.pages.filter((p) => opts.pageIds!.includes(p.id)) : doc.pages;
  const body = pages.map((p) => p.html).join('\n');
  let out = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title)}</title>
${doc.head}
<style>${BASE_CSS(doc.width, doc.height)}</style>
${opts.cssHrefs ? opts.cssHrefs.map((h) => `<link rel="stylesheet" href="${escapeHtml(h)}">`).join('\n') : `<style>\n${hoistImports(doc.css)}\n</style>`}
${opts.extraHead ?? ''}
</head>
<body>
${body}
${opts.presenter ? PRESENTER_SCRIPT : ''}
${opts.extraBody ?? ''}
</body>
</html>`;
  if (opts.assetResolver) out = opts.assetResolver(out);
  return out;
}

/** @import / @charset are only valid at the top of a stylesheet; style files are concatenated. */
export function hoistImports(css: string): string {
  const imports: string[] = [];
  const rest = css.replace(/^[ \t]*@(?:import|charset)\b[^;]*;[ \t]*$/gim, (m) => {
    if (!/^\s*@charset/i.test(m)) imports.push(m.trim());
    return '';
  });
  return imports.length ? `${imports.join('\n')}\n${rest}` : css;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function ownSignature($: cheerio.CheerioAPI, el: Element): string {
  const attrs = Object.entries(el.attribs)
    .filter(([k]) => k !== 'data-eid')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
  const text = (el.children ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => (c as unknown as { data: string }).data.trim())
    .join(' ');
  const childOrder = (el.children ?? [])
    .filter((c) => c.type === 'tag')
    .map((c) => (c as Element).attribs['data-eid'] ?? (c as Element).tagName)
    .join(',');
  const svg = el.tagName === 'svg' ? $(el).html() ?? '' : '';
  return `${el.tagName}#${attrs}#${text}#${childOrder}#${svg}`;
}

function textOf($: cheerio.CheerioAPI, el: Element) {
  return $(el).text().replace(/\s+/g, ' ').trim().slice(0, 60);
}

interface IndexedElement {
  sig: string;
  page: number;
  tag: string;
  text: string;
}

function indexDoc(doc: DeckDoc): Map<string, IndexedElement> {
  const map = new Map<string, IndexedElement>();
  doc.pages.forEach((p, i) => {
    const $ = cheerio.load(p.html, null, false);
    $('[data-eid]').each((_, el) => {
      const e = el as Element;
      map.set(e.attribs['data-eid'], { sig: ownSignature($, e), page: i + 1, tag: e.tagName, text: textOf($, e) });
    });
  });
  return map;
}

export function diffDocs(before: DeckDoc | null, after: DeckDoc): DiffSummary {
  const summary: DiffSummary = {
    pagesAdded: [],
    pagesRemoved: [],
    pagesChanged: [],
    cssChanged: false,
    elementsChanged: [],
    elementsAdded: [],
    elementsRemoved: [],
  };
  if (!before) {
    summary.pagesAdded = after.pages.map((_, i) => i + 1);
    return summary;
  }
  summary.cssChanged = before.css.trim() !== after.css.trim() || before.head.trim() !== after.head.trim();
  summary.readmeChanged = readmeBody(before.readme ?? '') !== readmeBody(after.readme ?? '');
  if (summary.cssChanged) {
    const old = new Map(cssFiles(before.css).map((f) => [f.path, f.css.trim()]));
    const now = cssFiles(after.css);
    summary.stylesChanged = [
      ...now.filter((f) => old.get(f.path) !== f.css.trim()).map((f) => f.path),
      ...[...old.keys()].filter((path) => !now.some((f) => f.path === path)),
    ];
  }
  const beforePages = new Map(before.pages.map((p) => [p.id, p.html]));
  const afterIds = new Set(after.pages.map((p) => p.id));
  after.pages.forEach((p, i) => {
    if (!beforePages.has(p.id)) summary.pagesAdded.push(i + 1);
    else if (beforePages.get(p.id) !== p.html) summary.pagesChanged.push(i + 1);
  });
  before.pages.forEach((p, i) => {
    if (!afterIds.has(p.id)) summary.pagesRemoved.push(`原第${i + 1}页`);
  });
  const a = indexDoc(before);
  const b = indexDoc(after);
  for (const [eid, info] of b) {
    const old = a.get(eid);
    if (!old) summary.elementsAdded.push({ eid, page: info.page, tag: info.tag, text: info.text });
    else if (old.sig !== info.sig) summary.elementsChanged.push({ eid, page: info.page, tag: info.tag, text: info.text });
  }
  for (const [eid, info] of a) {
    if (!b.has(eid)) summary.elementsRemoved.push({ eid, tag: info.tag, text: info.text });
  }
  return summary;
}

export function findElements(doc: DeckDoc, pageId: string, eids: string[]): ElementInfo[] {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return [];
  const $ = cheerio.load(page.html, null, false);
  const out: ElementInfo[] = [];
  for (const eid of eids) {
    const el = $(`[data-eid="${eid.replace(/"/g, '')}"]`).first();
    if (!el.length) continue;
    const node = el.get(0) as Element;
    let html = $.html(el);
    if (html.length > 3000) html = html.slice(0, 3000) + '…(已截断)';
    out.push({
      eid,
      tag: node.tagName,
      classes: el.attr('class') ?? '',
      text: el.text().replace(/\s+/g, ' ').trim().slice(0, 200),
      html,
    });
  }
  return out;
}

export function pageText(page: DeckPage): string {
  const $ = cheerio.load(page.html, null, false);
  $('style, script').remove();
  $('br').replaceWith('\n');
  $('p, h1, h2, h3, h4, h5, h6, li, div').each((_, el) => {
    $(el).append('\n');
  });
  return $.root()
    .text()
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function cloneDoc(doc: DeckDoc): DeckDoc {
  return JSON.parse(JSON.stringify(doc));
}

/** Replace one page with one or more new sections; new sections reuse the page id for the first. */
export function replacePage(doc: DeckDoc, pageId: string, newPages: DeckPage[], extraCss = ''): DeckDoc {
  const idx = doc.pages.findIndex((p) => p.id === pageId);
  if (idx < 0) throw new Error('目标页面不存在（可能已被其他用户删除）');
  const oldSectionEid = cheerio.load(doc.pages[idx].html, null, false)('section').first().attr('data-eid');
  const fixed = newPages.map((p, i) => {
    const $ = cheerio.load(p.html, null, false);
    const s = $('section').first();
    if (i === 0) {
      s.attr('data-page-id', pageId);
      if (!s.attr('data-eid') && oldSectionEid) s.attr('data-eid', oldSectionEid);
    } else {
      s.removeAttr('data-page-id');
    }
    return { id: i === 0 ? pageId : '', html: $.html(s), file: i === 0 ? doc.pages[idx].file : p.file };
  });
  const pages = [...doc.pages.slice(0, idx), ...fixed, ...doc.pages.slice(idx + 1)];
  const css = extraCss.trim() ? appendCss(doc.css, ADDITIONS_CSS, extraCss) : doc.css;
  return assignIds({ ...doc, pages, css });
}

export function duplicatePage(doc: DeckDoc, pageId: string): DeckDoc {
  const idx = doc.pages.findIndex((p) => p.id === pageId);
  if (idx < 0) throw new Error('页面不存在');
  const $ = cheerio.load(doc.pages[idx].html, null, false);
  $('[data-eid]').removeAttr('data-eid');
  $('section').first().removeAttr('data-page-id');
  const pages = [...doc.pages];
  pages.splice(idx + 1, 0, { id: '', html: $.html() });
  return assignIds({ ...doc, pages });
}

export function deletePage(doc: DeckDoc, pageId: string): DeckDoc {
  if (doc.pages.length <= 1) throw new Error('至少需要保留一页');
  if (!doc.pages.some((p) => p.id === pageId)) throw new Error('页面不存在');
  return { ...doc, pages: doc.pages.filter((p) => p.id !== pageId) };
}

export function movePage(doc: DeckDoc, pageId: string, toIndex: number): DeckDoc {
  const idx = doc.pages.findIndex((p) => p.id === pageId);
  if (idx < 0) throw new Error('页面不存在');
  const pages = [...doc.pages];
  const [p] = pages.splice(idx, 1);
  pages.splice(Math.max(0, Math.min(pages.length, toIndex)), 0, p);
  return { ...doc, pages };
}

/** Keep in sync with NOT_TEXT in the editor's selection script (web/src/lib/slideHtml.ts). */
const NOT_TEXT_TAGS = new Set(['svg', 'math', 'textarea', 'select', 'option', 'script', 'style', 'noscript', 'template', 'iframe', 'object', 'canvas', 'video', 'audio']);

/**
 * The text of an element that holds nothing but text and <br> line breaks (lines joined with \n,
 * whitespace collapsed), or null when it is the page itself, empty, or contains other elements.
 */
export function plainText(el: Element): string | null {
  if (NOT_TEXT_TAGS.has(el.tagName.toLowerCase()) || el.attribs['data-page-id'] !== undefined) return null;
  const lines = [''];
  for (const c of el.children ?? []) {
    if (c.type === 'text') lines[lines.length - 1] += (c as Text).data;
    else if (c.type === 'tag' && (c as Element).tagName.toLowerCase() === 'br') lines.push('');
    else if (c.type !== 'comment') return null;
  }
  const text = lines
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim();
  return text || null;
}

const failWith = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** Replace the text of a text-only element; line breaks become <br>. Errors carry an HTTP statusCode. */
export function setElementText(doc: DeckDoc, pageId: string, eid: string, text: string): { doc: DeckDoc; before: string; page: number } {
  const idx = doc.pages.findIndex((p) => p.id === pageId);
  if (idx < 0) throw failWith(409, '页面不存在（可能已被其他用户删除）');
  const $ = cheerio.load(doc.pages[idx].html, null, false);
  const node = $(`[data-eid="${eid.replace(/"/g, '')}"]`).first();
  if (!node.length) throw failWith(409, '元素不存在（可能已被其他用户修改或删除）');
  const before = plainText(node.get(0) as Element);
  if (before === null) throw failWith(400, '只有纯文字元素可以直接编辑；包含图片、图标或其他子元素的内容请用 AI 修改');
  node.html(text.split('\n').map(escapeHtml).join('<br>'));
  const pages = doc.pages.map((p, i) => (i === idx ? { ...p, html: $.html() } : p));
  return { doc: { ...doc, pages }, before, page: idx + 1 };
}
