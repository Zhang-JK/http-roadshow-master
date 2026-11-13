export interface User {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  createdAt: number;
  /** The MCP service account: signs in with a token, never with a password. */
  isService?: boolean;
  mcpEnabled?: boolean;
  tokenHint?: string | null;
  tokenCreatedAt?: number | null;
}

export interface DeckPage {
  id: string;
  html: string;
  file?: string;
}

export interface DeckDoc {
  title: string;
  width: number;
  height: number;
  head: string;
  css: string;
  pages: DeckPage[];
  readme?: string;
}

export type ProjectType = 'template' | 'deck';

export interface Project {
  id: string;
  type: ProjectType;
  name: string;
  meta: { aspect?: string; brief?: Record<string, unknown> };
  templateId: string | null;
  status: 'generating' | 'ready' | 'error';
  /** A job of this project waits for someone to answer the AI's question. */
  asking?: boolean;
  /** Jobs of this project running now. */
  busy?: number;
  error: string | null;
  versionNo: number;
  pageCount: number;
  width: number;
  height: number;
  firstPageId: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
  /** Set while anyone with the link may view the project without signing in. */
  share?: ShareInfo | null;
  doc?: DeckDoc;
}

export interface ShareInfo {
  token: string;
  sharedAt: number | null;
  sharedBy: string | null;
}

export interface JobReview {
  before: { errors: number; warnings: number };
  after: { errors: number; warnings: number };
  passes: number;
  toolCalls: number;
  edits: number;
  summary?: string;
  error?: string;
  layoutSkipped?: boolean;
  check?: { errors: number; warnings: number; fixes: number; remaining: string[]; error?: string };
}

/** One-line description of what the self-check did. */
export function reviewText(r: JobReview): string {
  const check = !r.check
    ? ''
    : r.check.error
      ? '；交付检查未完成'
      : r.check.errors
        ? `；交付检查仍有 ${r.check.errors} 个问题`
        : `；交付检查通过${r.check.fixes ? `（修复 ${r.check.fixes} 轮）` : ''}`;
  if (r.error) return `自检未完成（${r.error.slice(0, 60)}），已保存初稿${check}`;
  if (r.layoutSkipped) return check.replace(/^；/, '');
  const fixed = r.edits ? `修改 ${r.edits} 处` : '未修改';
  const issues = r.before.errors || r.after.errors ? `，布局错误 ${r.before.errors} → ${r.after.errors}` : '';
  return `自检：${fixed}${issues}${check}`;
}

export interface Job {
  id: string;
  projectId: string;
  kind: 'create' | 'edit';
  status: 'pending' | 'running' | 'done' | 'error';
  error: string | null;
  versionId: number | null;
  request: { prompt?: string; scope?: string; pageId?: string; elementIds?: string[] };
  progress: { chars: number; stage: string } | null;
  stats?: JobStats | null;
  durationMs?: number;
  finishedAt?: number | null;
  retryOf?: string | null;
  /** The job that ran this failed request again. */
  retriedBy?: string | null;
  /** Saved progress this failed job can continue from (only the latest change of a project keeps it). */
  resume?: { label: string; savedAt: number } | null;
  /** Times the job continued from its saved progress after failing. */
  resumeCount?: number;
  cost: number | null;
  review?: JobReview | null;
  /** A question the job is waiting on. */
  question?: JobQuestion | null;
  /** Questions asked during the job, with their answers. */
  questions?: JobQa[];
  userId: number | null;
  userName?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Model calls of a job: tokens in and out, output speed, and the call running now. */
export interface JobStats {
  calls: number;
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
  tokensPerSec: number | null;
  live: { stage?: string; endpoint: string; queued: boolean; tokens: number; tokensPerSec: number | null; waitingMs: number } | null;
}

export interface JobQuestion {
  id: string;
  kind: 'ask' | 'scope';
  text: string;
  options: string[];
  askedAt: number;
  expiresAt: number;
}

export interface JobQa {
  kind: 'ask' | 'scope';
  question: string;
  options: string[];
  answer: string | null;
  timedOut?: boolean;
  at: number;
}

export interface ElementRef {
  eid: string;
  page?: number;
  tag: string;
  text: string;
}

export interface DiffSummary {
  pagesAdded: number[];
  pagesRemoved: string[];
  pagesChanged: number[];
  cssChanged: boolean;
  readmeChanged?: boolean;
  stylesChanged?: string[];
  elementsChanged: ElementRef[];
  elementsAdded: ElementRef[];
  elementsRemoved: ElementRef[];
  /** Text typed straight into one element in the editor, without the model. */
  textEdit?: { eid: string; page: number; before: string; after: string };
}

export interface Version {
  id: number;
  versionNo: number;
  userId: number | null;
  userName: string;
  action: string;
  scope: 'global' | 'page' | 'element';
  pageIndex: number | null;
  pageId: string | null;
  elementIds: string[];
  prompt: string;
  summary: DiffSummary;
  createdAt: number;
  /** The AI job that produced this version (none for manual changes). */
  jobId?: string | null;
  durationMs?: number | null;
  stats?: JobStats | null;
  /** Times the job behind this version continued after failing. */
  resumeCount?: number;
}

export interface ProjectFile {
  path: string;
  kind: 'readme' | 'css' | 'page';
  chars: number;
  page?: number;
  title?: string;
  pageId?: string;
  content: string;
}

export interface Asset {
  id: string;
  filename: string;
  mime: string;
  size: number;
  kind: 'image' | 'document';
  role: 'embed' | 'reference';
  url: string;
  hasText: boolean;
  slideCount: number;
  slideUrls: string[];
  createdAt: number;
}

export interface SelectedElement {
  eid: string;
  tag: string;
  cls: string;
  text: string;
  label: string;
  isPage: boolean;
  /** Holds only text (and line breaks), so it can be edited in place without the model. */
  textOnly?: boolean;
  rect: { x: number; y: number; w: number; h: number };
}

export interface Endpoint {
  id: number;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  model: string;
  /** Requests try endpoints in this order, lowest first. */
  priority: number;
  enabled: boolean;
  extraBody: string;
  /** Requests sent to it at the same time (0 = no limit); more go to the next endpoint, or wait when all are full. */
  maxConcurrency: number;
  /** false: connects directly, bypassing the server's HTTPS_PROXY / HTTP_PROXY. */
  useProxy: boolean;
  inflight: number;
  lastTestAt: number | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

export interface TestResult {
  ok: boolean;
  textOk: boolean;
  visionOk: boolean;
  latencyMs: number;
  message: string;
  reply?: string;
}

export interface ParallelLevel {
  n: number;
  ok: number;
  concurrent: number;
  queued: boolean;
  /** Looked queued at first, so it was run again; the numbers are from the second run. */
  rechecked?: boolean;
  wallMs: number;
  maxFirstTokenMs: number | null;
  error?: string;
}

export interface ParallelTestResult {
  maxParallel: number;
  /** 0 = no limit needed; null when not even one request worked. */
  suggested: number | null;
  levels: ParallelLevel[];
  message: string;
  busy: number;
  /** Each request asked the model to count from 1 to this. */
  count: number;
}
