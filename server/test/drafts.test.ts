import { describe, expect, it } from 'vitest';
import { assignIds, type DeckDoc } from '../src/deck.js';
import { createDraftTools, Draft } from '../src/draft.js';
import { cssFiles, joinCssFiles } from '../src/files.js';

const snapshot = (): DeckDoc =>
  assignIds({
    title: 't',
    width: 1920,
    height: 1080,
    head: '',
    css: joinCssFiles([
      { path: 'styles/theme.css', css: ':root{--brand:#123456}' },
      { path: 'styles/components.css', css: '.title{font-size:80px}\n.card{padding:20px}' },
    ]),
    pages: [
      { id: '', html: '<section class="slide" data-layout="cover"><h1 class="title">封面 ACME</h1></section>', file: 'pages/cover.html' },
      { id: '', html: '<section class="slide" data-layout="kpi"><h2>数据</h2><div class="card">ARR</div></section>', file: 'pages/kpi.html' },
      { id: '', html: '<section class="slide" data-layout="end"><h2>谢谢 ACME</h2></section>', file: 'pages/end.html' },
    ],
    readme: '# 项目\n\n## 风格约定\n- 主色 #123456\n',
  });

const text = (d: DeckDoc) => d.pages.map((p) => p.html.replace(/<[^>]+>/g, ''));

