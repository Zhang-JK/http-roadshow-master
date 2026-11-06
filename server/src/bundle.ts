/**
 * Source export: the project as the files it is made of (README.md, styles/*.css, pages/*.html),
 * plus index.html showing all pages, and the images it uses under assets/.
 */
import fs from 'node:fs';
import JSZip from 'jszip';
import type { DB } from './db.js';
import { assembleHtml, hoistImports, type DeckDoc } from './deck.js';
import { assetPath } from './assets.js';
import { cssFiles, nameFiles, README } from './files.js';

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
};

const ASSET_RE = /(?:https?:\/\/[^"')\s]*)?\/api\/assets\/([A-Za-z0-9_-]{10,40})/g;

export async function exportBundle(db: DB, doc: DeckDoc, readme: string): Promise<Buffer> {
  const zip = new JSZip();
  const used = new Map<string, string>();
  const all = [doc.css, ...doc.pages.map((p) => p.html)].join('\n');
  for (const [, id] of all.matchAll(ASSET_RE)) {
    if (used.has(id)) continue;
    const row = db.prepare('SELECT mime FROM assets WHERE id = ?').get(id) as { mime: string } | undefined;
    if (!row || !fs.existsSync(assetPath(id))) continue;
    const name = `assets/${id}${EXT[row.mime] ?? ''}`;
    used.set(id, name);
    zip.file(name, fs.readFileSync(assetPath(id)));
  }
  const relink = (text: string, prefix: string) => text.replace(ASSET_RE, (m, id: string) => (used.has(id) ? `${prefix}${used.get(id)}` : m));

  zip.file(README, readme);
  const styles = cssFiles(doc.css);
  for (const f of styles) zip.file(f.path, `${hoistImports(relink(f.css, '../'))}\n`);
  const pages = nameFiles(doc.pages);
  const local = { ...doc, css: '', pages: pages.map((p) => ({ ...p, html: relink(p.html, '') })) };
  zip.file('index.html', assembleHtml(local, { presenter: true, cssHrefs: styles.map((f) => f.path) }));
  for (const p of pages) {
    const one = { ...doc, css: '', pages: [{ ...p, html: relink(p.html, '../') }] };
    zip.file(p.file!, assembleHtml(one, { cssHrefs: styles.map((f) => `../${f.path}`) }));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
