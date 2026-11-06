import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startMockLlm } from './mockLlm.js';
import type { DeckDoc } from '../src/deck.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-check-'));
process.env.DATA_DIR = tmp;

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
const toolResults = (call: { body: any }) => call.body.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content as string);

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

describe('layout inspection', () => {
  const doc = (pages: string[], css = ''): DeckDoc => ({
    title: 't',
    width: 1920,
    height: 1080,
    head: '',
    css,
    pages: pages.map((html, i) => ({ id: `p${i}`, html: html.replace('<section', `<section data-page-id="p${i}"`) })),
  });

  it('finds overflow, clipping, overlap, broken images, tiny fonts and empty pages', async () => {
    const { inspectLayout } = await import('../src/render.js');
    const reports = await inspectLayout(
      doc(
        [
          '<section class="slide"><h1 style="font-size:80px">干净的一页</h1><p style="font-size:36px">正文</p></section>',
          '<section class="slide"><p style="position:absolute;left:1700px;white-space:nowrap;font-size:40px">超出右边界的一行很长很长的文字</p></section>',
          '<section class="slide"><div style="height:100px;overflow:hidden;font-size:40px">第一行<br>第二行<br>第三行<br>第四行</div></section>',
          '<section class="slide"><p style="position:absolute;top:100px;left:100px;font-size:60px">重叠甲</p><p style="position:absolute;top:110px;left:110px;font-size:60px">重叠乙</p></section>',
          '<section class="slide"><img src="data:image/png;base64,AAAA"><p style="font-size:10px">脚注小字</p></section>',
          '<section class="slide"><div></div></section>',
        ],
      ),
      (h) => h,
    );
    const kinds = reports.map((r) => r.issues.map((i) => i.kind));
    expect(kinds[0]).toEqual([]);
    expect(kinds[1]).toContain('overflow');
    expect(reports[1].issues[0].message).toContain('超出右边界');
    expect(kinds[2]).toContain('clipped');
    expect(kinds[3]).toContain('overlap');
    expect(kinds[4]).toEqual(expect.arrayContaining(['broken_image', 'small_font']));
    expect(kinds[5]).toEqual(['empty']);
  });

  it('works under tsx, which `npm start` uses to run the server', () => {
    const script = `import { inspectLayout, closeBrowser } from './src/render.ts';
const r = await inspectLayout({ title: 't', width: 1920, height: 1080, head: '', css: '', pages: [{ id: 'p0', html: '<section class="slide" data-page-id="p0"><p style="position:absolute;left:1900px">OUT</p></section>' }] }, (h) => h);
console.log(JSON.stringify(r[0].issues.map((i) => i.kind)));
await closeBrowser();`;
    const file = path.join(process.cwd(), `.tsx-check-${process.pid}.mts`);
    fs.writeFileSync(file, script);
    try {
      const out = execFileSync('npx', ['tsx', file], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });
      expect(out.trim().split('\n').at(-1)).toBe('["overflow"]');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('contact sheets tile pages into labelled overview images', async () => {
    const { renderContactSheets } = await import('../src/render.js');
    const pages = Array.from({ length: 14 }, (_, i) => `<section class="slide"><h1>P${i + 1}</h1></section>`);
    const sheets = await renderContactSheets(doc(pages), (h) => h);
    expect(sheets).toHaveLength(2);
    expect(sheets[0].subarray(0, 3).toString('hex')).toBe('ffd8ff');
  });
});

describe('draft', () => {
  it('fragment drafts can only change the edited page and apply onto the latest document', async () => {
    const { Draft, createDraftTools } = await import('../src/draft.js');
    const { assignIds } = await import('../src/deck.js');
    const snapshot = assignIds({
      title: 't',
      width: 1920,
      height: 1080,
      head: '',
      css: '.a{color:red}',
      pages: [1, 2, 3].map((i) => ({ id: '', html: `<section class="slide"><h1>原第${i}页</h1></section>` })),
    });
    const target = snapshot.pages[1].id;
    const draft = Draft.fromFragment('```html\n<section class="slide"><h1>新第2页</h1><p>OLD</p></section>\n```', snapshot, target);
    expect(draft.editablePages()).toEqual([2]);
    const tools = createDraftTools(draft, (h) => h);
    expect(tools.defs.map((d) => d.function.name)).not.toContain('delete_page');
    expect((await tools.execute('read_draft', {})).content).toMatch(/第 1 页［只读］[\s\S]*第 2 页［可修改］[\s\S]*第 3 页［只读］/);
    expect((await tools.execute('replace_in_draft', { page: 1, old_text: '原', new_text: '改' })).content).toContain('只读');
    expect((await tools.execute('replace_in_draft', { page: 2, old_text: 'MISSING', new_text: 'x' })).content).toContain('没有找到 old_text');
    expect((await tools.execute('replace_in_draft', { page: 2, old_text: 'OLD', new_text: 'NEW' })).content).toContain('替换 1 处');
    expect((await tools.execute('rewrite_page', { page: 2, html: '<p>no section</p>' })).content).toContain('没有 <section>');
    expect((await tools.execute('rewrite_page', { page: 2, html: '<section class="slide"><h1>A</h1></section><section class="slide"><h1>B</h1></section>' })).content).toContain('拆分出 1 个新页面');
    expect(draft.pageCount).toBe(4);
    expect((await tools.execute('replace_in_draft', { page: 0, old_text: '', new_text: 'x' })).content).toContain('不能为空');
    await tools.execute('rewrite_page', { page: 3, html: '<section class="slide"><h1>B2 NEW</h1></section>' });
    const latest = { ...snapshot, pages: [...snapshot.pages, { id: 'pextra', html: '<section class="slide" data-page-id="pextra"><h1>别人新加的页</h1></section>' }] };
    const result = draft.result(latest);
    expect(result.pages.map((p) => p.html.replace(/<[^>]+>/g, ''))).toEqual(['原第1页', 'A', 'B2 NEW', '原第3页', '别人新加的页']);
    expect(result.pages[1].id).toBe(target);
    const render = await tools.execute('render_pages', { pages: [2, 3, 99] });
    expect(render.images?.map((i) => i.label)).toEqual(['草稿第 2 页', '草稿第 3 页']);
    expect(render.images?.[0].url).toMatch(/^data:image\/jpeg;base64,/);
  });
});

describe('self-check agent loop', () => {
  it('renders the draft, shows it to the model and lets it fix the layout before saving', async () => {
    const before = mock.reviewCalls.length;
    const r = await req('POST', '/api/projects', { type: 'template', name: '自检模板', style: '简约', notes: 'FIX_DRAFT' });
    const job = await waitJob(r.json.job.id);
    expect(job.status).toBe('done');
    const calls = mock.reviewCalls.slice(before);
    expect(calls).toHaveLength(3);

    const first = calls[0];
    expect(first.text).toContain('【自检阶段】');
    expect(first.text).toMatch(/第 2 页：\n\s+✗ 文字超出页面边界 \d+px：<p\.body>「OVERFLOW-TEXT/);
    expect(first.images.filter((i) => i.startsWith('data:image/jpeg'))).toHaveLength(1);
    expect(first.text).not.toContain('<section class="slide" data-layout'); // the draft HTML is not resent
    expect(first.body.tools.map((t: any) => t.function.name).sort()).toEqual(
      [
        'check_layout', 'delete_page', 'duplicate_page', 'edit_css', 'edit_elements', 'find_css', 'find_elements',
        'insert_page', 'move_page', 'read_draft', 'render_pages', 'replace_in_draft', 'rewrite_page',
      ],
    );

    const results = toolResults(calls[2]);
    expect(results[1]).toContain('第 2 页［可修改］');
    expect(results[2]).toContain('已渲染第 2 页');
    expect(results[3]).toContain('left:1800px');
    expect(results[4]).toContain('已在草稿第 2 页替换 1 处');
    expect(results[5]).toContain('没有找到 old_text');
    const shots = calls[2].body.messages.find((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.text?.includes('工具调用返回的图片'));
    expect(shots.content.find((p: any) => p.type === 'text' && p.text.includes('草稿第 2 页'))).toBeTruthy();

    expect(job.review).toMatchObject({ before: { errors: 1 }, after: { errors: 0 }, passes: 1, edits: 1, toolCalls: 6 });
    expect(job.review.summary).toContain('已修复');
    expect(job.cost).toBeCloseTo(0.0004, 6); // the draft plus three review rounds
    expect(job.promptTokens).toBeGreaterThan(calls.reduce((n, c) => n + c.text.length / 2, 0) - 10);
    const doc = savedDoc(r.json.project.id);
    expect(doc.pages).toHaveLength(3);
    expect(doc.pages[1].html).toContain('left:120px');
    expect(doc.pages[1].html).not.toContain('left:1800px');
    expect(doc.pages[1].html).toMatch(/data-eid="e/);
    expect((db.prepare('SELECT version_no FROM projects WHERE id = ?').get(r.json.project.id) as any).version_no).toBe(1);
  });

  it('page edits are reviewed with the other pages read-only', async () => {
    const r = await req('POST', '/api/projects', { type: 'template', name: '页编辑', style: '简约' });
    await waitJob(r.json.job.id);
    const id = r.json.project.id;
    const original = savedDoc(id);
    const before = mock.reviewCalls.length;
    const e = await req('POST', `/api/projects/${id}/edit`, { prompt: 'FIX_DRAFT 加一段', scope: 'page', pageId: original.pages[0].id });
    const job = await waitJob(e.json.job.id);
    expect(job.status).toBe('done');
    const calls = mock.reviewCalls.slice(before);
    expect(calls[0].text).toContain('本次只能修改第 1 页');
    expect(calls[0].body.tools.map((t: any) => t.function.name)).not.toContain('delete_page');
    const results = toolResults(calls.at(-1)!);
    expect(results.at(-1)).toContain('第 2 页是只读的');
    expect(job.review).toMatchObject({ before: { errors: 1 }, after: { errors: 0 }, edits: 1 });
    const doc = savedDoc(id);
    expect(doc.pages[0].html).toContain('left:120px');
    expect(doc.pages[0].html).toContain('整页新增段落');
    expect(doc.pages.slice(1)).toEqual(original.pages.slice(1));
  });

  it('remaining errors trigger one more pass, then the draft is saved anyway', async () => {
    const before = mock.reviewCalls.length;
    const r = await req('POST', '/api/projects', { type: 'template', name: '顽固', style: '简约', notes: 'BROKEN_ONLY' });
    const job = await waitJob(r.json.job.id);
    expect(job.status).toBe('done');
    const calls = mock.reviewCalls.slice(before);
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toContain('【自动复查】');
    expect(job.review).toMatchObject({ before: { errors: 1 }, after: { errors: 1 }, passes: 2, edits: 0 });
    expect(savedDoc(r.json.project.id).pages[1].html).toContain('OVERFLOW-TEXT');
  });

  it('an empty final review answer is accepted', async () => {
    const r = await req('POST', '/api/projects', { type: 'template', name: '空回复', style: '简约', notes: 'FIX_DRAFT EMPTY_FINAL' });
    const job = await waitJob(r.json.job.id);
    expect(job.status).toBe('done');
    expect(job.review.error).toBeUndefined();
    expect(job.review).toMatchObject({ after: { errors: 0 }, toolCalls: 6, edits: 1 });
    expect(job.review.summary).toBeUndefined();
  });

  it('can be switched off in the settings', async () => {
    expect((await req('PUT', '/api/settings', { selfCheck: false, selfCheckRounds: 50 })).json.settings).toMatchObject({ selfCheck: false, selfCheckRounds: 20 });
    const before = mock.reviewCalls.length;
    const r = await req('POST', '/api/projects', { type: 'template', name: '无自检', style: '简约', notes: 'FIX_DRAFT' });
    const job = await waitJob(r.json.job.id);
    expect(job.status).toBe('done');
    expect(mock.reviewCalls.length).toBe(before);
    expect(job.review).toBeNull();
    expect(savedDoc(r.json.project.id).pages[1].html).toContain('left:1800px');
    await req('PUT', '/api/settings', { selfCheck: true });
  });
});
