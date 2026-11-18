import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockLlm } from './mockLlm.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-folders-'));
process.env.DATA_DIR = tmp;

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockLlm>>;
let base = '';
let admin = '';
let token = '';
let templateId = '';
let oldTemplateId = '';

async function req(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie: admin } });
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

const folders = async () => (await req('GET', '/api/folders')).json.folders as any[];
const project = async (id: string) => (await req('GET', `/api/projects/${id}`)).json.project;

async function makeDeck(name: string, folderId?: string) {
  const r = await req('POST', '/api/projects', { type: 'deck', templateId, name, content: '介绍产品', ...(folderId !== undefined ? { folderId } : {}) });
  if (r.status === 200) expect((await waitJob(r.json.job.id)).status).toBe('done');
  return r;
}

beforeAll(async () => {
  mock = await startMockLlm();
  const { openDb } = await import('../src/db.js');
  const { buildApp } = await import('../src/app.js');
  const db = openDb(path.join(tmp, 'test.db'));
  app = await buildApp(db, { serveWeb: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } });
  admin = String(login.headers['set-cookie']).split(';')[0];
  await req('POST', '/api/llm/endpoints', { name: 'mock', baseUrl: mock.url, apiKey: 'good-key', model: 'mock-vision' });
  await req('PUT', '/api/settings', { selfCheck: false });
  const mcp = (await req('GET', '/api/users')).json.users.find((u: any) => u.username === 'mcp');
  await req('PATCH', `/api/users/${mcp.id}`, { mcpEnabled: true });
  token = (await req('POST', `/api/users/${mcp.id}/token`)).json.token;
  for (const name of ['在用模板', '旧模板']) {
    const t = await req('POST', '/api/projects', { type: 'template', name, style: '简约', purpose: '汇报' });
    expect((await waitJob(t.json.job.id)).status).toBe('done');
    if (name === '在用模板') templateId = t.json.project.id;
    else oldTemplateId = t.json.project.id;
  }
});

