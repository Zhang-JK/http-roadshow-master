import fs from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { HttpError, requireUser } from '../auth.js';
import { ASPECTS, assembleHtml, deletePage, duplicatePage, movePage, type DeckDoc } from '../deck.js';
import { assetPath, assetUrl, deleteAsset, makeAssetResolver, projectAssets, saveAsset, slideAssets, type AssetRole, type AssetRow } from '../assets.js';
import {
  applyManual,
  cleanTypedText,
  commitVersion,
  createProject,
  editElementText,
  getProject,
  MAX_ELEMENT_TEXT,
  jobProgress,
  projectDoc,
  retryJob,
  startEdit,
  startGeneration,
  withProjectLock,
  withReadme,
  type JobRow,
  type ProjectRow,
} from '../projects.js';
import { renderImagePdf, renderPdf, renderPptx } from '../render.js';
import { exportBundle } from '../bundle.js';
import { answerQuestion, pendingQuestion, projectsAsking } from '../questions.js';
import { cssFiles, fileTree, nameFiles } from '../files.js';
import { jobDuration, jobStats, type JobStats } from '../calls.js';

const MAX_README = 50_000;

const MAX_UPLOAD_FILES = 12;

function userNames(db: DB): Map<number, string> {
  const rows = db.prepare('SELECT id, username, display_name FROM users').all() as any[];
  return new Map(rows.map((r) => [r.id, r.display_name || r.username]));
}

/** Running jobs per project, for the spinner on the dashboard. */
function activeJobCounts(db: DB): Map<string, number> {
  const rows = db.prepare(`SELECT project_id, COUNT(*) AS c FROM jobs WHERE status IN ('pending','running') GROUP BY project_id`).all() as {
    project_id: string;
    c: number;
  }[];
  return new Map(rows.map((r) => [r.project_id, r.c]));
}

function publicProject(p: ProjectRow, names: Map<number, string>, withDoc: boolean, busy?: Map<string, number>) {
  const doc = projectDoc(p);
  const meta = JSON.parse(p.meta || '{}');
  return {
    id: p.id,
    type: p.type,
    name: p.name,
    meta,
    templateId: p.template_id,
    status: p.status,
    error: p.error,
    versionNo: p.version_no,
    pageCount: doc?.pages.length ?? 0,
    width: doc?.width ?? 1920,
    height: doc?.height ?? 1080,
    firstPageId: doc?.pages[0]?.id ?? null,
    asking: projectsAsking().has(p.id),
    busy: busy?.get(p.id) ?? 0,
    createdBy: p.created_by ? names.get(p.created_by) ?? null : null,
    updatedBy: p.updated_by ? names.get(p.updated_by) ?? null : null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    ...(withDoc ? { doc } : {}),
  };
}

function publicJob(j: JobRow, stats?: JobStats) {
  const progress = jobProgress.get(j.id);
  return {
    id: j.id,
    projectId: j.project_id,
    kind: j.kind,
    status: j.status,
    error: j.error,
    versionId: j.version_id,
    request: JSON.parse(j.request || '{}'),
    progress: progress ?? null,
    cost: j.cost,
    promptTokens: j.prompt_tokens,
    completionTokens: j.completion_tokens,
    review: j.review ? JSON.parse(j.review) : null,
    question: pendingQuestion(j.id) ?? null,
    questions: j.questions ? JSON.parse(j.questions) : [],
    stats: stats ?? null,
    durationMs: jobDuration(j),
    finishedAt: j.finished_at ?? null,
    retryOf: j.retry_of ?? null,
    retriedBy: j.retried_by ?? null,
    userId: j.user_id,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  };
}

const withStats = (db: DB, j: JobRow) => publicJob(j, jobStats(db, [j.id]).get(j.id));

const publicAsset = (db: DB, a: AssetRow) => {
  const slides = a.kind === 'document' ? slideAssets(db, a.id) : [];
  return {
    id: a.id,
    filename: a.filename,
    mime: a.mime,
    size: a.size,
    kind: a.kind,
    role: a.role,
    url: assetUrl(a.id),
    hasText: !!a.extracted_text,
    slideCount: slides.length,
    slideUrls: slides.map((s) => assetUrl(s.id)),
    createdAt: a.created_at,
  };
};

