import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startMockLlm } from './mockLlm.js';
import type { DeckDoc } from '../src/deck.js';
import { cssFiles } from '../src/files.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-files-'));
process.env.DATA_DIR = tmp;

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockLlm>>;
let cookie = '';
let db: import('../src/db.js').DB;

async function req(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, ...headers } });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* binary */
  }
  return { status: res.statusCode, json, raw: res.rawPayload, headers: res.headers };
}

async function waitJob(id: string) {
  for (let i = 0; i < 300; i++) {
    const { json } = await req('GET', `/api/jobs/${id}`);
    if (json.job.status === 'done' || json.job.status === 'error') return json.job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job timeout');
}

async function create(body: Record<string, unknown>) {
  const before = mock.calls.length;
  const r = await req('POST', '/api/projects', { type: 'template', style: '简约', ...body });
  const job = await waitJob(r.json.job.id);
  return { id: r.json.project.id as string, job, calls: mock.calls.slice(before) };
}

const savedDoc = (id: string) => JSON.parse((db.prepare('SELECT doc FROM projects WHERE id = ?').get(id) as { doc: string }).doc) as DeckDoc;
const isPlan = (c: { text: string }) => c.text.includes('本次只输出 README.md 与样式文件');
const isPages = (c: { text: string }) => c.text.includes('【本批任务】');

beforeAll(async () => {
  mock = await startMockLlm();
  const { openDb } = await import('../src/db.js');
  const { buildApp } = await import('../src/app.js');
  db = openDb(path.join(tmp, 'test.db'));
  app = await buildApp(db, { serveWeb: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } });
  cookie = String(login.headers['set-cookie']).split(';')[0];
  await req('POST', '/api/llm/endpoints', { name: 'mock', baseUrl: mock.url, apiKey: 'good-key', model: 'mock-vision' });
  await req('PUT', '/api/settings', { selfCheck: false });
});