describe('file-aware draft tools (whole document)', () => {
  const setup = () => {
    const draft = Draft.ofDocument(snapshot());
    const tools = createDraftTools(draft, (h) => h);
    const run = async (name: string, args: Record<string, unknown>) => (await tools.execute(name, args)).content;
    return { draft, tools, run };
  };

  it('lists and reads files by path', async () => {
    const { run, tools } = setup();
    expect(tools.defs.map((d) => d.function.name)).toEqual(expect.arrayContaining(['write_file', 'delete_file', 'read_draft']));
    const list = await run('read_draft', {});
    expect(list).toMatch(/README\.md（\d+ 字符）— 需求与风格说明/);
    expect(list).toContain('styles/theme.css');
    expect(list).toMatch(/pages\/kpi\.html — 第 2 页［可修改］\d+ 字符：数据 ARR/);
    expect(await run('read_draft', { path: 'README.md' })).toContain('主色 #123456');
    expect(await run('read_draft', { path: 'styles/components.css' })).toContain('.card{padding:20px}');
    expect(await run('read_draft', { path: 'pages/end.html' })).toContain('谢谢 ACME');
    expect(await run('read_draft', { path: 'pages/nope.html' })).toContain('错误：草稿中没有 pages/nope.html');
    expect(await run('read_draft', { path: '../secret' })).toContain('文件路径无效');
    expect(await run('read_draft', { page: 0 })).toContain('/* ==== file: styles/theme.css ==== */');
  });

  it('writes, overwrites, deletes and reorders files', async () => {
    const { run, draft } = setup();
    const kpiId = draft.view().pages[1].id;
    expect(await run('write_file', { path: 'pages/team.html', content: '<section class="slide" data-layout="team"><h2>团队</h2></section>', after: 1 })).toContain(
      '已新建 pages/team.html，插在第 1 页之后',
    );
    expect(await run('write_file', { path: 'pages/kpi.html', content: '<section class="slide"><h2>新数据</h2></section>' })).toContain('已覆盖 pages/kpi.html（第 3 页）');
    expect(await run('write_file', { path: 'styles/charts.css', content: '.bar{height:10px}' })).toContain('已新建 styles/charts.css');
    expect(await run('write_file', { path: 'styles/theme.css', content: ':root{--brand:#000}' })).toContain('已覆盖 styles/theme.css');
    expect(await run('write_file', { path: 'styles/bad.css', content: '<style>.x{}</style>' })).toContain('只能写 CSS');
    expect(await run('write_file', { path: 'README.md', content: '# 新说明\n- 主色 #000' })).toContain('已写入 README.md');
    expect(await run('delete_file', { path: 'pages/end.html' })).toContain('已删除 pages/end.html（原第 4 页）');
    expect(await run('delete_file', { path: 'README.md' })).toContain('不能删除');
    expect(await run('delete_file', { path: 'styles/charts.css' })).toContain('已删除 styles/charts.css');
    expect(await run('move_page', { page: 3, to: 1 })).toContain('移到第 1 页');
    const out = draft.result();
    expect(text(out)).toEqual(['新数据', '封面 ACME', '团队']);
    expect(out.pages.map((p) => p.file)).toEqual(['pages/kpi.html', 'pages/cover.html', 'pages/team.html']);
    expect(out.pages[0].id).toBe(kpiId);
    expect(cssFiles(out.css)).toEqual([
      { path: 'styles/theme.css', css: ':root{--brand:#000}' },
      { path: 'styles/components.css', css: '.title{font-size:80px}\n.card{padding:20px}' },
    ]);
    expect(out.readme).toBe('# 新说明\n- 主色 #000\n');
  });

  it('edits inside files and addresses pages by path', async () => {
    const { run, draft } = setup();
    expect(await run('replace_in_draft', { path: 'README.md', old_text: '#123456', new_text: '#0f172a' })).toBe('已在 README.md 中替换 1 处。');
    expect(await run('replace_in_draft', { path: 'styles/components.css', old_text: '20px', new_text: '32px' })).toContain('已在 styles/components.css 中替换 1 处');
    expect(await run('replace_in_draft', { path: 'pages/end.html', old_text: '谢谢', new_text: 'Thanks' })).toContain('替换 1 处');
    expect(await run('edit_css', { selector: ':root', set: { '--brand': '#0f172a' } })).toContain('已修改规则（styles/theme.css）');
    expect(await run('edit_css', { selector: '.bar', set: { height: '8px' }, file: 'styles/charts.css' })).toContain('已新建规则（styles/charts.css）');
    expect(await run('edit_css', { selector: '.chip', set: { color: 'red' } })).toContain('已新建规则（styles/charts.css）');
    expect(await run('find_css', { query: 'padding' })).toContain('［styles/components.css］.card{padding:32px}');
    expect(await run('find_elements', { selector: 'h2', path: 'pages/kpi.html' })).toMatch(/共 1 个匹配[\s\S]*第 2 页/);
    expect(await run('edit_elements', { selector: 'h2', path: 'pages/kpi.html', text: '关键数据' })).toContain('第 2 页');
    expect(await run('duplicate_page', { path: 'pages/cover.html' })).toMatch(/副本为第 2 页（pages\/cover-2\.html）/);
    expect(await run('rewrite_page', { path: 'pages/cover-2.html', html: '<section class="slide"><h1>副本</h1></section>' })).toContain('已重写');
    expect(await run('delete_page', { path: 'pages/cover-2.html' })).toContain('已删除');
    const out = draft.result();
    expect(out.readme).toContain('#0f172a');
    expect(text(out)).toEqual(['封面 ACME', '关键数据ARR', 'Thanks ACME']);
    expect(cssFiles(out.css).map((f) => f.path)).toEqual(['styles/theme.css', 'styles/components.css', 'styles/charts.css']);
    expect(out.css).toContain('--brand:#0f172a');
  });

  it('applies changed files written out in a reply, with deletions and a new order', () => {
    const { draft } = setup();
    const kpi = draft.view().pages[1];
    const ok = draft.replaceFromText(`改了这些：
<file path="pages/kpi.html">
${kpi.html.replace('数据', '新数据')}
</file>
<file path="pages/agenda.html">
<section class="slide"><h2>议程</h2></section>
</file>
<file path="styles/theme.css">
:root{--brand:#222}
</file>
<file path="pages/readonly-bad">x</file>
<delete path="pages/end.html"/>
<order>pages/cover.html, pages/agenda.html, pages/kpi.html</order>`);
    expect(ok).toBe(true);
    const out = draft.result();
    expect(text(out)).toEqual(['封面 ACME', '议程', '新数据ARR']);
    expect(out.pages[2].id).toBe(kpi.id);
    expect(out.pages[2].html).toContain(`data-eid="${kpi.html.match(/<h2[^>]*data-eid="([^"]+)"/)![1]}"`);
    expect(cssFiles(out.css)[0].css).toBe(':root{--brand:#222}');
    expect(draft.replaceFromText('没有文件，也没有 HTML')).toBe(false);
  });

  it('a full HTML re-output keeps the README and the page file names', () => {
    const { draft } = setup();
    const v = draft.view();
    const html = `<!DOCTYPE html><html><head><style>.x{}</style></head><body>${v.pages.map((p) => p.html).join('')}<section class="slide"><h1>新增</h1></section></body></html>`;
    expect(draft.replaceFromText(html)).toBe(true);
    const out = draft.result();
    expect(out.readme).toBe(snapshot().readme);
    expect(out.pages.map((p) => p.file)).toEqual(['pages/cover.html', 'pages/kpi.html', 'pages/end.html', 'pages/page.html']);
  });
});

