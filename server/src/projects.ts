import { nanoid } from 'nanoid';
import type { DB } from './db.js';
import { getSettings } from './db.js';
import {
  assignIds,
  diffDocs,
  emptyDoc,
  findElements,
  setElementText,
  type DeckDoc,
  type DiffSummary,
} from './deck.js';
import { chat, chatWithTools, type ChatMessage, type ChatResult } from './llm.js';
import {
  buildDeckPrompt,
  buildEditPrompt,
  buildReviewContext,
  buildTemplatePrompt,
  type DeckBrief,
  ASK_NOTE,
  withNote,
  type EditMode,
  type EditScope,
  type TemplateBrief,
} from './prompts.js';
import { logEdit, plannedPages, readmeFromBrief } from './files.js';
import { checkProject } from './projectCheck.js';
import { generateFiles } from './generate.js';
import { assetsByIds, makeAssetResolver, projectAssets, toAssetRefs, type AssetRow } from './assets.js';
import { assignFileIds, createFileTools, type FileTools } from './fileTools.js';
import { renderPageImages } from './render.js';
import { askQuestion, asksForAll, cancelQuestion, createAskTools, type QaEntry } from './questions.js';
import { cleanSummary, combineTools, createDraftTools, DRAFT_EDIT_TOOLS, DRAFT_TOOL_NAMES, Draft, reviewDraft, type ReviewLog } from './draft.js';

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
  review: string | null;
  finished_at?: number | null;
  retry_of?: string | null;
  retried_by?: string | null;
  /** Questions the model asked the user during the job, with the answers (QaEntry[]). */
  questions: string | null;
  created_at: number;
  updated_at: number;
}

export interface EditInput {
  prompt: string;
  scope: EditScope;
  pageId?: string;
  elementIds?: string[];
  /** Project assets uploaded together with this edit; sent to the model with their images. */
  attachmentIds?: string[];
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
  action: 'create' | 'edit' | 'revert' | 'page_delete' | 'page_duplicate' | 'page_move' | 'rename' | 'readme' | 'text_edit';
  scope: 'global' | 'page' | 'element';
  pageIndex?: number | null;
  pageId?: string | null;
  elementIds?: string[];
  prompt?: string;
  textEdit?: DiffSummary['textEdit'];
}

