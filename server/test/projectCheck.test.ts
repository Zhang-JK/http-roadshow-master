import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startMockLlm } from './mockLlm.js';
import { assignIds, type DeckDoc } from '../src/deck.js';
import { createDraftTools, Draft } from '../src/draft.js';
import { cssFiles, joinCssFiles } from '../src/files.js';
import { checkProject, formatProjectReport, type ProjectIssue } from '../src/projectCheck.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-check-'));
process.env.DATA_DIR = tmp;

const README_OK = `# 项目

## 需求
- 融资路演

## 风格约定
- 主色 #123456

## 页面规划
1. pages/cover.html ｜ cover ｜ 封面
2. pages/kpi.html ｜ kpi ｜ 数据
3. pages/end.html ｜ end ｜ 结束
`;

const project = (over: { css?: { path: string; css: string }[]; pages?: { file: string; html: string }[]; readme?: string } = {}): DeckDoc =>
  assignIds(
    {
      title: 't',
      width: 1920,
      height: 1080,
      head: '',
      css: joinCssFiles(
        over.css ?? [
          { path: 'styles/theme.css', css: ':root{--brand:#123456}' },
          { path: 'styles/components.css', css: '.title{font-size:80px;color:var(--brand)}' },
        ],
      ),
      pages: (
        over.pages ?? [
          { file: 'pages/cover.html', html: '<section class="slide" data-layout="cover"><h1 class="title">封面</h1></section>' },
          { file: 'pages/kpi.html', html: '<section class="slide" data-layout="kpi"><h2>数据</h2></section>' },
          { file: 'pages/end.html', html: '<section class="slide" data-layout="end"><h2>谢谢</h2></section>' },
        ]
      ).map((p) => ({ id: '', ...p })),
      readme: over.readme ?? README_OK,
    },
    { keepScripts: true },
  );

const check = (draft: Draft) => checkProject(undefined, draft.checkInput());
const errors = (issues: ProjectIssue[]) => issues.filter((i) => i.severity === 'error').map((i) => `${i.file}：${i.message}`);
const warnings = (issues: ProjectIssue[]) => issues.filter((i) => i.severity === 'warning').map((i) => `${i.file}：${i.message}`);

