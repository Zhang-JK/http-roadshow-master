import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockLlm } from './mockLlm.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-mcp-'));
process.env.DATA_DIR = tmp;

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let app: FastifyInstance;
let db: import('../src/db.js').DB;
let base = '';
let mock: Awaited<ReturnType<typeof startMockLlm>>;
let admin = '';
let alice = '';
let mcpId = 0;
let token = '';
let templateId = '';

async function req(method: string, url: string, cookie: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, ...headers } });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* empty or binary */
  }
  return { status: res.statusCode, json, res };
}

const login = async (username: string, password: string) => {
  const r = await req('POST', '/api/auth/login', '', { username, password });
  return { status: r.status, cookie: String(r.res.headers['set-cookie'] ?? '').split(';')[0] };
};

const rpc = (body: unknown, auth = `Bearer ${token}`, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    payload: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}), ...headers },
  });

async function waitJob(jobId: string) {
  for (let i = 0; i < 300; i++) {
    const { json } = await req('GET', `/api/jobs/${jobId}`, admin);
    if (json.job.status === 'done' || json.job.status === 'error') return json.job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job timeout');
}

async function connect(auth = token) {
  const client = new Client({ name: 'roadshow-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${auth}` } } });
  await client.connect(transport);
  return client;
}

const TOOL_NAMES = [
  'list_roadshow_templates',
  'create_roadshow_slides',
  'get_roadshow_slides_status',
  'list_roadshow_slides',
  'get_roadshow_slides',
  'update_roadshow_slides',
  'delete_roadshow_slides',
  'list_roadshow_folders',
  'create_roadshow_folder',
  'list_roadshow_files',
  'get_roadshow_file',
  'download_roadshow_slides',
];

const textOf = (r: any) => (r.content as any[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

beforeAll(async () => {
  mock = await startMockLlm();
  const { openDb } = await import('../src/db.js');
  const { buildApp } = await import('../src/app.js');
  db = openDb(path.join(tmp, 'test.db'));
  app = await buildApp(db, { serveWeb: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  admin = (await login('admin', 'admin123')).cookie;
  await req('POST', '/api/llm/endpoints', admin, { name: 'mock', baseUrl: mock.url, apiKey: 'good-key', model: 'mock-vision' });
  await req('POST', '/api/users', admin, { username: 'alice', password: 'alice123' });
  alice = (await login('alice', 'alice123')).cookie;
  const t = await req('POST', '/api/projects', admin, { type: 'template', name: '测试报告模板', style: '简洁的技术报告风格', purpose: '测试结果汇报', audience: '研发团队', pageCount: '3' });
  templateId = t.json.project.id;
  expect((await waitJob(t.json.job.id)).status).toBe('done');
});

afterAll(async () => {
  await app?.close();
  const { closeBrowser } = await import('../src/render.js');
  await closeBrowser();
  await mock?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('mcp service account', () => {
  it('exists from the start, switched off and without a token', async () => {
    const users = (await req('GET', '/api/users', alice)).json.users;
    const mcp = users.find((u: any) => u.username === 'mcp');
    expect(mcp).toMatchObject({ displayName: 'MCP', isAdmin: false, isService: true, mcpEnabled: false, tokenHint: null });
    expect(users.find((u: any) => u.username === 'alice').isService).toBeUndefined();
    mcpId = mcp.id;
  });

  it('cannot log in, get a password or be deleted', async () => {
    expect((await login('mcp', '')).status).toBe(401);
    expect((await req('PATCH', `/api/users/${mcpId}`, admin, { password: 'secret123' })).status).toBe(400);
    expect((await req('DELETE', `/api/users/${mcpId}`, admin)).status).toBe(400);
    expect((await req('GET', '/api/users', admin)).json.users.some((u: any) => u.username === 'mcp')).toBe(true);
  });

  it('only admins switch it and manage its token', async () => {
    expect((await req('PATCH', `/api/users/${mcpId}`, alice, { mcpEnabled: true })).status).toBe(403);
    expect((await req('POST', `/api/users/${mcpId}/token`, alice)).status).toBe(403);
    expect((await req('PATCH', `/api/users/1`, admin, { mcpEnabled: true })).status).toBe(400);
    expect((await req('POST', `/api/users/1/token`, admin)).status).toBe(400);
    expect((await req('PATCH', `/api/users/${mcpId}`, admin, { mcpEnabled: 'yes' })).status).toBe(400);
  });

  it('a new token is shown once and stored only as a hash', async () => {
    const r = await req('POST', `/api/users/${mcpId}/token`, admin);
    expect(r.status).toBe(200);
    token = r.json.token;
    expect(token).toMatch(/^rs_mcp_[A-Za-z0-9_-]{32}$/);
    expect(r.json.user).toMatchObject({ tokenHint: token.slice(-4), mcpEnabled: false });
    expect(r.json.user.tokenCreatedAt).toBeGreaterThan(0);
    expect(JSON.stringify((await req('GET', '/api/users', admin)).json)).not.toContain(token);
    const row = db.prepare('SELECT token_hash FROM users WHERE id = ?').get(mcpId) as { token_hash: string };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(token);
  });
});

describe('mcp http layer', () => {
  const init = (protocolVersion = '2025-06-18') => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'curl', version: '1' } },
  });

  it('needs the token and the admin switch', async () => {
    const none = await rpc(init(), '');
    expect(none.statusCode).toBe(401);
    expect(none.json().error.message).toMatch(/缺少 MCP 令牌/);
    expect((await rpc(init(), 'Bearer rs_mcp_wrong')).statusCode).toBe(401);
    const off = await rpc(init());
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { message: expect.stringContaining('允许 MCP 请求') } });
    expect((await req('PATCH', `/api/users/${mcpId}`, admin, { mcpEnabled: true })).json.user.mcpEnabled).toBe(true);
    expect((await rpc(init())).statusCode).toBe(200);
  });

  it('negotiates the protocol version', async () => {
    const r = (await rpc(init())).json();
    expect(r.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'roadshow' } });
    expect(r.result.instructions).toContain('list_roadshow_templates');
    expect((await rpc(init('1999-01-01'))).json().result.protocolVersion).toBe('2025-11-25');
  });

  it('speaks JSON-RPC: notifications, batches and errors', async () => {
    const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note.statusCode).toBe(202);
    expect(note.body).toBe('');
    const batch = (await rpc([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }])).json();
    expect(batch.map((m: any) => m.id)).toEqual(['a', 'b']);
    expect(batch[1].result.tools.map((t: any) => t.name)).toEqual(TOOL_NAMES);
    expect((await rpc({ jsonrpc: '2.0', id: 2, method: 'server/discover' })).json().error.code).toBe(-32601);
    expect((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } })).json().error.code).toBe(-32602);
    expect((await rpc({ id: 4, method: 'ping' })).json().error.code).toBe(-32600);
    const bad = await rpc('{"jsonrpc": "2.0", ');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe(-32700);
  });

  it('answers only POST from its own origin', async () => {
    const get = await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${token}` } });
    expect(get.statusCode).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect((await rpc(init(), undefined, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await rpc(init(), undefined, { origin: 'http://localhost:80', host: 'localhost:80' })).statusCode).toBe(200);
    expect((await rpc(init(), undefined, { origin: 'https://roadshow.example', host: 'roadshow.example' })).statusCode).toBe(200);
  });

  it('the token opens nothing but MCP and MCP downloads', async () => {
    expect((await req('GET', '/api/projects', '', undefined, { authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await req('GET', '/api/users', '', undefined, { authorization: `Bearer ${token}` })).status).toBe(401);
  });
});

describe('mcp tools through the SDK client', () => {
  let client: Client;
  let projectId = '';

  beforeAll(async () => {
    client = await connect();
  });
  afterAll(async () => {
    await client?.close();
  });

  it('lists the tools with the ready templates as choices', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'roadshow' });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    const create = tools.find((t) => t.name === 'create_roadshow_slides')!;
    expect(create.inputSchema.required).toEqual(['templateId', 'name', 'content']);
    expect((create.inputSchema.properties as any).templateId.enum).toEqual([templateId]);
    expect(create.description).toMatch(/test data|exact values/);
    const update = tools.find((t) => t.name === 'update_roadshow_slides')!;
    expect(update.inputSchema.required).toEqual(['projectId']);
    expect((update.inputSchema.properties as any).files.items).toEqual((create.inputSchema.properties as any).files.items);
    expect((create.inputSchema.properties as any).data).toEqual((update.inputSchema.properties as any).data);
    expect((create.inputSchema.properties as any).data.description).toMatch(/Raw data and statistics/);
    expect(tools.find((t) => t.name === 'delete_roadshow_slides')!.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(tools.find((t) => t.name === 'list_roadshow_slides')!.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('list_roadshow_templates describes each template, with optional covers', async () => {
    const r: any = await client.callTool({ name: 'list_roadshow_templates', arguments: {} });
    expect(r.isError).toBeFalsy();
    const [t] = r.structuredContent.templates;
    expect(t).toMatchObject({ templateId, name: '测试报告模板', size: '1920×1080', style: '简洁的技术报告风格', audience: '研发团队', layoutCount: 3 });
    expect(t.layouts).toHaveLength(3);
    expect(t.layouts[0].file).toMatch(/^pages\/.+\.html$/);
    expect(t.guide).toContain('页面规划');
    expect(JSON.parse(textOf(r)).templates[0].templateId).toBe(templateId);
    const withCovers: any = await client.callTool({ name: 'list_roadshow_templates', arguments: { includePreviews: true } });
    const image = withCovers.content.find((c: any) => c.type === 'image');
    expect(image.mimeType).toBe('image/jpeg');
    expect(Buffer.from(image.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('create_roadshow_slides stores the same brief and files as the web form and never asks', async () => {
    const before = mock.calls.length;
    const csv = 'case,p50_ms,p99_ms,qps\nbaseline,12,48,5200\nv2,9,31,7400\n';
    const report = '# 压测报告\n\n| 指标 | 基线 | v2 |\n|---|---|---|\n| p99 | 48 ms | 31 ms |\n';
    const r: any = await client.callTool({
      name: 'create_roadshow_slides',
      arguments: {
        templateId,
        name: '搜索服务 v2 压测报告',
        content: '## 测试目标\n验证 v2 在 7000 QPS 下的延迟。ASK_ME\n## 结果\n见 results.csv 与 latency.png：p99 从 48 ms 降到 31 ms。',
        purpose: '季度测试评审',
        audience: '研发负责人',
        pageCount: 3,
        notes: '每页标注数据来源',
        data: '| 版本 | QPS |\n|---|---|\n| 基线 | 5200 |\n| v2 | 7400 |',
        files: [
          { filename: 'latency.png', data: PNG_1x1 },
          { filename: 'flame.png', data: `data:image/png;base64,${PNG_1x1}`, role: 'reference' },
          { filename: 'results.csv', text: csv },
          { filename: 'report.md', data: Buffer.from(report).toString('base64') },
        ],
      },
    });
    expect(r.isError).toBeFalsy();
    projectId = r.structuredContent.projectId;
    expect(r.structuredContent).toMatchObject({ status: 'generating', template: '测试报告模板', size: '1920×1080', editorUrl: `${base}/p/${projectId}` });
    expect(r.structuredContent.files.map((f: any) => [f.filename, f.kind, f.role])).toEqual([
      ['latency.png', 'image', 'embed'],
      ['flame.png', 'image', 'reference'],
      ['results.csv', 'document', 'reference'],
      ['report.md', 'document', 'reference'],
      ['原始数据.md', 'document', 'reference'],
    ]);

    const p = (await req('GET', `/api/projects/${projectId}`, admin)).json;
    expect(p.assets.find((a: any) => a.filename === '原始数据.md')).toMatchObject({ mime: 'text/markdown', hasText: true });
    expect(p.project).toMatchObject({ type: 'deck', templateId, createdBy: 'MCP', width: 1920, height: 1080 });
    expect(p.project.meta.brief).toEqual({
      name: '搜索服务 v2 压测报告',
      purpose: '季度测试评审',
      audience: '研发负责人',
      content: expect.stringContaining('p99 从 48 ms 降到 31 ms'),
      pageCount: 3,
      notes: '每页标注数据来源',
    });
    expect(p.assets.find((a: any) => a.filename === 'results.csv')).toMatchObject({ mime: 'text/csv', hasText: true });

    let status: any;
    for (let i = 0; i < 20; i++) {
      status = (await client.callTool({ name: 'get_roadshow_slides_status', arguments: { projectId, waitSeconds: 5 } })).structuredContent;
      if (status.status !== 'generating') break;
    }
    expect(status).toMatchObject({ projectId, status: 'ready', pageCount: 3, size: '1920×1080' });
    expect(status.pages.map((x: any) => x.page)).toEqual([1, 2, 3]);
    expect(status.pages[0]).toEqual({ page: 1, file: expect.stringMatching(/^pages\/.+\.html$/), title: '第1页标题' });
    expect(Object.keys(status.downloads)).toEqual(['html', 'pdf', 'pdf-image', 'pptx', 'zip']);

    const calls = mock.calls.slice(before);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => !(c.body.tools ?? []).some((t: any) => t.function.name === 'ask_user'))).toBe(true);
    expect(calls[0].text).toContain('季度测试评审');
    expect(calls[0].text).toContain('baseline,12,48,5200');
    expect(calls[0].text).toContain('| v2 | 7400 |');
    expect(calls[0].images.some((u) => u.startsWith('data:image/png'))).toBe(true);
    const jobs = (await req('GET', `/api/projects/${projectId}/jobs`, admin)).json.jobs;
    expect(jobs).toEqual([expect.objectContaining({ kind: 'create', status: 'done', questions: [] })]);
  });

  it('get_roadshow_slides_status can return page images', async () => {
    const r: any = await client.callTool({ name: 'get_roadshow_slides_status', arguments: { projectId, waitSeconds: 0, includePreviews: true } });
    expect(r.content.filter((c: any) => c.type === 'image')).toHaveLength(3);
  });

  it('the token downloads exports of MCP decks only', async () => {
    const status: any = (await client.callTool({ name: 'get_roadshow_slides_status', arguments: { projectId, waitSeconds: 0 } })).structuredContent;
    const auth = { authorization: `Bearer ${token}` };
    const html = await fetch(status.downloads.html, { headers: auth });
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(await html.text()).toContain('<section');
    const pdf = await fetch(status.downloads.pdf, { headers: auth });
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
    expect((await fetch(status.downloads.html)).status).toBe(401);
    expect((await fetch(status.downloads.html, { headers: { authorization: 'Bearer rs_mcp_nope' } })).status).toBe(401);
    expect((await fetch(`${base}/api/projects/${templateId}/export?format=html`, { headers: auth })).status).toBe(404);
    const theirs: any = await client.callTool({ name: 'get_roadshow_slides_status', arguments: { projectId: templateId } });
    expect(theirs.isError).toBe(true);
  });

  it('reports bad arguments as tool errors the agent can fix', async () => {
    const call = async (args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name: 'create_roadshow_slides', arguments: { templateId, name: 'x', content: 'y', ...args } });
      expect(r.isError).toBe(true);
      return textOf(r);
    };
    const projects = (await req('GET', '/api/projects?type=deck', admin)).json.projects.length;
    expect(await call({ content: '' })).toMatch(/content/);
    expect(await call({ templateId: 'missing' })).toMatch(/所选模板不存在/);
    expect(await call({ pageCount: 41 })).toMatch(/pageCount/);
    expect(await call({ aspect: 'wide' })).toMatch(/aspect/);
    expect(await call({ aspect: 'custom', width: 1000 })).toMatch(/width and height/);
    expect(await call({ aspect: 'custom', width: 100, height: 1000 })).toMatch(/320 to 4000/);
    expect(await call({ files: [{ filename: 'tool.exe', data: PNG_1x1 }] })).toMatch(/unsupported file type/);
    expect(await call({ files: [{ filename: 'chart.png', data: Buffer.from('<svg/>').toString('base64') }] })).toMatch(/not a valid PNG/);
    expect(await call({ files: [{ filename: 'chart.png', text: 'abc' }] })).toMatch(/not both|binary|either/);
    expect(await call({ files: [{ filename: 'deck.pptx', text: 'abc' }] })).toMatch(/binary format/);
    expect(await call({ files: [{ filename: 'a.md', data: '***' }] })).toMatch(/base64/);
    expect(await call({ files: [{ filename: 'a.md', text: 'a', data: 'YQ==' }] })).toMatch(/not both/);
    expect(await call({ files: Array.from({ length: 13 }, (_, i) => ({ filename: `${i}.md`, text: 'a' })) })).toMatch(/At most 12/);
    expect(await call({ files: [{ filename: 'a.png', data: PNG_1x1, role: 'hero' }] })).toMatch(/role/);
    expect((await req('GET', '/api/projects?type=deck', admin)).json.projects.length).toBe(projects);
  });

  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as any;

  async function untilSettled(id: string) {
    let status: any;
    for (let i = 0; i < 30; i++) {
      status = (await call('get_roadshow_slides_status', { projectId: id, waitSeconds: 5 })).structuredContent;
      if (status.status !== 'generating' && status.status !== 'updating') return status;
    }
    throw new Error(`deck ${id} still ${status.status}`);
  }

  let aliceDeck = '';

  it('list_roadshow_slides finds the decks MCP created, with dates, authors and history', async () => {
    const a = await req('POST', '/api/projects', alice, { type: 'deck', templateId, name: 'Alice 的季度汇报', content: '网页上创建的材料' });
    aliceDeck = a.json.project.id;
    expect((await waitJob(a.json.job.id)).status).toBe('done');
    expect((await req('PATCH', `/api/projects/${projectId}`, alice, { name: '搜索服务 v2 压测报告（评审版）' })).status).toBe(200);

    const r = await call('list_roadshow_slides', {});
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.total).toBe(1);
    const [deck] = r.structuredContent.decks;
    expect(deck).toMatchObject({
      projectId,
      name: '搜索服务 v2 压测报告（评审版）',
      status: 'ready',
      version: 2,
      pageCount: 3,
      size: '1920×1080',
      template: { templateId, name: '测试报告模板' },
      purpose: '季度测试评审',
      audience: '研发负责人',
      createdBy: 'MCP',
      updatedBy: 'alice',
      historyCount: 2,
      editorUrl: `${base}/p/${projectId}`,
    });
    expect(deck.contentPreview).toContain('测试目标');
    expect(Date.parse(deck.createdAt)).toBeGreaterThan(0);
    expect(Date.parse(deck.updatedAt)).toBeGreaterThanOrEqual(Date.parse(deck.createdAt));
    expect(deck.history).toEqual([
      { version: 1, action: 'created', by: 'MCP', at: expect.any(String), request: expect.stringContaining('name: 搜索服务 v2 压测报告') },
      { version: 2, action: 'renamed', by: 'alice', at: expect.any(String), request: '重命名为「搜索服务 v2 压测报告（评审版）」' },
    ]);
    expect(JSON.stringify(r.structuredContent)).not.toContain(aliceDeck);

    expect((await call('list_roadshow_slides', { query: '压测' })).structuredContent.total).toBe(1);
    expect((await call('list_roadshow_slides', { query: '季度测试' })).structuredContent.total).toBe(1);
    const none = await call('list_roadshow_slides', { query: 'Alice' });
    expect(none.structuredContent).toMatchObject({ total: 0, decks: [] });
    expect(textOf(none)).toMatch(/No deck matches "Alice"/);
    expect((await call('list_roadshow_slides', { offset: 1 })).structuredContent).toMatchObject({ total: 1, decks: [] });
    expect((await call('list_roadshow_slides', { limit: 0 })).isError).toBe(true);
  });

  it('get_roadshow_slides returns the original request, the files and the full history', async () => {
    const r = await call('get_roadshow_slides', { projectId });
    expect(r.isError).toBeFalsy();
    const d = r.structuredContent;
    expect(d).toMatchObject({ projectId, status: 'ready', version: 2, createdBy: 'MCP', updatedBy: 'alice', pageCount: 3, size: '1920×1080' });
    expect(d.originalRequest).toEqual({
      templateId,
      name: '搜索服务 v2 压测报告',
      content: '## 测试目标\n验证 v2 在 7000 QPS 下的延迟。ASK_ME\n## 结果\n见 results.csv 与 latency.png：p99 从 48 ms 降到 31 ms。',
      purpose: '季度测试评审',
      audience: '研发负责人',
      pageCount: 3,
      notes: '每页标注数据来源',
    });
    expect(d.files.map((f: any) => [f.filename, f.role, f.uploadedBy])).toEqual([
      ['latency.png', 'embed', 'MCP'],
      ['flame.png', 'reference', 'MCP'],
      ['results.csv', 'reference', 'MCP'],
      ['report.md', 'reference', 'MCP'],
      ['原始数据.md', 'reference', 'MCP'],
    ]);
    expect(d.history.map((h: any) => [h.version, h.action, h.by])).toEqual([
      [1, 'created', 'MCP'],
      [2, 'renamed', 'alice'],
    ]);
    expect(d.history[0].request).toContain('p99 从 48 ms 降到 31 ms');
    expect(d.lastRequest).toMatchObject({ kind: 'create', status: 'done', requestedBy: 'MCP', resultVersion: 1 });
    expect(d.failedRequests).toBeUndefined();
    expect(d.pages).toHaveLength(3);
    expect(Object.keys(d.downloads)).toEqual(['html', 'pdf', 'pdf-image', 'pptx', 'zip']);
    expect((await call('get_roadshow_slides', { projectId: aliceDeck })).isError).toBe(true);
    expect((await call('get_roadshow_slides', { projectId: templateId })).isError).toBe(true);
  });

  it('update_roadshow_slides applies new data as a new version, with the files, and never asks', async () => {
    const before = mock.calls.length;
    const r = await call('update_roadshow_slides', {
      projectId,
      instructions: '## 复测结果 ASK_ME\n用 rerun.csv 的数据替换结果页：p99 从 31 ms 进一步降到 28 ms，并更新结论。',
      files: [{ filename: 'rerun.csv', text: 'case,p99_ms\nv2.1,28\n' }],
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ projectId, status: 'updating', version: 2, scope: 'deck', jobId: expect.any(String) });
    expect(r.structuredContent.files).toEqual([expect.objectContaining({ filename: 'rerun.csv', kind: 'document', role: 'reference' })]);

    const status = await untilSettled(projectId);
    expect(status).toMatchObject({ status: 'ready', version: 3, pageCount: 3 });
    expect(status.lastRequest).toMatchObject({
      jobId: r.structuredContent.jobId,
      kind: 'update',
      status: 'done',
      requestedBy: 'MCP',
      scope: 'deck',
      resultVersion: 3,
      request: expect.stringContaining('复测结果'),
    });
    expect(status.downloads).toBeDefined();

    const calls = mock.calls.slice(before);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].text).toContain('p99 从 31 ms 进一步降到 28 ms');
    expect(calls[0].text).toContain('rerun.csv');
    expect(calls.every((c) => !(c.body.tools ?? []).some((t: any) => t.function.name === 'ask_user'))).toBe(true);
    const job = (await req('GET', `/api/jobs/${r.structuredContent.jobId}`, admin)).json.job;
    expect(job).toMatchObject({ kind: 'edit', status: 'done', questions: [], request: { askUser: false, scope: 'global' } });
    expect(job.request.attachmentIds).toHaveLength(1);
    expect(projectDocCss()).toContain('#111827');

    const d = (await call('get_roadshow_slides', { projectId })).structuredContent;
    expect(d.history.at(-1)).toMatchObject({ version: 3, action: 'updated', by: 'MCP', request: expect.stringContaining('复测结果') });
    expect(d.files.map((f: any) => f.filename)).toContain('rerun.csv');
    expect(d.originalRequest.content).not.toContain('复测结果');
  });

  function projectDocCss() {
    const row = db.prepare('SELECT doc FROM projects WHERE id = ?').get(projectId) as { doc: string };
    return JSON.stringify(JSON.parse(row.doc).css);
  }

  it('update_roadshow_slides can change one page and rename the deck', async () => {
    const r = await call('update_roadshow_slides', { projectId, page: 2, instructions: '第 2 页补充复测环境说明', name: '搜索服务 v2.1 压测报告' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ name: '搜索服务 v2.1 压测报告', status: 'updating', scope: 'page 2', version: 4 });
    const status = await untilSettled(projectId);
    expect(status).toMatchObject({ status: 'ready', name: '搜索服务 v2.1 压测报告', version: 5, lastRequest: { status: 'done', scope: 'page' } });
    const doc = JSON.parse((db.prepare('SELECT doc FROM projects WHERE id = ?').get(projectId) as { doc: string }).doc);
    expect(doc.title).toBe('搜索服务 v2.1 压测报告');
    expect(doc.pages[1].html).toContain('整页新增段落');
    expect(doc.pages[0].html).not.toContain('整页新增段落');
    const { history } = (await call('get_roadshow_slides', { projectId })).structuredContent;
    expect(history.slice(-2)).toEqual([
      expect.objectContaining({ version: 4, action: 'renamed', by: 'MCP' }),
      expect.objectContaining({ version: 5, action: 'updated', by: 'MCP', page: 2, request: '第 2 页补充复测环境说明' }),
    ]);

    const renamed = await call('update_roadshow_slides', { projectId, name: '搜索服务 v2.1 压测报告（终版）' });
    expect(renamed.structuredContent).toMatchObject({ status: 'ready', version: 6, name: '搜索服务 v2.1 压测报告（终版）' });
    expect(renamed.structuredContent.jobId).toBeUndefined();
  });

  it('a failed update leaves the deck unchanged and says why', async () => {
    const r = await call('update_roadshow_slides', { projectId, instructions: 'NO_CHANGE 看看还有什么要改' });
    expect(r.isError).toBeFalsy();
    const status = await untilSettled(projectId);
    expect(status).toMatchObject({ status: 'ready', version: 6, lastRequest: { kind: 'update', status: 'error', error: expect.stringContaining('模型没有做任何修改') } });
    expect(status.next).toMatch(/failed and the deck is unchanged \(version 6\)/);
    const d = (await call('get_roadshow_slides', { projectId })).structuredContent;
    expect(d.failedRequests).toEqual([expect.objectContaining({ jobId: r.structuredContent.jobId, kind: 'update', request: 'NO_CHANGE 看看还有什么要改' })]);
    expect(d.history).toHaveLength(6);
  });

  it('update_roadshow_slides reports bad arguments and refuses a second change while one runs', async () => {
    const bad = async (args: Record<string, unknown>) => {
      const r = await call('update_roadshow_slides', args);
      expect(r.isError).toBe(true);
      return textOf(r);
    };
    const versions = () => (db.prepare('SELECT COUNT(*) AS n FROM project_versions WHERE project_id = ?').get(projectId) as { n: number }).n;
    const jobs = () => (db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?').get(projectId) as { n: number }).n;
    const [v0, j0] = [versions(), jobs()];
    expect(await bad({ projectId })).toMatch(/instructions .*name/);
    expect(await bad({ projectId, name: '  ' })).toMatch(/"name" must not be empty/);
    expect(await bad({ projectId, page: 2, name: '只改名' })).toMatch(/go with instructions/);
    expect(await bad({ projectId, name: '只改名', files: [{ filename: 'a.md', text: 'a' }] })).toMatch(/go with instructions/);
    expect(await bad({ projectId, instructions: 'x', page: 9 })).toMatch(/"page" must be from 1 to 3/);
    expect(await bad({ projectId, instructions: 'x', page: 0 })).toMatch(/page/);
    expect(await bad({ projectId, instructions: 'x', files: [{ filename: 'tool.exe', data: PNG_1x1 }] })).toMatch(/unsupported file type/);
    expect(await bad({ projectId: aliceDeck, instructions: 'x' })).toMatch(/No deck .* created through MCP/);
    expect(await bad({ projectId: templateId, name: 'x' })).toMatch(/No deck/);
    expect(await bad({ projectId: 'missing', instructions: 'x' })).toMatch(/list_roadshow_slides/);
    expect([versions(), jobs()]).toEqual([v0, j0]);

    const change = (id: number, instructions: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'update_roadshow_slides', arguments: { projectId, instructions } } });
    const [first, second] = (await rpc([change(1, '第一个修改'), change(2, '第二个修改')])).json();
    expect(first.result.isError).toBeFalsy();
    expect(second.result.isError).toBe(true);
    expect(second.result.content[0].text).toMatch(new RegExp(`still running \\(jobId ${first.result.structuredContent.jobId}\\)`));
    expect(await untilSettled(projectId)).toMatchObject({ status: 'ready', version: 7, lastRequest: { status: 'done', request: '第一个修改' } });
  });

  const auth = () => ({ authorization: `Bearer ${token}` });
  let latencyPath = '';

  it('list_roadshow_files lists the source files as in the ZIP, with links that take the token', async () => {
    const latency = db.prepare(`SELECT id FROM assets WHERE project_id = ? AND filename = 'latency.png'`).get(projectId) as { id: string };
    const row = db.prepare('SELECT doc FROM projects WHERE id = ?').get(projectId) as { doc: string };
    const doc = JSON.parse(row.doc);
    doc.pages[0].html += `<img src="/api/assets/${latency.id}" alt="延迟分布">`;
    db.prepare('UPDATE projects SET doc = ? WHERE id = ?').run(JSON.stringify(doc), projectId);
    latencyPath = `assets/${latency.id}.png`;

    const r = await call('list_roadshow_files', { projectId });
    expect(r.isError).toBeFalsy();
    const d = r.structuredContent;
    expect(d).toMatchObject({ projectId, version: 7, current: true, pageCount: 3, zipUrl: `${base}/api/projects/${projectId}/source`, downloadAuth: expect.stringContaining('Bearer') });
    const kinds = d.files.map((f: any) => f.kind);
    expect(kinds[0]).toBe('readme');
    expect(kinds.filter((k: string) => k === 'page')).toHaveLength(3);
    expect(kinds.slice(-1)).toEqual(['image']);
    expect(kinds).toContain('style');
    expect(kinds.indexOf('index')).toBeLessThan(kinds.indexOf('page'));
    expect(d.files.filter((f: any) => f.kind === 'page').map((f: any) => [f.page, f.path])).toEqual(
      d.files.filter((f: any) => f.kind === 'page').map((f: any, i: number) => [i + 1, expect.stringMatching(/^pages\/.+\.html$/)]),
    );
    expect(d.files.find((f: any) => f.kind === 'page').title).toEqual(expect.any(String));
    expect(d.files.at(-1)).toMatchObject({ path: latencyPath, mimeType: 'image/png', bytes: Buffer.from(PNG_1x1, 'base64').length });
    expect(d.fileCount).toBe(d.files.length);
    expect(d.totalBytes).toBe(d.files.reduce((n: number, f: any) => n + f.bytes, 0));
    expect(d.uploads.find((u: any) => u.filename === 'latency.png')).toMatchObject({ role: 'embed', url: `${base}/api/assets/${latency.id}` });
    expect(Object.keys(d.downloads)).toEqual(['html', 'pdf', 'pdf-image', 'pptx', 'zip']);

    const page1 = d.files.find((f: any) => f.page === 1);
    const res = await fetch(page1.url, { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain(`../${latencyPath}`);
    const img = await fetch(d.files.at(-1).url, { headers: auth() });
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await img.arrayBuffer()).toString('base64')).toBe(PNG_1x1);
    expect((await fetch(page1.url)).status).toBe(401);

    const old = await call('list_roadshow_files', { projectId, version: 1 });
    expect(old.structuredContent).toMatchObject({ version: 1, current: false, zipUrl: `${base}/api/projects/${projectId}/source?versionNo=1` });
    expect(old.structuredContent.files.some((f: any) => f.kind === 'image')).toBe(false);
    expect(old.structuredContent.files[0].url).toBe(`${base}/api/projects/${projectId}/source?path=README.md&versionNo=1`);
    expect(old.structuredContent.downloads.zip).toMatch(/format=zip&versionNo=1$/);
    expect(textOf(await call('list_roadshow_files', { projectId, version: 99 }))).toMatch(/no version 99; its versions are 1 to 7/);
    expect((await call('list_roadshow_files', { projectId: aliceDeck })).isError).toBe(true);
    expect((await call('list_roadshow_files', { projectId: templateId })).isError).toBe(true);
  });

  it('get_roadshow_file reads text in parts, returns images, and can show the rendered page', async () => {
    const { files } = (await call('list_roadshow_files', { projectId })).structuredContent;
    const readme = await call('get_roadshow_file', { projectId, path: 'README.md' });
    expect(readme.isError).toBeFalsy();
    const full = await (await fetch(files[0].url, { headers: auth() })).text();
    expect(readme.content[1]).toEqual({ type: 'text', text: full });
    expect(readme.structuredContent).toMatchObject({ path: 'README.md', kind: 'readme', mimeType: 'text/markdown', offset: 0, totalChars: full.length, text: full });
    expect(readme.structuredContent.nextOffset).toBeUndefined();
    const rest = await call('get_roadshow_file', { projectId, path: 'README.md', offset: 5 });
    expect(rest.content[1].text).toBe(full.slice(5));
    expect(textOf(await call('get_roadshow_file', { projectId, path: 'README.md', offset: full.length + 1 }))).toMatch(/past the end/);

    const css = files.find((f: any) => f.kind === 'style');
    const style = await call('get_roadshow_file', { projectId, path: `./${css.path}` });
    expect(style.structuredContent).toMatchObject({ path: css.path, kind: 'style', mimeType: 'text/css' });
    expect(style.content[1].text).toContain('#111827');

    const page = files.find((f: any) => f.page === 2);
    const shot = await call('get_roadshow_file', { projectId, path: page.path, includeImage: true });
    expect(shot.structuredContent).toMatchObject({ kind: 'page', page: 2 });
    expect(shot.content[1].text).toContain('<section');
    const image = shot.content.find((c: any) => c.type === 'image');
    expect(image.mimeType).toBe('image/jpeg');
    expect(Buffer.from(image.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    const png = await call('get_roadshow_file', { projectId, path: latencyPath });
    expect(png.structuredContent).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(png.content[1]).toEqual({ type: 'image', data: PNG_1x1, mimeType: 'image/png' });

    expect(textOf(await call('get_roadshow_file', { projectId, path: 'README.md', includeImage: true }))).toMatch(/only works for pages/);
    const missing = await call('get_roadshow_file', { projectId, path: 'pages/99-nope.html' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('README.md');
    expect(textOf(missing)).toContain(page.path);
    expect((await call('get_roadshow_file', { projectId: aliceDeck, path: 'README.md' })).isError).toBe(true);
  });

  it('download_roadshow_slides returns the ZIP or an export embedded, with its checksum', async () => {
    const JSZip = (await import('jszip')).default;
    const { createHash } = await import('node:crypto');
    const r = await call('download_roadshow_slides', { projectId });
    expect(r.isError).toBeFalsy();
    const d = r.structuredContent;
    expect(d).toMatchObject({
      version: 7,
      format: 'zip',
      filename: '搜索服务 v2.1 压测报告（终版）.zip',
      mimeType: 'application/zip',
      embedded: true,
      url: `${base}/api/projects/${projectId}/source`,
    });
    const res = r.content.find((c: any) => c.type === 'resource').resource;
    expect(res).toMatchObject({ uri: d.url, mimeType: 'application/zip' });
    const buf = Buffer.from(res.blob, 'base64');
    expect(buf.length).toBe(d.bytes);
    expect(createHash('sha256').update(buf).digest('hex')).toBe(d.sha256);
    const zip = await JSZip.loadAsync(buf);
    const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    expect(entries.sort()).toEqual([...d.files].sort());
    expect(entries).toContain(latencyPath);
    const listed = (await call('get_roadshow_file', { projectId, path: 'README.md' })).content[1].text;
    expect(await zip.file('README.md')!.async('string')).toBe(listed);

    const viaHttp = await fetch(d.url, { headers: auth() });
    expect(viaHttp.headers.get('content-type')).toBe('application/zip');
    expect(Object.keys((await JSZip.loadAsync(Buffer.from(await viaHttp.arrayBuffer()))).files)).toEqual(expect.arrayContaining(d.files));

    const html = await call('download_roadshow_slides', { projectId, format: 'html' });
    expect(html.structuredContent).toMatchObject({ format: 'html', mimeType: 'text/html', filename: '搜索服务 v2.1 压测报告（终版）.html' });
    expect(html.structuredContent.url).toBe(`${base}/api/projects/${projectId}/export?format=html`);
    expect(Buffer.from(html.content[1].resource.blob, 'base64').toString()).toContain('<section');

    const v1 = await call('download_roadshow_slides', { projectId, version: 1 });
    expect(v1.structuredContent).toMatchObject({ version: 1, filename: '搜索服务 v2.1 压测报告（终版）-v1.zip', url: `${base}/api/projects/${projectId}/source?versionNo=1` });
    expect(v1.structuredContent.files).not.toContain(latencyPath);
    expect(v1.structuredContent.sha256).not.toBe(d.sha256);

    expect(textOf(await call('download_roadshow_slides', { projectId, format: 'docx' }))).toMatch(/"format" must be one of/);
    expect((await call('download_roadshow_slides', { projectId: aliceDeck })).isError).toBe(true);
  });

  it('the source endpoint serves files to users and the token, for MCP decks only', async () => {
    const url = `/api/projects/${projectId}/source?path=README.md&versionNo=1`;
    const viaToken = await req('GET', url, '', undefined, auth());
    expect(viaToken.status).toBe(200);
    expect(viaToken.res.headers['content-type']).toContain('text/markdown');
    expect((await req('GET', url, alice)).status).toBe(200);
    expect((await req('GET', `/api/projects/${projectId}/source?path=../secret`, alice)).status).toBe(404);
    expect((await req('GET', `/api/projects/${projectId}/source?path=README.md&versionNo=99`, alice)).status).toBe(404);
    expect((await req('GET', `/api/projects/${aliceDeck}/source?path=README.md`, '', undefined, auth())).status).toBe(404);
    expect((await req('GET', `/api/projects/${aliceDeck}/source`, alice)).res.headers['content-type']).toBe('application/zip');
    expect((await req('GET', `/api/projects/${projectId}/source`, '')).status).toBe(401);
  });

  it('delete_roadshow_slides removes the deck with its history and files', async () => {
    const { assetPath } = await import('../src/assets.js');
    const assets = (db.prepare('SELECT id FROM assets WHERE project_id = ?').all(projectId) as { id: string }[]).map((a) => assetPath(a.id));
    expect(assets.length).toBeGreaterThan(4);
    expect(assets.every((f) => fs.existsSync(f))).toBe(true);
    expect((await call('delete_roadshow_slides', { projectId: aliceDeck })).isError).toBe(true);
    expect((await call('delete_roadshow_slides', { projectId: templateId })).isError).toBe(true);

    const r = await call('delete_roadshow_slides', { projectId });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ projectId, name: '搜索服务 v2.1 压测报告（终版）', deleted: true });
    expect(assets.some((f) => fs.existsSync(f))).toBe(false);
    expect((await req('GET', `/api/projects/${projectId}`, admin)).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_versions WHERE project_id = ?').get(projectId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?').get(projectId)).toEqual({ n: 0 });
    expect((await call('list_roadshow_slides', {})).structuredContent.total).toBe(0);
    expect(textOf(await call('list_roadshow_slides', {}))).toMatch(/No deck has been created through MCP yet/);
    expect((await call('get_roadshow_slides_status', { projectId })).isError).toBe(true);
    expect((await call('delete_roadshow_slides', { projectId })).isError).toBe(true);
    expect((await req('GET', `/api/projects/${aliceDeck}`, admin)).status).toBe(200);
  });

  it('switching MCP off or replacing the token locks clients out', async () => {
    await req('PATCH', `/api/users/${mcpId}`, admin, { mcpEnabled: false });
    await expect(client.listTools()).rejects.toThrow(/403|允许 MCP 请求/);
    await req('PATCH', `/api/users/${mcpId}`, admin, { mcpEnabled: true });
    expect((await client.listTools()).tools).toHaveLength(TOOL_NAMES.length);
    const old = token;
    token = (await req('POST', `/api/users/${mcpId}/token`, admin)).json.token;
    expect(token).not.toBe(old);
    await expect(client.listTools()).rejects.toThrow(/401|令牌/);
    const fresh = await connect(token);
    expect((await fresh.listTools()).tools).toHaveLength(TOOL_NAMES.length);
    expect((await req('DELETE', `/api/users/${mcpId}/token`, admin)).json.user.tokenHint).toBeNull();
    await expect(fresh.listTools()).rejects.toThrow(/401|令牌/);
    await fresh.close();
  });
});
