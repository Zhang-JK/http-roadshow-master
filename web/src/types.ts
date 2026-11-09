export interface User {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  createdAt: number;
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
  doc?: DeckDoc;
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
  rect: { x: number; y: number; w: number; h: number };
}

export interface Endpoint {
  id: number;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  model: string;
  weight: number;
  enabled: boolean;
  extraBody: string;
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