describe('delivery check', () => {
  it('passes a complete project: README, linked styles, standalone pages', async () => {
    const draft = Draft.ofDocument(project());
    const issues = await check(draft);
    expect(issues).toEqual([]);
    expect(formatProjectReport(draft.view(), issues)).toBe('已组装 README.md、index.html、2 个样式文件和 3 个页面文件并在浏览器中加载：交付检查通过。');
  });

  it('requires a README with the request, the style and a page plan matching the files', async () => {
    expect(errors(await check(Draft.ofDocument(project({ readme: ' ' }))))).toEqual([expect.stringMatching(/^README\.md：README\.md 为空/)]);
    const partial = await check(Draft.ofDocument(project({ readme: '# 项目\n\n## 需求\n- 路演\n' })));
    expect(errors(partial)).toEqual([
      expect.stringContaining('缺少「## 风格约定」一节'),
      expect.stringContaining('缺少「## 页面规划」一节'),
    ]);
    const stale = README_OK.replace('2. pages/kpi.html ｜ kpi ｜ 数据\n', '').replace('3. pages/end.html', '3. pages/old.html');
    expect(errors(await check(Draft.ofDocument(project({ readme: stale }))))).toEqual([
      'README.md：「页面规划」列出的 pages/old.html 不存在：页面已删除或改名时请同步更新 README',
      'README.md：「页面规划」没有列出 pages/kpi.html、pages/end.html：新增或拆分页面后请把它们按顺序补进页面规划',
    ]);
    // The edit log the system appends is not part of the plan.
    const logged = `${README_OK}\n## 修改记录\n- v2 删除了 pages/gone.html\n`;
    expect(await check(Draft.ofDocument(project({ readme: logged })))).toEqual([]);
  });

  it('checks the style files: syntax, imports between files, undefined variables, empty files', async () => {
    const issues = await check(
      Draft.ofDocument(
        project({
          css: [
            { path: 'styles/theme.css', css: ':root{--brand:#123456}\n.a{color:red' },
            { path: 'styles/components.css', css: '@import "theme.css";\n.title{color:var(--missing);background:var(--brand)}' },
            { path: 'styles/empty.css', css: '' },
          ],
        }),
      ),
    );
    expect(errors(issues)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^styles\/theme\.css：CSS 语法错误（第 2 行）：Unclosed block/),
        expect.stringMatching(/^styles\/components\.css：@import theme\.css：样式文件之间不要互相 @import/),
      ]),
    );
    expect(warnings(issues)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^styles\/components\.css：使用了未定义的 CSS 变量 --missing（/), 'styles/empty.css：样式文件为空']),
    );
    expect(errors(await check(Draft.ofDocument(project({ css: [] }))))).toEqual([expect.stringMatching(/^styles\/：没有任何样式文件/)]);
  });

  it('reports JavaScript the model wrote, although the saved pages never contain it', async () => {
    const draft = Draft.ofDocument(
      project({
        pages: [
          { file: 'pages/cover.html', html: '<section class="slide"><h1 onclick="go()">封面</h1><script>alert(1)</script></section>' },
          { file: 'pages/kpi.html', html: '<section class="slide"><a href="javascript:void(0)">链接</a><style>.x{color:red}</style></section>' },
          { file: 'pages/end.html', html: '<section class="slide"><iframe src="https://example.com"></iframe></section>' },
        ],
      }),
    );
    const issues = await check(draft);
    expect(errors(issues)).toEqual([
      expect.stringMatching(/^pages\/cover\.html：包含 <script>、事件属性（onclick 等）：材料不运行 JavaScript/),
      expect.stringMatching(/^pages\/kpi\.html：包含 javascript: 链接/),
      expect.stringMatching(/^pages\/end\.html：包含 <iframe>\/<object>/),
    ]);
    expect(warnings(issues)).toEqual([expect.stringMatching(/^pages\/kpi\.html：页面内含 <style>/)]);
    const saved = draft.result();
    expect(saved.pages.map((p) => p.html).join('')).not.toMatch(/<script|onclick|javascript:|<iframe/);
  });

  it('loads index.html and every page in the browser: missing files, broken images, page size', async () => {
    const issues = await check(
      Draft.ofDocument(
        project({
          css: [
            { path: 'styles/theme.css', css: ':root{--brand:#123456}' },
            { path: 'styles/components.css', css: '.hero{background:url(../images/bg.png)}\n.slide{width:1280px}' },
          ],
          pages: [
            { file: 'pages/cover.html', html: '<section class="slide"><div class="hero">封面</div></section>' },
            { file: 'pages/kpi.html', html: '<section class="slide"><img src="/api/assets/nonexistent-asset-1"></section>' },
            { file: 'pages/end.html', html: '<section class="slide"><img src="images/logo.png"></section>' },
          ],
        }),
      ),
    );
    expect(errors(issues)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^index\.html：页面尺寸为 1280×1080，应为 1920×1080/),
        expect.stringMatching(/^pages\/kpi\.html：图片无法加载：\/api\/assets\/nonexistent-asset-1/),
        expect.stringMatching(/^pages\/end\.html：图片无法加载：images\/logo\.png/),
        'styles/components.css：引用的文件不存在：images/bg.png',
        expect.stringMatching(/^pages\/kpi\.html：引用的文件不存在：\/api\/assets\/nonexistent-asset-1（素材不存在）/),
      ]),
    );
  });

  it('page edits only hear about the files they may change; README problems are warnings there', async () => {
    const doc = project({
      readme: '# 项目\n\n## 需求\n- 路演\n',
      css: [{ path: 'styles/theme.css', css: '.a{color:red' }],
      pages: [
        { file: 'pages/cover.html', html: '<section class="slide"><script>x()</script><h1>封面</h1></section>' },
        { file: 'pages/kpi.html', html: '<section class="slide"><h2>数据</h2></section>' },
      ],
    });
    const draft = Draft.ofPage(doc, doc.pages[1].id);
    await createDraftTools(draft, (h) => h).execute('replace_in_draft', { path: 'pages/kpi.html', old_text: '数据', new_text: '<span onclick="x()">数据</span>' });
    const issues = await check(draft);
    expect(errors(issues)).toEqual([expect.stringMatching(/^pages\/kpi\.html：包含 事件属性/)]);
    expect(warnings(issues)).toEqual([expect.stringContaining('缺少「## 风格约定」'), expect.stringContaining('缺少「## 页面规划」')]);
  });
});