const parseRole = (v: unknown): AssetRole => (v === 'reference' ? 'reference' : 'embed');

function mustProject(db: DB, id: string): ProjectRow {
  const p = getProject(db, id);
  if (!p) throw new HttpError(404, '项目不存在');
  return p;
}

function contentDisposition(name: string) {
  const safe = name.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120) || 'roadshow';
  return `attachment; filename="${safe.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function sendFile(reply: FastifyReply, buf: Buffer | string, mime: string, filename: string) {
  reply.header('Content-Type', mime);
  reply.header('Content-Disposition', contentDisposition(filename));
  return reply.send(buf);
}

export function projectRoutes(app: FastifyInstance, db: DB) {
  app.get('/api/aspects', async () => ({ aspects: ASPECTS }));

  app.get('/api/projects', async (req) => {
    requireUser(req);
    const { type } = req.query as { type?: string };
    const rows = (
      type
        ? db.prepare('SELECT * FROM projects WHERE type = ? ORDER BY updated_at DESC').all(type)
        : db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all()
    ) as ProjectRow[];
    const names = userNames(db);
    const busy = activeJobCounts(db);
    return { projects: rows.map((p) => publicProject(p, names, false, busy)) };
  });

  /** Create a template or deck. Multipart: text fields + optional supporting files. */
  app.post('/api/projects', async (req) => {
    const user = requireUser(req);
    const fields: Record<string, string> = {};
    const files: { filename: string; mime: string; buf: Buffer }[] = [];
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          if (!buf.length) continue;
          if (files.length >= MAX_UPLOAD_FILES) throw new HttpError(400, `最多上传 ${MAX_UPLOAD_FILES} 个文件`);
          files.push({ filename: part.filename, mime: part.mimetype, buf });
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
    } else {
      Object.assign(fields, req.body ?? {});
    }
    const type = fields.type === 'deck' ? 'deck' : fields.type === 'template' ? 'template' : null;
    if (!type) throw new HttpError(400, '项目类型必须是 template 或 deck');
    const name = String(fields.name ?? '').trim();
    if (!name) throw new HttpError(400, '请填写名称');
    const aspectKey = fields.aspect && ASPECTS[fields.aspect] ? fields.aspect : '16:9';
    let { width, height } = ASPECTS[aspectKey];
    if (fields.aspect === 'custom') {
      width = Math.round(Number(fields.width));
      height = Math.round(Number(fields.height));
      if (!(width >= 320 && width <= 4000 && height >= 320 && height <= 4000)) throw new HttpError(400, '自定义尺寸需在 320–4000 像素之间');
    }
    const pageCount = fields.pageCount ? Math.max(1, Math.min(40, Number(fields.pageCount) || 0)) || undefined : undefined;
    let brief: Record<string, unknown>;
    let templateId: string | null = null;
    if (type === 'template') {
      if (!String(fields.style ?? '').trim() && !String(fields.purpose ?? '').trim()) throw new HttpError(400, '请至少填写设计风格或计划用途');
      brief = {
        name,
        style: fields.style ?? '',
        purpose: fields.purpose ?? '',
        audience: fields.audience ?? '',
        colors: fields.colors ?? '',
        pageCount,
        notes: fields.notes ?? '',
      };
    } else {
      templateId = String(fields.templateId ?? '').trim() || null;
      if (!templateId) throw new HttpError(400, '请先选择一个模板');
      const tpl = getProject(db, templateId);
      if (!tpl || tpl.type !== 'template') throw new HttpError(400, '所选模板不存在');
      if (tpl.status !== 'ready' || !projectDoc(tpl)?.pages.length) throw new HttpError(400, '所选模板尚未生成完成');
      if (!String(fields.content ?? '').trim()) throw new HttpError(400, '请详细说明需要添加的内容');
      const tdoc = projectDoc(tpl)!;
      if (fields.aspect === undefined || fields.aspect === '' || fields.aspect === 'template') {
        width = tdoc.width;
        height = tdoc.height;
      }
      brief = {
        name,
        purpose: fields.purpose ?? '',
        audience: fields.audience ?? '',
        content: fields.content,
        pageCount,
        notes: fields.notes ?? '',
      };
    }
    const project = createProject(db, user.id, {
      type,
      name,
      width,
      height,
      aspect: fields.aspect === 'custom' ? `${width}x${height}` : aspectKey,
      templateId,
      brief: brief as any,
    });
    let roles: unknown[] = [];
    try {
      roles = JSON.parse(fields.fileRoles || '[]');
    } catch {
      /* default roles */
    }
    const defaultRole: AssetRole = type === 'template' ? 'reference' : 'embed';
    for (const [i, f] of files.entries()) {
      await saveAsset(db, project.id, user.id, f.filename, f.mime, f.buf, roles[i] === undefined ? defaultRole : parseRole(roles[i]));
    }
    const job = startGeneration(db, project.id, user.id);
    return { project: publicProject(getProject(db, project.id)!, userNames(db), false), job: publicJob(job) };
  });

  app.get('/api/projects/:id', async (req) => {
    requireUser(req);
    const p = mustProject(db, (req.params as any).id);
    const names = userNames(db);
    const template = p.template_id ? getProject(db, p.template_id) : null;
    return {
      project: publicProject(p, names, true),
      template: template ? { id: template.id, name: template.name } : null,
      assets: projectAssets(db, p.id).map((a) => publicAsset(db, a)),
    };
  });

  app.patch('/api/projects/:id', async (req) => {
    const user = requireUser(req);
    const p = mustProject(db, (req.params as any).id);
    const { name } = (req.body ?? {}) as { name?: string };
    const newName = String(name ?? '').trim();
    if (!newName) throw new HttpError(400, '名称不能为空');
    db.prepare('UPDATE projects SET name = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(newName, user.id, Date.now(), p.id);
    const doc = projectDoc(p);
    if (doc && doc.pages.length) {
      await withProjectLock(p.id, () => {
        const latest = projectDoc(getProject(db, p.id)!)!;
        return commitVersion(db, p.id, user.id, { ...latest, title: newName }, { action: 'rename', scope: 'global', prompt: `重命名为「${newName}」` });
      });
    }
    return { project: publicProject(getProject(db, p.id)!, userNames(db), false) };
  });

  app.delete('/api/projects/:id', async (req) => {
    requireUser(req);
    const p = mustProject(db, (req.params as any).id);
    if (p.type === 'template') {
      const used = db.prepare('SELECT COUNT(*) AS c FROM projects WHERE template_id = ?').get(p.id) as { c: number };
      if (used.c > 0) throw new HttpError(409, `该模板已被 ${used.c} 份路演材料使用，无法删除`);
    }
    const ids = db.prepare('SELECT id FROM assets WHERE project_id = ?').all(p.id) as { id: string }[];
    for (const a of ids) fs.rmSync(assetPath(a.id), { force: true });
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    return { ok: true };
  });

  app.post('/api/projects/:id/regenerate', async (req) => {
    const user = requireUser(req);
    const p = mustProject(db, (req.params as any).id);
    if (p.status === 'generating') throw new HttpError(409, '正在生成中');
    if (p.version_no > 0) throw new HttpError(409, '项目已生成，请通过修改对话框进行调整');
    return { job: publicJob(startGeneration(db, p.id, user.id)) };
  });

  app.post('/api/projects/:id/assets', async (req) => {
    const user = requireUser(req);
    const p = mustProject(db, (req.params as any).id);
    const saved: AssetRow[] = [];
    let role: AssetRole = 'embed';
    for await (const part of req.parts()) {
      if (part.type !== 'file') {
        if (part.fieldname === 'role') role = parseRole(part.value);
        continue;
      }
      const buf = await part.toBuffer();
      if (buf.length) saved.push(await saveAsset(db, p.id, user.id, part.filename, part.mimetype, buf, role));
    }
    return { assets: saved.map((a) => publicAsset(db, a)) };
  });

  app.delete('/api/projects/:id/assets/:assetId', async (req) => {
    requireUser(req);
    const { id, assetId } = req.params as any;
    deleteAsset(db, id, assetId);
    return { ok: true };
  });

  app.post('/api/projects/:id/edit', async (req) => {
    const user = requireUser(req);
    const p = mustProject(db, (req.params as any).id);
    const body = (req.body ?? {}) as any;
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) throw new HttpError(400, '请输入修改要求');
    const scope = ['global', 'page', 'element'].includes(body.scope) ? body.scope : 'global';
    try {
      const job = startEdit(db, p.id, user.id, {
        prompt,
        scope,
        pageId: body.pageId,
        elementIds: Array.isArray(body.elementIds) ? body.elementIds.map(String).slice(0, 30) : [],
        attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String).slice(0, 12) : [],
      });
      return { job: publicJob(job) };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  app.get('/api/jobs/:id', async (req) => {
    requireUser(req);
    const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get((req.params as any).id) as JobRow | undefined;
    if (!j) throw new HttpError(404, '任务不存在');
    return { job: withStats(db, j) };
  });

  app.post('/api/jobs/:id/answer', async (req) => {
    const user = requireUser(req);
    const id = (req.params as any).id as string;
    const body = (req.body ?? {}) as { questionId?: string; answer?: unknown; choice?: unknown };
    const q = pendingQuestion(id);
    if (!q || q.id !== body.questionId) throw new HttpError(409, '这个问题已经回答过或已超时');
    const choice = body.choice === undefined || body.choice === null ? undefined : Math.floor(Number(body.choice));
    let text = typeof body.answer === 'string' ? body.answer.trim().slice(0, 2000) : '';
    if (choice !== undefined && q.options[choice] !== undefined) text = q.options[choice];
    if (!answerQuestion(id, q.id, { text: text || null, choice: q.options[choice ?? -1] !== undefined ? choice : undefined, userId: user.id })) {
      throw new HttpError(409, '这个问题已经回答过或已超时');
    }
    const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow;
    return { job: withStats(db, j) };
  });

  /** Any user may run a failed request again; it runs as theirs. */
  app.post('/api/jobs/:id/retry', async (req) => {
    const user = requireUser(req);
    const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get((req.params as any).id) as JobRow | undefined;
    if (!j) throw new HttpError(404, '任务不存在');
    try {
      return { job: publicJob(retryJob(db, j, user.id)) };
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  });

  app.get('/api/projects/:id/jobs', async (req) => {
    requireUser(req);
    const p = mustProject(db, (req.params as any).id);
    const { active } = req.query as { active?: string };
    const rows = (
      active
        ? db.prepare(`SELECT * FROM jobs WHERE project_id = ? AND status IN ('pending','running') ORDER BY created_at`).all(p.id)
        : db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50').all(p.id)
    ) as JobRow[];
    const names = userNames(db);
    const stats = jobStats(db, rows.map((j) => j.id));
    return { jobs: rows.map((j) => ({ ...publicJob(j, stats.get(j.id)), userName: j.user_id ? names.get(j.user_id) ?? null : null })) };
  });

  const pageOp = (op: 'delete' | 'duplicate' | 'move') =>
    app.post(`/api/projects/:id/pages/:pageId/${op}`, async (req) => {
      const user = requireUser(req);
      const { id, pageId } = req.params as any;
      mustProject(db, id);
      const body = (req.body ?? {}) as any;
      try {
        const doc = projectDoc(getProject(db, id)!)!;
        const idx = doc.pages.findIndex((pg) => pg.id === pageId);
        const toIndex = Number(body.toIndex);
        const label = { delete: `删除第 ${idx + 1} 页`, duplicate: `复制第 ${idx + 1} 页`, move: `将第 ${idx + 1} 页移动到第 ${toIndex + 1} 位` }[op];
        const r = await applyManual(
          db,
          id,
          user.id,
          { action: `page_${op}`, scope: 'page', pageId, pageIndex: idx, prompt: label },
          (d: DeckDoc) => (op === 'delete' ? deletePage(d, pageId) : op === 'duplicate' ? duplicatePage(d, pageId) : movePage(d, pageId, toIndex)),
        );
        return { versionId: r.versionId };
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    });
  pageOp('delete');
  pageOp('duplicate');
  pageOp('move');

  /** Text typed straight into a text-only element in the editor; saved as a version without the model. */
  app.put('/api/projects/:id/pages/:pageId/elements/:eid/text', async (req) => {
    const user = requireUser(req);
    const { id, pageId, eid } = req.params as Record<string, string>;
    mustProject(db, id);
    const body = (req.body ?? {}) as { text?: unknown; oldText?: unknown };
    const text = cleanTypedText(body.text);
    if (!text) throw new HttpError(400, '文字不能为空；如需删除这个元素，请用 AI 修改');
    if (text.length > MAX_ELEMENT_TEXT) throw new HttpError(400, `文字过长（最多 ${MAX_ELEMENT_TEXT} 字）`);
    const oldText = typeof body.oldText === 'string' ? body.oldText : undefined;
    try {
      return await editElementText(db, id, user.id, { pageId, eid, text, oldText });
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      throw err.statusCode ? err : new HttpError(400, err.message);
    }
  });

  app.get('/api/projects/:id/versions', async (req) => {
    requireUser(req);
    const p = mustProject(db, (req.params as any).id);
    const rows = db
      .prepare(
        `SELECT v.id, v.version_no, v.user_id, v.action, v.scope, v.page_index, v.page_id, v.element_ids, v.prompt, v.summary, v.created_at,
                u.username, u.display_name, j.id AS job_id, j.status AS job_status, j.created_at AS job_created, j.updated_at AS job_updated,
                j.finished_at AS job_finished
         FROM project_versions v LEFT JOIN users u ON u.id = v.user_id LEFT JOIN jobs j ON j.version_id = v.id
         WHERE v.project_id = ? ORDER BY v.version_no DESC`,
      )
      .all(p.id) as any[];
    const failed = db
      .prepare(
        `SELECT j.*, u.username, u.display_name FROM jobs j LEFT JOIN users u ON u.id = j.user_id
         WHERE j.project_id = ? AND j.status = 'error' ORDER BY j.created_at DESC LIMIT 50`,
      )
      .all(p.id) as (JobRow & { username: string | null; display_name: string | null })[];
    const stats = jobStats(db, [...rows.filter((r) => r.job_id).map((r) => r.job_id as string), ...failed.map((j) => j.id)]);
    return {
      failedJobs: failed.map((j) => ({
        ...publicJob(j, stats.get(j.id)),
        userName: j.display_name || j.username || '（已删除用户）',
      })),
      versions: rows.map((r) => ({
        jobId: r.job_id ?? null,
        durationMs: r.job_id
          ? jobDuration({ status: r.job_status, created_at: r.job_created, updated_at: r.job_updated, finished_at: r.job_finished })
          : null,
        stats: r.job_id ? stats.get(r.job_id) ?? null : null,
        id: r.id,
        versionNo: r.version_no,
        userId: r.user_id,
        userName: r.display_name || r.username || '（已删除用户）',
        action: r.action,
        scope: r.scope,
        pageIndex: r.page_index,
        pageId: r.page_id,
        elementIds: JSON.parse(r.element_ids),
        prompt: r.prompt,
        summary: JSON.parse(r.summary),
        createdAt: r.created_at,
      })),
    };
  });

  function versionDoc(projectId: string, versionId: number): DeckDoc {
    const row = db.prepare('SELECT doc FROM project_versions WHERE id = ? AND project_id = ?').get(versionId, projectId) as
      | { doc: string }
      | undefined;
    if (!row) throw new HttpError(404, '版本不存在');
    return JSON.parse(row.doc);
  }

  app.get('/api/projects/:id/versions/:vid', async (req) => {
    requireUser(req);
    const { id, vid } = req.params as any;
    mustProject(db, id);
    return { doc: versionDoc(id, Number(vid)) };
  });

  app.post('/api/projects/:id/versions/:vid/revert', async (req) => {
    const user = requireUser(req);
    const { id, vid } = req.params as any;
    mustProject(db, id);
    const doc = versionDoc(id, Number(vid));
    const vno = (db.prepare('SELECT version_no FROM project_versions WHERE id = ?').get(Number(vid)) as any).version_no;
    const r = await withProjectLock(id, () =>
      commitVersion(db, id, user.id, doc, { action: 'revert', scope: 'global', prompt: `恢复到版本 v${vno}` }),
    );
    return { versionId: r.versionId };
  });

  /** The project as files (README, styles, pages) with their content, for the current or a past version. */
  app.get('/api/projects/:id/files', async (req) => {
    requireUser(req);
    const p = mustProject(db, (req.params as any).id);
    const { version } = req.query as { version?: string };
    const raw = version ? versionDoc(p.id, Number(version)) : projectDoc(p);
    if (!raw) throw new HttpError(404, '暂无内容');
    const doc = withReadme(p, raw);
    const css = new Map(cssFiles(doc.css).map((f) => [f.path, f.css]));
    const pages = new Map(nameFiles(doc.pages).map((pg) => [pg.file!, pg]));
    return {
      generatedReadme: !raw.readme?.trim(),
      files: fileTree(doc).map((e) => ({
        ...e,
        pageId: e.kind === 'page' ? pages.get(e.path)!.id : undefined,
        content: e.kind === 'readme' ? doc.readme : e.kind === 'css' ? css.get(e.path) : pages.get(e.path)!.html,
      })),
    };
  });

  app.put('/api/projects/:id/readme', async (req) => {
    const user = requireUser(req);
    const p = mustProject(db, (req.params as any).id);
    const readme = String(((req.body ?? {}) as any).readme ?? '').trim();
    if (!readme) throw new HttpError(400, 'README 不能为空');
    if (readme.length > MAX_README) throw new HttpError(400, `README 过长（最多 ${MAX_README} 字符）`);
    try {
      const r = await applyManual(db, p.id, user.id, { action: 'readme', scope: 'global', prompt: '编辑 README（生成说明）' }, (d: DeckDoc) => ({
        ...d,
        readme: `${readme}\n`,
      }));
      return { versionId: r.versionId };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  /** Rendered HTML for iframes (thumbnails, previews). */
  app.get('/api/projects/:id/html', async (req, reply) => {
    requireUser(req);
    const p = mustProject(db, (req.params as any).id);
    const { pageId, version } = req.query as { pageId?: string; version?: string };
    const doc = version ? versionDoc(p.id, Number(version)) : projectDoc(p);
    if (!doc) throw new HttpError(404, '暂无内容');
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    return assembleHtml(doc, {
      pageIds: pageId ? [pageId] : undefined,
      extraHead: pageId ? '<style>body{background:transparent;overflow:hidden}.slide{margin:0}</style>' : '',
    });
  });

  app.get('/api/projects/:id/export', async (req, reply) => {
    requireUser(req);
    const p = mustProject(db, (req.params as any).id);
    const { format = 'html', version } = req.query as { format?: string; version?: string };
    const doc = version ? versionDoc(p.id, Number(version)) : projectDoc(p);
    if (!doc || !doc.pages.length) throw new HttpError(400, '项目尚无可导出的内容');
    const resolver = makeAssetResolver(db);
    const base = `${p.name}${version ? `-v${version}` : ''}`;
    if (format === 'html') {
      return sendFile(reply, assembleHtml(doc, { presenter: true, assetResolver: resolver }), 'text/html; charset=utf-8', `${base}.html`);
    }
    if (format === 'pdf') return sendFile(reply, await renderPdf(doc, resolver), 'application/pdf', `${base}.pdf`);
    if (format === 'pdf-image') return sendFile(reply, await renderImagePdf(doc, resolver), 'application/pdf', `${base}.pdf`);
    if (format === 'zip') {
      const full = withReadme(p, doc);
      return sendFile(reply, await exportBundle(db, full, full.readme ?? ''), 'application/zip', `${base}.zip`);
    }
    if (format === 'pptx') {
      return sendFile(
        reply,
        await renderPptx(doc, resolver),
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        `${base}.pptx`,
      );
    }
    throw new HttpError(400, '不支持的导出格式');
  });

  app.get('/api/assets/:assetId', async (req, reply) => {
    const { assetId } = req.params as any;
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as AssetRow | undefined;
    if (!row || !fs.existsSync(assetPath(row.id))) throw new HttpError(404, '素材不存在');
    reply.header('Content-Type', row.mime);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(fs.readFileSync(assetPath(row.id)));
  });
}
