import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import type { DB } from './db.js';
import type { AssetRef } from './prompts.js';
import { renderHtmlReference } from './render.js';

export type AssetRole = 'embed' | 'reference';

export interface AssetRow {
  id: string;
  project_id: string | null;
  filename: string;
  mime: string;
  size: number;
  kind: 'image' | 'document' | 'slide';
  extracted_text: string | null;
  created_by: number | null;
  created_at: number;
  parent_id: string | null;
  page_no: number | null;
  role: AssetRole;
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log)$/i;
const HTML_EXT = /\.(html?|xhtml)$/i;
const SLIDES_EXT = /\.(pptx?|ppsx?|potx?|odp|key|pdf|docx?|odt)$/i;
const ZIP_EXT = /\.(pptx|ppsx|potx|odp|docx|odt|xlsx)$/i;
/** Whole documents are kept; the model pages through long ones with the read-only file tools. */
const MAX_TEXT = 2_000_000;
export const MAX_SLIDES = 30;

export const assetUrl = (id: string) => `/api/assets/${id}`;
export const assetPath = (id: string) => path.join(config.assetDir, id);
export const slidesScript = () => path.join(config.appRoot, 'server', 'scripts', 'slides-to-images.sh');

export const isSlidesFile = (filename: string) => SLIDES_EXT.test(filename);
export const isHtmlFile = (filename: string, mime = '') => HTML_EXT.test(filename) || mime === 'text/html';
export const isZipFile = (filename: string) => ZIP_EXT.test(filename);
export const isRawTextFile = (filename: string, mime = '') =>
  TEXT_EXT.test(filename) || isHtmlFile(filename, mime) || mime.startsWith('text/') || mime === 'application/json';

export type FileType = 'image' | 'presentation' | 'pdf' | 'html' | 'text' | 'word' | 'document';
export function fileType(a: Pick<AssetRow, 'filename' | 'mime' | 'kind'>): FileType {
  if (a.kind === 'image' || a.kind === 'slide') return 'image';
  if (/\.(pptx?|ppsx?|potx?|odp|key)$/i.test(a.filename)) return 'presentation';
  if (/\.pdf$/i.test(a.filename) || a.mime === 'application/pdf') return 'pdf';
  if (isHtmlFile(a.filename, a.mime)) return 'html';
  if (/\.(docx?|odt)$/i.test(a.filename)) return 'word';
  if (isRawTextFile(a.filename, a.mime)) return 'text';
  return 'document';
}

export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();
  $('br').replaceWith('\n');
  $('p, div, section, article, li, h1, h2, h3, h4, h5, h6, tr').append('\n');
  return $('body').text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function pdfText(buf: Buffer): Promise<string> {
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js' as string);
  const r = await pdfParse(buf);
  return String(r.text).slice(0, MAX_TEXT);
}

async function extractText(filename: string, mime: string, buf: Buffer): Promise<string | null> {
  try {
    if (mime === 'application/pdf' || /\.pdf$/i.test(filename)) return await pdfText(buf);
    if (isHtmlFile(filename, mime)) return htmlToText(buf.toString('utf8')).slice(0, MAX_TEXT);
    if (mime.startsWith('text/') || TEXT_EXT.test(filename) || mime === 'application/json') {
      return buf.toString('utf8').slice(0, MAX_TEXT);
    }
  } catch (e) {
    return `（文本提取失败：${(e as Error).message}）`;
  }
  return null;
}

/** Runs scripts/slides-to-images.sh: one JPEG per slide/page plus the intermediate PDF. */
export function exportSlides(file: string, maxPages = MAX_SLIDES): Promise<{ images: Buffer[]; texts: string[]; pdf: Buffer | null }> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-slides-'));
  return new Promise((resolve, reject) => {
    execFile('bash', [slidesScript(), file, out, String(maxPages), '1280'], { timeout: 240_000 }, (err, _stdout, stderr) => {
      try {
        if (err) return reject(new Error(stderr.trim().split('\n').pop() || err.message));
        const names = fs.readdirSync(out).filter((n) => /^slide-\d+\.jpg$/.test(n)).sort();
        const pdfFile = path.join(out, 'document.pdf');
        const textFile = path.join(out, 'text.txt');
        const texts = fs.existsSync(textFile) ? fs.readFileSync(textFile, 'utf8').split('\f').map((t) => t.trim()) : [];
        resolve({
          images: names.map((n) => fs.readFileSync(path.join(out, n))),
          texts: names.map((_, i) => texts[i] ?? ''),
          pdf: fs.existsSync(pdfFile) ? fs.readFileSync(pdfFile) : null,
        });
      } finally {
        fs.rmSync(out, { recursive: true, force: true });
      }
    });
  });
}

const insertAsset = (db: DB, row: AssetRow) =>
  db
    .prepare(
      `INSERT INTO assets (id, project_id, filename, mime, size, kind, extracted_text, created_by, created_at, parent_id, page_no, role)
       VALUES (@id, @project_id, @filename, @mime, @size, @kind, @extracted_text, @created_by, @created_at, @parent_id, @page_no, @role)`,
    )
    .run(row);

