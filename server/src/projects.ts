import { nanoid } from 'nanoid';
import type { DB } from './db.js';
import { getSettings } from './db.js';
import {
  assignIds,
  diffDocs,
  emptyDoc,
  findElements,
  parseFragment,
  parseFullHtml,
  replacePage,
  type DeckDoc,
  type DiffSummary,
} from './deck.js';
import { chat, type ChatMessage } from './llm.js';
import { buildDeckPrompt, buildEditPrompt, buildTemplatePrompt, type DeckBrief, type EditScope, type TemplateBrief } from './prompts.js';
import { makeAssetResolver, projectAssets, toAssetRefs } from './assets.js';
import { renderPageImages } from './render.js';

export interface ProjectRow {
  id: string;
  type: 'template' | 'deck';
  name: string;
  meta: string;
  template_id: string | null;
  doc: string | null;
  status: 'generating' | 'ready' | 'error';
  error: string | null;
  version_no: number;
  created_by: number | null;
  updated_by: number | null;
  created_at: number;
  updated_at: number;
}

export interface JobRow {
  id: string;
  project_id: string;
  user_id: number | null;
  kind: 'create' | 'edit';
  status: 'pending' | 'running' | 'done' | 'error';
  request: string;
  error: string | null;
  version_id: number | null;
  endpoint_id: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost: number | null;
  created_at: number;
  updated_at: number;
}

export interface EditInput {
  prompt: string;
  scope: EditScope;
  pageId?: string;
  elementIds?: string[];
}

/** Live progress of running jobs (characters streamed so far); kept in memory only. */
export const jobProgress = new Map<string, { chars: number; stage: string }>();

const projectLocks = new Map<string, Promise<unknown>>();