/** Persist a new document version and make it current. Must be called inside the project lock. */
export function commitVersion(db: DB, projectId: string, userId: number, doc: DeckDoc, meta: VersionMeta): { versionId: number; summary: DiffSummary } {
  const project = getProject(db, projectId);
  if (!project) throw new Error('项目不存在');
  const before = projectDoc(project);
  const summary = diffDocs(before && before.pages.length ? before : null, doc);
  if (meta.textEdit) summary.textEdit = meta.textEdit;
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
    review: null,
    questions: null,
    finished_at: null,
    retry_of: null,
    retried_by: null,
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
  if ((patch.status === 'done' || patch.status === 'error') && patch.finished_at === undefined) patch = { ...patch, finished_at: Date.now() };
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`).run({
    ...patch,
    id,
    updated_at: Date.now(),
  });
}

function describeTool(name: string, args: Record<string, unknown>): string {
  const f = String(args.file_id ?? '');
  const pages = Array.isArray(args.pages) ? args.pages.join('、') : String(args.pages ?? '');
  switch (name) {
    case 'render_pages':
      return `渲染草稿${pages ? `第 ${pages} 页` : ''}${args.paths ? ` ${String(args.paths)}` : ''}`;
    case 'check_layout':
      return '检查草稿布局';
    case 'check_project':
      return '交付检查（index.html、README、样式与页面文件）';
    case 'read_draft':
      return args.path
        ? `查看 ${String(args.path)}`
        : args.page === undefined
          ? '查看项目文件列表'
          : Number(args.page) === 0
            ? '查看草稿 CSS'
            : `查看草稿第 ${args.page} 页源码`;
    case 'write_file':
      return `写入 ${String(args.path ?? '')}`;
    case 'delete_file':
      return `删除 ${String(args.path ?? '')}`;
    case 'replace_in_draft':
      return args.path ? `修改 ${String(args.path)}` : Number(args.page) === 0 ? '修改草稿 CSS' : `修改草稿第 ${args.page} 页`;
    case 'rewrite_page':
      return `重写草稿${args.path ? ` ${String(args.path)}` : `第 ${args.page} 页`}`;
    case 'delete_page':
      return `删除草稿${args.path ? ` ${String(args.path)}` : `第 ${args.page} 页`}`;
    case 'find_elements':
      return `查找元素 ${String(args.selector ?? args.contains ?? '').slice(0, 30)}`;
    case 'edit_elements':
      return `修改元素${args.page ? `（第 ${args.page} 页）` : ''}`;
    case 'find_css':
      return `查找样式 ${String(args.query ?? '').slice(0, 30)}`;
    case 'edit_css':
      return `修改样式 ${String(args.selector ?? '').slice(0, 30)}`;
    case 'insert_page':
      return `插入页面${args.path ? ` ${String(args.path)}` : ''}`;
    case 'duplicate_page':
      return `复制第 ${args.page} 页`;
    case 'move_page':
      return `把${args.path ? ` ${String(args.path)}` : `第 ${args.page} 页`}移到第 ${args.to} 页`;
    case 'list_files':
      return '列出参考文件';
    case 'read_text':
      return `读取 ${f}${args.page ? ` 第 ${args.page} 页` : ''} 文字`;
    case 'read_raw':
      return `读取 ${f} 源码`;
    case 'search_files':
      return `搜索“${String(args.query ?? '').slice(0, 20)}”`;
    case 'view_page':
      return `查看 ${f} 第 ${args.page} 页`;
    case 'list_archive':
      return `查看 ${f} 内部结构`;
    case 'read_archive_entry':
      return `读取 ${f} 的 ${String(args.path ?? '')}`;
    default:
      return name;
  }
}

/** Sets up the read-only file tools over the given uploads; returns undefined when there are none. */
function fileToolsFor(db: DB, rows: AssetRow[]): { tools: FileTools; ids: Map<string, string> } | undefined {
  if (!rows.length) return undefined;
  const files = assignFileIds(rows);
  return { tools: createFileTools(db, files), ids: new Map([...files].map(([fid, r]) => [r.id, fid])) };
}

const toolStage = (name: string, args: Record<string, unknown>, phase = '自检') =>
  name === 'ask_user' || name === 'extend_scope'
    ? '等待用户回答问题'
    : `${DRAFT_TOOL_NAMES.has(name) ? phase : '读取参考文件'}：${describeTool(name, args)}`;

/**
 * ask_user while the job may pause for an answer (off in the settings: not offered), and for page and
 * element edits extend_scope. Each question and answer is kept with the job.
 */
function askToolsFor(db: DB, job: JobRow, extra: { draft?: Draft; prompt?: string } = {}): FileTools | undefined {
  const jobId = job.id;
  const settings = getSettings(db);
  const minutes = Math.max(0.01, Number(settings.askTimeoutMinutes) || 30);
  const qa: QaEntry[] = [];
  return createAskTools({
    ask: settings.askUser === false ? undefined : (q) => askQuestion({ id: jobId, projectId: job.project_id }, q, minutes * 60_000),
    timeoutMinutes: minutes,
    onAsked: (entry) => {
      qa.push(entry);
      updateJob(db, jobId, { questions: JSON.stringify(qa) });
    },
    ...extra,
  });
}

/** Adds one model call's usage to the job's running totals. */
function recordUsage(db: DB, jobId: string, r: { endpointId: number; promptTokens?: number; completionTokens?: number; cost?: number }) {
  db.prepare(
    `UPDATE jobs SET endpoint_id = ?,
       prompt_tokens = CASE WHEN ? IS NULL THEN prompt_tokens ELSE COALESCE(prompt_tokens, 0) + ? END,
       completion_tokens = CASE WHEN ? IS NULL THEN completion_tokens ELSE COALESCE(completion_tokens, 0) + ? END,
       cost = CASE WHEN ? IS NULL THEN cost ELSE COALESCE(cost, 0) + ? END,
       updated_at = ? WHERE id = ?`,
  ).run(
    r.endpointId,
    r.promptTokens ?? null,
    r.promptTokens ?? null,
    r.completionTokens ?? null,
    r.completionTokens ?? null,
    r.cost ?? null,
    r.cost ?? null,
    Date.now(),
    jobId,
  );
}

/**
 * Self-check loop: render the draft in headless Chrome, inspect its layout and let the model fix it
 * with the draft tools (skipped when disabled in the settings), then the delivery check of the
 * project as exported, whose errors go back to the model up to MAX_CHECK_FIXES times. Errors that
 * remain after that fail the job (an edit only for errors the project did not have before).
 */
async function selfReview(
  db: DB,
  jobId: string,
  userId: number,
  draft: Draft,
  prompt: ChatMessage[],
  fileTools?: FileTools,
  skipIfClean = false,
  before?: DeckDoc,
): Promise<ReviewLog> {
  const settings = getSettings(db);
  const log = await reviewDraft(db, userId, {
    draft,
    resolver: makeAssetResolver(db),
    prompt,
    fileTools,
    maxRounds: Number(settings.selfCheckRounds) || 10,
    maxTokens: Number(settings.maxTokens) || undefined,
    temperature: Number(settings.temperature),
    onDelta: (_c, total) => jobProgress.set(jobId, { chars: total, stage: '自检：模型检查草稿' }),
    onTool: (name, args) => jobProgress.set(jobId, { chars: 0, stage: toolStage(name, args) }),
    onStage: (stage) => jobProgress.set(jobId, { chars: 0, stage }),
    onUsage: (u) => recordUsage(db, jobId, u),
    jobId,
    stage: '自检与交付检查',
    skipIfClean,
    layoutReview: !!settings.selfCheck,
    baseline: before ? () => checkProject(db, Draft.ofDocument(before).checkInput()) : undefined,
  });
  updateJob(db, jobId, { review: JSON.stringify(log) });
  const left = log.check?.unresolved;
  if (left?.length) {
    const tries = (log.check?.fixes ?? 0) + 1;
    throw new Error(
      `交付检查 ${tries} 次未通过（已交回模型修复 ${log.check!.fixes} 次${log.check?.error ? `，修复时模型调用失败：${log.check.error.slice(0, 200)}` : ''}），仍有以下问题：\n${left.map((x) => `- ${x}`).join('\n')}`,
    );
  }
  return log;
}

/** One model call for a job, with the read-only reference tools when there are uploads. */
async function runStep(
  db: DB,
  jobId: string,
  userId: number,
  messages: ChatMessage[],
  tools: FileTools | undefined,
  stage: string,
  /** The caller treats an empty reply as a miss and asks again. */
  allowEmpty = false,
): Promise<ChatResult> {
  const settings = getSettings(db);
  jobProgress.set(jobId, { chars: 0, stage });
  const opts = {
    jobId,
    stage,
    maxTokens: Number(settings.maxTokens) || undefined,
    temperature: Number(settings.temperature),
    onDelta: (_c: string, total: number) => jobProgress.set(jobId, { chars: total, stage }),
    onReasoning: (total: number) => jobProgress.set(jobId, { chars: total, stage: `${stage}（思考中）` }),
    allowEmpty,
  };
  if (!tools?.defs.length) {
    const r = await chat(db, userId, messages, opts);
    recordUsage(db, jobId, r);
    return r;
  }
  return chatWithTools(db, userId, messages, {
    ...opts,
    tools: tools.defs,
    execute: tools.execute,
    onTool: (name, args) => jobProgress.set(jobId, { chars: 0, stage: toolStage(name, args) }),
    onRound: (r) => recordUsage(db, jobId, r),
    allowEmptyFinal: allowEmpty,
  });
}

const MAX_CONTINUATIONS = 3;

/** A single complete answer; a reply cut off by the output limit is continued where it stopped. */
async function runLlm(db: DB, jobId: string, userId: number, messages: ChatMessage[], tools?: FileTools) {
  let r = await runStep(db, jobId, userId, messages, tools, '模型生成中');
  let text = r.text;
  for (let i = 0; r.finishReason === 'length' && i < MAX_CONTINUATIONS; i++) {
    const next: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: text },
      { role: 'user', content: '你的回复因达到最大输出长度被截断。请从中断处继续输出剩余内容：不要重复已输出的部分，不要重新开始，也不要加任何说明。' },
    ];
    r = await runStep(db, jobId, userId, next, undefined, `模型继续输出（第 ${i + 2} 段）`);
    text += r.text.replace(/^\s*```(?:html)?\s*\n/, '');
  }
  if (r.finishReason === 'length') {
    throw new Error('模型输出多次达到长度上限仍未完成，请提高「最大输出 tokens」设置、减少页数，或使用分步生成后重试');
  }
  return text;
}

