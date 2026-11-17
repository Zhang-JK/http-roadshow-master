import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startMockLlm } from './mockLlm.js';
import type { DeckDoc } from '../src/deck.js';
import { cssFiles, joinCssFiles } from '../src/files.js';
import { Draft } from '../src/draft.js';
import { createParallelEditTools } from '../src/parallelEdit.js';
import type { ChatResult } from '../src/llm.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-par-edit-'));
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
const isGroup = (c: { text: string }) => c.text.includes('【并行子任务】');
const isEdit = (c: { text: string }) => c.text.includes('【修改方式】') && !isGroup(c);
const stages = (jobId: string) =>
  db.prepare(`SELECT stage, status FROM llm_calls WHERE job_id = ? AND stage LIKE '并行修改%' ORDER BY id`).all(jobId) as { stage: string; status: string }[];

/** A seven-page project, made once and edited by each test from its current version. */
let projectId = '';

async function edit(prompt: string, scope: 'global' | 'page' = 'global') {
  const before = { calls: mock.calls.length, reviews: mock.pageReviewCalls.length };
  const pageId = scope === 'page' ? savedDoc(projectId).pages[1].id : undefined;
  const r = await req('POST', `/api/projects/${projectId}/edit`, { prompt, scope, pageId });
  expect(r.status).toBe(200);
  const job = await waitJob(r.json.job.id);
  return { job, calls: mock.calls.slice(before.calls), reviews: mock.pageReviewCalls.slice(before.reviews) };
}

/** What the editing model was told the groups did (the tool result of its last round). */
const groupReport = (calls: { text: string; body: any }[]) =>
  calls
    .filter(isEdit)
    .flatMap((c) => c.body.messages)
    .filter((m: any) => m.role === 'tool' && String(m.content).startsWith('并行修改完成'))
    .at(-1)?.content as string | undefined;

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
  const r = await req('POST', '/api/projects', { type: 'template', name: '并行修改模板', style: '简约', notes: 'MANY_PAGES' });
  projectId = r.json.project.id;
  expect((await waitJob(r.json.job.id)).status).toBe('done');
  expect(savedDoc(projectId).pages).toHaveLength(7);
});

