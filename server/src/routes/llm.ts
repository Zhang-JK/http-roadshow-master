import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { getSettings, setSettings } from '../db.js';
import { HttpError, requireAdmin, requireUser } from '../auth.js';
import { callTimeouts, listEnabledEndpoints, rankEndpointsForUser, testEndpoint, type Endpoint } from '../llm.js';

const maskKey = (k: string) => (k.length <= 10 ? '****' : `${k.slice(0, 6)}…${k.slice(-4)}`);

const publicEndpoint = (e: Endpoint) => ({
  id: e.id,
  name: e.name,
  baseUrl: e.base_url,
  apiKeyMasked: maskKey(e.api_key),
  model: e.model,
  weight: e.weight,
  enabled: !!e.enabled,
  extraBody: e.extra_body,
  lastTestAt: e.last_test_at,
  lastTestOk: e.last_test_ok === null ? null : !!e.last_test_ok,
  lastTestMessage: e.last_test_message,
});

function validate(body: any, partial: boolean) {
  const out: Record<string, unknown> = {};
  const str = (k: string, required: boolean) => {
    if (body[k] === undefined) {
      if (required && !partial) throw new HttpError(400, `缺少字段 ${k}`);
      return;
    }
    const v = String(body[k]).trim();
    if (required && !v) throw new HttpError(400, `${k} 不能为空`);
    out[k] = v;
  };
  str('name', true);
  str('baseUrl', true);
  str('model', true);
  if (body.apiKey !== undefined && String(body.apiKey).trim()) out.apiKey = String(body.apiKey).trim();
  else if (!partial) throw new HttpError(400, 'API Token 不能为空');
  if (body.weight !== undefined) out.weight = Math.max(1, Math.min(100, Number(body.weight) || 1));
  if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;
  if (body.extraBody !== undefined) {
    const raw = String(body.extraBody || '{}').trim() || '{}';
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    } catch {
      throw new HttpError(400, '附加请求参数必须是 JSON 对象');
    }
    out.extraBody = raw;
  }
  if (out.baseUrl && !/^https?:\/\//.test(out.baseUrl as string)) throw new HttpError(400, '接入地址必须以 http:// 或 https:// 开头');
  return out;
}