/**
 * Tool-first edit: the model changes the loaded draft with the structured tools instead of re-typing
 * whole pages, which matters most for slow models. A reply with complete HTML is still accepted.
 */
async function editWithTools(db: DB, jobId: string, userId: number, draft: Draft, messages: ChatMessage[], fileTools?: FileTools, askTools?: FileTools) {
  const settings = getSettings(db);
  const tools = combineTools(createDraftTools(draft, makeAssetResolver(db), db), fileTools, askTools);
  jobProgress.set(jobId, { chars: 0, stage: '模型修改中' });
  const r = await chatWithTools(db, userId, messages, {
    jobId,
    stage: '修改',
    maxTokens: Number(settings.maxTokens) || undefined,
    temperature: Number(settings.temperature),
    onDelta: (_c, total) => jobProgress.set(jobId, { chars: total, stage: '模型修改中' }),
    onReasoning: (total) => jobProgress.set(jobId, { chars: total, stage: '模型思考中' }),
    tools: tools.defs,
    execute: tools.execute,
    onTool: (name, args) => jobProgress.set(jobId, { chars: 0, stage: toolStage(name, args, DRAFT_EDIT_TOOLS.has(name) ? '修改' : '查看') }),
    onRound: (round) => recordUsage(db, jobId, round),
    maxRounds: Number(settings.editToolRounds) || 12,
    allowEmptyFinal: true,
  });
  if (draft.edits) return;
  if (r.text && draft.replaceFromText(r.text)) return;
  if (r.finishReason === 'length') throw new Error('模型输出达到长度上限被截断，请提高「最大输出 tokens」设置后重试');
  const why = r.text ? cleanSummary(r.text) : undefined;
  throw new Error(`模型没有做任何修改${why ? `：${why}` : ''}`);
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

export interface GenerationOptions {
  /** False for callers that cannot answer (MCP): the model must not pause to ask the user. */
  askUser?: boolean;
}

export function startGeneration(db: DB, projectId: string, userId: number, opts: GenerationOptions = {}): JobRow {
  const project = getProject(db, projectId)!;
  const meta = JSON.parse(project.meta);
  const job = createJob(db, projectId, userId, 'create', { brief: meta.brief });
  void (async () => {
    try {
      updateJob(db, job.id, { status: 'running' });
      db.prepare(`UPDATE projects SET status='generating', error=NULL WHERE id=?`).run(projectId);
      const base = projectDoc(project)!;
      const rows = projectAssets(db, projectId);
      const ft = fileToolsFor(db, rows);
      const assets = toAssetRefs(db, rows, true, ft?.ids);
      const settings = getSettings(db);
      const ask = opts.askUser === false ? undefined : askToolsFor(db, job);
      const tplRow = project.type === 'deck' && project.template_id ? getProject(db, project.template_id) : undefined;
      const template = tplRow ? projectDoc(tplRow) : null;
      let draft: Draft;
      let reviewContext: ChatMessage[];
      if (settings.generateMode !== 'single') {
        const doc = await generateFiles(
          { base, kind: project.type, brief: meta.brief, template, assets },
          {
            call: (messages, stage, step) =>
              step === 'plan' && ask
                ? runStep(db, job.id, userId, withNote(messages, ASK_NOTE), combineTools(ft?.tools, ask), stage, true)
                : runStep(db, job.id, userId, messages, ft?.tools, stage, true),
            pagesPerCall: Number(settings.genPagesPerCall) || 3,
          },
        );
        draft = Draft.ofDocument(assignIds({ ...doc, title: project.name }, { keepScripts: true }));
        reviewContext = buildReviewContext(doc, project.type);
      } else {
        reviewContext =
          project.type === 'template' ? buildTemplatePrompt(base, meta.brief, assets) : buildDeckPrompt(base, template, meta.brief, assets);
        const text = await runLlm(db, job.id, userId, ask ? withNote(reviewContext, ASK_NOTE) : reviewContext, combineTools(ft?.tools, ask));
        draft = Draft.fromDocument(text, {
          width: base.width,
          height: base.height,
          title: project.name,
          readme: readmeFromBrief(project.type, project.name, meta.brief),
        });
      }
      if (settings.generateMode !== 'single') draft.expectedPages = plannedPages(draft.view().readme ?? '').map((p) => p.path);
      if (project.type === 'template') {
        draft.templateCheck = {
          referenceTexts: assets.flatMap((a) => (a.kind === 'document' && a.text ? [a.text] : [])),
          allowed: Object.values(meta.brief ?? {}).map(String).join('\n'),
        };
      }
      await selfReview(db, job.id, userId, draft, reviewContext, ft?.tools);
      jobProgress.set(job.id, { chars: 0, stage: '解析与保存' });
      const doc = draft.result();
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
      cancelQuestion(job.id);
      jobProgress.delete(job.id);
    }
  })();
  return job;
}

/** The saved document, with a README written from the creation brief when the project predates READMEs. */
export function withReadme(project: ProjectRow, doc: DeckDoc = projectDoc(project)!): DeckDoc {
  if (doc.readme?.trim()) return doc;
  const meta = JSON.parse(project.meta || '{}');
  return { ...doc, readme: readmeFromBrief(project.type, project.name, meta.brief) };
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
      const snapshot = withReadme(getProject(db, projectId)!);
      const attachmentIds = input.attachmentIds ?? [];
      const attachedRows = assetsByIds(db, projectId, attachmentIds);
      const otherRows = projectAssets(db, projectId).filter((a) => !attachmentIds.includes(a.id));
      const ft = fileToolsFor(db, [...otherRows, ...attachedRows]);
      const attachments = toAssetRefs(db, attachedRows, true, ft?.ids);
      const assets = toAssetRefs(db, otherRows, false, ft?.ids);
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
      const mode: EditMode = settings.editMode === 'rewrite' ? 'rewrite' : 'tools';
      const messages = buildEditPrompt(
        snapshot,
        {
          scope,
          prompt: input.prompt,
          pageIndex,
          pageHtml: pageIndex !== undefined ? snapshot.pages[pageIndex].html : undefined,
          elements,
          screenshot,
          attachments,
          ask: settings.askUser !== false,
          explicitAll: asksForAll(input.prompt),
        },
        assets,
        project.type,
        mode,
      );
      let draft: Draft;
      if (mode === 'tools') {
        draft = scope === 'global' ? Draft.ofDocument(snapshot) : Draft.ofPage(snapshot, input.pageId!);
        await editWithTools(db, job.id, userId, draft, messages, ft?.tools, askToolsFor(db, job, { draft, prompt: input.prompt }));
      } else {
        const text = await runLlm(db, job.id, userId, messages, combineTools(ft?.tools, askToolsFor(db, job)));
        if (scope === 'global') {
          draft = Draft.ofDocument(snapshot);
          if (!draft.replaceFromText(text)) throw new Error(`模型没有输出任何文件修改${cleanSummary(text) ? `：${cleanSummary(text)}` : ''}`);
        } else draft = Draft.fromFragment(text, snapshot, input.pageId!);
      }
      await selfReview(db, job.id, userId, draft, messages, ft?.tools, mode === 'tools', snapshot);
      jobProgress.set(job.id, { chars: 0, stage: '解析与保存' });
      const { versionId } = await withProjectLock(projectId, () => {
        const latestRow = getProject(db, projectId)!;
        const latest = withReadme(latestRow);
        let next: DeckDoc;
        if (scope === 'global') {
          next = draft.result();
          next.title = latest.title;
        } else {
          next = draft.result(latest);
        }
        const idx = latest.pages.findIndex((p) => p.id === input.pageId);
        const extended = draft.mode === 'fragment' ? draft.extendedChanges() : { pages: [], css: false };
        const also = [extended.pages.length ? `第 ${extended.pages.join('、')} 页` : '', extended.css ? '共享样式' : ''].filter(Boolean).join('和');
        const where =
          scope === 'global' ? '整份材料' : `第 ${idx + 1} 页${scope === 'element' ? `（${elementIds.length} 个元素）` : ''}${also ? `，并同步修改${also}` : ''}`;
        const who = (db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as { display_name?: string } | undefined)?.display_name ?? '';
        next.readme = logEdit(next.readme ?? '', `v${latestRow.version_no + 1} ${who ? `${who}：` : ''}${where} — ${input.prompt}`);
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
      cancelQuestion(job.id);
      jobProgress.delete(job.id);
    }
  })();
  return job;
}

