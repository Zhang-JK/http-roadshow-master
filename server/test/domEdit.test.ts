import { describe, expect, it } from 'vitest';
import { assignIds, type DeckDoc } from '../src/deck.js';
import { editCss, editInPage, findCssRules, findInPage } from '../src/domEdit.js';
import { createDraftTools, Draft } from '../src/draft.js';
import { cssFiles } from '../src/files.js';

const PAGE = `<section class="slide" data-page-id="p1" data-eid="e0">
<h1 class="title" data-eid="e1">年度回顾</h1>
<div class="kpi" data-eid="e2"><h3 data-eid="e3">收入</h3><p class="num" data-eid="e4">1.2 亿</p></div>
<div class="kpi" data-eid="e5"><h3 data-eid="e6">利润</h3><p class="num" data-eid="e7" style="color: red; font-size: 40px">3000 万</p></div>
</section>`;

describe('structured element edits', () => {
  it('finds elements by selector, eid and text', () => {
    expect(findInPage(PAGE, { selector: '.kpi h3' }).map((m) => m.eid)).toEqual(['e3', 'e6']);
    expect(findInPage(PAGE, { eids: ['e4'] })[0]).toMatchObject({ tag: 'p', classes: 'num', text: '1.2 亿' });
    expect(findInPage(PAGE, { text: '利润' }).map((m) => m.eid)).toEqual(['e6']);
    expect(() => findInPage(PAGE, { selector: 'h1[' })).toThrow('CSS 选择器无效');
  });

  it('changes text, style, attributes and classes, keeping ids', () => {
    let r = editInPage(PAGE, { eids: ['e1'] }, { text: '2026 年度回顾' }, false);
    expect(r.html).toContain('<h1 class="title" data-eid="e1">2026 年度回顾</h1>');
    r = editInPage(r.html, { eids: ['e7'] }, { style: { color: '#16a34a', 'font-size': null, 'font-weight': '700' } }, false);
    expect(r.html).toContain('style="color:#16a34a;font-weight:700"');
    r = editInPage(r.html, { selector: '.kpi' }, { add_class: 'card', attrs: { title: 'KPI' } }, true);
    expect(r.count).toBe(2);
    expect(findInPage(r.html, { selector: '.kpi.card[title="KPI"]' })).toHaveLength(2);
    expect(r.html).toContain('data-page-id="p1"');
  });

  it('refuses ambiguous, destructive or protected edits', () => {
    expect(() => editInPage(PAGE, { selector: 'h3' }, { text: 'x' }, false)).toThrow(/匹配到 2 个元素[\s\S]*data-eid="e3"/);
    expect(() => editInPage(PAGE, { eids: ['e2'] }, { text: 'x' }, false)).toThrow('含有子元素');
    expect(() => editInPage(PAGE, { eids: ['e1'] }, { attrs: { 'data-eid': 'x' } }, false)).toThrow('系统标识');
    expect(() => editInPage(PAGE, { selector: 'section' }, { remove: true }, false)).toThrow('页面根元素');
    expect(() => editInPage(PAGE, { eids: ['e1'] }, {}, false)).toThrow('没有指定任何修改');
    expect(() => editInPage(PAGE, { eids: ['e1'] }, { style: { color: 'red;}body{display:none' } }, false)).toThrow('不能包含');
    expect(() => editInPage(PAGE, { eids: ['e1', 'nope'] }, { text: 'x' }, false)).toThrow('没有找到 data-eid 为 nope');
  });

  it('inserts, replaces and removes elements', () => {
    let r = editInPage(PAGE, { eids: ['e5'] }, { insert: { position: 'after', html: '<div class="kpi"><h3>现金流</h3></div>' } }, false);
    expect(findInPage(r.html, { selector: '.kpi' })).toHaveLength(3);
    r = editInPage(r.html, { eids: ['e1'] }, { outer_html: '<h2 class="title">新标题</h2>' }, false);
    expect(r.html).toContain('<h2 class="title" data-eid="e1">新标题</h2>');
    r = editInPage(r.html, { eids: ['e2', 'e5'] }, { remove: true }, false);
    expect(findInPage(r.html, { selector: '.kpi' }).map((m) => m.text)).toEqual(['现金流']);
  });
});

describe('structured CSS edits', () => {
  const CSS = `:root{--brand:#1e40af;--accent:#f59e0b}
.title{font-size:96px;color:var(--brand)}
/* cards */
.kpi { border-radius: 12px; padding: 24px }
@media (max-width: 800px) { .title { font-size: 48px } }`;

  it('updates declarations in place and keeps the rest of the stylesheet as written', () => {
    const r = editCss(CSS, { selector: ':root', set: { '--brand': '#111827' } });
    expect(r.action).toBe('updated');
    expect(r.css).toContain(':root{--brand:#111827;--accent:#f59e0b}');
    expect(r.css).toContain('/* cards */\n.kpi { border-radius: 12px; padding: 24px }');
    const r2 = editCss(r.css, { selector: '.kpi', set: { padding: null, 'box-shadow': '0 2px 8px rgba(0,0,0,.1)' } });
    expect(r2.rule).toBe('.kpi { border-radius: 12px; box-shadow:0 2px 8px rgba(0,0,0,.1) }');
  });

  it('targets @media rules, creates new rules and removes rules', () => {
    let r = editCss(CSS, { selector: '.title', media: '(max-width: 800px)', set: { 'font-size': '40px !important' } });
    expect(r.css).toContain('.title{font-size:96px;color:var(--brand)}');
    expect(r.css).toMatch(/@media \(max-width: 800px\) \{ \.title \{ font-size: 40px !important \} \}/);
    r = editCss(r.css, { selector: '.badge', set: { color: 'white' } });
    expect(r.action).toBe('created');
    expect(findCssRules(r.css, 'badge')).toEqual(['.badge{color:white}']);
    r = editCss(r.css, { selector: '.kpi', remove: true });
    expect(r.css).not.toContain('.kpi');
    expect(() => editCss(r.css, { selector: '.kpi', remove: true })).toThrow('没有找到规则');
    expect(findCssRules(CSS, 'font-size')).toHaveLength(2);
    expect(findCssRules(CSS, 'title')[1]).toBe('@media (max-width: 800px) { .title { font-size: 48px } }');
  });

  it('reports CSS it cannot parse', () => {
    expect(() => editCss('.a{color:red', { selector: '.a', set: { color: 'blue' } })).toThrow('无法解析');
  });
});

