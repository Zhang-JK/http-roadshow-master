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
    expect(batch[1].result.tools.map((t: any) => t.name)).toEqual(['list_roadshow_templates', 'create_roadshow_slides', 'get_roadshow_slides_status']);
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
    expect(tools.map((t) => t.name)).toEqual(['list_roadshow_templates', 'create_roadshow_slides', 'get_roadshow_slides_status']);
    const create = tools.find((t) => t.name === 'create_roadshow_slides')!;
    expect(create.inputSchema.required).toEqual(['templateId', 'name', 'content']);
    expect((create.inputSchema.properties as any).templateId.enum).toEqual([templateId]);
    expect(create.description).toMatch(/test data|exact values/);
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
    ]);

    const p = (await req('GET', `/api/projects/${projectId}`, admin)).json;
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
    expect(Object.keys(status.downloads)).toEqual(['html', 'pdf', 'pdf-image', 'pptx', 'zip']);

    const calls = mock.calls.slice(before);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => !(c.body.tools ?? []).some((t: any) => t.function.name === 'ask_user'))).toBe(true);
    expect(calls[0].text).toContain('季度测试评审');
    expect(calls[0].text).toContain('baseline,12,48,5200');
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

  it('switching MCP off or replacing the token locks clients out', async () => {
    await req('PATCH', `/api/users/${mcpId}`, admin, { mcpEnabled: false });
    await expect(client.listTools()).rejects.toThrow(/403|允许 MCP 请求/);
    await req('PATCH', `/api/users/${mcpId}`, admin, { mcpEnabled: true });
    expect((await client.listTools()).tools).toHaveLength(3);
    const old = token;
    token = (await req('POST', `/api/users/${mcpId}/token`, admin)).json.token;
    expect(token).not.toBe(old);
    await expect(client.listTools()).rejects.toThrow(/401|令牌/);
    const fresh = await connect(token);
    expect((await fresh.listTools()).tools).toHaveLength(3);
    expect((await req('DELETE', `/api/users/${mcpId}/token`, admin)).json.user.tokenHint).toBeNull();
    await expect(fresh.listTools()).rejects.toThrow(/401|令牌/);
    await fresh.close();
  });
});
