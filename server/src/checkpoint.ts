/**
 * Progress of running jobs, so that a job whose model went away for a while (a local model restarting,
 * a network outage) can continue where it stopped instead of starting over.
 *
 * Only the latest change of a project keeps its progress after failing: the checkpoint goes stale once
 * a newer job starts or a newer version is saved, and a job that finishes drops it.
 */
import zlib from 'node:zlib';
import type { DB } from './db.js';

export interface CheckpointInfo {
  /** What was done, e.g. "已完成规划与 6/12 页". */
  label: string;
  savedAt: number;
}

/** Jobs (alias j) whose checkpoint can no longer be used. */
const STALE = `(j.status NOT IN ('pending', 'running') AND (
  j.status <> 'error'
  OR EXISTS (SELECT 1 FROM jobs n WHERE n.project_id = j.project_id AND (n.created_at > j.created_at OR (n.created_at = j.created_at AND n.rowid > j.rowid)))
  OR EXISTS (SELECT 1 FROM project_versions v WHERE v.project_id = j.project_id AND v.created_at > COALESCE(j.finished_at, j.updated_at))
))`;

export function saveCheckpoint(db: DB, jobId: string, label: string, data: unknown) {
  const blob = zlib.gzipSync(JSON.stringify(data), { level: 1 });
  db.prepare(
    `INSERT INTO job_checkpoints (job_id, label, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET label = excluded.label, data = excluded.data, updated_at = excluded.updated_at`,
  ).run(jobId, label, blob, Date.now());
}

/** The checkpoint of a job, if it can still be used. */
export function loadCheckpoint<T>(db: DB, jobId: string): (CheckpointInfo & { data: T }) | null {
  const row = db
    .prepare(`SELECT c.label, c.data, c.updated_at FROM job_checkpoints c JOIN jobs j ON j.id = c.job_id WHERE c.job_id = ? AND NOT ${STALE}`)
    .get(jobId) as { label: string; data: Buffer; updated_at: number } | undefined;
  if (!row) return null;
  return { label: row.label, savedAt: row.updated_at, data: JSON.parse(zlib.gunzipSync(row.data).toString('utf8')) as T };
}

export function deleteCheckpoint(db: DB, jobId: string) {
  db.prepare('DELETE FROM job_checkpoints WHERE job_id = ?').run(jobId);
}

/** Failed jobs among `ids` that can continue from their checkpoint. */
export function resumableJobs(db: DB, ids: string[]): Map<string, CheckpointInfo> {
  const out = new Map<string, CheckpointInfo>();
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT c.job_id, c.label, c.updated_at FROM job_checkpoints c JOIN jobs j ON j.id = c.job_id
       WHERE c.job_id IN (SELECT value FROM json_each(?)) AND j.status = 'error' AND NOT ${STALE}`,
    )
    .all(JSON.stringify(ids)) as { job_id: string; label: string; updated_at: number }[];
  for (const r of rows) out.set(r.job_id, { label: r.label, savedAt: r.updated_at });
  return out;
}

/** Drops checkpoints that can no longer be used (of one project, or of all). */
export function pruneCheckpoints(db: DB, projectId?: string) {
  db.prepare(
    `DELETE FROM job_checkpoints WHERE job_id IN (
       SELECT j.id FROM jobs j JOIN job_checkpoints c ON c.job_id = j.id WHERE ${projectId ? 'j.project_id = ? AND' : ''} ${STALE}
     )`,
  ).run(...(projectId ? [projectId] : []));
}
