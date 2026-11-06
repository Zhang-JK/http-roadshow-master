import { describe, expect, it } from 'vitest';
import { assembleHtml, assignIds, diffDocs, hoistImports, replacePage, type DeckDoc } from '../src/deck.js';
import {
  appendCss,
  checkPath,
  cssFiles,
  fileTree,
  joinCssFiles,
  logEdit,
  nameFiles,
  parseFileBlocks,
  plannedPages,
  readmeBody,
  readmeFromBrief,
} from '../src/files.js';
import { generateFiles, type GenerateDeps } from '../src/generate.js';
import type { ChatMessage, ChatResult } from '../src/llm.js';

const doc = (over: Partial<DeckDoc> = {}): DeckDoc =>
  assignIds({
    title: 't',
    width: 1920,
    height: 1080,
    head: '',
    css: joinCssFiles([
      { path: 'styles/theme.css', css: ':root{--brand:#123}' },
      { path: 'styles/components.css', css: '.title{font-size:80px}' },
    ]),
    pages: [
      { id: '', html: '<section class="slide" data-layout="cover"><h1 class="title">封面</h1></section>', file: 'pages/cover.html' },
      { id: '', html: '<section class="slide" data-layout="kpi"><h1>数据</h1></section>' },
    ],
    readme: '# 项目\n\n## 需求\n- 原始需求\n',
    ...over,
  });

