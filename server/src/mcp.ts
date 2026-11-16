import path from 'node:path';
import * as cheerio from 'cheerio';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db.js';
import { config } from './config.js';
import { HttpError, requireMcpCaller, type ServiceUser } from './auth.js';
import { ASPECTS, type DeckDoc } from './deck.js';
import { makeAssetResolver, projectAssets, saveAsset, slideAssets, type AssetRow } from './assets.js';
import { MAX_UPLOAD_FILES, createFromForm, type UploadFile } from './create.js';
import {
  deleteProject,
  getProject,
  jobProgress,
  projectDoc,
  renameProject,
  startEdit,
  withReadme,
  type JobRow,
  type ProjectRow,
} from './projects.js';
import { nameFiles, readmeBody } from './files.js';
import { renderPageImages } from './render.js';
import { versionInfo } from './system.js';

/** Newest first. Clients on newer revisions fall back to the initialize handshake when `server/discover` is unknown. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Files arrive base64-encoded inside the JSON body, a third larger than the web upload. */
const BODY_LIMIT = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_CONTENT = 100_000;
const DEFAULT_WAIT_SECONDS = 20;
const MAX_WAIT_SECONDS = 50;
const MAX_PREVIEW_PAGES = 12;
const MAX_TEMPLATE_PREVIEWS = 8;
const GUIDE_LIMIT = 3000;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
/** History entries per deck in list_roadshow_slides (the latest ones); get_roadshow_slides has all. */
const LIST_HISTORY = 10;
const LIST_TEXT_LIMIT = 300;
const MAX_FAILED_REQUESTS = 10;

