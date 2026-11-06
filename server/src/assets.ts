import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import type { DB } from './db.js';
import type { AssetRef } from './prompts.js';

export interface AssetRow {
  id: string;
  project_id: string | null;
  filename: string;
  mime: string;
  size: number;
  kind: 'image' | 'document';
  extracted_text: string | null;
  created_by: number | null;
  created_at: number;
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|html?|xml|ya?ml|log)$/i;
const MAX_TEXT = 40_000;

export const assetUrl = (id: string) => `/api/assets/${id}`;
export const assetPath = (id: string) => path.join(config.assetDir, id);

async function extractText(filename: string, mime: string, buf: Buffer): Promise<string | null> {
  try {
    if (mime === 'application/pdf' || /\.pdf$/i.test(filename)) {
      const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js' as string);
      const r = await pdfParse(buf);
      return String(r.text).slice(0, MAX_TEXT);
    }
    if (mime.startsWith('text/') || TEXT_EXT.test(filename) || mime === 'application/json') {
      return buf.toString('utf8').slice(0, MAX_TEXT);
    }
  } catch (e) {
    return `（文本提取失败：${(e as Error).message}）`;
  }
  return null;
}

export async function saveAsset(
  db: DB,
  projectId: string | null,
  userId: number,
  filename: string,
  mime: string,
  buf: Buffer,
): Promise<AssetRow> {
  const id = nanoid(21);
  const kind = mime.startsWith('image/') ? 'image' : 'document';
  fs.writeFileSync(assetPath(id), buf);
  const text = kind === 'document' ? await extractText(filename, mime, buf) : null;
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
  };
  db.prepare(
    `INSERT INTO assets (id, project_id, filename, mime, size, kind, extracted_text, created_by, created_at)
     VALUES (@id, @project_id, @filename, @mime, @size, @kind, @extracted_text, @created_by, @created_at)`,
  ).run(row);
  return row;
}

export function projectAssets(db: DB, projectId: string): AssetRow[] {
  return db.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at').all(projectId) as AssetRow[];
}

export function toAssetRefs(rows: AssetRow[], withData: boolean): AssetRef[] {
  return rows.map((r) => {
    const ref: AssetRef = { id: r.id, filename: r.filename, url: assetUrl(r.id), kind: r.kind, text: r.extracted_text };
    if (withData && r.kind === 'image' && fs.existsSync(assetPath(r.id))) {
      ref.dataUrl = `data:${r.mime};base64,${fs.readFileSync(assetPath(r.id)).toString('base64')}`;
    }
    return ref;
  });
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