describe('file-aware tools, every one of them', () => {
  const setup = (db?: any) => {
    const draft = Draft.ofDocument(project());
    const tools = createDraftTools(draft, (h) => h, db);
    const run = async (name: string, args: Record<string, unknown> = {}) => (await tools.execute(name, args)).content;
    return { draft, tools, run };
  };

  it('pages are addressed by file everywhere and every result names the file', async () => {
    const { draft, run } = setup();
    expect(await run('insert_page', { after_path: 'pages/cover.html', path: 'pages/team.html', html: '<section class="slide" data-layout="team"><h2>团队</h2></section>' })).toBe(
      '已在第 1 页之后插入 1 页（pages/team.html），后续页码顺延；现共 4 页。',
    );
    expect(await run('insert_page', { after: 4, html: '<section class="slide" data-layout="qa"><h2>问答</h2></section>' })).toContain('（pages/qa.html）');
    expect(await run('insert_page', { after: 0, path: 'pages/kpi.html', html: '<section class="slide"></section>' })).toContain('pages/kpi.html 已存在');
    expect(await run('insert_page', { after: 0, path: 'styles/x.css', html: '<section class="slide"></section>' })).toContain('path 必须是 pages/名称.html');
    expect(await run('move_page', { path: 'pages/end.html', to: 1 })).toBe('已把 pages/end.html（原第 4 页）移到第 1 页；页面顺序即 index.html 中的顺序。');
    expect(await run('find_elements', { selector: 'h2' })).toMatch(/第 1 页（pages\/end\.html） <h2>[\s\S]*第 3 页（pages\/team\.html） <h2>/);
    expect(await run('edit_elements', { selector: 'h2', text: 'x' })).toMatch(/匹配到 \d+ 个元素[\s\S]*第 1 页（pages\/end\.html）/);
    expect(await run('edit_elements', { path: 'pages/team.html', selector: 'h2', text: '核心团队' })).toBe('已修改 1 个元素（第 3 页（pages/team.html））。需要时用 render_pages 查看效果。');
    expect(await run('replace_in_draft', { page: 2, old_text: '封面', new_text: '首页' })).toContain('已在草稿第 2 页（pages/cover.html）替换 1 处');
    expect(await run('replace_in_draft', { all_pages: true, old_text: '<h2', new_text: '<h2 class="sub"' })).toMatch(/第 1 页（pages\/end\.html） 1 处/);
    expect(await run('rewrite_page', { path: 'pages/qa.html', html: '<section class="slide"><h2>Q&amp;A</h2></section>' })).toContain('已重写草稿第 5 页（pages/qa.html）');
    expect(await run('duplicate_page', { path: 'pages/qa.html' })).toContain('（pages/qa-2.html）');
    expect(await run('delete_page', { path: 'pages/qa-2.html' })).toContain('已删除草稿第 6 页（pages/qa-2.html）');
    expect(draft.view().pages.map((p) => p.file)).toEqual(['pages/end.html', 'pages/cover.html', 'pages/team.html', 'pages/kpi.html', 'pages/qa.html']);
    const report = await run('check_layout');
    expect(report).toContain('共 5 页');
  });

  it('layout reports and screenshots name the page files', async () => {
    const { run, tools } = setup();
    await run('edit_elements', { path: 'pages/kpi.html', selector: 'h2', style: { position: 'absolute', left: '1800px', 'white-space': 'nowrap' }, text: '这一行文字会超出页面右边界很多很多' });
    expect(await run('check_layout')).toMatch(/第 2 页（pages\/kpi\.html）：\n\s+✗ 文字超出页面边界/);
    const shot = await tools.execute('render_pages', { paths: ['pages/kpi.html', 'pages/end.html'] });
    expect(shot.content).toMatch(/^已渲染第 2 页（pages\/kpi\.html）、第 3 页（pages\/end\.html）/);
    expect(shot.images?.map((i) => i.label)).toEqual(['草稿第 2 页（pages/kpi.html）', '草稿第 3 页（pages/end.html）']);
  });

  it('warns when written HTML does not pair its tags (the parser re-nests it)', async () => {
    const { run } = setup();
    expect(await run('rewrite_page', { path: 'pages/kpi.html', html: '<section class="slide"><div class="grid"><div class="card">A</div></section>' })).toMatch(
      /注意：写入的 HTML 标签不配对（<div> 多了 1 个开标签（缺少 <\/div>））/,
    );
    expect(await run('write_file', { path: 'pages/new.html', content: '<section class="slide"><span>x</span></span></section>' })).toContain('<span> 多了 1 个闭标签');
    expect(await run('replace_in_draft', { path: 'pages/end.html', old_text: '谢谢', new_text: '<b>谢谢' })).toContain('<b> 多了 1 个开标签');
    expect(await run('rewrite_page', { path: 'pages/cover.html', html: '<section class="slide"><h1>ok</h1></section>' })).not.toContain('注意');
  });

  it('check_project runs the delivery check on demand (only where the job has a database)', async () => {
    expect(setup().tools.defs.map((d) => d.function.name)).not.toContain('check_project');
    const { openDb } = await import('../src/db.js');
    const db = openDb(path.join(tmp, 'tools.db'));
    const { tools, run } = setup(db);
    expect(tools.defs.map((d) => d.function.name)).toContain('check_project');
    expect(await run('check_project')).toContain('交付检查通过');
    await run('delete_file', { path: 'pages/end.html' });
    expect(await run('check_project')).toContain('✗ README.md：「页面规划」列出的 pages/end.html 不存在');
  });
});

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockLlm>>;
let cookie = '';
let db: import('../src/db.js').DB;