afterAll(async () => {
  await app?.close();
  await mock?.close();
  const { closeBrowser } = await import('../src/render.js');
  await closeBrowser();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('deck folders', () => {
  let qa = '';
  let y2026 = '';

  it('are created at the top level or inside another, with names unique among siblings', async () => {
    const a = await req('POST', '/api/folders', { name: '  QA  ' });
    expect(a.status).toBe(200);
    qa = a.json.folder.id;
    expect(a.json.folder).toMatchObject({ name: 'QA', parentId: null, deckCount: 0, folderCount: 0, createdBy: '管理员' });
    const b = await req('POST', '/api/folders', { name: '2026', parentId: qa });
    y2026 = b.json.folder.id;
    expect(b.json.folder.parentId).toBe(qa);
    expect((await req('POST', '/api/folders', { name: 'qa' })).status).toBe(409);
    expect((await req('POST', '/api/folders', { name: '2026' })).status).toBe(200);
    expect((await req('POST', '/api/folders', { name: '   ' })).status).toBe(400);
    expect((await req('POST', '/api/folders', { name: 'x', parentId: 'nope' })).status).toBe(400);
    expect((await req('POST', '/api/folders', { name: 'a/b' })).json.folder.name).toBe('a b');
    expect((await folders()).find((f) => f.id === qa).folderCount).toBe(1);
  });

  it('are renamed and moved, never into themselves', async () => {
    expect((await req('PATCH', `/api/folders/${qa}`, { parentId: y2026 })).json.error).toMatch(/自己或它的子文件夹/);
    expect((await req('PATCH', `/api/folders/${qa}`, { parentId: qa })).status).toBe(400);
    expect((await req('PATCH', `/api/folders/${y2026}`, { name: '2026 年' })).json.folder.name).toBe('2026 年');
    const top = (await folders()).find((f) => f.name === '2026' && !f.parentId);
    expect((await req('PATCH', `/api/folders/${top.id}`, { parentId: qa, name: '2026 年' })).status).toBe(409);
    expect((await req('PATCH', `/api/folders/${top.id}`, { parentId: qa })).json.folder.parentId).toBe(qa);
  });

  it('hold decks: created in one, moved between them and back to the top level', async () => {
    const deck = await makeDeck('年度回顾', y2026);
    expect(deck.json.project.folderId).toBe(y2026);
    expect((await folders()).find((f) => f.id === y2026).deckCount).toBe(1);
    expect((await makeDeck('坏文件夹', 'nope')).json.error).toMatch(/文件夹不存在/);
    const id = deck.json.project.id;
    expect((await req('PATCH', `/api/projects/${id}`, { folderId: qa })).json.project.folderId).toBe(qa);
    expect((await req('PATCH', `/api/projects/${id}`, { folderId: null })).json.project.folderId).toBeNull();
    expect((await req('PATCH', `/api/projects/${id}`, { folderId: y2026, name: '年度回顾（终版）' })).json.project).toMatchObject({
      folderId: y2026,
      name: '年度回顾（终版）',
    });
    // Templates are never in a folder.
    expect((await req('PATCH', `/api/projects/${templateId}`, { folderId: qa })).status).toBe(400);
    const t = await req('POST', '/api/projects', { type: 'template', name: '不进文件夹', style: '简约', folderId: qa });
    expect(t.json.project.folderId).toBeNull();
    await waitJob(t.json.job.id);
    expect((await req('PATCH', `/api/projects/${id}`, {})).status).toBe(400);
  });

  it('deleting one moves what it held up a level', async () => {
    const parent = (await req('POST', '/api/folders', { name: '待删' })).json.folder.id;
    const child = (await req('POST', '/api/folders', { name: 'QA', parentId: parent })).json.folder.id;
    const deck = await makeDeck('待删里的材料', parent);
    const r = await req('DELETE', `/api/folders/${parent}`);
    expect(r.json).toEqual({ ok: true, movedDecks: 1, movedFolders: 1 });
    expect((await project(deck.json.project.id)).folderId).toBeNull();
    // The top level already has a "QA": the moved one is numbered.
    expect((await folders()).find((f) => f.id === child)).toMatchObject({ parentId: null, name: 'QA (2)' });
    expect((await req('DELETE', `/api/folders/${parent}`)).status).toBe(404);
  });
});

describe('archiving', () => {
  it('marks a deck or template archived and back, without changing anything else', async () => {
    const deck = await makeDeck('要归档的材料');
    const id = deck.json.project.id;
    const before = await project(id);
    const r = await req('PATCH', `/api/projects/${id}`, { archived: true });
    expect(r.json.project).toMatchObject({ archivedBy: '管理员', versionNo: before.versionNo, updatedAt: before.updatedAt });
    expect(r.json.project.archivedAt).toBeGreaterThan(0);
    expect((await req('PATCH', `/api/projects/${id}`, { archived: 'yes' })).status).toBe(400);
    // Archived decks still open and change.
    expect((await req('GET', `/api/projects/${id}`)).status).toBe(200);
    const back = await req('PATCH', `/api/projects/${id}`, { archived: false });
    expect(back.json.project).toMatchObject({ archivedAt: null, archivedBy: null });
  });

  it('counts archived decks apart in their folder', async () => {
    const f = (await req('POST', '/api/folders', { name: '归档计数' })).json.folder.id;
    const deck = await makeDeck('计数材料', f);
    await req('PATCH', `/api/projects/${deck.json.project.id}`, { archived: true });
    expect((await folders()).find((x) => x.id === f)).toMatchObject({ deckCount: 0, archivedCount: 1 });
  });

  it('an archived template starts no new deck and is not offered through MCP', async () => {
    await req('PATCH', `/api/projects/${oldTemplateId}`, { archived: true });
    const r = await req('POST', '/api/projects', { type: 'deck', templateId: oldTemplateId, name: 'x', content: 'y' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/已归档/);
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      const offered = (tools.find((t) => t.name === 'create_roadshow_slides')!.inputSchema.properties as any).templateId.enum;
      expect(offered).toContain(templateId);
      expect(offered).not.toContain(oldTemplateId);
      const list: any = await client.callTool({ name: 'list_roadshow_templates', arguments: {} });
      const listed = list.structuredContent.templates.map((t: any) => t.templateId);
      expect(listed).toContain(templateId);
      expect(listed).not.toContain(oldTemplateId);
    } finally {
      await client.close();
    }
    await req('PATCH', `/api/projects/${oldTemplateId}`, { archived: false });
    expect((await req('POST', '/api/projects', { type: 'deck', templateId: oldTemplateId, name: 'x', content: 'y' })).status).toBe(200);
  });

  it('a template that decks use cannot be deleted, and the error points to archiving', async () => {
    const r = await req('DELETE', `/api/projects/${templateId}`);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/可以归档/);
  });
});

async function connect() {
  const client = new Client({ name: 'folders-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

describe('folders and archiving through MCP', () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect();
  });
  afterAll(async () => {
    await client?.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as any;

  it('create_roadshow_folder makes a folder, nested or not, and returns the existing one on a second call', async () => {
    const top = await call('create_roadshow_folder', { name: 'MCP 报告' });
    expect(top.isError).toBeFalsy();
    expect(top.structuredContent).toMatchObject({ name: 'MCP 报告', path: 'MCP 报告', parentFolderId: null, created: true, mcpDecks: 0 });
    const again = await call('create_roadshow_folder', { name: 'mcp 报告' });
    expect(again.structuredContent).toMatchObject({ folderId: top.structuredContent.folderId, created: false });
    const sub = await call('create_roadshow_folder', { name: '压测', parentFolderId: top.structuredContent.folderId });
    expect(sub.structuredContent).toMatchObject({ path: 'MCP 报告 / 压测', parentFolderId: top.structuredContent.folderId, created: true });
    expect((await call('create_roadshow_folder', { name: 'x', parentFolderId: 'nope' })).isError).toBe(true);
    expect(textOfError(await call('create_roadshow_folder', { name: ' / ' }))).toMatch(/more than slashes/);
    // The web page sees the same folders.
    expect((await folders()).find((f) => f.id === sub.structuredContent.folderId)).toMatchObject({ name: '压测', parentId: top.structuredContent.folderId });
  });

  it('list_roadshow_folders shows every folder with its path; create and update put decks in them', async () => {
    const list = await call('list_roadshow_folders', {});
    const sub = list.structuredContent.folders.find((f: any) => f.path === 'MCP 报告 / 压测');
    expect(sub).toBeTruthy();
    expect(list.structuredContent.folders.some((f: any) => f.path === 'QA / 2026 年')).toBe(true);
    expect((await call('list_roadshow_folders', { query: '压测' })).structuredContent.folders).toHaveLength(1);

    const made = await call('create_roadshow_slides', { templateId, name: 'MCP 压测报告', content: '## 结果\np99 31 ms', folderId: sub.folderId });
    expect(made.isError).toBeFalsy();
    expect(made.structuredContent.folder).toEqual({ folderId: sub.folderId, path: 'MCP 报告 / 压测' });
    const id = made.structuredContent.projectId;
    for (let i = 0; i < 30; i++) {
      const s = await call('get_roadshow_slides_status', { projectId: id, waitSeconds: 5 });
      if (s.structuredContent.status !== 'generating') break;
    }
    expect((await project(id)).folderId).toBe(sub.folderId);
    expect((await call('list_roadshow_folders', { query: '压测' })).structuredContent.folders[0].mcpDecks).toBe(1);
    expect((await call('create_roadshow_slides', { templateId, name: 'x', content: 'y', folderId: 'nope' })).isError).toBe(true);

    const listed = await call('list_roadshow_slides', { folderId: sub.folderId });
    expect(listed.structuredContent.decks.map((d: any) => d.projectId)).toEqual([id]);
    expect(listed.structuredContent.decks[0]).toMatchObject({ folder: { folderId: sub.folderId, path: 'MCP 报告 / 压测' }, archived: false });

    const moved = await call('update_roadshow_slides', { projectId: id, folderId: '', archived: true });
    expect(moved.isError).toBeFalsy();
    expect(moved.structuredContent).toMatchObject({ folder: null, archived: true, next: 'Moved, archived; no generation needed.' });
    expect(await project(id)).toMatchObject({ folderId: null, archivedBy: 'MCP' });
    expect((await call('list_roadshow_slides', { archived: false })).structuredContent.decks.some((d: any) => d.projectId === id)).toBe(false);
    expect((await call('list_roadshow_slides', { archived: true })).structuredContent.decks.map((d: any) => d.projectId)).toEqual([id]);
    expect((await call('get_roadshow_slides', { projectId: id })).structuredContent).toMatchObject({ folder: null, archived: true });

    const restored = await call('update_roadshow_slides', { projectId: id, folderId: sub.folderId, archived: false });
    expect(restored.structuredContent).toMatchObject({ folder: { folderId: sub.folderId }, archived: false });
    expect((await call('update_roadshow_slides', { projectId: id, archived: 'no' })).isError).toBe(true);
  });
});

const textOfError = (r: any) => (r.content as any[]).map((c) => c.text).join('\n');
