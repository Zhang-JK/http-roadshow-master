import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startMockLlm } from './mockLlm.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test-'));
process.env.DATA_DIR = tmp;

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockLlm>>;
let closeBrowser: () => Promise<void>;
let adminCookie = '';
let aliceCookie = '';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function cookieOf(res: { headers: Record<string, unknown> }) {
  const sc = res.headers['set-cookie'];
  const first = Array.isArray(sc) ? sc[0] : String(sc);
  return first.split(';')[0];
}

async function req(method: string, url: string, cookie: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, ...headers } });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* binary */
  }
  return { status: res.statusCode, json, res };
}

function multipart(fields: Record<string, string>, files: { name: string; filename: string; type: string; data: Buffer }[]) {
  const boundary = '----rs' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`),
      f.data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function waitJob(jobId: string, cookie = adminCookie) {
  for (let i = 0; i < 200; i++) {
    const { json } = await req('GET', `/api/jobs/${jobId}`, cookie);
    if (json.job.status === 'done' || json.job.status === 'error') return json.job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job timeout');
}

beforeAll(async () => {
  mock = await startMockLlm();
  const { openDb } = await import('../src/db.js');
  const { buildApp } = await import('../src/app.js');
  ({ closeBrowser } = await import('../src/render.js'));
  app = await buildApp(openDb(path.join(tmp, 'test.db')), { serveWeb: false });
});

afterAll(async () => {
  await app?.close();
  await closeBrowser?.();
  await mock?.close();
});

describe('auth & users', () => {
  it('rejects anonymous access and bad credentials', async () => {
    expect((await req('GET', '/api/projects', '')).status).toBe(401);
    expect((await req('POST', '/api/auth/login', '', { username: 'admin', password: 'nope' })).status).toBe(401);
  });

  it('default admin can log in', async () => {
    const r = await req('POST', '/api/auth/login', '', { username: 'admin', password: 'admin123' });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ username: 'admin', isAdmin: true });
    adminCookie = cookieOf(r.res);
    expect((await req('GET', '/api/auth/me', adminCookie)).json.user.username).toBe('admin');
  });

  it('only admin creates users; validation and duplicates', async () => {
    expect((await req('POST', '/api/users', adminCookie, { username: 'a b', password: '123456' })).status).toBe(400);
    expect((await req('POST', '/api/users', adminCookie, { username: 'alice', password: '123' })).status).toBe(400);
    const r = await req('POST', '/api/users', adminCookie, { username: 'alice', password: 'alice123', displayName: '爱丽丝' });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ username: 'alice', isAdmin: false, displayName: '爱丽丝' });
    expect((await req('POST', '/api/users', adminCookie, { username: 'alice', password: 'alice123' })).status).toBe(409);
    const login = await req('POST', '/api/auth/login', '', { username: 'alice', password: 'alice123' });
    aliceCookie = cookieOf(login.res);
    expect((await req('POST', '/api/users', aliceCookie, { username: 'bob', password: 'bob12345' })).status).toBe(403);
    expect((await req('GET', '/api/llm/endpoints', aliceCookie)).status).toBe(403);
    expect((await req('POST', '/api/llm/endpoints', aliceCookie, {})).status).toBe(403);
    expect((await req('PUT', '/api/settings', aliceCookie, { maxTokens: 5 })).status).toBe(403);
    expect((await req('GET', '/api/users', aliceCookie)).json.users).toHaveLength(2);
  });

  it('password change, admin reset (invalidates sessions) and delete', async () => {
    expect((await req('POST', '/api/auth/password', aliceCookie, { oldPassword: 'wrong', newPassword: 'abcdef' })).status).toBe(400);
    expect((await req('POST', '/api/auth/password', aliceCookie, { oldPassword: 'alice123', newPassword: 'alice456' })).status).toBe(200);
    expect((await req('POST', '/api/auth/login', '', { username: 'alice', password: 'alice456' })).status).toBe(200);
    const bob = await req('POST', '/api/users', adminCookie, { username: 'bob', password: 'bob12345' });
    const bobLogin = await req('POST', '/api/auth/login', '', { username: 'bob', password: 'bob12345' });
    const bobCookie = cookieOf(bobLogin.res);
    expect((await req('PATCH', `/api/users/${bob.json.user.id}`, adminCookie, { password: 'newbob123' })).status).toBe(200);
    expect((await req('GET', '/api/auth/me', bobCookie)).status).toBe(401);
    expect((await req('DELETE', `/api/users/1`, adminCookie)).status).toBe(400);
    expect((await req('DELETE', `/api/users/${bob.json.user.id}`, adminCookie)).status).toBe(200);
    expect((await req('POST', '/api/auth/login', '', { username: 'bob', password: 'newbob123' })).status).toBe(401);
  });
});

describe('LLM endpoints', () => {
  let goodId = 0;
  it('validates and stores endpoints with masked keys', async () => {
    expect((await req('POST', '/api/llm/endpoints', adminCookie, { name: 'x', baseUrl: 'ftp://x', model: 'm', apiKey: 'k' })).status).toBe(400);
    expect((await req('POST', '/api/llm/endpoints', adminCookie, { name: 'x', baseUrl: mock.url, model: 'm', apiKey: 'k', extraBody: '[1]' })).status).toBe(400);
    const r = await req('POST', '/api/llm/endpoints', adminCookie, { name: 'Mock A', baseUrl: mock.url, model: 'mock-vision', apiKey: 'good-key' });
    expect(r.status).toBe(200);
    expect(r.json.endpoint.apiKeyMasked).not.toContain('good-key');
    goodId = r.json.endpoint.id;
  });

  it('connectivity test checks multimodal support', async () => {
    const ok = await req('POST', `/api/llm/endpoints/${goodId}/test`, adminCookie);
    expect(ok.json.result).toMatchObject({ ok: true, textOk: true, visionOk: true });
    const list = await req('GET', '/api/llm/endpoints', adminCookie);
    expect(list.json.endpoints[0].lastTestOk).toBe(true);
    const textOnly = await req('POST', '/api/llm/test', adminCookie, { name: 't', baseUrl: mock.url, model: 'textonly', apiKey: 'good-key' });
    expect(textOnly.json.result).toMatchObject({ ok: false, textOk: true, visionOk: false });
    const badKey = await req('POST', '/api/llm/test', adminCookie, { name: 't', baseUrl: mock.url, model: 'm', apiKey: 'bad' });
    expect(badKey.json.result.ok).toBe(false);
    expect(badKey.json.result.message).toContain('401');
    // testing an existing endpoint's edited config without re-entering the key
    const reuse = await req('POST', '/api/llm/test', adminCookie, { id: goodId, name: 't', baseUrl: mock.url, model: 'mock-vision' });
    expect(reuse.json.result.ok).toBe(true);
  });

  it('per-user assignment, and failover when a user\'s endpoint is down', async () => {
    const broken = await req('POST', '/api/llm/endpoints', adminCookie, { name: 'Broken', baseUrl: mock.brokenUrl, model: 'mock-vision', apiKey: 'good-key', weight: 100 });
    const a = await req('GET', '/api/llm/assignments', adminCookie);
    expect(a.json.assignments.length).toBeGreaterThanOrEqual(2);
    expect(a.json.assignments.every((x: any) => x.endpointName)).toBe(true);
    // With weight 100 most users land on the broken endpoint; generation must still succeed via failover.
    const { chat } = await import('../src/llm.js');
    const { openDb } = await import('../src/db.js');
    const db = openDb(path.join(tmp, 'test.db'));
    const before = mock.calls.length;
    const r = await chat(db, 1, [{ role: 'user', content: 'hello 【模板名称】X' }]);
    expect(r.endpointId).toBe(goodId);
    expect(mock.calls.length).toBe(before + 1);
    expect(mock.calls.at(-1)!.user).toBe('rs-user-1');
    db.close();
    await req('PUT', `/api/llm/endpoints/${broken.json.endpoint.id}`, adminCookie, { enabled: false });
  });

  it('settings can be read and updated by admin', async () => {
    const r = await req('PUT', '/api/settings', adminCookie, { maxTokens: 20000, temperature: 0.5, attachScreenshots: true });
    expect(r.json.settings).toMatchObject({ maxTokens: 20000, temperature: 0.5, attachScreenshots: true });
  });
});

describe('templates, decks, edits, history and export', () => {
  let templateId = '';
  let deckId = '';
  let doc: any;

  it('validates creation input', async () => {
    expect((await req('POST', '/api/projects', adminCookie, { type: 'template', name: '' })).status).toBe(400);
    expect((await req('POST', '/api/projects', adminCookie, { type: 'template', name: 'x' })).status).toBe(400);
    expect((await req('POST', '/api/projects', adminCookie, { type: 'deck', name: 'x', content: 'c' })).status).toBe(400);
    expect((await req('POST', '/api/projects', adminCookie, { type: 'nope', name: 'x' })).status).toBe(400);
  });

  it('creates a template from a brief with a reference image', async () => {
    const mp = multipart(
      { type: 'template', name: '科技蓝模板', style: '深色科技', purpose: '融资路演', pageCount: '3' },
      [{ name: 'files', filename: 'logo.png', type: 'image/png', data: PNG_1x1 }],
    );
    const r = await req('POST', '/api/projects', aliceCookie, mp.payload, mp.headers);
    expect(r.status).toBe(200);
    expect(r.json.project.status).toBe('generating');
    templateId = r.json.project.id;
    const job = await waitJob(r.json.job.id);
    expect(job.status).toBe('done');
    const call = planCall();
    expect(call.stream).toBe(true);
    expect(call.text).toContain('深色科技');
    expect(call.text).toContain('1920×1080');
    expect(call.images[0]).toMatch(/^data:image\/png;base64,/);
    // The pages are written in a second call that works from the README and the styles.
    const pages = mock.calls.at(-1)!;
    expect(pages.text).toContain('【本批任务】');
    expect(pages.text).toContain('MOCK-README-NEED');
    expect(pages.text).toContain('<file path="styles/theme.css">');
    const p = await req('GET', `/api/projects/${templateId}`, adminCookie);
    expect(p.json.project).toMatchObject({ status: 'ready', versionNo: 1, pageCount: 3, width: 1920, height: 1080, createdBy: '爱丽丝' });
    expect(p.json.assets).toHaveLength(1);
    expect(p.json.project.doc.title).toBe('科技蓝模板');
    expect(p.json.project.doc.readme).toContain('## 页面规划');
    expect(p.json.project.doc.pages.map((x: any) => x.file)).toEqual(['pages/cover.html', 'pages/content-1.html', 'pages/content-2.html']);
  });

  const planCall = () => [...mock.calls].reverse().find((c) => c.text.includes('本次只输出 README.md 与样式文件'))!;

  it('supports other aspect ratios', async () => {
    const r = await req('POST', '/api/projects', adminCookie, { type: 'template', name: '竖版', style: '简约', aspect: '9:16' });
    await waitJob(r.json.job.id);
    const p = await req('GET', `/api/projects/${r.json.project.id}`, adminCookie);
    expect(p.json.project).toMatchObject({ width: 1080, height: 1920 });
    expect(mock.calls.at(-1)!.text).toContain('1080×1920 像素（竖向）');
  });

  it('creates a deck from a template plus supporting documents', async () => {
    const mp = multipart(
      { type: 'deck', name: 'A轮融资路演', templateId, content: '公司简介：我们做AI路演工具。ARR 1200万。', purpose: '融资' },
      [
        { name: 'files', filename: 'data.csv', type: 'text/csv', data: Buffer.from('年份,收入\n2024,500\n2025,1200\n') },
        { name: 'files', filename: 'product.png', type: 'image/png', data: PNG_1x1 },
      ],
    );
    const r = await req('POST', '/api/projects', adminCookie, mp.payload, mp.headers);
    expect(r.status).toBe(200);
    deckId = r.json.project.id;
    expect((await waitJob(r.json.job.id)).status).toBe('done');
    const call = planCall();
    expect(call.text).toContain('所选模板');
    expect(call.text).toContain('模板的样式文件已由系统复制到本项目');
    expect(call.text).toContain('2025,1200'); // csv text extracted
    expect(call.text).toMatch(/\/api\/assets\/[A-Za-z0-9_-]{21}/);
    const pages = mock.calls.at(-1)!;
    expect(pages.text).toContain('【模板版式页');
    expect(pages.text).toContain('第1页标题'); // template html is embedded
    expect(pages.text).toContain('公司简介：我们做AI路演工具');
    const p = await req('GET', `/api/projects/${deckId}`, adminCookie);
    expect(p.json.project.templateId).toBe(templateId);
    expect(p.json.template.name).toBe('科技蓝模板');
    doc = p.json.project.doc;
  });

  it('cannot delete a template that is in use', async () => {
    expect((await req('DELETE', `/api/projects/${templateId}`, adminCookie)).status).toBe(409);
  });

  it('lists projects by type with authorship', async () => {
    const t = await req('GET', '/api/projects?type=template', aliceCookie);
    expect(t.json.projects.map((p: any) => p.id)).toContain(templateId);
    const d = await req('GET', '/api/projects?type=deck', aliceCookie);
    expect(d.json.projects).toHaveLength(1);
    expect(d.json.projects[0].doc).toBeUndefined();
  });

  it('element edit sends page number, element info and an annotated screenshot', async () => {
    const page2 = doc.pages[1];
    const eid = page2.html.match(/<h1[^>]*data-eid="([^"]+)"/)[1];
    const r = await req('POST', `/api/projects/${deckId}/edit`, aliceCookie, {
      prompt: '标题改为 MARK',
      scope: 'element',
      pageId: page2.id,
      elementIds: [eid],
    });
    expect(r.status).toBe(200);
    const job = await waitJob(r.json.job.id);
    expect(job.status).toBe('done');
    const call = mock.calls.at(-1)!;
    expect(call.text).toContain('第 2 页');
    expect(call.text).toContain(`data-eid="${eid}"`);
    expect(call.text).toContain('第2页标题');
    expect(call.text).toContain('<h1>');
    expect(call.images.some((i) => i.startsWith('data:image/jpeg'))).toBe(true);
    const p = await req('GET', `/api/projects/${deckId}`, adminCookie);
    expect(p.json.project.versionNo).toBe(2);
    expect(p.json.project.doc.pages[1].html).toContain('已修改：MARK');
    expect(p.json.project.doc.css).toMatch(/\.added\s*\{\s*color:\s*red/);
    expect(p.json.project.doc.pages[0].html).toBe(doc.pages[0].html);
    const v = await req('GET', `/api/projects/${deckId}/versions`, adminCookie);
    const latest = v.json.versions[0];
    expect(latest).toMatchObject({ versionNo: 2, userName: '爱丽丝', scope: 'element', pageIndex: 1, elementIds: [eid], prompt: '标题改为 MARK' });
    expect(latest.summary.elementsChanged.map((e: any) => e.eid)).toEqual([eid]);
    expect(latest.summary.pagesChanged).toEqual([2]);
  });

  it('page edit and global edit', async () => {
    const pageId = doc.pages[2].id;
    const r1 = await req('POST', `/api/projects/${deckId}/edit`, adminCookie, { prompt: '加一段话', scope: 'page', pageId });
    expect((await waitJob(r1.json.job.id)).status).toBe('done');
    expect(mock.calls.at(-1)!.text).toContain('第 3 页整页');
    const r2 = await req('POST', `/api/projects/${deckId}/edit`, adminCookie, { prompt: '整体换成深色', scope: 'global' });
    expect((await waitJob(r2.json.job.id)).status).toBe('done');
    expect(mock.calls.at(-1)!.text).toContain('整份材料');
    const p = await req('GET', `/api/projects/${deckId}`, adminCookie);
    expect(p.json.project.doc.css).toContain('--brand:#111827');
    expect(p.json.project.doc.pages[2].html).toContain('整页新增段落');
    const v = await req('GET', `/api/projects/${deckId}/versions`, adminCookie);
    expect(v.json.versions[0]).toMatchObject({ scope: 'global', userName: '管理员' });
    expect(v.json.versions[0].summary.cssChanged).toBe(true);
    expect(v.json.versions[1].summary.elementsAdded.length).toBe(1);
    expect(v.json.versions[1].summary.elementsAdded[0]).toMatchObject({ page: 3, tag: 'p' });
  });

  it('rejects bad edit requests', async () => {
    expect((await req('POST', `/api/projects/${deckId}/edit`, adminCookie, { prompt: '', scope: 'global' })).status).toBe(400);
    expect((await req('POST', `/api/projects/${deckId}/edit`, adminCookie, { prompt: 'x', scope: 'page', pageId: 'nope' })).status).toBe(400);
  });

  it('edits go through the structured tools by default, with fallbacks and the rewrite mode', async () => {
    const c = await req('POST', '/api/projects', adminCookie, { type: 'template', name: '工具编辑', style: '简约' });
    expect((await waitJob(c.json.job.id)).status).toBe('done');
    const id = c.json.project.id;
    const doc0 = (await req('GET', `/api/projects/${id}`, adminCookie)).json.project.doc;
    const edit = async (body: Record<string, unknown>) => waitJob((await req('POST', `/api/projects/${id}/edit`, adminCookie, body)).json.job.id);

    const before = mock.calls.length;
    expect((await edit({ prompt: '加一段', scope: 'page', pageId: doc0.pages[0].id })).status).toBe('done');
    const [first, last] = mock.calls.slice(before);
    expect(mock.calls.length).toBe(before + 2);
    expect(first.text).toContain('【修改方式】');
    expect(first.text).not.toContain('只输出修改后的第');
    expect(first.body.tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(['edit_elements', 'edit_css', 'find_elements']));
    expect(last.body.messages.find((m: any) => m.role === 'tool').content).toContain('已修改 1 个元素（第 1 页（pages/cover.html））');
    let doc = (await req('GET', `/api/projects/${id}`, adminCookie)).json.project.doc;
    expect(doc.pages[0].html).toContain('整页新增段落');
    expect(doc.pages.slice(1)).toEqual(doc0.pages.slice(1));

    const none = await edit({ prompt: 'NO_CHANGE 随便看看', scope: 'global' });
    expect(none.status).toBe('error');
    expect(none.error).toContain('模型没有做任何修改：我认为不需要修改');

    expect((await edit({ prompt: 'FULL_REWRITE 重做', scope: 'global' })).status).toBe('done');
    doc = (await req('GET', `/api/projects/${id}`, adminCookie)).json.project.doc;
    expect(doc.pages[0].html).not.toContain('整页新增段落');

    await req('PUT', '/api/settings', adminCookie, { editMode: 'rewrite' });
    const b2 = mock.calls.length;
    expect((await edit({ prompt: '加一段', scope: 'page', pageId: doc.pages[1].id })).status).toBe('done');
    expect(mock.calls.length).toBe(b2 + 1);
    expect(mock.calls.at(-1)!.text).toContain('只输出修改后的第');
    expect(mock.calls.at(-1)!.body.tools).toBeUndefined();
    expect((await req('GET', `/api/projects/${id}`, adminCookie)).json.project.doc.pages[1].html).toContain('整页新增段落');
    expect((await req('PUT', '/api/settings', adminCookie, { editMode: 'tools', editToolRounds: 99 })).json.settings).toMatchObject({ editMode: 'tools', editToolRounds: 40 });
    expect((await req('DELETE', `/api/projects/${id}`, adminCookie)).status).toBe(200);
  });

  it('concurrent edits by two users on different pages are both applied', async () => {
    const p = await req('GET', `/api/projects/${deckId}`, adminCookie);
    const pages = p.json.project.doc.pages;
    const e1 = pages[0].html.match(/<p[^>]*data-eid="([^"]+)"/)[1];
    const e2 = pages[1].html.match(/<p[^>]*data-eid="([^"]+)"/)[1];
    const [a, b] = await Promise.all([
      req('POST', `/api/projects/${deckId}/edit`, adminCookie, { prompt: 'MARK one', scope: 'element', pageId: pages[0].id, elementIds: [e1] }),
      req('POST', `/api/projects/${deckId}/edit`, aliceCookie, { prompt: 'MARK two', scope: 'element', pageId: pages[1].id, elementIds: [e2] }),
    ]);
    const active = await req('GET', `/api/projects/${deckId}/jobs?active=1`, adminCookie);
    expect(active.json.jobs.length).toBeGreaterThanOrEqual(0);
    await Promise.all([waitJob(a.json.job.id), waitJob(b.json.job.id)]);
    const after = (await req('GET', `/api/projects/${deckId}`, adminCookie)).json.project.doc;
    expect(after.pages[0].html).toMatch(new RegExp(`data-eid="${e1}"[^>]*>已修改`));
    expect(after.pages[1].html).toMatch(new RegExp(`data-eid="${e2}"[^>]*>已修改`));
  });

  it('page duplicate / move / delete are recorded in history', async () => {
    let p = (await req('GET', `/api/projects/${deckId}`, adminCookie)).json.project;
    const n = p.pageCount;
    const first = p.doc.pages[0].id;
    expect((await req('POST', `/api/projects/${deckId}/pages/${first}/duplicate`, aliceCookie)).status).toBe(200);
    expect((await req('POST', `/api/projects/${deckId}/pages/${first}/move`, aliceCookie, { toIndex: 2 })).status).toBe(200);
    p = (await req('GET', `/api/projects/${deckId}`, adminCookie)).json.project;
    expect(p.pageCount).toBe(n + 1);
    expect(p.doc.pages[2].id).toBe(first);
    expect((await req('POST', `/api/projects/${deckId}/pages/${first}/delete`, aliceCookie)).status).toBe(200);
    p = (await req('GET', `/api/projects/${deckId}`, adminCookie)).json.project;
    expect(p.pageCount).toBe(n);
    const v = (await req('GET', `/api/projects/${deckId}/versions`, adminCookie)).json.versions;
    expect(v.slice(0, 3).map((x: any) => x.action)).toEqual(['page_delete', 'page_move', 'page_duplicate']);
    expect(v[0].summary.pagesRemoved).toEqual(['原第3页']);
  });

  it('can preview and revert to an older version', async () => {
    const v = (await req('GET', `/api/projects/${deckId}/versions`, adminCookie)).json.versions;
    const v1 = v.find((x: any) => x.versionNo === 1);
    const old = await req('GET', `/api/projects/${deckId}/versions/${v1.id}`, adminCookie);
    expect(old.json.doc.pages[1].html).not.toContain('已修改');
    const r = await req('POST', `/api/projects/${deckId}/versions/${v1.id}/revert`, aliceCookie);
    expect(r.status).toBe(200);
    const p = (await req('GET', `/api/projects/${deckId}`, adminCookie)).json.project;
    expect(p.doc).toEqual(old.json.doc);
    const latest = (await req('GET', `/api/projects/${deckId}/versions`, adminCookie)).json.versions[0];
    expect(latest).toMatchObject({ action: 'revert', prompt: '恢复到版本 v1' });
  });

  it('renames a project', async () => {
    const r = await req('PATCH', `/api/projects/${deckId}`, adminCookie, { name: 'A轮融资路演（终版）' });
    expect(r.json.project.name).toBe('A轮融资路演（终版）');
    const p = (await req('GET', `/api/projects/${deckId}`, adminCookie)).json.project;
    expect(p.doc.title).toBe('A轮融资路演（终版）');
  });

  it('serves page html for previews', async () => {
    const p = (await req('GET', `/api/projects/${deckId}`, adminCookie)).json.project;
    const r = await req('GET', `/api/projects/${deckId}/html?pageId=${p.doc.pages[1].id}`, adminCookie);
    expect(r.res.headers['content-type']).toContain('text/html');
    expect(r.res.body).toContain('第2页标题');
    expect(r.res.body).not.toContain('第1页标题');
  });

  it('exports HTML (self-contained, paged), PDF and PPTX', async () => {
    // put an asset reference into the doc to check inlining
    const assets = (await req('GET', `/api/projects/${deckId}`, adminCookie)).json.assets;
    const img = assets.find((a: any) => a.kind === 'image');
    const { openDb } = await import('../src/db.js');
    const db = openDb(path.join(tmp, 'test.db'));
    const row = db.prepare('SELECT doc FROM projects WHERE id = ?').get(deckId) as any;
    const d = JSON.parse(row.doc);
    d.pages[0].html = d.pages[0].html.replace('</section>', `<img src="${img.url}"></section>`);
    db.prepare('UPDATE projects SET doc = ? WHERE id = ?').run(JSON.stringify(d), deckId);
    db.close();

    const html = await req('GET', `/api/projects/${deckId}/export?format=html`, adminCookie);
    expect(html.status).toBe(200);
    expect(html.res.headers['content-disposition']).toContain("filename*=UTF-8''");
    const body = html.res.body;
    expect(body.match(/<section class="slide/g)).toHaveLength(d.pages.length);
    expect(body).toContain('@page{size:1920px 1080px');
    expect(body).toContain('data:image/png;base64,');
    expect(body).not.toContain('/api/assets/');

    const pdf = await req('GET', `/api/projects/${deckId}/export?format=pdf`, adminCookie);
    expect(pdf.status).toBe(200);
    const pdfBuf = pdf.res.rawPayload;
    expect(pdfBuf.subarray(0, 4).toString()).toBe('%PDF');
    const pageCount = (pdfBuf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageCount).toBe(d.pages.length);

    const imgPdf = await req('GET', `/api/projects/${deckId}/export?format=pdf-image`, adminCookie);
    expect(imgPdf.status).toBe(200);
    const imgPdfText = imgPdf.res.rawPayload.toString('latin1');
    expect(imgPdfText.startsWith('%PDF')).toBe(true);
    expect((imgPdfText.match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(d.pages.length);

    const pptx = await req('GET', `/api/projects/${deckId}/export?format=pptx`, adminCookie);
    expect(pptx.status).toBe(200);
    const pbuf = pptx.res.rawPayload;
    expect(pbuf.subarray(0, 2).toString()).toBe('PK');
    const slides = new Set(pbuf.toString('latin1').match(/ppt\/slides\/slide\d+\.xml/g));
    expect(slides.size).toBe(d.pages.length);

    const v1 = (await req('GET', `/api/projects/${deckId}/versions`, adminCookie)).json.versions.at(-1);
    const old = await req('GET', `/api/projects/${deckId}/export?format=html&version=${v1.id}`, adminCookie);
    expect(old.status).toBe(200);
    expect((await req('GET', `/api/projects/${deckId}/export?format=doc`, adminCookie)).status).toBe(400);
  }, 120_000);

  it('records usage per user and endpoint', async () => {
    const u = await req('GET', '/api/llm/usage', adminCookie);
    const names = u.json.usage.map((r: any) => r.username);
    expect(names).toContain('alice');
    expect(names).toContain('admin');
    expect(u.json.usage[0].cost).toBeGreaterThan(0);
  });

  it('reports an error job when no endpoints are configured, and the project can be regenerated', async () => {
    const eps = (await req('GET', '/api/llm/endpoints', adminCookie)).json.endpoints;
    for (const e of eps) await req('PUT', `/api/llm/endpoints/${e.id}`, adminCookie, { enabled: false });
    const r = await req('POST', '/api/projects', adminCookie, { type: 'template', name: 'fail', style: 's' });
    const job = await waitJob(r.json.job.id);
    expect(job.status).toBe('error');
    expect(job.error).toContain('接入点');
    const p = (await req('GET', `/api/projects/${r.json.project.id}`, adminCookie)).json.project;
    expect(p.status).toBe('error');
    for (const e of eps) if (e.name === 'Mock A') await req('PUT', `/api/llm/endpoints/${e.id}`, adminCookie, { enabled: true });
    const again = await req('POST', `/api/projects/${r.json.project.id}/regenerate`, adminCookie);
    expect((await waitJob(again.json.job.id)).status).toBe('done');
    expect((await req('POST', `/api/projects/${r.json.project.id}/regenerate`, adminCookie)).status).toBe(409);
    expect((await req('DELETE', `/api/projects/${r.json.project.id}`, adminCookie)).status).toBe(200);
  });
});