/** Serialize mutations per project so concurrent users never overwrite each other's applied changes. */
export function withProjectLock<T>(projectId: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = projectLocks.get(projectId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  projectLocks.set(projectId, next);
  next.finally(() => {
    if (projectLocks.get(projectId) === next) projectLocks.delete(projectId);
  }).catch(() => {});
  return next;
}

export function getProject(db: DB, id: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
}

export function projectDoc(p: ProjectRow): DeckDoc | null {
  return p.doc ? (JSON.parse(p.doc) as DeckDoc) : null;
}

export interface VersionMeta {
  action: 'create' | 'edit' | 'revert' | 'page_delete' | 'page_duplicate' | 'page_move' | 'rename';
  scope: 'global' | 'page' | 'element';
  pageIndex?: number | null;
  pageId?: string | null;
  elementIds?: string[];
  prompt?: string;
}

/** Persist a new document version and make it current. Must be called inside the project lock. */
export function commitVersion(db: DB, projectId: string, userId: number, doc: DeckDoc, meta: VersionMeta): { versionId: number; summary: DiffSummary } {
  const project = getProject(db, projectId);
  if (!project) throw new Error('项目不存在');
  const before = projectDoc(project);
  const summary = diffDocs(before && before.pages.length ? before : null, doc);
  const now = Date.now();
  const versionNo = project.version_no + 1;
  let versionId = 0;
  db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO project_versions (project_id, version_no, user_id, action, scope, page_index, page_id, element_ids, prompt, summary, doc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        versionNo,
        userId,
        meta.action,
        meta.scope,
        meta.pageIndex ?? null,
        meta.pageId ?? null,
        JSON.stringify(meta.elementIds ?? []),
        meta.prompt ?? '',
        JSON.stringify(summary),
        JSON.stringify(doc),
        now,
      );
    versionId = Number(r.lastInsertRowid);
    db.prepare(
      `UPDATE projects SET doc = ?, version_no = ?, status = 'ready', error = NULL, updated_by = ?, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(doc), versionNo, userId, now, projectId);
  })();
  return { versionId, summary };
}

function createJob(db: DB, projectId: string, userId: number, kind: JobRow['kind'], request: unknown): JobRow {
  const now = Date.now();
  const job: JobRow = {
    id: nanoid(16),
    project_id: projectId,
    user_id: userId,
    kind,
    status: 'pending',
    request: JSON.stringify(request),
    error: null,
    version_id: null,
    endpoint_id: null,
    prompt_tokens: null,
    completion_tokens: null,
    cost: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO jobs (id, project_id, user_id, kind, status, request, created_at, updated_at)
     VALUES (@id, @project_id, @user_id, @kind, @status, @request, @created_at, @updated_at)`,
  ).run(job);
  return job;
}

function updateJob(db: DB, id: string, patch: Partial<JobRow>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`).run({
    ...patch,
    id,
    updated_at: Date.now(),
  });
}

async function runLlm(db: DB, jobId: string, userId: number, messages: ChatMessage[]) {
  const settings = getSettings(db);
  jobProgress.set(jobId, { chars: 0, stage: '模型生成中' });
  const result = await chat(db, userId, messages, {
    maxTokens: Number(settings.maxTokens) || undefined,
    temperature: Number(settings.temperature),
    onDelta: (_c, total) => jobProgress.set(jobId, { chars: total, stage: '模型生成中' }),
  });
  updateJob(db, jobId, {
    endpoint_id: result.endpointId,
    prompt_tokens: result.promptTokens ?? null,
    completion_tokens: result.completionTokens ?? null,
    cost: result.cost ?? null,
  });
  if (result.finishReason === 'length') {
    throw new Error('模型输出达到长度上限被截断，请提高「最大输出 tokens」设置或减少页数后重试');
  }
  return result.text;
}

export interface CreateInput {
  type: 'template' | 'deck';
  name: string;
  width: number;
  height: number;
  aspect: string;
  templateId?: string | null;
  brief: TemplateBrief | DeckBrief;
}

export function createProject(db: DB, userId: number, input: CreateInput): ProjectRow {
  const now = Date.now();
  const id = nanoid(12);
  const doc = emptyDoc(input.name, input.width, input.height);
  db.prepare(
    `INSERT INTO projects (id, type, name, meta, template_id, doc, status, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'generating', ?, ?, ?, ?)`,
  ).run(
    id,
    input.type,
    input.name,
    JSON.stringify({ aspect: input.aspect, brief: input.brief }),
    input.templateId ?? null,
    JSON.stringify(doc),
    userId,
    userId,
    now,
    now,
  );
  return getProject(db, id)!;
}

export function startGeneration(db: DB, projectId: string, userId: number): JobRow {
  const project = getProject(db, projectId)!;
  const meta = JSON.parse(project.meta);
  const job = createJob(db, projectId, userId, 'create', { brief: meta.brief });
  void (async () => {
    try {
      updateJob(db, job.id, { status: 'running' });
      db.prepare(`UPDATE projects SET status='generating', error=NULL WHERE id=?`).run(projectId);
      const base = projectDoc(project)!;
      const assets = toAssetRefs(projectAssets(db, projectId), true);
      let messages: ChatMessage[];
      if (project.type === 'template') {
        messages = buildTemplatePrompt(base, meta.brief, assets);
      } else {
        const tpl = project.template_id ? getProject(db, project.template_id) : undefined;
        messages = buildDeckPrompt(base, tpl ? projectDoc(tpl) : null, meta.brief, assets);
      }
      const text = await runLlm(db, job.id, userId, messages);
      jobProgress.set(job.id, { chars: text.length, stage: '解析与保存' });
      const doc = parseFullHtml(text, { width: base.width, height: base.height, title: project.name });
      doc.title = project.name;
      const { versionId } = await withProjectLock(projectId, () =>
        commitVersion(db, projectId, userId, doc, { action: 'create', scope: 'global', prompt: describeBrief(meta.brief) }),
      );
      updateJob(db, job.id, { status: 'done', version_id: versionId });
    } catch (e) {
      const msg = (e as Error).message;
      updateJob(db, job.id, { status: 'error', error: msg });
      const p = getProject(db, projectId);
      if (p && p.version_no === 0) db.prepare(`UPDATE projects SET status='error', error=? WHERE id=?`).run(msg, projectId);
      else db.prepare(`UPDATE projects SET status='ready' WHERE id=?`).run(projectId);
    } finally {
      jobProgress.delete(job.id);
    }
  })();
  return job;
}

function describeBrief(brief: Record<string, unknown>): string {
  return Object.entries(brief)
    .filter(([, v]) => v !== undefined && v !== '' && v !== null)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 500)}`)
    .join('\n');
}