/** Runs a failed request again as a new job of `userId`; each failed job is retried at most once. */
export function retryJob(db: DB, failed: JobRow, userId: number): JobRow {
  if (failed.status !== 'error') throw new Error('只有失败的请求可以重试');
  if (failed.retried_by) throw new Error('这个请求已经重试过了');
  const project = getProject(db, failed.project_id);
  if (!project) throw new Error('项目不存在');
  let job: JobRow;
  if (failed.kind === 'create') {
    if (project.version_no > 0) throw new Error('项目已生成，请通过修改对话框进行调整');
    if (project.status === 'generating') throw new Error('正在生成中');
    job = startGeneration(db, project.id, userId);
  } else {
    const req = JSON.parse(failed.request || '{}') as EditInput;
    job = startEdit(db, project.id, userId, {
      prompt: String(req.prompt ?? ''),
      scope: req.scope ?? 'global',
      pageId: req.pageId,
      elementIds: req.elementIds ?? [],
      attachmentIds: req.attachmentIds ?? [],
    });
  }
  db.prepare('UPDATE jobs SET retry_of = ? WHERE id = ?').run(failed.id, job.id);
  db.prepare('UPDATE jobs SET retried_by = ? WHERE id = ?').run(job.id, failed.id);
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as JobRow;
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

export const MAX_ELEMENT_TEXT = 5000;

/** Text typed in the editor: line breaks kept, runs of spaces collapsed, control characters dropped. */
export function cleanTypedText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim();
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Replace the text of one text-only element, typed by the user in the editor (no model involved),
 * as a new version. `oldText` is what the user saw when they started typing: when the saved text
 * differs from it, someone else changed the element meanwhile and nothing is written (409).
 */
export function editElementText(
  db: DB,
  projectId: string,
  userId: number,
  input: { pageId: string; eid: string; text: string; oldText?: string },
): Promise<{ versionId: number; versionNo: number } | { unchanged: true }> {
  return withProjectLock(projectId, () => {
    const project = getProject(db, projectId);
    if (!project) throw new Error('项目不存在');
    const doc = projectDoc(project);
    if (!doc || !doc.pages.length) throw new Error('项目尚未生成完成');
    const { doc: changed, before, page } = setElementText(doc, input.pageId, input.eid, input.text);
    if (input.oldText !== undefined && squash(input.oldText) !== squash(before)) {
      throw Object.assign(new Error(`这段文字刚被其他人改成了「${clip(before, 60)}」，你的修改没有保存`), { statusCode: 409 });
    }
    if (before === input.text) return { unchanged: true as const };
    const versionNo = project.version_no + 1;
    const who = (db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as { display_name?: string } | undefined)?.display_name ?? '';
    const next = withReadme(project, assignIds(changed));
    next.readme = logEdit(next.readme ?? '', `v${versionNo} ${who ? `${who}：` : ''}第 ${page} 页 直接改字「${clip(squash(before), 40)}」→「${clip(squash(input.text), 40)}」`);
    const { versionId } = commitVersion(db, projectId, userId, next, {
      action: 'text_edit',
      scope: 'element',
      pageIndex: page - 1,
      pageId: input.pageId,
      elementIds: [input.eid],
      prompt: `直接修改文字：「${clip(before, 200)}」→「${clip(input.text, 200)}」`,
      textEdit: { eid: input.eid, page, before: clip(before, 1000), after: clip(input.text, 1000) },
    });
    return { versionId, versionNo };
  });
}