async function req(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
  return { status: res.statusCode, json: res.json() };
}

async function waitJob(id: string) {
  for (let i = 0; i < 300; i++) {
    const { json } = await req('GET', `/api/jobs/${id}`);
    if (json.job.status === 'done' || json.job.status === 'error') return json.job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job timeout');
}

const savedDoc = (id: string) => JSON.parse((db.prepare('SELECT doc FROM projects WHERE id = ?').get(id) as { doc: string }).doc) as DeckDoc;

describe('delivery check in jobs', () => {
  beforeAll(async () => {
    mock = await startMockLlm();
    const { openDb } = await import('../src/db.js');
    const { buildApp } = await import('../src/app.js');
    db = openDb(path.join(tmp, 'test.db'));
    app = await buildApp(db, { serveWeb: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } });
    cookie = String(login.headers['set-cookie']).split(';')[0];
    await req('POST', '/api/llm/endpoints', { name: 'mock', baseUrl: mock.url, apiKey: 'good-key', model: 'mock-vision' });
  });

  afterAll(async () => {
    await app.close();
    await mock.close();
    const { closeBrowser } = await import('../src/render.js');
    await closeBrowser();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const create = async (notes: string) => {
    const before = mock.checkCalls.length;
    const r = await req('POST', '/api/projects', { type: 'template', name: '交付', style: '简约', notes });
    const job = await waitJob(r.json.job.id);
    return { id: r.json.project.id as string, job, checks: mock.checkCalls.slice(before) };
  };

  it('a clean generation passes without going back to the model', async () => {
    const { job, checks } = await create('');
    expect(job.status).toBe('done');
    expect(checks).toHaveLength(0);
    expect(job.review.check).toEqual({ errors: 0, warnings: 0, fixes: 0, remaining: [] });
  });

  it('scripts in generated pages go back to the model, which removes them', async () => {
    const { id, job, checks } = await create('BAD_PAGE_JS');
    expect(job.status).toBe('done');
    expect(checks[0].text).toContain('【交付检查】');
    expect(checks[0].text).toMatch(/✗ pages\/content-1\.html：包含 <script>、事件属性（onclick 等）/);
    expect(checks[0].body.tools.map((t: any) => t.function.name)).toContain('check_project');
    expect(job.review.check).toMatchObject({ errors: 0, fixes: 1 });
    const page = savedDoc(id).pages[1].html;
    expect(page).not.toMatch(/<script|onclick/);
    expect(page).toContain('下一步');
  });

  it('scripts the model leaves in get three fix rounds; saving strips them, so the job still succeeds', async () => {
    const { id, job, checks } = await create('BAD_PAGE_JS CHECK_STUBBORN');
    expect(job.status).toBe('done');
    expect(checks).toHaveLength(3);
    expect(job.review.check).toMatchObject({ errors: 1, fixes: 3, remaining: [expect.stringMatching(/^pages\/content-1\.html：包含 <script>/)] });
    expect(job.review.check.unresolved).toBeUndefined();
    expect(savedDoc(id).pages[1].html).not.toMatch(/<script|onclick/);
  });

  it('errors still there after three fix rounds fail the job, listing them', async () => {
    const { id, job, checks } = await create('BAD_IMG CHECK_STUBBORN');
    expect(checks).toHaveLength(3);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/^交付检查 4 次未通过（已交回模型修复 3 次），仍有以下问题：\n- pages\/content-1\.html：图片无法加载/);
    expect(job.review.check.fixes).toBe(3);
    expect(job.review.check.unresolved[0]).toContain('图片无法加载');
    const p = await req('GET', `/api/projects/${id}`);
    expect(p.json.project).toMatchObject({ status: 'error', versionNo: 0 });
    const h = await req('GET', `/api/projects/${id}/versions`);
    expect(h.json.failedJobs[0].error).toContain('交付检查 4 次未通过');
  });

  it('a plan without style sheets carries on, and the check has the model write them', async () => {
    const plans = () => mock.calls.filter((c) => c.text.includes('本次只输出 README.md 与样式文件')).length;
    const before = plans();
    const { id, job, checks } = await create('NO_CSS');
    expect(job.status).toBe('done');
    // The first reply and three requests for the missing files, then the pages are written anyway.
    expect(plans() - before).toBe(4);
    expect(checks[0].text).toContain('✗ styles/：没有任何样式文件');
    expect(savedDoc(id).css).toContain('CHECK-WROTE-STYLES');
    expect(job.review.check).toMatchObject({ errors: 0, fixes: 1 });
  });

  it('style sheets in ```css blocks instead of <file> tags are taken as they are', async () => {
    const plans = () => mock.calls.filter((c) => c.text.includes('本次只输出 README.md 与样式文件')).length;
    const before = plans();
    const { id, job, checks } = await create('CSS_FENCED');
    expect(job.status).toBe('done');
    expect(plans() - before).toBe(1);
    expect(checks).toHaveLength(0);
    expect(cssFiles(savedDoc(id).css).map((f) => f.path)).toEqual(['styles/theme.css', 'styles/components.css']);
  });

  it('a page the model fails to write is left to the check, which has it written', async () => {
    const { id, job, checks } = await create('SKIP_PAGE');
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    expect(checks[0].text).toContain('✗ pages/content-1.html：页面 pages/content-1.html 还没有写出');
    const doc = savedDoc(id);
    expect(doc.pages.map((p) => p.file)).toEqual(['pages/cover.html', 'pages/content-1.html', 'pages/content-2.html']);
    expect(doc.pages[1].html).toContain('CHECK-WROTE-PAGE');
  });

  it('an edit is not failed for errors the project already had', async () => {
    const { id } = await create('');
    const doc = savedDoc(id);
    doc.pages[2].html = doc.pages[2].html.replace('</section>', '<img src="/api/assets/old-missing" alt="旧图"></section>');
    db.prepare('UPDATE projects SET doc = ? WHERE id = ?').run(JSON.stringify(doc), id);
    const before = mock.checkCalls.length;
    const e = await req('POST', `/api/projects/${id}/edit`, { prompt: 'CHECK_STUBBORN 整体微调', scope: 'global' });
    const job = await waitJob(e.json.job.id);
    expect(mock.checkCalls.length - before).toBe(3);
    expect(job.status).toBe('done');
    expect(job.review.check).toMatchObject({ fixes: 3, remaining: expect.arrayContaining([expect.stringContaining('图片无法加载')]) });
  });

  it('a whole-document edit that deletes a page must bring the README page plan up to date', async () => {
    const { id } = await create('');
    const e = await req('POST', `/api/projects/${id}/edit`, { prompt: 'DELETE_LAST 删掉最后一页', scope: 'global' });
    const before = mock.checkCalls.length;
    const job = await waitJob(e.json.job.id);
    expect(job.status).toBe('done');
    const checks = mock.checkCalls.slice(before);
    expect(checks[0].text).toContain('✗ README.md：「页面规划」列出的 pages/content-2.html 不存在');
    const doc = savedDoc(id);
    expect(doc.pages.map((p) => p.file)).toEqual(['pages/cover.html', 'pages/content-1.html']);
    expect(doc.readme).toMatch(/## 页面规划\n1\. pages\/cover\.html.*\n2\. pages\/content-1\.html.*\n/);
    expect(doc.readme).not.toContain('pages/content-2.html ｜');
    expect(doc.readme).toContain('MOCK-README-NEED');
    expect(doc.readme).toMatch(/## 修改记录\n- v2 .*DELETE_LAST/);
    expect(job.review.check).toMatchObject({ errors: 0, fixes: 1 });
  });

  it('scripts added by an edit are caught as well', async () => {
    const { id } = await create('');
    const e = await req('POST', `/api/projects/${id}/edit`, { prompt: 'EDIT_ADD_JS 加统计代码', scope: 'global' });
    const job = await waitJob(e.json.job.id);
    expect(job.status).toBe('done');
    expect(job.review.check).toMatchObject({ errors: 0, fixes: 1 });
    expect(savedDoc(id).pages.map((p) => p.html).join('')).not.toContain('<script');
  });

  it('page edits are not sent back for README warnings', async () => {
    const { id } = await create('');
    const doc = savedDoc(id);
    const before = mock.checkCalls.length;
    const e = await req('POST', `/api/projects/${id}/edit`, { prompt: '加一段', scope: 'page', pageId: doc.pages[0].id });
    const job = await waitJob(e.json.job.id);
    expect(job.status).toBe('done');
    expect(mock.checkCalls.length).toBe(before);
    expect(job.review.check).toMatchObject({ errors: 0, fixes: 0 });
  });
});