export function llmRoutes(app: FastifyInstance, db: DB) {
  app.get('/api/llm/endpoints', async (req) => {
    requireAdmin(req);
    const rows = db.prepare('SELECT * FROM llm_endpoints ORDER BY id').all() as Endpoint[];
    return { endpoints: rows.map(publicEndpoint) };
  });

  app.post('/api/llm/endpoints', async (req) => {
    requireAdmin(req);
    const v = validate(req.body ?? {}, false);
    const r = db
      .prepare(
        `INSERT INTO llm_endpoints (name, base_url, api_key, model, weight, enabled, extra_body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.name, v.baseUrl, v.apiKey, v.model, v.weight ?? 1, v.enabled ?? 1, v.extraBody ?? '{}', Date.now());
    return { endpoint: publicEndpoint(db.prepare('SELECT * FROM llm_endpoints WHERE id = ?').get(r.lastInsertRowid) as Endpoint) };
  });

  app.put('/api/llm/endpoints/:id', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as any).id);
    if (!db.prepare('SELECT 1 FROM llm_endpoints WHERE id = ?').get(id)) throw new HttpError(404, '接入点不存在');
    const v = validate(req.body ?? {}, true);
    const map: Record<string, string> = {
      name: 'name',
      baseUrl: 'base_url',
      apiKey: 'api_key',
      model: 'model',
      weight: 'weight',
      enabled: 'enabled',
      extraBody: 'extra_body',
    };
    const entries = Object.entries(v);
    if (entries.length) {
      db.prepare(`UPDATE llm_endpoints SET ${entries.map(([k]) => `${map[k]} = ?`).join(', ')} WHERE id = ?`).run(
        ...entries.map(([, val]) => val),
        id,
      );
    }
    return { endpoint: publicEndpoint(db.prepare('SELECT * FROM llm_endpoints WHERE id = ?').get(id) as Endpoint) };
  });

  app.delete('/api/llm/endpoints/:id', async (req) => {
    requireAdmin(req);
    db.prepare('DELETE FROM llm_endpoints WHERE id = ?').run(Number((req.params as any).id));
    return { ok: true };
  });

  app.post('/api/llm/endpoints/:id/test', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as any).id);
    const ep = db.prepare('SELECT * FROM llm_endpoints WHERE id = ?').get(id) as Endpoint | undefined;
    if (!ep) throw new HttpError(404, '接入点不存在');
    const result = await testEndpoint(ep, callTimeouts(db).idleTimeoutMs);
    db.prepare('UPDATE llm_endpoints SET last_test_at = ?, last_test_ok = ?, last_test_message = ? WHERE id = ?').run(
      Date.now(),
      result.ok ? 1 : 0,
      result.message,
      id,
    );
    return { result };
  });

  /** Test a configuration before saving it. */
  app.post('/api/llm/test', async (req) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as any;
    let apiKey = String(body.apiKey ?? '').trim();
    if (!apiKey && body.id) {
      apiKey = (db.prepare('SELECT api_key FROM llm_endpoints WHERE id = ?').get(Number(body.id)) as any)?.api_key ?? '';
    }
    const v = validate({ ...body, apiKey: apiKey || undefined }, false);
    const ep: Endpoint = {
      id: 0,
      name: String(v.name),
      base_url: String(v.baseUrl),
      api_key: String(v.apiKey),
      model: String(v.model),
      weight: 1,
      enabled: 1,
      extra_body: String(v.extraBody ?? '{}'),
      last_test_at: null,
      last_test_ok: null,
      last_test_message: null,
      created_at: Date.now(),
    };
    return { result: await testEndpoint(ep, callTimeouts(db).idleTimeoutMs) };
  });

  /** Shows which endpoint each user is pinned to (rendezvous hashing over enabled endpoints). */
  app.get('/api/llm/assignments', async (req) => {
    requireAdmin(req);
    const eps = listEnabledEndpoints(db);
    const users = db.prepare('SELECT id, username FROM users ORDER BY id').all() as { id: number; username: string }[];
    return {
      assignments: users.map((u) => {
        const ranked = rankEndpointsForUser(eps, `rs-user-${u.id}`);
        return { userId: u.id, username: u.username, endpointId: ranked[0]?.id ?? null, endpointName: ranked[0]?.name ?? null };
      }),
    };
  });

  app.get('/api/llm/usage', async (req) => {
    requireAdmin(req);
    const rows = db
      .prepare(
        `SELECT u.username, e.name AS endpoint, COUNT(*) AS calls, SUM(j.prompt_tokens) AS promptTokens,
                SUM(j.completion_tokens) AS completionTokens, SUM(j.cost) AS cost
         FROM jobs j LEFT JOIN users u ON u.id = j.user_id LEFT JOIN llm_endpoints e ON e.id = j.endpoint_id
         WHERE j.endpoint_id IS NOT NULL GROUP BY j.user_id, j.endpoint_id ORDER BY cost DESC`,
      )
      .all();
    return { usage: rows };
  });

  app.get('/api/settings', async (req) => {
    requireUser(req);
    return { settings: getSettings(db) };
  });

  app.put('/api/settings', async (req) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (body.attachScreenshots !== undefined) patch.attachScreenshots = !!body.attachScreenshots;
    if (body.selfCheck !== undefined) patch.selfCheck = !!body.selfCheck;
    if (body.selfCheckRounds !== undefined) patch.selfCheckRounds = Math.max(1, Math.min(20, Math.floor(Number(body.selfCheckRounds)) || 10));
    if (body.maxTokens !== undefined) patch.maxTokens = Math.max(1000, Math.min(1_000_000, Math.floor(Number(body.maxTokens)) || 65536));
    if (body.contextTokens !== undefined) patch.contextTokens = Math.max(8000, Math.min(10_000_000, Math.floor(Number(body.contextTokens)) || 200000));
    if (body.generateMode !== undefined) patch.generateMode = body.generateMode === 'single' ? 'single' : 'files';
    if (body.genPagesPerCall !== undefined) patch.genPagesPerCall = Math.max(1, Math.min(10, Math.floor(Number(body.genPagesPerCall)) || 3));
    if (body.temperature !== undefined) patch.temperature = Math.max(0, Math.min(2, Number(body.temperature)));
    if (body.editMode !== undefined) patch.editMode = body.editMode === 'rewrite' ? 'rewrite' : 'tools';
    if (body.editToolRounds !== undefined) patch.editToolRounds = Math.max(2, Math.min(40, Math.floor(Number(body.editToolRounds)) || 12));
    if (body.llmIdleTimeoutSec !== undefined) patch.llmIdleTimeoutSec = Math.max(30, Math.min(7200, Math.floor(Number(body.llmIdleTimeoutSec)) || 600));
    if (body.llmMaxCallMinutes !== undefined) patch.llmMaxCallMinutes = Math.max(5, Math.min(1440, Math.floor(Number(body.llmMaxCallMinutes)) || 120));
    setSettings(db, patch);
    return { settings: getSettings(db) };
  });
}
