import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { HttpError, requireUser } from '../auth.js';
import { getProject, projectDoc, type ProjectRow } from '../projects.js';

export interface ShareInfo {
  token: string;
  sharedAt: number | null;
  sharedBy: string | null;
}

export function shareInfo(p: ProjectRow, names: Map<number, string>): ShareInfo | null {
  if (!p.share_token) return null;
  return { token: p.share_token, sharedAt: p.shared_at, sharedBy: p.shared_by ? names.get(p.shared_by) ?? null : null };
}

/**
 * Any signed-in user may share a project (everyone signed in can already edit every project).
 * The link shows the current version read-only to anyone who has it; a signed-in visitor can go on to edit.
 */
export function shareRoutes(app: FastifyInstance, db: DB) {
  const mustProject = (id: string) => {
    const p = getProject(db, id);
    if (!p) throw new HttpError(404, '项目不存在');
    return p;
  };

  app.post('/api/projects/:id/share', async (req) => {
    const user = requireUser(req);
    const p = mustProject((req.params as { id: string }).id);
    const { reset } = (req.body ?? {}) as { reset?: unknown };
    if (!p.share_token || reset === true) {
      db.prepare('UPDATE projects SET share_token = ?, shared_by = ?, shared_at = ? WHERE id = ?').run(
        crypto.randomBytes(18).toString('base64url'),
        user.id,
        Date.now(),
        p.id,
      );
    }
    const row = getProject(db, p.id)!;
    const by = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(row.shared_by) as { username: string; display_name: string } | undefined;
    return { share: shareInfo(row, new Map(by ? [[row.shared_by!, by.display_name || by.username]] : [])) };
  });

  app.delete('/api/projects/:id/share', async (req) => {
    requireUser(req);
    const p = mustProject((req.params as { id: string }).id);
    db.prepare('UPDATE projects SET share_token = NULL, shared_by = NULL, shared_at = NULL WHERE id = ?').run(p.id);
    return { share: null };
  });

  /** Public. The README (its change log names users and their requests) stays private. */
  app.get('/api/share/:token', async (req, reply) => {
    const token = String((req.params as { token: string }).token);
    const p = /^[A-Za-z0-9_-]{16,64}$/.test(token)
      ? (db.prepare('SELECT * FROM projects WHERE share_token = ?').get(token) as ProjectRow | undefined)
      : undefined;
    if (!p) throw new HttpError(404, '分享链接无效或已被关闭');
    const doc = projectDoc(p);
    reply.header('Cache-Control', 'no-store');
    return {
      project: {
        ...(req.user ? { id: p.id } : {}),
        type: p.type,
        name: p.name,
        versionNo: p.version_no,
        status: p.status,
        updatedAt: p.updated_at,
      },
      doc: doc?.pages.length ? { title: doc.title, width: doc.width, height: doc.height, head: doc.head, css: doc.css, pages: doc.pages } : null,
      canEdit: !!req.user,
    };
  });
}
