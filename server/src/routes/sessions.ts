import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { HttpError, requireAdmin } from '../auth.js';
import { jobProgress, type JobRow } from '../projects.js';
import { pendingQuestion } from '../questions.js';
import { jobDuration, jobStats, tokensPerSec } from '../calls.js';

type SessionRow = JobRow & {
  project_name: string | null;
  project_type: string | null;
  username: string | null;
  display_name: string | null;
  endpoints: string | null;
};

const ACTIVE = `j.status IN ('pending','running')`;

function describe(j: JobRow): string {
  const req = JSON.parse(j.request || '{}');
  if (j.kind === 'edit') return String(req.prompt ?? '');
  const brief = req.brief ?? {};
  return String(brief.topic ?? brief.name ?? brief.title ?? Object.values(brief).find((v) => typeof v === 'string') ?? '');
}

/** Admin view of every generation and edit job ("session"): what runs now, what ran before, and how fast. */
export function sessionRoutes(app: FastifyInstance, db: DB) {
  app.get('/api/admin/sessions', async (req) => {
    requireAdmin(req);
    const q = req.query as { status?: string; limit?: string; offset?: string };
    const active = q.status !== 'history';
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 50));
    const offset = Math.max(0, Number(q.offset) || 0);
    const where = active ? ACTIVE : `NOT ${ACTIVE}`;
    const rows = db
      .prepare(
        `SELECT j.*, p.name AS project_name, p.type AS project_type, u.username, u.display_name,
                (SELECT GROUP_CONCAT(DISTINCT e.name) FROM llm_calls c JOIN llm_endpoints e ON e.id = c.endpoint_id WHERE c.job_id = j.id) AS endpoints
         FROM jobs j LEFT JOIN projects p ON p.id = j.project_id LEFT JOIN users u ON u.id = j.user_id
         WHERE ${where} ORDER BY j.created_at ${active ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as SessionRow[];
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM jobs j WHERE ${where}`).get() as { c: number }).c;
    const liveCount = active ? total : (db.prepare(`SELECT COUNT(*) AS c FROM jobs j WHERE ${ACTIVE}`).get() as { c: number }).c;
    const stats = jobStats(db, rows.map((r) => r.id));
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS calls, SUM(prompt_tokens) AS promptTokens, SUM(completion_tokens) AS completionTokens
         FROM llm_calls WHERE started_at >= ?`,
      )
      .get(Date.now() - 24 * 3600_000) as { calls: number; promptTokens: number | null; completionTokens: number | null };
    return {
      total,
      liveCount,
      last24h: { calls: totals.calls, promptTokens: totals.promptTokens ?? 0, completionTokens: totals.completionTokens ?? 0 },
      sessions: rows.map((j) => {
        const req = JSON.parse(j.request || '{}');
        const question = pendingQuestion(j.id);
        return {
          id: j.id,
          projectId: j.project_id,
          projectName: j.project_name,
          projectType: j.project_type,
          userName: j.display_name || j.username || '（已删除用户）',
          kind: j.kind,
          status: j.status,
          scope: req.scope ?? 'global',
          prompt: describe(j).slice(0, 300),
          stage: question ? `等待回答：${question.text}` : jobProgress.get(j.id)?.stage ?? null,
          error: j.error,
          versionId: j.version_id,
          endpoints: j.endpoints ? j.endpoints.split(',') : [],
          retryOf: j.retry_of ?? null,
          retriedBy: j.retried_by ?? null,
          resumeCount: j.resume_count ?? 0,
          createdAt: j.created_at,
          finishedAt: j.finished_at ?? null,
          durationMs: jobDuration(j),
          stats: stats.get(j.id) ?? null,
        };
      }),
    };
  });

  app.get('/api/admin/sessions/:id/calls', async (req) => {
    requireAdmin(req);
    const id = (req.params as any).id as string;
    if (!db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id)) throw new HttpError(404, '任务不存在');
    const rows = db
      .prepare(
        `SELECT c.*, e.name AS endpoint_name FROM llm_calls c LEFT JOIN llm_endpoints e ON e.id = c.endpoint_id
         WHERE c.job_id = ? ORDER BY c.started_at, c.id`,
      )
      .all(id) as any[];
    return {
      calls: rows.map((c) => {
        const outMs = c.first_token_at && c.ended_at ? c.ended_at - c.first_token_at : null;
        return {
          id: c.id,
          endpoint: c.endpoint_name ?? `#${c.endpoint_id}`,
          model: c.model,
          stage: c.stage,
          status: c.status,
          error: c.error,
          queuedMs: c.queued_ms,
          startedAt: c.started_at,
          firstTokenMs: c.first_token_at ? c.first_token_at - c.started_at : null,
          durationMs: c.ended_at ? c.ended_at - c.started_at : null,
          promptTokens: c.prompt_tokens,
          completionTokens: c.completion_tokens,
          estimated: !!c.estimated,
          tokensPerSec: c.status === 'ok' ? tokensPerSec(c.completion_tokens, outMs) : null,
        };
      }),
    };
  });
}