const IMAGE_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** The document types the web dialog accepts (SLIDES_ACCEPT and TEXT_ACCEPT). */
const DOC_EXT: Record<string, string> = {
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pps: 'application/vnd.ms-powerpoint',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  odp: 'application/vnd.oasis.opendocument.presentation',
  key: 'application/vnd.apple.keynote',
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const PLAIN_TEXT_EXT = new Set(['html', 'htm', 'txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml']);
const SUPPORTED = [...Object.keys(IMAGE_EXT), ...Object.keys(DOC_EXT)].join(', ');
const EXPORT_FORMATS = ['html', 'pdf', 'pdf-image', 'pptx', 'zip'] as const;

const INSTRUCTIONS = `Creates roadshow slide decks (路演材料: HTML slides, exportable to PDF and PPTX) with HTTP 路演生成器.
1. Call list_roadshow_templates and pick a templateId.
2. Call create_roadshow_slides with everything the deck must show: the full test data and results, and the charts/screenshots as images.
3. Call get_roadshow_slides_status until status is "ready" (generation takes a few minutes), then share editorUrl or download the exports with the same bearer token.
To change a deck made earlier: call list_roadshow_slides to find it (title, dates, author, change history), get_roadshow_slides for its original request, files and full history, then update_roadshow_slides with the new data or changes (and get_roadshow_slides_status until it is "ready" again), or delete_roadshow_slides to remove it.`;

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

/** A failed tool call: reported to the model as `isError` so it can fix its arguments. */
class ToolError extends Error {}

type Args = Record<string, unknown>;
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
interface ToolResult {
  content: Content[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const PARSE_ERROR = Symbol('parse error');
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const json = (v: unknown) => JSON.stringify(v, null, 2);

function textArg(args: Args, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (opts.required) throw new ToolError(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError(`"${key}" must be a string`);
  if (opts.required && !v.trim()) throw new ToolError(`"${key}" must not be empty`);
  if (opts.max && v.length > opts.max) throw new ToolError(`"${key}" is ${v.length} characters; the limit is ${opts.max}. Put long raw data in files instead.`);
  return v;
}

function intArg(args: Args, key: string, min: number, max: number): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new ToolError(`"${key}" must be an integer from ${min} to ${max}`);
  return String(n);
}

function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export function decodeFile(raw: unknown, i: number): UploadFile {
  const at = `files[${i}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError(`${at} must be an object with filename and data or text`);
  const f = raw as Args;
  const filename = typeof f.filename === 'string' ? path.basename(f.filename.trim().replace(/\\/g, '/')) : '';
  if (!filename) throw new ToolError(`${at}.filename is required`);
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!IMAGE_EXT[ext] && !DOC_EXT[ext]) throw new ToolError(`${at} "${filename}": unsupported file type. Supported extensions: ${SUPPORTED}`);
  if ((f.data === undefined) === (f.text === undefined)) throw new ToolError(`${at} "${filename}": give either data (base64) or text (plain text), not both`);
  let buf: Buffer;
  if (f.data !== undefined) {
    if (typeof f.data !== 'string') throw new ToolError(`${at}.data must be a base64 string`);
    const b64 = f.data.trim().replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) throw new ToolError(`${at} "${filename}": data is not valid base64`);
    buf = Buffer.from(b64, 'base64');
  } else {
    if (typeof f.text !== 'string') throw new ToolError(`${at}.text must be a string`);
    if (!PLAIN_TEXT_EXT.has(ext)) throw new ToolError(`${at} "${filename}" is a binary format; send it base64-encoded in data`);
    buf = Buffer.from(f.text, 'utf8');
  }
  if (!buf.length) throw new ToolError(`${at} "${filename}" is empty`);
  if (buf.length > MAX_FILE_BYTES) throw new ToolError(`${at} "${filename}" is larger than 100 MB`);
  if (f.role !== undefined && f.role !== 'embed' && f.role !== 'reference') throw new ToolError(`${at}.role must be "embed" or "reference"`);
  const role = f.role as UploadFile['role'];
  if (IMAGE_EXT[ext]) {
    const mime = sniffImage(buf);
    if (!mime) throw new ToolError(`${at} "${filename}" is not a valid PNG, JPEG, GIF or WebP image`);
    return { filename, mime, buf, role };
  }
  return { filename, mime: DOC_EXT[ext], buf, role };
}

/** The first heading (else the first text) of a page, entities decoded. */
function pageTitle(html: string): string | undefined {
  const $ = cheerio.load(html);
  $('style, script, template').remove();
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  const text = squash($('h1, h2, h3').first().text()) || squash($.root().text());
  if (!text) return undefined;
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

const pageList = (doc: DeckDoc) => nameFiles(doc.pages).map((p, i) => ({ page: i + 1, file: p.file!, title: pageTitle(p.html) }));

function readyTemplates(db: DB): ProjectRow[] {
  const rows = db.prepare(`SELECT * FROM projects WHERE type = 'template' AND status = 'ready' ORDER BY updated_at DESC`).all() as ProjectRow[];
  return rows.filter((p) => projectDoc(p)?.pages.length);
}

const fileItemSchema = {
  type: 'object',
  properties: {
    filename: { type: 'string', description: `File name with extension: ${SUPPORTED}.` },
    data: { type: 'string', description: 'File content, base64-encoded (a data: URL also works).' },
    text: { type: 'string', description: 'File content as plain text, for html, txt, md, csv, json, xml and yaml files.' },
    role: {
      type: 'string',
      enum: ['embed', 'reference'],
      default: 'embed',
      description: 'Images only: "embed" may be placed on slides, "reference" is only looked at. Documents are always reference material.',
    },
  },
  required: ['filename'],
  additionalProperties: false,
};

const projectIdSchema = { type: 'string', description: 'projectId from list_roadshow_slides or create_roadshow_slides.' };

function toolDefinitions(db: DB) {
  const ids = readyTemplates(db).map((t) => t.id);
  return [
    {
      name: 'list_roadshow_templates',
      title: 'List roadshow templates',
      description:
        'List the slide templates a deck can be created from (模板): id, name, size, style, intended purpose and audience, and the layouts each one offers. Call this before create_roadshow_slides and pick the template that fits the content and audience.',
      inputSchema: {
        type: 'object',
        properties: {
          includePreviews: { type: 'boolean', description: 'Also return a cover image of each template (slower).', default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'create_roadshow_slides',
      title: 'Create roadshow slides',
      description: `Create a roadshow slide deck (路演材料) from a template, the same as 新建路演材料 on the web page. Returns a projectId at once; generation runs in the background and takes a few minutes, so then call get_roadshow_slides_status until status is "ready".

The deck can only show what you send, and the generator does not make up numbers. For tests, experiments, benchmarks or evaluations send the complete material, not a summary:
- content: the goal and what was tested; the setup (hardware, software and versions, datasets, parameters); the method and test cases; every metric with exact values and units plus baselines or previous results, as Markdown tables; failures, anomalies and limitations; conclusions, risks and next steps; and what each section of the deck should say.
- files: charts, plots, screenshots and diagrams as images (PNG/JPEG/GIF/WebP; role "embed" lets them appear on slides), and the raw results and reports (CSV, JSON, Markdown, logs, PDF, PPTX) for the generator to read. Name each file in content and say what it shows and where it belongs.`,
      inputSchema: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description: 'Template id from list_roadshow_templates.',
            ...(ids.length ? { enum: ids } : {}),
          },
          name: { type: 'string', description: 'Deck title (材料名称), e.g. "Search v2 load test report".' },
          content: {
            type: 'string',
            description: `What the deck must contain (需要添加的内容), section by section, in Markdown: the main input. Include all the test data and results described above. At most ${MAX_CONTENT} characters; send longer raw data as files. The deck is written in the language of this text unless notes says otherwise.`,
          },
          purpose: { type: 'string', description: 'Purpose (用途), e.g. "monthly QA review for engineering leads".' },
          audience: { type: 'string', description: 'Audience (受众), e.g. "engineering managers and the CTO".' },
          pageCount: { type: 'integer', minimum: 1, maximum: 40, description: 'Number of pages (页数). Omit to let the generator decide.' },
          aspect: {
            type: 'string',
            enum: ['template', ...Object.keys(ASPECTS), 'custom'],
            default: 'template',
            description: `Slide size (画幅): "template" keeps the template's size; ${Object.entries(ASPECTS)
              .map(([k, a]) => `"${k}" ${a.width}×${a.height}`)
              .join(', ')}; "custom" uses width and height.`,
          },
          width: { type: 'integer', minimum: 320, maximum: 4000, description: 'Slide width in pixels, only with aspect "custom".' },
          height: { type: 'integer', minimum: 320, maximum: 4000, description: 'Slide height in pixels, only with aspect "custom".' },
          notes: { type: 'string', description: 'Other requirements (其他要求), e.g. language, a logo on every page, colours to avoid.' },
          files: {
            type: 'array',
            maxItems: MAX_UPLOAD_FILES,
            description: `Supporting files (支持材料与参考), at most ${MAX_UPLOAD_FILES}, 100 MB each. Binary files go base64-encoded in data; text files may use text instead. PPT/PDF/HTML pages are converted to images and their text extracted.`,
            items: fileItemSchema,
          },
        },
        required: ['templateId', 'name', 'content'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: 'get_roadshow_slides_status',
      title: 'Get roadshow slides status',
      description:
        'Progress and result of a deck started with create_roadshow_slides or changed with update_roadshow_slides. Waits up to waitSeconds while it is still "generating" or "updating". When status is "ready" it returns the page list, the editor link and download links (html, pdf, pdf-image, pptx, zip; send the same Authorization header); when "error" it returns the reason. lastRequest is the latest create or update made through MCP: if an update failed, status is "ready" with the deck unchanged and lastRequest.error says why.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'projectId returned by create_roadshow_slides (or from list_roadshow_slides).' },
          waitSeconds: {
            type: 'integer',
            minimum: 0,
            maximum: MAX_WAIT_SECONDS,
            default: DEFAULT_WAIT_SECONDS,
            description: 'How long to wait for the deck to finish before answering.',
          },
          includePreviews: { type: 'boolean', default: false, description: `When ready, also return images of the first ${MAX_PREVIEW_PAGES} pages to check the result.` },
        },
        required: ['projectId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'list_roadshow_slides',
      title: 'List roadshow slides',
      description:
        'List the decks (路演材料) created through MCP, most recently changed first, to find one made earlier: projectId, title, status, created/updated date and by whom, page count, template, purpose, audience, the start of the original content, and the latest change history (who changed what, when). Then call get_roadshow_slides for the full original request and history, update_roadshow_slides to change a deck or delete_roadshow_slides to remove it.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Only decks whose title, content, purpose or audience contains this text (case-insensitive).' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT, description: 'Most decks to return.' },
          offset: { type: 'integer', minimum: 0, default: 0, description: 'Decks to skip, for paging.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'get_roadshow_slides',
      title: 'Get roadshow slides',
      description:
        'Everything about one deck created through MCP: the original request it was created from (originalRequest: templateId, name, content, purpose, audience, pageCount, notes, the same fields create_roadshow_slides takes), its uploaded files, the full change history with each request (who, when, what), failed requests, the page list, and the editor and download links. Use it to see what a deck already says before update_roadshow_slides.',
      inputSchema: {
        type: 'object',
        properties: { projectId: projectIdSchema },
        required: ['projectId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'update_roadshow_slides',
      title: 'Update roadshow slides',
      description: `Change a deck created through MCP, the same as the 修改 box in the web editor: the generator edits the current deck according to instructions and saves the result as a new version (earlier versions stay in the history and can be restored on the web page). Returns at once; then call get_roadshow_slides_status until status is "ready" again and check lastRequest.

Send the new data in full, as for create_roadshow_slides: new or corrected numbers with units as Markdown tables, what changed since the last version, and which pages or sections they replace or extend. New charts and data files go in files; name each in instructions and say where it belongs. name alone renames the deck without the generator.`,
      inputSchema: {
        type: 'object',
        properties: {
          projectId: projectIdSchema,
          instructions: {
            type: 'string',
            description: `What to change (修改要求), in Markdown, with all the new data, e.g. "Replace the results on the latency page with the re-run below and update the conclusion: …". At most ${MAX_CONTENT} characters.`,
          },
          page: {
            type: 'integer',
            minimum: 1,
            description: 'Only change this page (1-based, see pages in get_roadshow_slides). Omit to let the change cover the whole deck: adding, removing or reordering pages as needed.',
          },
          name: { type: 'string', description: 'New deck title (材料名称).' },
          files: {
            type: 'array',
            maxItems: MAX_UPLOAD_FILES,
            description: `New supporting files for this change, at most ${MAX_UPLOAD_FILES}, 100 MB each, in the same form as for create_roadshow_slides. They are added to the deck's files.`,
            items: fileItemSchema,
          },
        },
        required: ['projectId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: 'delete_roadshow_slides',
      title: 'Delete roadshow slides',
      description:
        'Permanently delete a deck created through MCP, with all its versions, uploaded files and share link. It disappears from the web page too and cannot be restored. Confirm with the user first.',
      inputSchema: {
        type: 'object',
        properties: { projectId: projectIdSchema },
        required: ['projectId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function baseUrl(req: FastifyRequest): string {
  if (config.publicUrl) return config.publicUrl;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim();
  const proto = first(req.headers['x-forwarded-proto']) || ((req.raw.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const host = first(req.headers['x-forwarded-host']) || req.headers.host || `localhost:${config.port}`;
  return `${proto}://${host}`;
}

/** Browsers send Origin; a page from another site must not drive the server even if it learnt the token. */
function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const hostname = (h: string) => new URL(`http://${h.split(',')[0].trim()}`).hostname;
    const allowed = [req.headers.host, req.headers['x-forwarded-host'], config.publicUrl && new URL(config.publicUrl).host];
    const from = new URL(origin).hostname;
    return allowed.some((h) => typeof h === 'string' && hostname(h) === from);
  } catch {
    return false;
  }
}

function latestCreateJob(db: DB, projectId: string): JobRow | undefined {
  return db.prepare(`SELECT * FROM jobs WHERE project_id = ? AND kind = 'create' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(projectId) as JobRow | undefined;
}

/** The latest create or update the MCP account asked for. */
function latestMcpJob(db: DB, projectId: string, svcId: number): JobRow | undefined {
  return db.prepare(`SELECT * FROM jobs WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(projectId, svcId) as
    | JobRow
    | undefined;
}

const isActive = (j: JobRow | undefined) => j?.status === 'pending' || j?.status === 'running';
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : undefined);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function userNames(db: DB): Map<number, string> {
  const rows = db.prepare('SELECT id, username, display_name FROM users').all() as { id: number; username: string; display_name: string }[];
  return new Map(rows.map((r) => [r.id, r.display_name || r.username]));
}

const ACTIONS: Record<string, string> = {
  create: 'created',
  edit: 'updated',
  revert: 'restored',
  rename: 'renamed',
  text_edit: 'text edited',
  page_delete: 'page deleted',
  page_duplicate: 'page duplicated',
  page_move: 'page moved',
  readme: 'readme edited',
};

interface VersionRow {
  version_no: number;
  user_id: number | null;
  action: string;
  page_index: number | null;
  prompt: string;
  created_at: number;
}

/** The versions of a deck, oldest first: what each change asked for, by whom and when. */
function history(db: DB, projectId: string, names: Map<number, string>, textLimit?: number) {
  const rows = db
    .prepare('SELECT version_no, user_id, action, page_index, prompt, created_at FROM project_versions WHERE project_id = ? ORDER BY version_no')
    .all(projectId) as VersionRow[];
  return rows.map((v) => ({
    version: v.version_no,
    action: ACTIONS[v.action] ?? v.action,
    by: v.user_id ? names.get(v.user_id) ?? null : null,
    at: iso(v.created_at),
    ...(v.page_index !== null ? { page: v.page_index + 1 } : {}),
    request: textLimit ? clip(v.prompt, textLimit) : v.prompt,
  }));
}

const JOB_STATUS: Record<JobRow['status'], string> = { pending: 'queued', running: 'running', done: 'done', error: 'error' };

function publicJob(db: DB, j: JobRow, names: Map<number, string>) {
  const req = JSON.parse(j.request || '{}') as { prompt?: string; scope?: string; pageId?: string };
  const version = j.version_id
    ? (db.prepare('SELECT version_no FROM project_versions WHERE id = ?').get(j.version_id) as { version_no: number } | undefined)?.version_no
    : undefined;
  return {
    jobId: j.id,
    kind: j.kind === 'edit' ? 'update' : 'create',
    status: JOB_STATUS[j.status],
    requestedBy: j.user_id ? names.get(j.user_id) ?? null : null,
    requestedAt: iso(j.created_at),
    finishedAt: iso(j.finished_at),
    ...(j.kind === 'edit' ? { request: req.prompt, scope: req.scope === 'global' ? 'deck' : 'page' } : {}),
    ...(version ? { resultVersion: version } : {}),
    ...(j.status === 'error' ? { error: j.error ?? 'unknown error' } : {}),
  };
}

function briefOf(p: Pick<ProjectRow, 'meta'>): Record<string, unknown> {
  return (JSON.parse(p.meta || '{}').brief ?? {}) as Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeFiles(args: Args): UploadFile[] {
  const rawFiles = args.files ?? [];
  if (!Array.isArray(rawFiles)) throw new ToolError('"files" must be an array');
  if (rawFiles.length > MAX_UPLOAD_FILES) throw new ToolError(`At most ${MAX_UPLOAD_FILES} files; merge small tables into one CSV or Markdown file`);
  return rawFiles.map(decodeFile);
}

const publicAsset = (db: DB, a: AssetRow) => ({
  filename: a.filename,
  kind: a.kind,
  role: a.role,
  bytes: a.size,
  ...(a.kind === 'document' ? { pagesAsImages: slideAssets(db, a.id).length, textExtracted: !!a.extracted_text } : {}),
});

export async function mcpRoutes(app: FastifyInstance, db: DB) {
  /** Decks are reachable through MCP only when the MCP account created them. */
  function myDeck(svc: ServiceUser, id: string): ProjectRow {
    const p = getProject(db, id);
    if (!p || p.type !== 'deck' || p.created_by !== svc.id) {
      throw new ToolError(`No deck "${id}" created through MCP. Call list_roadshow_slides to find the projectId.`);
    }
    return p;
  }

  const downloadLinks = (base: string, id: string) => Object.fromEntries(EXPORT_FORMATS.map((f) => [f, `${base}/api/projects/${id}/export?format=${f}`]));

  async function listTemplates(req: FastifyRequest, args: Args): Promise<ToolResult> {
    const withPreviews = args.includePreviews === true;
    const templates = readyTemplates(db).map((p) => {
      const doc = projectDoc(p)!;
      const brief = (JSON.parse(p.meta || '{}').brief ?? {}) as Record<string, unknown>;
      const pick = (k: string) => (typeof brief[k] === 'string' && (brief[k] as string).trim() ? (brief[k] as string).trim() : undefined);
      const guide = readmeBody(withReadme(p, doc).readme ?? '');
      return {
        templateId: p.id,
        name: p.name,
        size: `${doc.width}×${doc.height}`,
        style: pick('style'),
        purpose: pick('purpose'),
        audience: pick('audience'),
        colors: pick('colors'),
        notes: pick('notes'),
        layoutCount: doc.pages.length,
        layouts: pageList(doc).map(({ file, title }) => ({ file, title })),
        guide: guide.length > GUIDE_LIMIT ? `${guide.slice(0, GUIDE_LIMIT)}…` : guide,
        updatedAt: new Date(p.updated_at).toISOString(),
      };
    });
    const content: Content[] = [
      {
        type: 'text',
        text: templates.length
          ? json({ templates })
          : 'No template is ready yet. A person has to create a template (模板) on the web page first: ' + `${baseUrl(req)}/templates`,
      },
    ];
    if (withPreviews) {
      const resolver = makeAssetResolver(db);
      for (const t of readyTemplates(db).slice(0, MAX_TEMPLATE_PREVIEWS)) {
        const doc = projectDoc(t)!;
        const [shot] = await renderPageImages(doc, resolver, { pageIds: [doc.pages[0].id], scale: 0.4, type: 'jpeg' });
        if (!shot) continue;
        content.push({ type: 'text', text: `Cover of "${t.name}" (${t.id})` }, { type: 'image', data: shot.image.toString('base64'), mimeType: 'image/jpeg' });
      }
    }
    return { content, structuredContent: { templates } };
  }

  async function createSlides(req: FastifyRequest, svc: ServiceUser, args: Args): Promise<ToolResult> {
    const fields: Record<string, string | undefined> = {
      type: 'deck',
      templateId: textArg(args, 'templateId', { required: true })!.trim(),
      name: textArg(args, 'name', { required: true, max: 200 }),
      content: textArg(args, 'content', { required: true, max: MAX_CONTENT }),
      purpose: textArg(args, 'purpose', { max: 2000 }),
      audience: textArg(args, 'audience', { max: 2000 }),
      notes: textArg(args, 'notes', { max: 10_000 }),
      pageCount: intArg(args, 'pageCount', 1, 40),
      aspect: textArg(args, 'aspect') ?? 'template',
      width: intArg(args, 'width', 320, 4000),
      height: intArg(args, 'height', 320, 4000),
    };
    if (fields.aspect !== 'template' && fields.aspect !== 'custom' && !ASPECTS[fields.aspect!]) {
      throw new ToolError(`"aspect" must be one of: template, ${Object.keys(ASPECTS).join(', ')}, custom`);
    }
    if (fields.aspect === 'custom' && (!fields.width || !fields.height)) throw new ToolError('aspect "custom" needs width and height');
    const files = decodeFiles(args);
    const { project, job } = await createFromForm(db, svc.id, fields, files, { askUser: false });
    req.log.info({ projectId: project.id, jobId: job.id, files: files.length }, 'mcp create_roadshow_slides');
    const assets = projectAssets(db, project.id).map((a) => publicAsset(db, a));
    const result = {
      projectId: project.id,
      name: project.name,
      status: 'generating',
      template: getProject(db, fields.templateId!)?.name,
      size: `${projectDoc(project)?.width}×${projectDoc(project)?.height}`,
      files: assets,
      editorUrl: `${baseUrl(req)}/p/${project.id}`,
      next: `Generation takes a few minutes. Call get_roadshow_slides_status with projectId "${project.id}" until status is "ready".`,
    };
    return { content: [{ type: 'text', text: json(result) }], structuredContent: result };
  }

  async function slidesStatus(req: FastifyRequest, svc: ServiceUser, args: Args): Promise<ToolResult> {
    const id = textArg(args, 'projectId', { required: true })!.trim();
    const wait = Number(intArg(args, 'waitSeconds', 0, MAX_WAIT_SECONDS) ?? DEFAULT_WAIT_SECONDS);
    let project = myDeck(svc, id);
    const deadline = Date.now() + wait * 1000;
    const busy = () => project.status === 'generating' || isActive(latestMcpJob(db, id, svc.id));
    while (busy() && Date.now() < deadline && !req.raw.socket.destroyed) {
      await sleep(Math.min(1000, deadline - Date.now()));
      const p = getProject(db, id);
      if (!p) throw new ToolError(`Deck "${id}" was deleted`);
      project = p;
    }
    const mcpJob = latestMcpJob(db, id, svc.id);
    const updating = project.status !== 'generating' && mcpJob?.kind === 'edit' && isActive(mcpJob);
    const job = updating ? mcpJob : latestCreateJob(db, id);
    const progress = job ? jobProgress.get(job.id) : undefined;
    const doc = projectDoc(project);
    const base = baseUrl(req);
    const started = job?.created_at ?? project.created_at;
    const failedUpdate = mcpJob?.kind === 'edit' && mcpJob.status === 'error';
    const result: Record<string, unknown> = {
      projectId: project.id,
      name: project.name,
      status: updating ? 'updating' : project.status,
      version: project.version_no,
      ...(project.status === 'generating' || updating
        ? {
            stage: progress?.stage ?? (job?.status === 'pending' ? 'queued' : 'starting'),
            generatedChars: progress?.chars ?? 0,
            elapsedSeconds: Math.round((Date.now() - started) / 1000),
            next: `Still ${updating ? 'updating' : 'generating'}. Call get_roadshow_slides_status again.`,
          }
        : {}),
      ...(project.status === 'error' ? { error: project.error ?? job?.error ?? 'unknown error' } : {}),
      ...(mcpJob ? { lastRequest: publicJob(db, mcpJob, userNames(db)) } : {}),
      ...(failedUpdate && project.status === 'ready'
        ? { next: `The last update failed and the deck is unchanged (version ${project.version_no}): ${mcpJob.error ?? 'unknown error'}. Call update_roadshow_slides again if the change is still wanted.` }
        : {}),
      editorUrl: `${base}/p/${project.id}`,
    };
    if (result.status === 'ready' && doc) {
      result.pageCount = doc.pages.length;
      result.size = `${doc.width}×${doc.height}`;
      result.pages = pageList(doc);
      const done = mcpJob?.status === 'done' ? mcpJob : job;
      result.durationSeconds = done?.finished_at ? Math.round((done.finished_at - done.created_at) / 1000) : undefined;
      result.downloads = downloadLinks(base, project.id);
      result.downloadAuth = 'Send the same "Authorization: Bearer <token>" header used for MCP.';
    }
    const content: Content[] = [{ type: 'text', text: json(result) }];
    if (args.includePreviews === true && result.status === 'ready' && doc) {
      const ids = doc.pages.slice(0, MAX_PREVIEW_PAGES).map((pg) => pg.id);
      const shots = await renderPageImages(doc, makeAssetResolver(db), { pageIds: ids, scale: 0.4, type: 'jpeg' });
      shots.forEach((s, i) => content.push({ type: 'text', text: `Page ${i + 1}` }, { type: 'image', data: s.image.toString('base64'), mimeType: 'image/jpeg' }));
    }
    return { content, structuredContent: result };
  }

  async function listSlides(req: FastifyRequest, svc: ServiceUser, args: Args): Promise<ToolResult> {
    const asked = textArg(args, 'query', { max: 500 })?.trim();
    const query = asked?.toLowerCase();
    const limit = Number(intArg(args, 'limit', 1, MAX_LIST_LIMIT) ?? DEFAULT_LIST_LIMIT);
    const offset = Number(intArg(args, 'offset', 0, 1_000_000) ?? 0);
    const rows = db
      .prepare(
        `SELECT id, name, meta, template_id, status, error, version_no, created_by, updated_by, created_at, updated_at,
                json_array_length(doc, '$.pages') AS page_count, json_extract(doc, '$.width') AS width, json_extract(doc, '$.height') AS height
         FROM projects WHERE type = 'deck' AND created_by = ? ORDER BY updated_at DESC, rowid DESC`,
      )
      .all(svc.id) as (Omit<ProjectRow, 'doc'> & { page_count: number | null; width: number | null; height: number | null })[];
    const matched = query
      ? rows.filter((r) => {
          const b = briefOf(r);
          return [r.name, b.name, b.content, b.purpose, b.audience].some((v) => typeof v === 'string' && v.toLowerCase().includes(query));
        })
      : rows;
    const names = userNames(db);
    const templateName = (tid: string | null) => (tid ? (db.prepare('SELECT name FROM projects WHERE id = ?').get(tid) as { name: string } | undefined)?.name : undefined);
    const base = baseUrl(req);
    const decks = matched.slice(offset, offset + limit).map((r) => {
      const b = briefOf(r);
      const content = str(b.content);
      const changes = history(db, r.id, names, LIST_TEXT_LIMIT);
      return {
        projectId: r.id,
        name: r.name,
        status: r.status,
        ...(r.status === 'error' ? { error: r.error ?? 'unknown error' } : {}),
        version: r.version_no,
        pageCount: r.page_count ?? 0,
        size: r.width && r.height ? `${r.width}×${r.height}` : undefined,
        template: r.template_id ? { templateId: r.template_id, name: templateName(r.template_id) ?? null } : null,
        purpose: str(b.purpose),
        audience: str(b.audience),
        contentPreview: content ? clip(content, LIST_TEXT_LIMIT) : undefined,
        createdAt: iso(r.created_at),
        createdBy: r.created_by ? names.get(r.created_by) ?? null : null,
        updatedAt: iso(r.updated_at),
        updatedBy: r.updated_by ? names.get(r.updated_by) ?? null : null,
        historyCount: changes.length,
        history: changes.slice(-LIST_HISTORY),
        editorUrl: `${base}/p/${r.id}`,
      };
    });
    const result = {
      total: matched.length,
      offset,
      decks,
      ...(offset + decks.length < matched.length ? { next: `More decks: call list_roadshow_slides again with offset ${offset + decks.length}.` } : {}),
    };
    const empty = !rows.length
      ? 'No deck has been created through MCP yet. Use create_roadshow_slides to make one.'
      : !decks.length
        ? `No deck${asked ? ` matches "${asked}"` : ' at this offset'} (${rows.length} created through MCP in all).`
        : undefined;
    return { content: [{ type: 'text', text: empty ?? json(result) }], structuredContent: result };
  }

  async function getSlides(req: FastifyRequest, svc: ServiceUser, args: Args): Promise<ToolResult> {
    const p = myDeck(svc, textArg(args, 'projectId', { required: true })!.trim());
    const names = userNames(db);
    const b = briefOf(p);
    const doc = projectDoc(p);
    const base = baseUrl(req);
    const template = p.template_id ? getProject(db, p.template_id) : undefined;
    const failed = db
      .prepare(`SELECT * FROM jobs WHERE project_id = ? AND status = 'error' ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(p.id, MAX_FAILED_REQUESTS) as JobRow[];
    const mcpJob = latestMcpJob(db, p.id, svc.id);
    const hasPages = !!doc?.pages.length;
    const result = {
      projectId: p.id,
      name: p.name,
      status: p.status !== 'generating' && mcpJob?.kind === 'edit' && isActive(mcpJob) ? 'updating' : p.status,
      ...(p.status === 'error' ? { error: p.error ?? 'unknown error' } : {}),
      version: p.version_no,
      createdAt: iso(p.created_at),
      createdBy: p.created_by ? names.get(p.created_by) ?? null : null,
      updatedAt: iso(p.updated_at),
      updatedBy: p.updated_by ? names.get(p.updated_by) ?? null : null,
      template: p.template_id ? { templateId: p.template_id, name: template?.name ?? null } : null,
      size: doc ? `${doc.width}×${doc.height}` : undefined,
      originalRequest: {
        templateId: p.template_id ?? undefined,
        name: str(b.name) ?? p.name,
        content: str(b.content),
        purpose: str(b.purpose),
        audience: str(b.audience),
        pageCount: typeof b.pageCount === 'number' ? b.pageCount : undefined,
        notes: str(b.notes),
      },
      files: projectAssets(db, p.id).map((a) => ({ ...publicAsset(db, a), uploadedAt: iso(a.created_at), uploadedBy: a.created_by ? names.get(a.created_by) ?? null : null })),
      history: history(db, p.id, names),
      ...(failed.length ? { failedRequests: failed.map((j) => publicJob(db, j, names)) } : {}),
      ...(mcpJob ? { lastRequest: publicJob(db, mcpJob, names) } : {}),
      ...(hasPages ? { pageCount: doc!.pages.length, pages: pageList(doc!) } : {}),
      editorUrl: `${base}/p/${p.id}`,
      ...(hasPages ? { downloads: downloadLinks(base, p.id), downloadAuth: 'Send the same "Authorization: Bearer <token>" header used for MCP.' } : {}),
    };
    return { content: [{ type: 'text', text: json(result) }], structuredContent: result };
  }

  async function updateSlides(req: FastifyRequest, svc: ServiceUser, args: Args): Promise<ToolResult> {
    const p = myDeck(svc, textArg(args, 'projectId', { required: true })!.trim());
    const instructions = textArg(args, 'instructions', { max: MAX_CONTENT })?.trim() || undefined;
    const rawName = textArg(args, 'name', { max: 200 });
    const name = rawName?.trim();
    if (rawName !== undefined && !name) throw new ToolError('"name" must not be empty');
    const pageNo = intArg(args, 'page', 1, 10_000);
    const files = decodeFiles(args);
    if (!instructions && !name) throw new ToolError('Give instructions (what to change, with the new data), a new name, or both');
    if (!instructions && (files.length || pageNo)) throw new ToolError('files and page go with instructions: say what to change and how to use the files');
    let pageId: string | undefined;
    if (instructions) {
      if (p.status === 'generating') throw new ToolError(`Deck "${p.id}" is still being generated. Wait with get_roadshow_slides_status until it is "ready".`);
      const doc = projectDoc(p);
      if (!doc?.pages.length) {
        throw new ToolError(`Deck "${p.id}" has no pages to update because its generation failed (${p.error ?? 'unknown error'}). Delete it and create it again.`);
      }
      if (pageNo) {
        if (Number(pageNo) > doc.pages.length) throw new ToolError(`"page" must be from 1 to ${doc.pages.length}`);
        pageId = doc.pages[Number(pageNo) - 1].id;
      }
      const running = latestMcpJob(db, p.id, svc.id);
      if (isActive(running)) {
        throw new ToolError(`An update of deck "${p.id}" is still running (jobId ${running!.id}). Wait with get_roadshow_slides_status until it is "ready", then send the next change.`);
      }
    }
    if (name && name !== p.name) await renameProject(db, p.id, svc.id, name);
    let job: JobRow | undefined;
    let saved: AssetRow[] = [];
    if (instructions) {
      for (const f of files) saved.push(await saveAsset(db, p.id, svc.id, f.filename, f.mime, f.buf, f.role ?? 'embed'));
      try {
        job = startEdit(db, p.id, svc.id, {
          prompt: instructions,
          scope: pageId ? 'page' : 'global',
          pageId,
          elementIds: [],
          attachmentIds: saved.map((a) => a.id),
          askUser: false,
        });
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
    }
    req.log.info({ projectId: p.id, jobId: job?.id, renamed: !!name, files: saved.length }, 'mcp update_roadshow_slides');
    const project = getProject(db, p.id)!;
    const result = {
      projectId: project.id,
      name: project.name,
      status: job ? 'updating' : project.status,
      version: project.version_no,
      ...(job ? { jobId: job.id, scope: pageNo ? `page ${pageNo}` : 'deck', files: saved.map((a) => publicAsset(db, a)) } : {}),
      editorUrl: `${baseUrl(req)}/p/${project.id}`,
      next: job
        ? `The change takes a few minutes. Call get_roadshow_slides_status with projectId "${project.id}" until status is "ready", then check lastRequest.`
        : 'Renamed; no generation needed.',
    };
    return { content: [{ type: 'text', text: json(result) }], structuredContent: result };
  }

  async function deleteSlides(req: FastifyRequest, svc: ServiceUser, args: Args): Promise<ToolResult> {
    const p = myDeck(svc, textArg(args, 'projectId', { required: true })!.trim());
    deleteProject(db, p.id);
    req.log.info({ projectId: p.id }, 'mcp delete_roadshow_slides');
    const result = { projectId: p.id, name: p.name, deleted: true };
    return { content: [{ type: 'text', text: json(result) }], structuredContent: result };
  }

  async function callTool(req: FastifyRequest, svc: ServiceUser, params: Args): Promise<ToolResult> {
    const name = params.name;
    const args = (params.arguments ?? {}) as Args;
    if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError(-32602, 'arguments must be an object');
    const tools: Record<string, () => Promise<ToolResult>> = {
      list_roadshow_templates: () => listTemplates(req, args),
      create_roadshow_slides: () => createSlides(req, svc, args),
      get_roadshow_slides_status: () => slidesStatus(req, svc, args),
      list_roadshow_slides: () => listSlides(req, svc, args),
      get_roadshow_slides: () => getSlides(req, svc, args),
      update_roadshow_slides: () => updateSlides(req, svc, args),
      delete_roadshow_slides: () => deleteSlides(req, svc, args),
    };
    if (typeof name !== 'string' || !Object.hasOwn(tools, name)) throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
    try {
      return await tools[name]();
    } catch (e) {
      if (!(e instanceof ToolError) && !(e instanceof HttpError)) req.log.error(e);
      return { content: [{ type: 'text', text: (e as Error).message || 'Tool failed' }], isError: true };
    }
  }

  async function dispatch(req: FastifyRequest, svc: ServiceUser, method: string, params: Args): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const asked = String(params.protocolVersion ?? '');
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'roadshow', title: 'HTTP 路演生成器', version: versionInfo().version },
          instructions: INSTRUCTIONS,
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: toolDefinitions(db) };
      case 'tools/call':
        return callTool(req, svc, params);
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  async function handleMessage(req: FastifyRequest, svc: ServiceUser, msg: unknown): Promise<unknown> {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || (msg as Args).jsonrpc !== '2.0') {
      return rpcError((msg as Args | null)?.id, -32600, 'Invalid Request');
    }
    const m = msg as Args;
    if (typeof m.method !== 'string') return 'result' in m || 'error' in m ? undefined : rpcError(m.id, -32600, 'Invalid Request');
    if (!('id' in m)) return undefined;
    const params = m.params && typeof m.params === 'object' ? (m.params as Args) : {};
    try {
      return { jsonrpc: '2.0', id: m.id, result: await dispatch(req, svc, m.method, params) };
    } catch (e) {
      if (e instanceof RpcError) return rpcError(m.id, e.code, e.message);
      req.log.error(e);
      return rpcError(m.id, -32603, `Internal error: ${(e as Error).message}`);
    }
  }

  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: BODY_LIMIT }, (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(null, PARSE_ERROR);
      }
    });

    scope.post('/mcp', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
      if (!sameOrigin(req)) return reply.status(403).send(rpcError(null, -32000, 'Origin not allowed'));
      let svc: ServiceUser;
      try {
        svc = requireMcpCaller(db, req);
      } catch (e) {
        if (e instanceof HttpError) return reply.status(e.statusCode).send(rpcError(null, -32001, e.message));
        throw e;
      }
      if (req.body === PARSE_ERROR) return reply.status(400).send(rpcError(null, -32700, 'Parse error'));
      const batch = Array.isArray(req.body);
      const messages = batch ? (req.body as unknown[]) : [req.body];
      if (!messages.length) return reply.status(400).send(rpcError(null, -32600, 'Invalid Request'));
      const out: unknown[] = [];
      for (const msg of messages) {
        const r = await handleMessage(req, svc, msg);
        if (r !== undefined) out.push(r);
      }
      if (!out.length) return reply.status(202).send();
      return reply.type('application/json').send(batch ? out : out[0]);
    });
  });

  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.status(405).header('Allow', 'POST').send(rpcError(null, -32000, 'Method not allowed: this server only answers POST (stateless, no SSE stream)'));
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
