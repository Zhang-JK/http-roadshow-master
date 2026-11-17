/**
 * Downloads of a deck, shared by the web export route and MCP: the rendered exports (HTML, PDF,
 * PPTX) and the source files the ZIP is made of, one by one.
 */
import path from 'node:path';
import type { DB } from './db.js';
import { assembleHtml, type DeckDoc } from './deck.js';
import { isChart, makeAssetResolver } from './assets.js';
import { bundleFiles, exportBundle } from './bundle.js';
import { nameFiles, README } from './files.js';
import { renderImagePdf, renderPdf, renderPptx } from './render.js';

export const EXPORT_FORMATS = ['html', 'pdf', 'pdf-image', 'pptx', 'zip'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const EXPORT_TYPES: Record<ExportFormat, { mime: string; ext: string }> = {
  html: { mime: 'text/html; charset=utf-8', ext: 'html' },
  pdf: { mime: 'application/pdf', ext: 'pdf' },
  'pdf-image': { mime: 'application/pdf', ext: 'pdf' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  zip: { mime: 'application/zip', ext: 'zip' },
};

/** `doc` must carry its README for the ZIP (see withReadme). */
export async function exportDeck(db: DB, doc: DeckDoc, format: ExportFormat, base: string): Promise<{ buf: Buffer; mime: string; filename: string }> {
  const resolver = makeAssetResolver(db);
  const { mime, ext } = EXPORT_TYPES[format];
  const buf =
    format === 'html'
      ? Buffer.from(assembleHtml(doc, { presenter: true, assetResolver: resolver }), 'utf8')
      : format === 'pdf'
        ? await renderPdf(doc, resolver)
        : format === 'pdf-image'
          ? await renderImagePdf(doc, resolver)
          : format === 'pptx'
            ? await renderPptx(doc, resolver)
            : await exportBundle(db, doc, doc.readme ?? '');
  return { buf, mime, filename: `${base}.${ext}` };
}

const TEXT_TYPES: Record<string, string> = { '.md': 'text/markdown', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };

export interface SourceFile {
  path: string;
  kind: 'readme' | 'style' | 'index' | 'page' | 'image' | 'chart';
  mimeType: string;
  bytes: number;
  /** Text files are strings, images Buffers. */
  content: string | Buffer;
  /** Pages: position in the deck (1-based). */
  page?: number;
}

/** The files of the source ZIP, in its order: README, styles, index.html, pages, then the images they use. */
export function sourceFiles(db: DB, doc: DeckDoc): SourceFile[] {
  const files = bundleFiles(db, doc, doc.readme ?? '');
  const pageNo = new Map(nameFiles(doc.pages).map((p, i) => [p.file!, i + 1]));
  const charts = new Set(
    [...files.keys()]
      .filter((p) => p.endsWith('.svg'))
      .filter((p) => {
        const row = db.prepare('SELECT mime, extracted_text FROM assets WHERE id = ?').get(path.basename(p, '.svg')) as
          | { mime: string; extracted_text: string | null }
          | undefined;
        return !!row && isChart(row);
      }),
  );
  const list = [...files].map(([p, content]): SourceFile => {
    const ext = path.extname(p).toLowerCase();
    const kind: SourceFile['kind'] =
      p === README ? 'readme' : p === 'index.html' ? 'index' : pageNo.has(p) ? 'page' : ext === '.css' ? 'style' : charts.has(p) ? 'chart' : 'image';
    return {
      path: p,
      kind,
      mimeType: TEXT_TYPES[ext] ?? IMAGE_TYPES[ext] ?? 'application/octet-stream',
      bytes: typeof content === 'string' ? Buffer.byteLength(content) : content.length,
      content,
      ...(pageNo.has(p) ? { page: pageNo.get(p) } : {}),
    };
  });
  const rank = { readme: 0, style: 1, index: 2, page: 3, chart: 4, image: 4 } as const;
  return list.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.page ?? 0) - (b.page ?? 0));
}

export const isTextFile = (f: Pick<SourceFile, 'mimeType'>) => f.mimeType.startsWith('text/') || f.mimeType === 'image/svg+xml';
