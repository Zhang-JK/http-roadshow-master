import { describe, expect, it } from 'vitest';
import {
  assembleHtml,
  assignIds,
  deletePage,
  diffDocs,
  duplicatePage,
  extractHtmlBlock,
  findElements,
  movePage,
  pageText,
  parseFragment,
  parseFullHtml,
  replacePage,
} from '../src/deck.js';

const SAMPLE = `好的，下面是模板：
\`\`\`html
<!DOCTYPE html><html><head><title>Demo</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
<style>:root{--c:#123} .t{font-size:80px}</style></head>
<body>
<section class="slide" data-layout="cover"><h1 class="t">封面标题</h1><p onclick="alert(1)">副标题</p><script>alert(1)</script></section>
<section class="slide"><ul><li>要点一</li><li>要点二</li></ul><svg width="10" height="10"><rect width="5" height="5"/></svg></section>
</body></html>
\`\`\``;

const base = { width: 1920, height: 1080, title: 'x' };

describe('deck parsing', () => {
  it('extracts fenced html, including unterminated fences', () => {
    expect(extractHtmlBlock('a\n```html\n<b>x</b>\n```\nb')).toBe('<b>x</b>\n');
    expect(extractHtmlBlock('```html\n<section>x</section>')).toBe('<section>x</section>');
    expect(extractHtmlBlock('blah <section>y</section>')).toBe('<section>y</section>');
  });

  it('parses a full document into pages with ids, css and head links, and sanitizes', () => {
    const doc = parseFullHtml(SAMPLE, base);
    expect(doc.title).toBe('Demo');
    expect(doc.pages).toHaveLength(2);
    expect(doc.css).toContain('--c:#123');
    expect(doc.head).toContain('fonts.googleapis.com');
    expect(doc.pages[0].html).not.toContain('<script');
    expect(doc.pages[0].html).not.toContain('onclick');
    for (const p of doc.pages) {
      expect(p.id).toMatch(/^p[0-9a-z]{8}$/);
      expect(p.html).toContain(`data-page-id="${p.id}"`);
    }
    expect(doc.pages[0].html).toMatch(/<h1[^>]*data-eid="e[0-9a-z]{8}"/);
    // svg root gets an id, svg internals do not
    expect(doc.pages[1].html).toMatch(/<svg[^>]*data-eid=/);
    expect(doc.pages[1].html).not.toMatch(/<rect[^>]*data-eid=/);
  });

  it('keeps existing ids stable and de-duplicates collisions', () => {
    const doc = parseFullHtml(SAMPLE, base);
    const again = assignIds(doc);
    expect(again.pages.map((p) => p.html)).toEqual(doc.pages.map((p) => p.html));
    const dup = assignIds({ ...doc, pages: [doc.pages[0], { id: doc.pages[0].id, html: doc.pages[0].html }] });
    expect(dup.pages[0].id).not.toBe(dup.pages[1].id);
    const eids = dup.pages.flatMap((p) => [...p.html.matchAll(/data-eid="([^"]+)"/g)].map((m) => m[1]));
    expect(new Set(eids).size).toBe(eids.length);
  });

  it('throws when the model returns no slides', () => {
    expect(() => parseFullHtml('sorry, I cannot', base)).toThrow(/section/);
  });

  it('assembles a paged html document with fixed slide size and print page size', () => {
    const doc = parseFullHtml(SAMPLE, base);
    const html = assembleHtml(doc, { presenter: true });
    expect(html).toContain('width:1920px;height:1080px');
    expect(html).toContain('@page{size:1920px 1080px');
    expect(html).toContain('rs-present');
    const one = assembleHtml(doc, { pageIds: [doc.pages[1].id] });
    expect(one).not.toContain('封面标题');
    expect(one).toContain('要点一');
  });
});

describe('page edits and diff', () => {
  it('replaces a page with a fragment, keeps ids and appends css; diff reports changed elements', () => {
    const doc = parseFullHtml(SAMPLE, base);
    const h1 = doc.pages[0].html.match(/<h1[^>]*data-eid="([^"]+)"/)![1];
    const pEid = doc.pages[0].html.match(/<p[^>]*data-eid="([^"]+)"/)![1];
    const frag = parseFragment(`\`\`\`html
<style>.new{color:red}</style>
<section class="slide" data-page-id="${doc.pages[0].id}"><h1 class="t new" data-eid="${h1}">新标题</h1><p data-eid="${pEid}">副标题</p><span>新增</span></section>
\`\`\``);
    const next = replacePage(doc, doc.pages[0].id, frag.pages, frag.css);
    expect(next.css).toContain('.new{color:red}');
    expect(next.pages[0].id).toBe(doc.pages[0].id);
    const d = diffDocs(doc, next);
    expect(d.pagesChanged).toEqual([1]);
    expect(d.cssChanged).toBe(true);
    expect(d.elementsChanged.map((e) => e.eid)).toContain(h1);
    expect(d.elementsChanged.map((e) => e.eid)).not.toContain(pEid);
    expect(d.elementsAdded.some((e) => e.tag === 'span' && e.page === 1)).toBe(true);
    expect(d.elementsRemoved).toEqual([]);
  });

  it('splitting a page into several sections inserts new pages', () => {
    const doc = parseFullHtml(SAMPLE, base);
    const frag = parseFragment('<section class="slide"><h2>A</h2></section><section class="slide"><h2>B</h2></section>');
    const next = replacePage(doc, doc.pages[1].id, frag.pages);
    expect(next.pages).toHaveLength(3);
    expect(next.pages[1].id).toBe(doc.pages[1].id);
    expect(diffDocs(doc, next).pagesAdded).toEqual([3]);
  });

  it('rejects replacing a page that no longer exists', () => {
    const doc = parseFullHtml(SAMPLE, base);
    expect(() => replacePage(doc, 'pmissing', [{ id: '', html: '<section></section>' }])).toThrow(/不存在/);
  });

  it('duplicate / move / delete pages', () => {
    const doc = parseFullHtml(SAMPLE, base);
    const dup = duplicatePage(doc, doc.pages[0].id);
    expect(dup.pages).toHaveLength(3);
    expect(dup.pages[1].id).not.toBe(doc.pages[0].id);
    expect(pageText(dup.pages[1])).toContain('封面标题');
    const eidsA = [...dup.pages[0].html.matchAll(/data-eid="([^"]+)"/g)].map((m) => m[1]);
    const eidsB = [...dup.pages[1].html.matchAll(/data-eid="([^"]+)"/g)].map((m) => m[1]);
    expect(eidsA.filter((e) => eidsB.includes(e))).toEqual([]);
    const moved = movePage(dup, dup.pages[0].id, 2);
    expect(moved.pages[2].id).toBe(dup.pages[0].id);
    const del = deletePage(moved, moved.pages[0].id);
    expect(del.pages).toHaveLength(2);
    expect(() => deletePage({ ...del, pages: [del.pages[0]] }, del.pages[0].id)).toThrow();
    expect(diffDocs(doc, deletePage(doc, doc.pages[1].id)).pagesRemoved).toEqual(['原第2页']);
  });

  it('finds element info for prompts', () => {
    const doc = parseFullHtml(SAMPLE, base);
    const h1 = doc.pages[0].html.match(/<h1[^>]*data-eid="([^"]+)"/)![1];
    const [info] = findElements(doc, doc.pages[0].id, [h1, 'nope']);
    expect(info).toMatchObject({ eid: h1, tag: 'h1', classes: 't', text: '封面标题' });
    expect(info.html).toContain('封面标题');
  });
});
