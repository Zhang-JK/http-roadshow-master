/**
 * Every model call a job makes: when it was queued, when the first token arrived, when it ended and
 * how many tokens went in and out. Output speed (tokens per second) is measured from the first token
 * to the end of the reply, so waiting for a busy model and reading a long prompt do not count.
 */
import type { DB } from './db.js';

export interface CallRecord {
  jobId: string;
  userId?: number;
  endpointId: number;
  model: string;
  stage?: string;
  queuedMs: number;
  startedAt: number;
  firstTokenAt?: number;
  endedAt: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Token counts estimated from the text because the endpoint reported no usage. */
  estimated: boolean;
  status: 'ok' | 'error';
  error?: string;
}

export function recordCall(db: DB, c: CallRecord) {
  try {
    db.prepare(
      `INSERT INTO llm_calls (job_id, user_id, endpoint_id, model, stage, queued_ms, started_at, first_token_at, ended_at,
                              prompt_tokens, completion_tokens, estimated, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      c.jobId,
      c.userId ?? null,
      c.endpointId,
      c.model,
      c.stage ?? null,
      c.queuedMs,
      c.startedAt,
      c.firstTokenAt ?? null,
      c.endedAt,
      c.promptTokens ?? null,
      c.completionTokens ?? null,
      c.estimated ? 1 : 0,
      c.status,
      c.error?.slice(0, 2000) ?? null,
    );
  } catch {
    /* the job may have been deleted with its project meanwhile */
  }
}

/** A model call in progress; a job may have several at once (page batches written in parallel). */
export interface LiveCall {
  endpointId: number;
  endpointName: string;
  model: string;
  stage?: string;
  /** Waiting for a free slot on an endpoint (its parallel limit is reached). */
  queuedSince?: number;
  startedAt?: number;
  firstTokenAt?: number;
  /** Output so far (text, reasoning and tool arguments), estimated in tokens. */
  tokens: number;
}

const liveCalls = new Map<string, Set<LiveCall>>();

export function addLiveCall(jobId: string, call: LiveCall) {
  const set = liveCalls.get(jobId) ?? new Set();
  set.add(call);
  liveCalls.set(jobId, set);
}

export function removeLiveCall(jobId: string, call: LiveCall) {
  const set = liveCalls.get(jobId);
  if (!set) return;
  set.delete(call);
  if (!set.size) liveCalls.delete(jobId);
}

/** The job's calls in progress taken together: total output, combined speed, queued only if all are. */
function liveStats(calls: LiveCall[], now: number): JobStats['live'] {
  if (!calls.length) return null;
  const running = calls.filter((l) => l.startedAt);
  const speeds = running.map((l) => (l.firstTokenAt && now - l.firstTokenAt >= 1000 ? tokensPerSec(l.tokens, now - l.firstTokenAt) : null));
  const queued = !running.length;
  const silent = running.filter((l) => !l.firstTokenAt);
  return {
    stage: calls.length === 1 ? calls[0].stage : `${calls.length} 个模型调用同时进行`,
    endpoint: [...new Set(running.map((l) => l.endpointName))].join('、'),
    queued,
    tokens: calls.reduce((n, l) => n + l.tokens, 0),
    tokensPerSec: speeds.some((s) => s !== null) ? Math.round(speeds.reduce<number>((n, s) => n + (s ?? 0), 0) * 10) / 10 : null,
    waitingMs: queued
      ? now - Math.min(...calls.map((l) => l.queuedSince ?? now))
      : silent.length === running.length
        ? now - Math.max(...running.map((l) => l.startedAt!))
        : 0,
    parallel: calls.length,
  };
}

/** Seconds of output and tokens produced in them, for calls whose speed can be measured. */
export const SPEED_SQL = `SUM(CASE WHEN c.status = 'ok' AND c.first_token_at IS NOT NULL AND c.ended_at > c.first_token_at AND c.completion_tokens > 0 THEN c.completion_tokens END) AS speed_tokens,
  SUM(CASE WHEN c.status = 'ok' AND c.first_token_at IS NOT NULL AND c.ended_at > c.first_token_at AND c.completion_tokens > 0 THEN c.ended_at - c.first_token_at END) AS speed_ms`;

export const tokensPerSec = (tokens: number | null | undefined, ms: number | null | undefined): number | null =>
  tokens && ms && ms >= 200 ? Math.round((tokens / ms) * 10_000) / 10 : null;

/**
 * Wall time of a job: until it finished, or until now while it runs. A job continued after a failure
 * counts its earlier runs (prior_ms) but not the time it sat failed.
 */
export const jobDuration = (j: {
  status: string;
  created_at: number;
  updated_at: number;
  finished_at?: number | null;
  resumed_at?: number | null;
  prior_ms?: number | null;
}) => (j.prior_ms ?? 0) + (j.finished_at ?? (j.status === 'done' || j.status === 'error' ? j.updated_at : Date.now())) - (j.resumed_at ?? j.created_at);

export interface JobStats {
  calls: number;
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
  /** Average output speed over the finished calls. */
  tokensPerSec: number | null;
  /** The calls running now, together: output speed and tokens so far; `parallel` is how many. */
  live: { stage?: string; endpoint: string; queued: boolean; tokens: number; tokensPerSec: number | null; waitingMs: number; parallel: number } | null;
}

interface StatsRow {
  job_id: string;
  calls: number;
  failed: number;
  prompt: number | null;
  completion: number | null;
  estimated: number | null;
  speed_tokens: number | null;
  speed_ms: number | null;
}

/** Totals for the given jobs (one query), plus the live call of running ones. */
export function jobStats(db: DB, jobIds: string[]): Map<string, JobStats> {
  const out = new Map<string, JobStats>();
  if (!jobIds.length) return out;
  const rows: StatsRow[] = [];
  for (let i = 0; i < jobIds.length; i += 500) {
    const ids = jobIds.slice(i, i + 500);
    rows.push(
      ...(db
        .prepare(
          `SELECT c.job_id, COUNT(*) AS calls, SUM(c.status = 'error') AS failed, SUM(c.prompt_tokens) AS prompt,
                  SUM(c.completion_tokens) AS completion, MAX(c.estimated) AS estimated, ${SPEED_SQL}
           FROM llm_calls c WHERE c.job_id IN (${ids.map(() => '?').join(',')}) GROUP BY c.job_id`,
        )
        .all(...ids) as StatsRow[]),
    );
  }
  const byId = new Map(rows.map((r) => [r.job_id, r]));
  const now = Date.now();
  for (const id of jobIds) {
    const r = byId.get(id);
    const live = liveStats([...(liveCalls.get(id) ?? [])], now);
    out.set(id, {
      calls: r?.calls ?? 0,
      failedCalls: r?.failed ?? 0,
      promptTokens: r?.prompt ?? 0,
      completionTokens: (r?.completion ?? 0) + (live?.tokens ?? 0),
      estimated: !!r?.estimated || !!live,
      tokensPerSec: tokensPerSec(r?.speed_tokens, r?.speed_ms),
      live,
    });
  }
  return out;
}