afterAll(async () => {
  await app.close();
  await mock.close();
  const { closeBrowser } = await import('../src/render.js');
  await closeBrowser();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('whole-deck edits split into parallel groups', () => {
  it('the editing model sends page groups to sub-agents that work at the same time; the result is checked and saved', async () => {
    const { job, calls, reviews } = await edit('PARALLEL 按新数据更新每一页');
    expect(job.status).toBe('done');
    const [first] = calls.filter(isEdit);
    expect(first.text).toContain('edit_pages_in_parallel');
    expect(first.body.tools.map((t: any) => t.function.name)).toContain('edit_pages_in_parallel');

    const groups = calls.filter(isGroup);
    expect(groups).toHaveLength(7);
    expect(mock.groupsAtOnce).toBe(4);
    const third = groups.find((c) => c.text.includes('GROUP-3 更新本页数据'))!;
    expect(third.text).toContain('你负责第 3 组，只修改本组页面');
    expect(third.text).toContain('【修改要求】\nPARALLEL 按新数据更新每一页');
    expect(third.text).toContain('<file path="pages/content-2.html">');
    expect(third.text).not.toContain('<file path="pages/content-3.html">');
    expect(third.text).toMatch(/3\. pages\/content-2\.html［本组］/);
    expect(third.text).toMatch(/1\. pages\/cover\.html［其他组同时修改］/);
    // The shared change the editing model made first is what every group builds on.
    expect(third.text).toContain('#0f766e');
    expect(third.body.tools ?? []).not.toContainEqual(expect.objectContaining({ function: expect.objectContaining({ name: 'write_file' }) }));

    // Each group looked at its own rendered page.
    expect(reviews.filter(isGroup)).toHaveLength(7);
    expect(reviews.find((c) => c.text.includes('GROUP-3'))!.images).toHaveLength(1);

    const doc = savedDoc(projectId);
    expect(doc.pages.map((p) => p.html.match(/GROUP-(\d)-EDITED/)?.[1])).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(doc.css).toContain('#0f766e');
    const report = groupReport(calls)!;
    expect(report).toContain('7 组中 7 组成功');
    expect(report).toContain('- 第 3 组（pages/content-2.html）：改写了 pages/content-2.html');
    expect(report).toMatch(/render_pages 或 check_project/);

    const rows = stages(job.id);
    expect(rows.filter((r) => r.status === 'ok' && !r.stage.includes('检查渲染效果'))).toHaveLength(7);
    expect(rows).toContainEqual({ stage: '并行修改：第 3 组（1 页）', status: 'ok' });
    expect(rows).toContainEqual({ stage: '并行修改：第 3 组（1 页）：检查渲染效果', status: 'ok' });
    const versions = (await req('GET', `/api/projects/${projectId}/versions`)).json.versions;
    expect(versions[0]).toMatchObject({ action: 'edit', scope: 'global', prompt: 'PARALLEL 按新数据更新每一页' });
  });

  it('a group that keeps failing leaves its page unchanged without holding up the others; a flaky one is tried again', async () => {
    const before = savedDoc(projectId).pages[1].html;
    const failed = await edit('PARALLEL_FAIL 再次更新每一页');
    expect(failed.job.status).toBe('done');
    const doc = savedDoc(projectId);
    expect(doc.pages[1].html).toBe(before);
    expect(doc.pages.filter((p) => (p.html.match(/-EDITED/g) ?? []).length === 2)).toHaveLength(6);
    const report = groupReport(failed.calls)!;
    expect(report).toContain('7 组中 6 组成功');
    expect(report).toMatch(/- 第 2 组（pages\/content-1\.html）：失败（已尝试 3 次）：.*这组页面保持原样/);
    expect(report).toContain('可以把失败的组再派一次');
    const rows = stages(failed.job.id).filter((r) => r.stage.startsWith('并行修改：第 2 组'));
    expect(rows.map((r) => r.status)).toEqual(['error', 'error', 'error']);

    const flaky = await edit('PARALLEL_FLAKY 第三次更新每一页');
    expect(flaky.job.status).toBe('done');
    expect(savedDoc(projectId).pages.every((p) => /GROUP-\d-EDITED/.test(p.html))).toBe(true);
    expect(groupReport(flaky.calls)).toContain('7 组中 7 组成功');
    expect(stages(flaky.job.id).filter((r) => r.stage.startsWith('并行修改：第 2 组') && !r.stage.includes('检查'))).toEqual([
      { stage: '并行修改：第 2 组（1 页）', status: 'error' },
      { stage: '并行修改：第 2 组（1 页）（第 2 次尝试）', status: 'ok' },
    ]);
  });

  it('a group may add pages after its own and style rules to the additions file', async () => {
    const { job } = await edit('PARALLEL PARALLEL_NEW_PAGE 补充一页');
    expect(job.status).toBe('done');
    const doc = savedDoc(projectId);
    expect(doc.pages).toHaveLength(8);
    expect(doc.pages[1]).toMatchObject({ file: 'pages/group-extra.html' });
    expect(doc.pages[1].html).toContain('GROUP-NEW-PAGE');
    expect(cssFiles(doc.css).find((f) => f.path === 'styles/additions.css')?.css).toContain('.group-note');
  });

  it('is offered only for whole-deck tool edits with more than one group at a time', async () => {
    const page = await edit('只改第 2 页', 'page');
    expect(page.calls.filter(isEdit)[0].body.tools.map((t: any) => t.function.name)).not.toContain('edit_pages_in_parallel');
    await req('PUT', '/api/settings', { genParallel: 1 });
    try {
      const single = await edit('整份调整一下');
      const prompt = single.calls.filter(isEdit)[0];
      expect(prompt.text).not.toContain('edit_pages_in_parallel');
      expect(prompt.body.tools.map((t: any) => t.function.name)).not.toContain('edit_pages_in_parallel');
    } finally {
      await req('PUT', '/api/settings', { genParallel: 4 });
    }
  });
});

describe('edit_pages_in_parallel', () => {
  const doc = (): DeckDoc => ({
    title: 't',
    width: 1920,
    height: 1080,
    head: '',
    css: joinCssFiles([{ path: 'styles/main.css', css: '.title{font-size:96px}' }]),
    readme: '# t\n',
    pages: ['a', 'b', 'c', 'd', 'e'].map((n) => ({ id: '', file: `pages/${n}.html`, html: `<section class="slide"><h1 class="title">${n}</h1></section>` })),
  });
  const reply = (text: string): ChatResult => ({ text, finishReason: 'stop', endpointId: 1 }) as ChatResult;
  const rewrite = (text: string, mark: string) =>
    [...text.matchAll(/<file path="(pages\/\w\.html)">\n([\s\S]*?)\n<\/file>/g)]
      .map(([, p, html]) => `<file path="${p}">\n${html.replace('</h1>', ` ${mark}</h1>`)}\n</file>`)
      .join('\n');

  it('checks the groups before starting any', async () => {
    const draft = Draft.ofDocument(doc());
    let called = 0;
    const tools = createParallelEditTools(draft, { request: 'x', kind: 'deck', assets: [] }, { call: async () => (called++, reply('')), parallel: 2 });
    const run = async (groups: unknown) => (await tools.execute('edit_pages_in_parallel', { groups })).content;
    expect(await run([])).toMatch(/至少要有一组/);
    expect(await run([{ pages: ['pages/a.html'], instructions: 'x' }, { pages: [1], instructions: 'y' }])).toMatch(/pages\/a\.html 同时在第 1 组和第 2 组中/);
    expect(await run([{ pages: ['pages/zz.html'], instructions: 'x' }])).toMatch(/没有页面 pages\/zz\.html（共 5 页/);
    expect(await run([{ pages: ['styles/main.css'], instructions: 'x' }])).toMatch(/不是页面文件/);
    expect(await run([{ pages: ['9'], instructions: 'x' }])).toMatch(/没有页面 9/);
    expect(await run([{ pages: ['pages/a.html'], instructions: ' ' }])).toMatch(/缺少 instructions/);
    expect(await run([{ pages: Array.from({ length: 7 }, (_, i) => String(i + 1)), instructions: 'x' }])).toMatch(/每组最多 6 页/);
    expect(called).toBe(0);
    expect(draft.edits).toBe(0);
  });

  it('runs at most `parallel` groups at once, keeps every group to its own pages and orders them as the deck', async () => {
    const draft = Draft.ofDocument(doc());
    let now = 0;
    let most = 0;
    const stagesSeen: string[] = [];
    const tools = createParallelEditTools(
      draft,
      { request: '统一改写', kind: 'deck', assets: [] },
      {
        call: async (messages, stage) => {
          stagesSeen.push(stage);
          most = Math.max(most, ++now);
          await new Promise((r) => setTimeout(r, 30));
          now--;
          const text = String(messages[1].content);
          // A group also writing a page that is not its own: ignored.
          return reply(`${rewrite(text, 'NEW')}\n<file path="pages/e.html">\n<section class="slide"><h1>HIJACK</h1></section>\n</file>`);
        },
        parallel: 2,
      },
    );
    const out = await tools.execute('edit_pages_in_parallel', {
      groups: [
        { pages: ['pages/c.html', 'pages/a.html'], instructions: '第一组' },
        { pages: ['2'], instructions: '第二组' },
        { pages: ['pages/d.html'], instructions: '第三组' },
      ],
    });
    expect(most).toBe(2);
    expect(stagesSeen.sort()).toEqual(['并行修改：第 1 组（2 页）', '并行修改：第 2 组（1 页）', '并行修改：第 3 组（1 页）']);
    expect(out.content).toContain('3 组中 3 组成功');
    expect(out.content).toContain('- 第 1 组（pages/a.html、pages/c.html）：改写了');
    expect(draft.view().pages.map((p) => p.html.match(/<h1[^>]*>([^<]*)</)![1])).toEqual(['a NEW', 'b NEW', 'c NEW', 'd NEW', 'e']);
  });

  it('shows each group its rendered pages and takes its corrections; a failed render keeps the pages as written', async () => {
    const draft = Draft.ofDocument(doc());
    const looked: string[][] = [];
    let reviewText = '';
    const tools = createParallelEditTools(
      draft,
      { request: 'x', kind: 'deck', assets: [] },
      {
        call: async (messages, _stage, step) => {
          if (step === 'review') {
            const last = messages.at(-1)!.content as any[];
            reviewText = last[0].text;
            return reply(rewrite(String(messages[1].content), 'FIXED').replace(/<file path="pages\/b\.html">[\s\S]*?<\/file>/, ''));
          }
          return reply(rewrite(String(messages[1].content), 'NEW'));
        },
        lookAt: async (d) => {
          looked.push(d.pages.map((p) => p.file!));
          return d.pages.map((p) => ({ image: 'data:image/jpeg;base64,AA==', issues: p.file === 'pages/a.html' ? [{ severity: 'error' as const, message: '文字超出页面边界' }] : [] }));
        },
        parallel: 2,
      },
    );
    const out = await tools.execute('edit_pages_in_parallel', { groups: [{ pages: ['1', '2'], instructions: 'x' }] });
    expect(looked[0]).toEqual(['pages/a.html', 'pages/b.html']);
    expect(reviewText).toContain('【页面自检】');
    expect(reviewText).toContain('文字超出页面边界');
    expect(out.content).toContain('看过渲染截图后又修正了');
    expect(draft.view().pages[0].html).toContain('a FIXED');

    const broken = Draft.ofDocument(doc());
    const kept = createParallelEditTools(
      broken,
      { request: 'x', kind: 'deck', assets: [] },
      {
        call: async (messages) => reply(rewrite(String(messages[1].content), 'NEW')),
        lookAt: async () => {
          throw new Error('chrome went away');
        },
        parallel: 2,
      },
    );
    expect((await kept.execute('edit_pages_in_parallel', { groups: [{ pages: ['1'], instructions: 'x' }] })).content).toContain('1 组中 1 组成功');
    expect(broken.view().pages[0].html).toContain('a NEW');
  });
});