export function startEdit(db: DB, projectId: string, userId: number, input: EditInput): JobRow {
  const project = getProject(db, projectId);
  if (!project) throw new Error('项目不存在');
  const doc = projectDoc(project);
  if (!doc || !doc.pages.length) throw new Error('项目尚未生成完成，无法修改');
  let scope = input.scope;
  const elementIds = (input.elementIds ?? []).filter(Boolean);
  if (scope === 'element' && !elementIds.length) scope = 'page';
  if (scope !== 'global') {
    if (!input.pageId || !doc.pages.some((p) => p.id === input.pageId)) throw new Error('请指定要修改的页面');
  }
  const job = createJob(db, projectId, userId, 'edit', { ...input, scope, elementIds });
  void (async () => {
    try {
      updateJob(db, job.id, { status: 'running' });
      const settings = getSettings(db);
      const snapshot = projectDoc(getProject(db, projectId)!)!;
      const assets = toAssetRefs(projectAssets(db, projectId), false);
      const resolver = makeAssetResolver(db);
      let pageIndex: number | undefined;
      let elements: ReturnType<typeof findElements> = [];
      let screenshot: string | undefined;
      if (scope !== 'global') {
        pageIndex = snapshot.pages.findIndex((p) => p.id === input.pageId);
        if (pageIndex < 0) throw new Error('目标页面不存在（可能已被其他用户删除）');
        if (scope === 'element') {
          elements = findElements(snapshot, input.pageId!, elementIds);
          if (!elements.length) throw new Error('选中的元素已不存在（可能已被其他用户修改），请重新选择');
        }
        if (settings.attachScreenshots) {
          jobProgress.set(job.id, { chars: 0, stage: '渲染页面截图' });
          try {
            const [shot] = await renderPageImages(snapshot, resolver, {
              pageIds: [input.pageId!],
              highlight: scope === 'element' ? elementIds : [],
              scale: 0.5,
              type: 'jpeg',
            });
            if (shot) screenshot = `data:image/jpeg;base64,${shot.image.toString('base64')}`;
          } catch {
            /* screenshots are an optional hint for the model */
          }
        }
      }
      const messages = buildEditPrompt(
        snapshot,
        {
          scope,
          prompt: input.prompt,
          pageIndex,
          pageHtml: pageIndex !== undefined ? snapshot.pages[pageIndex].html : undefined,
          elements,
          screenshot,
        },
        assets,
        project.type,
      );
      const text = await runLlm(db, job.id, userId, messages);
      jobProgress.set(job.id, { chars: text.length, stage: '解析与保存' });
      const { versionId } = await withProjectLock(projectId, () => {
        const latest = projectDoc(getProject(db, projectId)!)!;
        let next: DeckDoc;
        if (scope === 'global') {
          next = parseFullHtml(text, { width: latest.width, height: latest.height, title: latest.title });
          next.title = latest.title;
        } else {
          const frag = parseFragment(text);
          next = replacePage(latest, input.pageId!, frag.pages, frag.css);
        }
        const idx = latest.pages.findIndex((p) => p.id === input.pageId);
        return commitVersion(db, projectId, userId, next, {
          action: 'edit',
          scope,
          pageIndex: scope === 'global' ? null : idx,
          pageId: scope === 'global' ? null : input.pageId,
          elementIds: scope === 'element' ? elementIds : [],
          prompt: input.prompt,
        });
      });
      updateJob(db, job.id, { status: 'done', version_id: versionId });
    } catch (e) {
      updateJob(db, job.id, { status: 'error', error: (e as Error).message });
    } finally {
      jobProgress.delete(job.id);
    }
  })();
  return job;
}

export function applyManual(
  db: DB,
  projectId: string,
  userId: number,
  meta: VersionMeta,
  mutate: (doc: DeckDoc) => DeckDoc,
) {
  return withProjectLock(projectId, () => {
    const project = getProject(db, projectId);
    if (!project) throw new Error('项目不存在');
    const doc = projectDoc(project);
    if (!doc || !doc.pages.length) throw new Error('项目尚未生成完成');
    const next = assignIds(mutate(doc));
    return commitVersion(db, projectId, userId, next, meta);
  });
}