afterAll(async () => {
  await app.close();
  await mock.close();
  const { closeBrowser } = await import('../src/render.js');
  await closeBrowser();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('settings for long outputs and small contexts', () => {
  it('defaults to staged generation with a 65536-token output limit inside a 200K context', async () => {
    const s = (await req('GET', '/api/settings')).json.settings;
    expect(s).toMatchObject({ maxTokens: 65536, contextTokens: 200000, generateMode: 'files', genPagesPerCall: 3 });
    const r = (await req('PUT', '/api/settings', { contextTokens: 10, genPagesPerCall: 99, generateMode: 'weird', maxTokens: 'x' })).json.settings;
    expect(r).toMatchObject({ contextTokens: 8000, genPagesPerCall: 10, generateMode: 'files', maxTokens: 65536 });
    await req('PUT', '/api/settings', { contextTokens: 200000, genPagesPerCall: 3 });
  });

  it('moves a saved copy of the old 32000 default to the new default', async () => {
    const { openDb, setSettings } = await import('../src/db.js');
    const file = path.join(tmp, 'migrate.db');
    const old = openDb(file);
    setSettings(old, { maxTokens: 32000 });
    const n = (old.prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number }).v;
    old.prepare('DELETE FROM _migrations WHERE version = ?').run(n);
    old.close();
    const again = openDb(file);
    expect(JSON.parse((again.prepare(`SELECT value FROM settings WHERE key = 'maxTokens'`).get() as { value: string }).value)).toBe(65536);
    again.close();
  });
});

describe('staged multi-file generation', () => {
  let projectId = '';

  it('writes README and styles first, then pages in batches; every request fits the context', async () => {
    const { id, job, calls } = await create({ name: '分步模板', notes: 'MANY_PAGES' });
    projectId = id;
    expect(job.status).toBe('done');
    expect(calls.map((c) => (isPlan(c) ? 'plan' : isPages(c) ? 'pages' : 'other'))).toEqual(['plan', 'pages', 'pages', 'pages']);
    expect(calls[1].text).toContain('第 1–3 页');
    expect(calls[3].text).toContain('本批是第 7 页');
    expect(calls[2].text).toContain('【风格参照：已完成的 pages/content-2.html】');
    for (const c of calls) expect(c.body.max_tokens).toBe(65536);
    const doc = savedDoc(id);
    expect(doc.pages).toHaveLength(7);
    expect(doc.pages.map((p) => p.file)).toEqual(['pages/cover.html', ...[1, 2, 3, 4, 5, 6].map((i) => `pages/content-${i}.html`)]);
    expect(doc.readme).toContain('MOCK-README-NEED');
    expect(cssFiles(doc.css).map((f) => f.path)).toEqual(['styles/theme.css', 'styles/components.css']);
    const v = (await req('GET', `/api/projects/${id}/versions`)).json.versions[0];
    expect(v.summary.pagesAdded).toHaveLength(7);
  });

  it('recovers from a plan and a page batch cut off by the output limit', async () => {
    const { id, job, calls } = await create({ name: '截断模板', notes: 'TRUNCATE_PLAN TRUNCATE_PAGES' });
    expect(job.status).toBe('done');
    expect(calls.filter(isPlan)).toHaveLength(2);
    expect(calls[1].body.messages.at(-1).content).toContain('回复达到最大输出长度被截断');
    // One page fit into the cut-off reply, so the rest is asked for one page at a time.
    const pages = calls.filter(isPages);
    expect(pages.map((c) => c.text.match(/本批是第 ([\d–]+) 页/)![1])).toEqual(['1–3', '2', '3']);
    expect(savedDoc(id).pages.map((p) => p.html.match(/第(\d)页标题/)![1])).toEqual(['1', '2', '3']);
  });

  it('single-shot mode continues a cut-off reply and still writes a README', async () => {
    await req('PUT', '/api/settings', { generateMode: 'single' });
    try {
      const { id, job, calls } = await create({ name: '单次模板', notes: 'TRUNCATE_SINGLE' });
      expect(job.status).toBe('done');
      expect(calls).toHaveLength(2);
      expect(calls[1].body.messages.at(-1).content).toContain('请从中断处继续输出');
      const doc = savedDoc(id);
      expect(doc.pages).toHaveLength(3);
      expect(doc.readme).toContain('# 单次模板');
      expect(doc.readme).toContain('TRUNCATE_SINGLE');
    } finally {
      await req('PUT', '/api/settings', { generateMode: 'files' });
    }
  });

  it('lists the files with their content', async () => {
    const r = await req('GET', `/api/projects/${projectId}/files`);
    expect(r.json.generatedReadme).toBe(false);
    expect(r.json.files.map((f: any) => f.path).slice(0, 4)).toEqual(['README.md', 'styles/theme.css', 'styles/components.css', 'pages/cover.html']);
    const cover = r.json.files.find((f: any) => f.path === 'pages/cover.html');
    expect(cover).toMatchObject({ kind: 'page', page: 1, pageId: savedDoc(projectId).pages[0].id });
    expect(cover.content).toContain('第1页标题');
    expect(r.json.files[1].content).toBe(':root{--brand:#1e40af}');
  });

  it('edits read the README, update it with an edit log, and report changed style files', async () => {
    const before = mock.calls.length;
    const e = await req('POST', `/api/projects/${projectId}/edit`, { prompt: '主色改深', scope: 'global' });
    expect((await waitJob(e.json.job.id)).status).toBe('done');
    const first = mock.calls[before];
    expect(first.text).toContain('【README.md —— 项目的生成说明');
    expect(first.text).toContain('MOCK-README-NEED');
    expect(first.text).toContain('【项目文件列表】');
    expect(first.text).toContain('pages/content-3.html — 第 4 页');
    expect(first.body.tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(['write_file', 'delete_file']));
    const doc = savedDoc(projectId);
    expect(cssFiles(doc.css)[0].css).toContain('--brand:#111827');
    expect(doc.readme).toMatch(/## 修改记录\n- v2 管理员：整份材料 — 主色改深/);
    const v = (await req('GET', `/api/projects/${projectId}/versions`)).json.versions[0];
    expect(v.summary.stylesChanged).toEqual(['styles/theme.css']);
    expect(v.summary.readmeChanged).toBe(false);

    const pageId = doc.pages[2].id;
    const before2 = mock.calls.length;
    const p = await req('POST', `/api/projects/${projectId}/edit`, { prompt: '加一段', scope: 'page', pageId });
    expect((await waitJob(p.json.job.id)).status).toBe('done');
    expect(mock.calls[before2].text).toContain('【第 3 页当前 HTML（pages/content-2.html）】');
    expect(mock.calls[before2].text).toContain('MOCK-README-NEED');
    expect(savedDoc(projectId).readme).toMatch(/- v3 管理员：第 3 页 — 加一段/);
  });

  it('rewrite mode outputs only the changed files', async () => {
    await req('PUT', '/api/settings', { editMode: 'rewrite' });
    try {
      const doc = savedDoc(projectId);
      db.prepare('UPDATE projects SET doc = ? WHERE id = ?').run(JSON.stringify({ ...doc, css: doc.css.replace('--brand:#111827', '--brand:#1e40af') }), projectId);
      const before = mock.calls.length;
      const e = await req('POST', `/api/projects/${projectId}/edit`, { prompt: '换回深色', scope: 'global' });
      expect((await waitJob(e.json.job.id))).toMatchObject({ status: 'done', error: null });
      const call = mock.calls[before];
      expect(call.text).toContain('只输出需要修改或新增的文件');
      expect(call.text).toContain('<file path="pages/cover.html">');
      expect(call.body.messages[0].content).toContain('每个文件用 <file path="路径">');
      const next = savedDoc(projectId);
      expect(cssFiles(next.css)[0].css).toBe(':root{--brand:#111827}');
      expect(next.pages.map((p) => p.html)).toEqual(doc.pages.map((p) => p.html));
    } finally {
      await req('PUT', '/api/settings', { editMode: 'tools' });
    }
  });

  it('the README can be edited by hand as a new version', async () => {
    expect((await req('PUT', `/api/projects/${projectId}/readme`, { readme: '  ' })).status).toBe(400);
    const r = await req('PUT', `/api/projects/${projectId}/readme`, { readme: '# 分步模板\n\n## 风格约定\n- 主色改为墨绿 HAND-EDIT' });
    expect(r.status).toBe(200);
    const v = (await req('GET', `/api/projects/${projectId}/versions`)).json.versions[0];
    expect(v).toMatchObject({ action: 'readme', prompt: '编辑 README（生成说明）' });
    expect(v.summary.readmeChanged).toBe(true);
    expect(v.summary.pagesChanged).toEqual([]);
    const before = mock.calls.length;
    const e = await req('POST', `/api/projects/${projectId}/edit`, { prompt: '按 README 调整', scope: 'global' });
    await waitJob(e.json.job.id);
    expect(mock.calls[before].text).toContain('HAND-EDIT');
  });

  it('exports the source files as a ZIP with linked styles and local assets', async () => {
    const up = await (async () => {
      const boundary = '----rszip';
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`),
        PNG_1x1,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return req('POST', `/api/projects/${projectId}/assets`, payload, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    })();
    const asset = up.json.assets[0];
    const doc = savedDoc(projectId);
    doc.pages[1].html = doc.pages[1].html.replace('</section>', `<img src="${asset.url}"></section>`);
    doc.css += `\n.bg{background:url(${asset.url})}`;
    db.prepare('UPDATE projects SET doc = ? WHERE id = ?').run(JSON.stringify(doc), projectId);

    const r = await req('GET', `/api/projects/${projectId}/export?format=zip`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    const zip = await JSZip.loadAsync(r.raw);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    expect(names).toEqual(
      [
        'README.md',
        `assets/${asset.id}.png`,
        'index.html',
        'pages/cover.html',
        ...[1, 2, 3, 4, 5, 6].map((i) => `pages/content-${i}.html`),
        'styles/components.css',
        'styles/theme.css',
      ].sort(),
    );
    expect(await zip.file('README.md')!.async('string')).toContain('HAND-EDIT');
    const index = await zip.file('index.html')!.async('string');
    expect(index).toContain('<link rel="stylesheet" href="styles/theme.css">');
    expect(index).toContain(`src="assets/${asset.id}.png"`);
    expect(index.match(/<section/g)).toHaveLength(7);
    const page = await zip.file('pages/content-1.html')!.async('string');
    expect(page).toContain('<link rel="stylesheet" href="../styles/components.css">');
    expect(page).toContain(`src="../assets/${asset.id}.png"`);
    expect(page.match(/<section/g)).toHaveLength(1);
    expect(await zip.file('styles/components.css')!.async('string')).toContain(`url(../assets/${asset.id}.png)`);
  });

  it('projects made before READMEs get one from their brief', async () => {
    const { id } = await create({ name: '旧项目', purpose: '老板汇报 OLD-BRIEF' });
    const doc = savedDoc(id);
    delete doc.readme;
    for (const p of doc.pages) delete p.file;
    doc.css = cssFiles(doc.css).map((f) => f.css).join('\n');
    db.prepare('UPDATE projects SET doc = ? WHERE id = ?').run(JSON.stringify(doc), id);
    const files = (await req('GET', `/api/projects/${id}/files`)).json;
    expect(files.generatedReadme).toBe(true);
    expect(files.files[0].content).toContain('老板汇报 OLD-BRIEF');
    expect(files.files.map((f: any) => f.path)).toEqual(['README.md', 'styles/main.css', 'pages/cover.html', 'pages/content.html', 'pages/content-2.html']);
    const before = mock.calls.length;
    const e = await req('POST', `/api/projects/${id}/edit`, { prompt: '改标题', scope: 'global' });
    expect((await waitJob(e.json.job.id)).status).toBe('done');
    expect(mock.calls[before].text).toContain('老板汇报 OLD-BRIEF');
    const saved = savedDoc(id);
    expect(saved.readme).toContain('老板汇报 OLD-BRIEF');
    expect(saved.readme).toContain('## 修改记录');
    expect(saved.pages.map((p) => p.file)).toEqual(['pages/cover.html', 'pages/content.html', 'pages/content-2.html']);
  });
});