export async function saveAsset(
  db: DB,
  projectId: string | null,
  userId: number,
  filename: string,
  mime: string,
  buf: Buffer,
  role: AssetRole = 'embed',
): Promise<AssetRow> {
  const id = nanoid(21);
  const kind = mime.startsWith('image/') ? 'image' : 'document';
  fs.writeFileSync(assetPath(id), buf);
  let text = kind === 'document' ? await extractText(filename, mime, buf) : null;
  let slides: Buffer[] = [];
  let pageTexts: string[] = [];
  if (kind === 'document' && isHtmlFile(filename, mime)) {
    try {
      const r = await renderHtmlReference(buf.toString('utf8'), MAX_SLIDES);
      slides = r.images;
      pageTexts = r.texts;
    } catch (e) {
      text = `${text ?? ''}\n（页面图片导出失败：${(e as Error).message}）`.trim();
    }
  } else if (kind === 'document' && isSlidesFile(filename)) {
    // The converter picks the input format from the extension, which stored assets do not have.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-upload-'));
    const file = path.join(dir, `input${path.extname(filename).toLowerCase()}`);
    try {
      fs.writeFileSync(file, buf);
      const r = await exportSlides(file);
      slides = r.images;
      pageTexts = r.texts;
      if (!text && r.pdf) text = await pdfText(r.pdf).catch(() => null);
    } catch (e) {
      text = `${text ?? ''}\n（页面图片导出失败：${(e as Error).message}）`.trim();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const row: AssetRow = {
    id,
    project_id: projectId,
    filename,
    mime,
    size: buf.length,
    kind,
    extracted_text: text,
    created_by: userId,
    created_at: Date.now(),
    parent_id: null,
    page_no: null,
    role: kind === 'image' ? role : 'reference',
  };
  db.transaction(() => {
    insertAsset(db, row);
    slides.forEach((img, i) => {
      const sid = nanoid(21);
      fs.writeFileSync(assetPath(sid), img);
      insertAsset(db, {
        ...row,
        id: sid,
        filename: `${filename} · 第 ${i + 1} 页`,
        mime: 'image/jpeg',
        size: img.length,
        kind: 'slide',
        extracted_text: pageTexts[i] || null,
        parent_id: id,
        page_no: i + 1,
        role: 'reference',
      });
    });
  })();
  return row;
}

/** Top-level uploads of a project (slide images exported from a file hang off their parent). */
export function projectAssets(db: DB, projectId: string): AssetRow[] {
  return db
    .prepare('SELECT * FROM assets WHERE project_id = ? AND parent_id IS NULL ORDER BY created_at')
    .all(projectId) as AssetRow[];
}

export function slideAssets(db: DB, parentId: string): AssetRow[] {
  return db.prepare('SELECT * FROM assets WHERE parent_id = ? ORDER BY page_no').all(parentId) as AssetRow[];
}

export function slideCount(db: DB, parentId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM assets WHERE parent_id = ?').get(parentId) as { n: number }).n;
}

export function deleteAsset(db: DB, projectId: string, assetId: string) {
  const ids = [assetId, ...slideAssets(db, assetId).map((s) => s.id)];
  db.prepare('DELETE FROM assets WHERE id = ? AND project_id = ?').run(assetId, projectId);
  for (const id of ids) fs.rmSync(assetPath(id), { force: true });
}

const dataUrl = (r: AssetRow) =>
  fs.existsSync(assetPath(r.id)) ? `data:${r.mime};base64,${fs.readFileSync(assetPath(r.id)).toString('base64')}` : undefined;

/** `fileIds` maps asset id → the id the file tools use (F1, …); omit when tools are not offered. */
export function toAssetRefs(db: DB, rows: AssetRow[], withData: boolean, fileIds?: Map<string, string>): AssetRef[] {
  return rows.map((r) => {
    const ref: AssetRef = {
      id: r.id,
      filename: r.filename,
      url: assetUrl(r.id),
      kind: r.kind === 'slide' ? 'image' : r.kind,
      role: r.role,
      text: r.extracted_text,
      fileId: fileIds?.get(r.id),
      fileType: fileType(r),
    };
    if (withData && r.kind === 'image') ref.dataUrl = dataUrl(r);
    if (r.kind === 'document') {
      const slides = slideAssets(db, r.id);
      if (slides.length) {
        ref.slides = slides.map((s) => ({ page: s.page_no ?? 0, dataUrl: withData ? dataUrl(s) : undefined }));
      }
    }
    return ref;
  });
}

export function assetsByIds(db: DB, projectId: string, ids: string[]): AssetRow[] {
  if (!ids.length) return [];
  const rows = db
    .prepare(`SELECT * FROM assets WHERE project_id = ? AND parent_id IS NULL AND id IN (${ids.map(() => '?').join(',')})`)
    .all(projectId, ...ids) as AssetRow[];
  return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is AssetRow => !!r);
}

/** Inline every /api/assets/<id> reference as a data URI so exported files are self-contained. */
export function makeAssetResolver(db: DB) {
  const cache = new Map<string, string | null>();
  return (html: string) =>
    html.replace(/(?:https?:\/\/[^"')\s]*)?\/api\/assets\/([A-Za-z0-9_-]{10,40})/g, (m, id: string) => {
      if (!cache.has(id)) {
        const row = db.prepare('SELECT mime FROM assets WHERE id = ?').get(id) as { mime: string } | undefined;
        if (row && fs.existsSync(assetPath(id))) {
          cache.set(id, `data:${row.mime};base64,${fs.readFileSync(assetPath(id)).toString('base64')}`);
        } else cache.set(id, null);
      }
      return cache.get(id) ?? m;
    });
}
