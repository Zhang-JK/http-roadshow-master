import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LEAKED, startMockLlm } from './mockLlm.js';
import { assignIds, type DeckDoc } from '../src/deck.js';
import { createDraftTools, Draft } from '../src/draft.js';
import { joinCssFiles } from '../src/files.js';
import { checkProject } from '../src/projectCheck.js';
import { asksForAll, createAskTools } from '../src/questions.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ask-'));
process.env.DATA_DIR = tmp;

const deck = (): DeckDoc =>
  assignIds({
    title: 'T',
    width: 1920,
    height: 1080,
    head: '',
    css: joinCssFiles([{ path: 'styles/theme.css', css: '.title{color:#1e40af}' }]),
    readme: '# T\n\n## 需求\n- x\n\n## 风格约定\n- y\n\n## 页面规划\n1. pages/a.html ｜ cover ｜ A ｜ -\n2. pages/b.html ｜ content ｜ B ｜ -\n3. pages/c.html ｜ end ｜ C ｜ -\n',
    pages: ['a', 'b', 'c'].map((n) => ({ id: '', file: `pages/${n}.html`, html: `<section class="slide"><h1 class="title">ACME ${n}</h1><p>正文 ${n}</p></section>` })),
  });

describe('widening a page edit (extend_scope)', () => {
  const setup = (prompt: string, answer?: { text: string | null; choice?: number }) => {
    const doc = deck();
    const draft = Draft.ofPage(doc, doc.pages[1].id);
    const asked: string[] = [];
    const ask = createAskTools({
      draft,
      prompt,
      timeoutMinutes: 1,
      ask: answer
        ? async (q) => {
            asked.push(q.text);
            return answer;
          }
        : undefined,
    })!;
    const tools = createDraftTools(draft, async () => null);
    const run = async (name: string, args: Record<string, unknown> = {}) =>
      (ask.defs.some((d) => d.function.name === name) ? ask : tools).execute(name, args).then((r) => r.content);
    return { doc, draft, run, asked };
  };

  it('other pages and shared styles stay read-only until the user agrees', async () => {
    const { doc, draft, run, asked } = setup('把 ACME 改成 Nova', { text: '全部修改', choice: 0 });
    expect(await run('edit_elements', { path: 'pages/a.html', selector: 'h1', text: 'Nova a' })).toMatch(/只读/);
    expect(await run('edit_css', { selector: '.title', set: { color: 'red' } })).toMatch(/共享样式/);
    expect(await run('extend_scope', { pages: [1, 3], summary: '第 1、3 页也有 ACME' })).toMatch(/^用户同意一起修改。已开放第 1、3 页/);
    expect(asked).toEqual(['第 1、3 页也有 ACME。要把第 1、3 页的同类内容一起修改吗？']);
    expect(draft.editablePages()).toEqual([1, 2, 3]);
    expect(await run('replace_in_draft', { old_text: 'ACME', new_text: 'Nova', all_pages: true })).toMatch(/第 1 页.*第 2 页.*第 3 页/s);
    expect(await run('edit_css', { selector: '.title', set: { color: 'red' } })).toContain('styles/theme.css');
    expect(await run('delete_file', { path: 'pages/a.html' })).toMatch(/不是本次选中的页面，不能删除/);
    expect(await run('rewrite_page', { page: 3, html: '<section class="slide"><h1>x</h1></section><section class="slide"><h1>y</h1></section>' })).toMatch(/不能拆分/);
    expect(draft.extendedChanges()).toEqual({ pages: [1, 3], css: true });

    // Applied onto the latest document: the target page, the opened pages by id, and the shared styles.
    const latest = { ...doc, pages: [...doc.pages, { id: 'pnew', html: '<section class="slide" data-page-id="pnew"><h1>new</h1></section>' }] };
    const out = draft.result(latest);
    expect(out.pages.map((p) => p.html.match(/<h1[^>]*>([^<]*)/)?.[1])).toEqual(['Nova a', 'Nova b', 'Nova c', 'new']);
    expect(out.css).toMatch(/\.title\s*\{\s*color:\s*red/);
    expect(doc.pages[0].html).toContain('ACME a'); // the snapshot itself is untouched
  });

  it('a declined or skipped question keeps the edit local', async () => {
    for (const answer of [{ text: '只改选中的', choice: 1 }, { text: null }]) {
      const { draft, run } = setup('把 ACME 改成 Nova', answer);
      expect(await run('extend_scope', { summary: '其他页面也有 ACME' })).toMatch(/未开放其他页面/);
      expect(draft.editablePages()).toEqual([2]);
      expect(draft.canEdit('styles/theme.css')).toBe(false);
    }
  });

  it('an explicit "all" in the request opens the pages without asking; with asking off it does not', async () => {
    const explicit = setup('把所有页面的 ACME 统一改成 Nova', { text: '只改选中的', choice: 1 });
    expect(await explicit.run('extend_scope', { summary: '其他页面也有 ACME' })).toMatch(/用户的修改要求已明确包含所有同类内容。已开放全部页面/);
    expect(explicit.asked).toEqual([]);
    expect(explicit.draft.editablePages()).toEqual([1, 2, 3]);

    const off = setup('把 ACME 改成 Nova');
    expect(await off.run('extend_scope', { summary: '其他页面也有 ACME' })).toMatch(/提问功能已关闭/);
    expect(off.draft.editablePages()).toEqual([2]);
  });

  it('recognises requests that already ask for every occurrence', () => {
    for (const p of ['全部改成蓝色', '所有标题加粗', '每页的 logo 都换掉', '统一字号', 'change it everywhere', 'make all titles red']) expect(asksForAll(p)).toBe(true);
    for (const p of ['标题改成蓝色', '把这个 logo 换成红色', 'make it smaller']) expect(asksForAll(p)).toBe(false);
  });

  it('ask_user stops after three questions', async () => {
    const tools = createAskTools({ timeoutMinutes: 1, ask: async () => ({ text: '好' }) })!;
    expect(tools.defs.map((d) => d.function.name)).toEqual(['ask_user']);
    for (let i = 0; i < 3; i++) expect((await tools.execute('ask_user', { question: `Q${i}` })).content).toBe('用户回答：「好」');
    expect((await tools.execute('ask_user', { question: 'Q4' })).content).toMatch(/提问上限/);
    expect(createAskTools({ timeoutMinutes: 1 })).toBeUndefined();
  });
});

describe('template delivery check', () => {
  const tpl = (body: string): DeckDoc => ({ ...deck(), pages: [{ id: 'p1', file: 'pages/a.html', html: `<section class="slide">${body}</section>` }], readme: deck().readme!.replace(/\n2\.[\s\S]*$/, '\n') });
  const errors = async (doc: DeckDoc, refs: string[], allowed = '') =>
    (await checkProject(undefined, { doc, sources: [], canEdit: () => true, strictReadme: true, template: { referenceTexts: refs, allowed } })).filter((i) => i.severity === 'error');
  const PARTS =
    '<svg><rect/><rect/><rect/></svg><svg><polyline/><circle/><circle/></svg><table><tr><td>XX%</td></tr></table><div class="timeline">阶段一</div>';

  it('flags content copied from the reference files, but not placeholders or the brief', async () => {
    const ref = `${LEAKED}，同比增长 37%。Our platform delivers secure quantum analytics for banks.`;
    const leak = await errors(tpl(`<h1>${LEAKED}</h1><p>Our platform delivers secure quantum analytics</p><p>增长 37%</p>${PARTS}`), [ref]);
    expect(leak).toHaveLength(1);
    expect(leak[0].file).toBe('pages/a.html');
    expect(leak[0].message).toContain(`「${LEAKED}」`);
    expect(leak[0].message).toContain('请把这些内容换成占位符');
    expect(await errors(tpl(`<h1>「公司名称」YYYY 年营收 X,XXX 万元</h1><p>增长 XX%</p><text>100</text>${PARTS}`), [ref])).toEqual([]);
    expect(await errors(tpl(`<h1>ACME 量子科技有限公司</h1>${PARTS}`), [ref], '品牌：ACME 量子科技有限公司')).toEqual([]);
  });

  it('requires charts, a table and a flow or timeline in a generated template', async () => {
    const missing = await errors(tpl('<h1>演示标题</h1><svg><path/></svg>'), []);
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toMatch(/模板缺少通用组件：图表（至少 2 个内联 SVG 图表.*现有 0 个）；表格.*；流程图或时间线/);
    expect(await errors(tpl(`<h1>演示标题</h1>${PARTS}`), [])).toEqual([]);
  });
});

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockLlm>>;
let cookie = '';
let db: import('../src/db.js').DB;

async function req(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, ...headers } });
  return { status: res.statusCode, json: res.json() };
}