describe('project files', () => {
  it('validates paths', () => {
    expect(checkPath('./readme.MD')).toEqual({ path: 'README.md', kind: 'readme' });
    expect(checkPath('/styles/theme.css')).toEqual({ path: 'styles/theme.css', kind: 'css' });
    expect(checkPath('pages\\cover-2.html')).toEqual({ path: 'pages/cover-2.html', kind: 'page' });
    for (const bad of ['../etc/passwd', 'pages/a/b.html', 'styles/x.js', 'pages/封面.html', 'index.html', 'pages/.html']) {
      expect(() => checkPath(bad)).toThrow(/文件路径无效/);
    }
  });

  it('keeps style files in one stylesheet with markers', () => {
    const files = [
      { path: 'styles/a.css', css: '.a{color:red}' },
      { path: 'styles/b.css', css: '.b{color:blue}' },
    ];
    const css = joinCssFiles(files);
    expect(cssFiles(css)).toEqual(files);
    expect(cssFiles('.old{color:red}')).toEqual([{ path: 'styles/main.css', css: '.old{color:red}' }]);
    expect(cssFiles('')).toEqual([]);
    expect(cssFiles(appendCss(css, 'styles/b.css', '.c{x:1}')).find((f) => f.path === 'styles/b.css')!.css).toBe('.b{color:blue}\n.c{x:1}');
    expect(cssFiles(appendCss('.old{}', 'styles/additions.css', '.n{}')).map((f) => f.path)).toEqual(['styles/main.css', 'styles/additions.css']);
  });

  it('names page files from their layout and keeps names unique', () => {
    const pages = nameFiles([
      { id: 'a', html: '<section data-layout="Content Page"></section>' },
      { id: 'b', html: '<section data-layout="content page"></section>' },
      { id: 'c', html: '<section></section>', file: 'pages/content-page.html' },
      { id: 'd', html: '<section></section>', file: 'pages/content-page.html' },
      { id: 'e', html: '<section></section>', file: 'bad name.html' },
    ]);
    expect(pages.map((p) => p.file)).toEqual([
      'pages/content-page-2.html',
      'pages/content-page-3.html',
      'pages/content-page.html',
      'pages/page.html',
      'pages/page-2.html',
    ]);
  });

  it('assignIds keeps page files; the tree lists README, styles and pages', () => {
    const d = doc();
    expect(d.pages.map((p) => p.file)).toEqual(['pages/cover.html', 'pages/kpi.html']);
    expect(fileTree(d).map((e) => [e.path, e.kind, e.page])).toEqual([
      ['README.md', 'readme', undefined],
      ['styles/theme.css', 'css', undefined],
      ['styles/components.css', 'css', undefined],
      ['pages/cover.html', 'page', 1],
      ['pages/kpi.html', 'page', 2],
    ]);
  });

  it('parses file blocks, including a reply cut off inside the last file', () => {
    const blocks = parseFileBlocks(`说明文字
<file path="README.md">
# T
</file>
<file path='styles/a.css'>
\`\`\`css
.a{color:red}
\`\`\`
</file>
<file path="pages/x.html">
<section class="slide"><h1>未完`);
    expect(blocks).toEqual([
      { path: 'README.md', content: '# T', complete: true },
      { path: 'styles/a.css', content: '.a{color:red}', complete: true },
      { path: 'pages/x.html', content: '<section class="slide"><h1>未完', complete: false },
    ]);
  });

  it('reads the page plan from the README', () => {
    const plan = plannedPages(`## 页面规划
1. pages/cover.html ｜ cover ｜ 封面 ｜ 公司名
2、pages/problem.html ｜ content ｜ 痛点
- pages/cover.html（重复）
* pages/team.html | team | 团队`);
    expect(plan.map((p) => p.path)).toEqual(['pages/cover.html', 'pages/problem.html', 'pages/team.html']);
    expect(plan[0].line).toBe('pages/cover.html ｜ cover ｜ 封面 ｜ 公司名');
  });

  it('keeps an edit log at the end of the README, capped, and ignores it when diffing', () => {
    let r = '# T\n\n## 需求\n- x\n';
    for (let i = 1; i <= 35; i++) r = logEdit(r, `v${i} 修改 ${i}`);
    const lines = r.split('\n').filter((l) => l.startsWith('- v'));
    expect(lines).toHaveLength(30);
    expect(lines[0]).toBe('- v6 修改 6');
    expect(r.match(/## 修改记录/g)).toHaveLength(1);
    expect(readmeBody(r)).toBe('# T\n\n## 需求\n- x');
    const withSection = logEdit('# T\n## 修改记录\n- a\n## 附录\nz', 'b');
    expect(withSection).toContain('- a\n- b\n');
    expect(withSection).toContain('## 附录\nz');

    const before = doc();
    const logged = { ...before, readme: logEdit(before.readme!, 'v2 小改') };
    expect(diffDocs(before, logged).readmeChanged).toBe(false);
    expect(diffDocs(before, { ...before, readme: '# 新需求' }).readmeChanged).toBe(true);
  });

  it('writes a README for old projects from their brief', () => {
    const r = readmeFromBrief('deck', 'A轮', { name: 'A轮', purpose: '融资', content: 'ARR 1200万', empty: '' });
    expect(r).toContain('# A轮');
    expect(r).toContain('- 用途：融资');
    expect(r).toContain('- 内容：ARR 1200万');
    expect(r).not.toContain('empty');
  });

  it('diff names the style files that changed', () => {
    const before = doc();
    const files = cssFiles(before.css);
    files[1].css = '.title{font-size:90px}';
    const after = { ...before, css: joinCssFiles([...files, { path: 'styles/new.css', css: '.n{}' }]) };
    expect(diffDocs(before, after).stylesChanged).toEqual(['styles/components.css', 'styles/new.css']);
    expect(diffDocs(before, { ...before, css: joinCssFiles([files[0]]) }).stylesChanged).toEqual(['styles/components.css']);
  });

  it('page replacement keeps the file name and puts new rules in styles/additions.css', () => {
    const d = doc();
    const next = replacePage(d, d.pages[0].id, [{ id: '', html: '<section class="slide"><h1>新封面</h1></section>' }], '.x{color:red}');
    expect(next.pages[0].file).toBe('pages/cover.html');
    expect(cssFiles(next.css).map((f) => f.path)).toEqual(['styles/theme.css', 'styles/components.css', 'styles/additions.css']);
  });

  it('hoists @import to the top of the assembled stylesheet', () => {
    const css = joinCssFiles([
      { path: 'styles/a.css', css: '.a{color:red}' },
      { path: 'styles/fonts.css', css: "@import url('https://fonts.googleapis.com/css2?family=Inter');\n.b{}" },
    ]);
    const out = hoistImports(css);
    expect(out.startsWith("@import url('https://fonts.googleapis.com/css2?family=Inter');")).toBe(true);
    expect(assembleHtml({ ...doc(), css })).toMatch(/<style>\n@import url/);
    expect(assembleHtml(doc(), { cssHrefs: ['styles/theme.css'] })).toContain('<link rel="stylesheet" href="styles/theme.css">');
  });
});

describe('staged generation', () => {
  const base: DeckDoc = { title: 'T', width: 1920, height: 1080, head: '', css: '', pages: [] };
  const plan = (n: number) =>
    `<file path="README.md">\n# T\n## 页面规划\n${Array.from({ length: n }, (_, i) => `${i + 1}. pages/p${i + 1}.html ｜ content ｜ 第${i + 1}页`).join('\n')}\n</file>\n<file path="styles/theme.css">\n.t{}\n</file>`;
  const page = (n: number) => `<file path="pages/p${n}.html">\n<section class="slide"><h1>P${n}</h1></section>\n</file>`;
  const batchOf = (m: ChatMessage[]) => {
    const text = JSON.stringify(m);
    return [...text.matchAll(/- 第 (\d+) 页：pages\/[\w.-]+\.html/g)].map((x) => Number(x[1]));
  };
  const result = (text: string, finishReason = 'stop'): ChatResult => ({ text, endpointId: 1, model: 'm', finishReason });

  function scripted(replies: ((m: ChatMessage[], stage: string) => ChatResult)[]) {
    const stages: string[] = [];
    let i = 0;
    const deps: GenerateDeps = {
      pagesPerCall: 3,
      call: async (m, stage) => {
        stages.push(stage);
        const f = replies[Math.min(i++, replies.length - 1)];
        return f(m, stage);
      },
    };
    return { deps, stages };
  }
  const titles = (d: DeckDoc) => d.pages.map((p) => p.html.replace(/<[^>]+>/g, ''));

  it('writes the plan first, then the pages in batches, in plan order', async () => {
    const { deps, stages } = scripted([
      () => result(plan(5)),
      (m) => result(batchOf(m).reverse().map(page).join('\n')),
    ]);
    const d = await generateFiles({ base, kind: 'deck', brief: { name: 'T', content: 'c' }, template: null, assets: [] }, deps);
    expect(titles(d)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
    expect(d.pages.map((p) => p.file)).toEqual(['pages/p1.html', 'pages/p2.html', 'pages/p3.html', 'pages/p4.html', 'pages/p5.html']);
    expect(d.readme).toContain('## 页面规划');
    expect(cssFiles(d.css)).toEqual([{ path: 'styles/theme.css', css: '.t{}' }]);
    expect(stages).toEqual(['规划：编写 README 与样式文件', '生成页面：第 1–3 页（共 5 页）', '生成页面：第 4–5 页（共 5 页）']);
  });

  it('continues a cut-off plan and recovers from a cut-off page batch', async () => {
    const full = plan(4);
    const seen: ChatMessage[][] = [];
    const { deps } = scripted([
      () => result(full.slice(0, 40), 'length'),
      (m) => {
        seen.push(m);
        return result(full);
      },
      () => result(`${page(1)}\n${page(2).slice(0, 30)}`, 'length'),
      (m) => result(batchOf(m).map(page).join('\n')),
    ]);
    const d = await generateFiles({ base, kind: 'template', brief: { name: 'T', style: 's', purpose: 'p' }, template: null, assets: [] }, deps);
    expect(titles(d)).toEqual(['P1', 'P2', 'P3', 'P4']);
    const note = seen[0].at(-1)!.content as string;
    expect(note).toContain('回复达到最大输出长度被截断');
    expect(note).toContain('README.md');
    expect(seen[0].at(-2)).toMatchObject({ role: 'assistant' });
  });

  it('maps pages written under other names onto the planned files and moves <style> into additions.css', async () => {
    const { deps } = scripted([
      () => result(plan(2)),
      () =>
        result(
          '<file path="pages/intro.html">\n<style>.only-here{color:red}</style><section class="slide"><h1>P1</h1></section>\n</file>\n<file path="pages/other.html">\n<h1>P2 无 section</h1>\n</file>',
        ),
    ]);
    const d = await generateFiles({ base, kind: 'deck', brief: { name: 'T', content: 'c' }, template: null, assets: [] }, deps);
    expect(d.pages.map((p) => p.file)).toEqual(['pages/p1.html', 'pages/p2.html']);
    expect(d.pages[1].html).toMatch(/^<section class="slide"><h1>P2 无 section<\/h1><\/section>$/);
    expect(cssFiles(d.css).find((f) => f.path === 'styles/additions.css')!.css).toBe('.only-here{color:red}');
  });

  it('copies the template styles, drops to one page per call after a miss and gives up after repeated misses', async () => {
    const template = doc();
    const sizes: number[] = [];
    const { deps } = scripted([
      () => result('<file path="README.md">\n# T\n## 页面规划\n1. pages/a.html ｜ cover\n2. pages/b.html ｜ kpi\n</file>'),
      (m) => {
        sizes.push(batchOf(m).length);
        return result('我先想一想。');
      },
    ]);
    await expect(
      generateFiles({ base, kind: 'deck', brief: { name: 'T', content: 'c' }, template, assets: [] }, deps),
    ).rejects.toThrow(/连续 3 次没有输出页面 pages\/a\.html/);
    expect(sizes).toEqual([2, 1, 1]);

    const ok = scripted([
      () => result('<file path="README.md">\n# T\n## 页面规划\n1. pages/a.html ｜ cover\n</file>'),
      () => result('<file path="pages/a.html">\n<section class="slide"><h1>A</h1></section>\n</file>'),
    ]);
    const d = await generateFiles({ base, kind: 'deck', brief: { name: 'T', content: 'c' }, template, assets: [] }, ok.deps);
    expect(cssFiles(d.css)).toEqual(cssFiles(template.css));
  });

  it('fails clearly when the plan never names any pages', async () => {
    const { deps, stages } = scripted([() => result('<file path="README.md">\n# T\n没有规划\n</file>\n<file path="styles/a.css">\n.a{}\n</file>')]);
    await expect(generateFiles({ base, kind: 'deck', brief: { name: 'T', content: 'c' }, template: null, assets: [] }, deps)).rejects.toThrow(
      /页面规划/,
    );
    expect(stages).toHaveLength(3);
  });
});