describe('structured draft tools', () => {
  const snapshot = (): DeckDoc =>
    assignIds({
      title: 't',
      width: 1920,
      height: 1080,
      head: '',
      css: '.title{color:red}\n.num{font-size:40px}',
      pages: [1, 2, 3].map((i) => ({ id: '', html: `<section class="slide"><h1 class="title">第${i}页 ACME</h1><p class="num">${i}0%</p></section>` })),
    });

  it('edit whole documents element by element, page by page', async () => {
    const draft = Draft.ofDocument(snapshot());
    const tools = createDraftTools(draft, (h) => h);
    const run = async (name: string, args: Record<string, unknown>) => (await tools.execute(name, args)).content;
    expect(await run('find_elements', { selector: 'h1' })).toMatch(/共 3 个匹配[\s\S]*第 3 页 <h1\.title> data-eid="e[0-9a-z]{8}"「第3页 ACME」/);
    expect(await run('edit_elements', { selector: 'h1', text: 'x' })).toContain('匹配到 3 个元素');
    expect(await run('edit_elements', { selector: '.num', all: true, style: { color: 'green' } })).toContain('已修改 3 个元素（第 1、2、3 页）');
    const eid = draft.view().pages[1].html.match(/<h1[^>]*data-eid="([^"]+)"/)![1];
    expect(await run('edit_elements', { eids: [eid], text: '市场机会' })).toContain('第 2 页');
    expect(await run('replace_in_draft', { old_text: 'ACME', new_text: 'Acme 公司', all_pages: true })).toContain('已替换 2 处');
    expect(await run('edit_css', { selector: '.title', set: { color: '#111827' } })).toContain('已修改规则（styles/main.css）：.title{color:#111827}');
    expect(await run('find_css', { query: 'num' })).toContain('.num{font-size:40px}');
    expect(await run('duplicate_page', { page: 1 })).toContain('现共 4 页');
    expect(await run('move_page', { page: 4, to: 1 })).toContain('移到第 1 页');
    expect(await run('insert_page', { after: 0, html: '<section class="slide"><h1>封面</h1></section>' })).toContain('现共 5 页');
    const out = draft.result();
    expect(out.pages.map((p) => p.html.replace(/<[^>]+>/g, ''))).toEqual(['封面', '第3页 Acme 公司30%', '第1页 Acme 公司10%', '第1页 Acme 公司10%', '市场机会20%']);
    expect(new Set(out.pages.map((p) => p.id)).size).toBe(5);
    expect(out.pages[2].html).toContain('style="color:green"');
    expect(cssFiles(out.css)).toEqual([{ path: 'styles/main.css', css: '.title{color:#111827}\n.num{font-size:40px}' }]);
  });

  it('page edits keep the other pages and the shared CSS read-only', async () => {
    const doc = snapshot();
    const draft = Draft.ofPage(doc, doc.pages[1].id);
    const tools = createDraftTools(draft, (h) => h);
    const run = async (name: string, args: Record<string, unknown>) => (await tools.execute(name, args)).content;
    expect(tools.defs.map((d) => d.function.name)).not.toContain('move_page');
    expect(await run('edit_elements', { selector: 'h1', page: 1, text: 'x' })).toContain('只读');
    expect(await run('edit_elements', { selector: 'h1', text: '只改第二页' })).toContain('已修改 1 个元素（第 2 页）');
    expect(await run('edit_css', { selector: '.title', set: { color: 'blue' } })).toContain('共享样式');
    expect(await run('edit_css', { selector: '.p2-note', set: { color: 'blue' } })).toContain('已新建规则');
    expect(await run('find_css', { query: 'title' })).toContain('［styles/main.css，共享只读］.title{color:red}');
    expect(await run('insert_page', { after: 2, html: '<section class="slide"><h1>2b</h1></section>' })).toContain('现共 4 页');
    expect(await run('insert_page', { after: 4, html: '<section class="slide"><h1>x</h1></section>' })).toContain('只能在第 2–3 页之后');
    const out = draft.result(doc);
    expect(out.pages.map((p) => p.html.replace(/<[^>]+>/g, ''))).toEqual(['第1页 ACME10%', '只改第二页20%', '2b', '第3页 ACME30%']);
    expect(out.css).toContain('.p2-note');
    expect(out.css).toContain('.title{color:red}');
    expect(draft.edits).toBe(3);
  });
});