describe('file-aware draft tools (one page)', () => {
  it('keeps shared styles read-only, collects new rules in additions.css and carries README edits onto the latest version', async () => {
    const doc = snapshot();
    const draft = Draft.ofPage(doc, doc.pages[1].id);
    const tools = createDraftTools(draft, (h) => h);
    const run = async (name: string, args: Record<string, unknown>) => (await tools.execute(name, args)).content;
    const list = await run('read_draft', {});
    expect(list).toContain('styles/theme.css（22 字符）［共享，只读］');
    expect(list).toContain('styles/additions.css（尚未创建）［可追加本页样式］');
    expect(list).toContain('pages/cover.html — 第 1 页［只读］');
    expect(await run('write_file', { path: 'styles/theme.css', content: ':root{}' })).toContain('共享样式文件只读');
    expect(await run('write_file', { path: 'pages/cover.html', content: '<section class="slide"></section>' })).toContain('只读');
    expect(await run('delete_file', { path: 'styles/theme.css' })).toContain('只读');
    expect(await run('replace_in_draft', { path: 'styles/components.css', old_text: '80px', new_text: '90px' })).toContain('只读');
    expect(await run('write_file', { path: 'styles/additions.css', content: '.kpi-big{font-size:120px}' })).toContain('本次追加部分');
    expect(await run('read_draft', { path: 'styles/additions.css' })).toContain('.kpi-big{font-size:120px}');
    expect(await run('edit_css', { selector: '.kpi-note', set: { color: 'gray' } })).toContain('已新建规则（styles/additions.css）');
    expect(await run('write_file', { path: 'pages/kpi-2.html', content: '<section class="slide"><h2>数据续</h2></section>' })).toContain('插在第 2 页之后');
    expect(await run('replace_in_draft', { path: 'README.md', old_text: '主色 #123456', new_text: '主色 #123456；数据页用大号数字' })).toContain('替换 1 处');
    const latest = { ...doc, pages: [...doc.pages, { id: 'pz', html: '<section class="slide" data-page-id="pz"><h1>别人加的</h1></section>', file: 'pages/z.html' }] };
    const out = draft.result(latest);
    expect(text(out)).toEqual(['封面 ACME', '数据ARR', '数据续', '谢谢 ACME', '别人加的']);
    expect(out.pages.map((p) => p.file)).toEqual(['pages/cover.html', 'pages/kpi.html', 'pages/kpi-2.html', 'pages/end.html', 'pages/z.html']);
    expect(out.readme).toContain('数据页用大号数字');
    const files = cssFiles(out.css);
    expect(files.map((f) => f.path)).toEqual(['styles/theme.css', 'styles/components.css', 'styles/additions.css']);
    expect(files[2].css).toContain('.kpi-big{font-size:120px}');
    expect(files[2].css).toContain('.kpi-note');
  });
});
