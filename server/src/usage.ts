/** Usage statistics of the model endpoints: totals per model and per user, and a day-by-day series. */
import type { DB } from './db.js';
import { inflightCount } from './llm.js';
import { SPEED_SQL, tokensPerSec } from './calls.js';

const DAY_MS = 86_400_000;

/** Per-model and per-user totals of everything since `since` (all time when omitted). */
export function usageTables(db: DB, since?: number) {
  const args = since === undefined ? [] : [since];
  const rows = db
    .prepare(
      `SELECT u.username, e.name AS endpoint, COUNT(*) AS calls, SUM(j.prompt_tokens) AS promptTokens,
              SUM(j.completion_tokens) AS completionTokens, SUM(j.cost) AS cost
       FROM jobs j LEFT JOIN users u ON u.id = j.user_id LEFT JOIN llm_endpoints e ON e.id = j.endpoint_id
       WHERE j.endpoint_id IS NOT NULL ${since === undefined ? '' : 'AND j.created_at >= ?'}
       GROUP BY j.user_id, j.endpoint_id ORDER BY cost DESC`,
    )
    .all(...args) as any[];
  // Output speed comes from the recorded model calls (jobs from before the calls were recorded have none).
  const speedRows = db
    .prepare(
      `SELECT u.username, e.name AS endpoint, ${SPEED_SQL}
       FROM llm_calls c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN llm_endpoints e ON e.id = c.endpoint_id
       ${since === undefined ? '' : 'WHERE c.started_at >= ?'}
       GROUP BY c.user_id, c.endpoint_id`,
    )
    .all(...args) as any[];
  const speed = new Map(speedRows.map((r) => [`${r.username}\u0000${r.endpoint}`, tokensPerSec(r.speed_tokens, r.speed_ms)]));
  const models = (
    db
      .prepare(
        `SELECT e.id, e.name, e.model, e.max_concurrency, COUNT(c.id) AS calls, SUM(c.status = 'error') AS failed,
                SUM(c.prompt_tokens) AS promptTokens, SUM(c.completion_tokens) AS completionTokens,
                AVG(CASE WHEN c.first_token_at IS NOT NULL THEN c.first_token_at - c.started_at END) AS firstTokenMs,
                AVG(c.queued_ms) AS queuedMs, ${SPEED_SQL}
         FROM llm_endpoints e LEFT JOIN llm_calls c ON c.endpoint_id = e.id ${since === undefined ? '' : 'AND c.started_at >= ?'}
         GROUP BY e.id ORDER BY e.priority, e.id`,
      )
      .all(...args) as any[]
  ).map((r) => ({
    endpointId: r.id,
    endpoint: r.name,
    model: r.model,
    calls: r.calls,
    failedCalls: r.failed ?? 0,
    promptTokens: r.promptTokens ?? 0,
    completionTokens: r.completionTokens ?? 0,
    tokensPerSec: tokensPerSec(r.speed_tokens, r.speed_ms),
    firstTokenMs: r.firstTokenMs === null ? null : Math.round(r.firstTokenMs),
    queuedMs: r.queuedMs === null ? null : Math.round(r.queuedMs),
    inflight: inflightCount(r.id),
    maxConcurrency: r.max_concurrency ?? 0,
  }));
  return {
    usage: rows.map((r) => ({ ...r, tokensPerSec: speed.get(`${r.username}\u0000${r.endpoint}`) ?? null })),
    models,
  };
}

/**
 * Start of the day `daysAgo` days before the one holding `now`, in the viewer's time zone.
 * `tzOffset` is what the viewer's `Date.getTimezoneOffset()` returns (minutes; UTC+8 is -480).
 */
export function dayStart(now: number, tzOffset: number, daysAgo = 0): number {
  const shift = tzOffset * 60_000;
  return Math.floor((now - shift) / DAY_MS) * DAY_MS + shift - daysAgo * DAY_MS;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface DailyUsage {
  /** The viewer's local date, YYYY-MM-DD. */
  date: string;
  /** Requests (generations and changes) made that day, and how many of them failed. */
  tasks: number;
  failedTasks: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Average output speed of that day's model calls; null when none could be measured. */
  tokensPerSec: number | null;
}

/** One entry per local day for the last `days` days, today last; days without use are zeros. */
export function dailyUsage(db: DB, days: number, tzOffset: number, now = Date.now()): DailyUsage[] {
  const shift = tzOffset * 60_000;
  const since = dayStart(now, tzOffset, days - 1);
  const day = (col: string) => `date((${col} - ${shift}) / 1000, 'unixepoch')`;
  const calls = db
    .prepare(
      `SELECT ${day('c.started_at')} AS day, COUNT(*) AS calls, SUM(c.prompt_tokens) AS promptTokens,
              SUM(c.completion_tokens) AS completionTokens, ${SPEED_SQL}
       FROM llm_calls c WHERE c.started_at >= ? GROUP BY day`,
    )
    .all(since) as any[];
  const jobs = db
    .prepare(`SELECT ${day('j.created_at')} AS day, COUNT(*) AS tasks, SUM(j.status = 'error') AS failed FROM jobs j WHERE j.created_at >= ? GROUP BY day`)
    .all(since) as any[];
  const byCalls = new Map(calls.map((r) => [r.day as string, r]));
  const byJobs = new Map(jobs.map((r) => [r.day as string, r]));
  return Array.from({ length: days }, (_, i) => {
    const date = dayKey(since + i * DAY_MS - shift);
    const c = byCalls.get(date);
    const j = byJobs.get(date);
    return {
      date,
      tasks: j?.tasks ?? 0,
      failedTasks: j?.failed ?? 0,
      calls: c?.calls ?? 0,
      promptTokens: c?.promptTokens ?? 0,
      completionTokens: c?.completionTokens ?? 0,
      tokensPerSec: c ? tokensPerSec(c.speed_tokens, c.speed_ms) : null,
    };
  });
}