async function waitJob(id: string, until: (job: any) => boolean = (j) => j.status === 'done' || j.status === 'error') {
  for (let i = 0; i < 300; i++) {
    const { json } = await req('GET', `/api/jobs/${id}`);
    if (until(json.job)) return json.job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job timeout');
}

const savedDoc = (id: string) => JSON.parse((db.prepare('SELECT doc FROM projects WHERE id = ?').get(id) as { doc: string }).doc) as DeckDoc;
const h1s = (doc: DeckDoc) => doc.pages.map((p) => p.html.match(/<h1[^>]*>([^<]*)/)?.[1]);

describe('questions in jobs', () => {
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
    const r = await req('POST', '/api/projects', { type: 'template', name: '提问', style: '简约', notes });
    return { id: r.json.project.id as string, jobId: r.json.job.id as string };
  };

  it('generation pauses on a question and continues with the answer', async () => {
    const { id, jobId } = await create('ASK_ME');
    const waiting = await waitJob(jobId, (j) => !!j.question || j.status !== 'running');
    expect(waiting.question).toMatchObject({ kind: 'ask', text: 'MOCK-QUESTION 面向谁？', options: ['投资人', '客户'] });
    expect(waiting.progress.stage).toBe('等待用户回答问题');
    expect((await req('GET', '/api/projects?type=template')).json.projects.find((p: any) => p.id === id).asking).toBe(true);
    expect((await req('POST', `/api/jobs/${jobId}/answer`, { questionId: 'stale', choice: 0 })).status).toBe(409);
    expect((await req('POST', `/api/jobs/${jobId}/answer`, { questionId: waiting.question.id, choice: 0 })).status).toBe(200);
    const job = await waitJob(jobId);
    expect(job.status).toBe('done');
    expect(job.question).toBeNull();
    expect(job.questions).toEqual([expect.objectContaining({ kind: 'ask', question: 'MOCK-QUESTION 面向谁？', answer: '投资人' })]);
    expect(savedDoc(id).readme).toContain('ASK-RESULT 用户回答：「投资人」');
    expect((await req('POST', `/api/jobs/${jobId}/answer`, { questionId: waiting.question.id, choice: 1 })).status).toBe(409);
    // Only the plan step may ask; page batches do not get the tool.
    const pageCall = [...mock.calls].reverse().find((c) => c.text.includes('【本批任务】') && c.text.includes('ASK_ME'))!;
    expect(pageCall.body.tools).toBeUndefined();
  });

  it('lists my own jobs for notifications: running ones with their question, then those finished since the last poll', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/jobs/mine' })).statusCode).toBe(401);
    await req('POST', '/api/users', { username: 'carol', password: 'carol123' });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'carol', password: 'carol123' } });
    const carol = String(login.headers['set-cookie']).split(';')[0];
    const mine = async (query = '', as = cookie) => (await app.inject({ method: 'GET', url: `/api/jobs/mine${query}`, headers: { cookie: as } })).json();

    const start = await mine();
    expect(start).toMatchObject({ now: expect.any(Number), active: [], finished: [] });
    const { id, jobId } = await create('ASK_ME');
    const q = (await waitJob(jobId, (j) => !!j.question)).question;
    const running = await mine(`?since=${start.now}`);
    expect(running.active).toEqual([
      expect.objectContaining({
        id: jobId,
        projectId: id,
        projectName: '提问',
        projectType: 'template',
        kind: 'create',
        question: expect.objectContaining({ id: q.id, text: 'MOCK-QUESTION 面向谁？' }),
      }),
    ]);
    expect(running.finished).toEqual([]);
    expect(await mine(`?since=${start.now}`, carol)).toMatchObject({ active: [], finished: [] });

    await req('POST', `/api/jobs/${jobId}/answer`, { questionId: q.id, choice: 0 });
    await waitJob(jobId);
    const after = await mine(`?since=${running.now}`);
    expect(after.active).toEqual([]);
    expect(after.finished).toEqual([expect.objectContaining({ id: jobId, status: 'done', projectName: '提问', question: null })]);
    expect(after.finished[0].finishedAt).toBeGreaterThanOrEqual(running.now);
    // Later polls leave it out, unless the caller still has it as running.
    expect((await mine(`?since=${after.now}`)).finished).toEqual([]);
    expect((await mine(`?since=${after.now}&ids=${jobId}`)).finished.map((j: { id: string }) => j.id)).toEqual([jobId]);
    expect((await mine(`?since=${start.now}&ids=${jobId}`, carol)).finished).toEqual([]);
  });

  it('a skipped or unanswered question lets the model go on with its own judgement', async () => {
    const a = await create('ASK_ME');
    const q = (await waitJob(a.jobId, (j) => !!j.question)).question;
    await req('POST', `/api/jobs/${a.jobId}/answer`, { questionId: q.id, answer: null });
    expect((await waitJob(a.jobId)).status).toBe('done');
    expect(savedDoc(a.id).readme).toContain('ASK-RESULT 用户跳过了这个问题');

    const { setSettings } = await import('../src/db.js');
    setSettings(db, { askTimeoutMinutes: 0.01 });
    const b = await create('ASK_ME');
    const job = await waitJob(b.jobId);
    setSettings(db, { askTimeoutMinutes: 30 });
    expect(job.status).toBe('done');
    expect(job.questions).toEqual([expect.objectContaining({ answer: null, timedOut: true })]);
    expect(savedDoc(b.id).readme).toMatch(/ASK-RESULT 用户在 [\d.]+ 分钟内没有回答/);
  });

  it('with asking switched off the model gets no question tool', async () => {
    expect((await req('PUT', '/api/settings', { askUser: false, askTimeoutMinutes: 0 })).json.settings).toMatchObject({ askUser: false, askTimeoutMinutes: 30 });
    const before = mock.calls.length;
    const { jobId } = await create('ASK_ME');
    const job = await waitJob(jobId);
    await req('PUT', '/api/settings', { askUser: true });
    expect(job.status).toBe('done');
    expect(job.questions).toEqual([]);
    const plan = mock.calls.slice(before).find((c) => c.text.includes('本次只输出 README.md 与样式文件'))!;
    expect(plan.body.tools).toBeUndefined();
    expect(plan.text).not.toContain('【需求澄清】');
  });

  const elementEdit = async (prompt: string, answer?: (q: any) => unknown) => {
    const { id, jobId } = await create('');
    await waitJob(jobId);
    const doc = savedDoc(id);
    const eid = doc.pages[1].html.match(/<h1[^>]*data-eid="([^"]+)"/)![1];
    const e = await req('POST', `/api/projects/${id}/edit`, { prompt, scope: 'element', pageId: doc.pages[1].id, elementIds: [eid] });
    let job = await waitJob(e.json.job.id, (j) => !!j.question || j.status === 'done' || j.status === 'error');
    const question = job.question;
    if (question && answer) {
      await req('POST', `/api/jobs/${job.id}/answer`, { questionId: question.id, ...(answer(question) as object) });
      job = await waitJob(job.id);
    }
    return { id, job, question, doc: savedDoc(id) };
  };

  it('an element edit is made locally first, then the user is asked about the same thing on other pages', async () => {
    const { job, question, doc } = await elementEdit('SIMILAR 标题改成红色', () => ({ choice: 0 }));
    expect(question).toMatchObject({ kind: 'scope', options: ['全部修改', '只改选中的'] });
    expect(question.text).toContain('MOCK-SIMILAR 其他页面也有同样的标题');
    expect(job.status).toBe('done');
    expect(h1s(doc)).toEqual(['SIMILAR-DONE', 'SIMILAR-DONE', 'SIMILAR-DONE']);
    expect(doc.css).toMatch(/\.title\s*\{[^}]*color:\s*#ff0000/);
    expect(doc.readme).toMatch(/## 修改记录\n- v2 .*第 2 页（1 个元素），并同步修改第 1、3 页和共享样式 — SIMILAR/);
    const calls = mock.calls.filter((c) => c.text.includes('SIMILAR 标题改成红色'));
    const scopeResult = calls.at(-1)!.body.messages.find((m: any) => m.role === 'tool' && m.content.startsWith('用户同意一起修改'));
    expect(scopeResult).toBeTruthy();
    expect(calls[0].text).toContain('【先局部修改，再处理同类内容】');
    expect(calls[0].body.tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(['extend_scope', 'ask_user', 'find_elements']));
  });

  it('declining keeps the change on the selected element only', async () => {
    const { job, question, doc } = await elementEdit('SIMILAR 标题改成红色', () => ({ choice: 1 }));
    expect(question.kind).toBe('scope');
    expect(job.status).toBe('done');
    expect(h1s(doc)).toEqual(['第1页标题', '已修改：X', '第3页标题']);
    expect(doc.css).not.toContain('#ff0000');
    expect(job.questions).toEqual([expect.objectContaining({ kind: 'scope', answer: '只改选中的' })]);
  });

  it('a request that already says "all" is applied everywhere without a question', async () => {
    const { job, question, doc } = await elementEdit('SIMILAR 把所有标题统一改成红色');
    expect(question).toBeNull();
    expect(job.status).toBe('done');
    expect(job.questions).toEqual([]);
    expect(h1s(doc)).toEqual(['SIMILAR-DONE', 'SIMILAR-DONE', 'SIMILAR-DONE']);
  });

  it('edits can ask, and typed answers reach the model', async () => {
    const { job, question } = await elementEdit('ASK_ME 换个颜色', () => ({ answer: '紫色' }));
    expect(question).toMatchObject({ kind: 'ask', text: 'MOCK-QUESTION 改成什么颜色？' });
    expect(job.status).toBe('done');
    const last = [...mock.calls].reverse().find((c) => c.text.includes('ASK_ME 换个颜色'))!;
    expect(last.body.messages.some((m: any) => m.role === 'tool' && m.content === '用户回答：「紫色」')).toBe(true);
  });

  it('templates are built from placeholders: reference text is withheld and copied content goes back to the model', async () => {
    const boundary = '----rsask';
    const text = `${LEAKED}，同比增长 37%。核心客户包括多家头部银行与保险公司的数据中台项目。`;
    const parts = [
      ...Object.entries({ type: 'template', name: '占位模板', style: '仿照参考', notes: 'COPY_REF', fileRoles: JSON.stringify(['reference']) }).map(
        ([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      ),
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="report.txt"\r\nContent-Type: text/plain\r\n\r\n${text}\r\n`,
      `--${boundary}--\r\n`,
    ];
    const before = { calls: mock.calls.length, checks: mock.checkCalls.length };
    const r = await req('POST', '/api/projects', Buffer.from(parts.join('')), { 'content-type': `multipart/form-data; boundary=${boundary}` });
    expect(r.status).toBe(200);
    const job = await waitJob(r.json.job.id);
    expect(job.status).toBe('done');
    const plan = mock.calls.slice(before.calls).find((c) => c.text.includes('本次只输出 README.md 与样式文件'))!;
    expect(plan.text).toContain('【模板只是模板，不是示例：所有内容都用占位符】');
    expect(plan.text).toContain('参考文件「report.txt」');
    expect(plan.text).not.toContain('头部银行');
    expect(plan.text).toContain('【模板要包含的通用组件】');
    const checks = mock.checkCalls.slice(before.checks);
    expect(checks[0].text).toMatch(/✗ pages\/content-1\.html：含有从参考资料中照搬的具体内容：「ACME 量子科技有限公司 2023 年营收 1234\.5 万元」/);
    expect(job.review.check).toMatchObject({ errors: 0, fixes: 1 });
    const saved = savedDoc(r.json.project.id).pages.map((p) => p.html).join('');
    expect(saved).not.toContain('ACME');
    expect(saved).toContain('「公司名称」YYYY 年营收 X,XXX 万元');
  });
});
