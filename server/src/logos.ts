/**
 * find_logo / use_logo: real company and product logos, looked up online instead of drawn by the model.
 * Candidates come from Wikidata (the logo file on Wikimedia Commons), the company's own website and
 * Simple Icons. The model sees them side by side and saves the right one as a project image.
 */
import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';
import { config } from './config.js';
import type { DB } from './db.js';
import { saveAsset } from './assets.js';
import { activeProxy } from './proxy.js';
import { withContext } from './render.js';
import type { FileTools, ToolDef, ToolOutput } from './fileTools.js';

const UA = 'HTTP-Roadshow/1.0 (company logos for slide decks)';
const TIMEOUT_MS = 12_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATES = 6;
/** Rasters smaller than this are favicons, not logos. */
const MIN_RASTER_PX = 48;

export interface LogoCandidate {
  source: string;
  note: string;
  url: string;
  mime: string;
  buf: Buffer;
  width: number;
  height: number;
}

function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b < 128) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateIp(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

/** Pages the model names come from user content: the server must not be steered into its own network. */
async function checkHost(hostname: string) {
  if (config.logoAllowPrivate) return;
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const refuse = () => new Error(`不能访问内网地址（${host}）`);
  if (net.isIP(host)) {
    if (privateIp(host)) throw refuse();
    return;
  }
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|lan|intranet|corp|home\.arpa)$/.test(host)) throw refuse();
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    // Behind a proxy this machine may not resolve public names; the proxy does.
    if (activeProxy()) return;
    throw new Error(`无法解析域名 ${host}`);
  }
  if (addrs.some((a) => privateIp(a.address))) throw refuse();
}

async function get(url: string, accept: string, maxBytes: number, hops = 0): Promise<{ buf: Buffer; type: string; url: string }> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('只支持 http / https 地址');
  if (u.username || u.password) throw new Error('地址中不能包含账号');
  await checkHost(u.hostname);
  const res = await fetch(u, { redirect: 'manual', headers: { 'user-agent': UA, accept }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    const loc = res.headers.get('location');
    if (!loc || hops >= 5) throw new Error('重定向过多');
    return get(new URL(loc, u).href, accept, maxBytes, hops + 1);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  if (Number(res.headers.get('content-length') || 0) > maxBytes) {
    await res.body?.cancel();
    throw new Error('文件过大');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > maxBytes) throw new Error('文件过大');
    chunks.push(Buffer.from(c));
  }
  return { buf: Buffer.concat(chunks), type: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), url: u.href };
}

function imageMime(buf: Buffer): string | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  const head = buf.subarray(0, 4000).toString('utf8').replace(/^\uFEFF/, '');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** A standalone SVG without scripts, event handlers or links out (pages and exports embed it as an image). */
export function cleanSvg(svg: string): string | null {
  const $ = cheerio.load(svg, { xml: true });
  const root = $('svg').first();
  if (!root.length) return null;
  root.find('script, foreignObject').remove();
  let xlink = false;
  root.find('*').addBack().each((_, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
    for (const [name, value] of Object.entries(attribs)) {
      const link = name === 'href' || name === 'xlink:href';
      if (/^on/i.test(name) || (link && !value.startsWith('#') && !value.startsWith('data:image/'))) $(el).removeAttr(name);
      else if (name.startsWith('xlink:')) xlink = true;
    }
  });
  root.attr('xmlns', 'http://www.w3.org/2000/svg');
  if (xlink) root.attr('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${$.xml(root)}`;
}

interface Found {
  source: string;
  note: string;
  url: string;
  mime: string;
  buf: Buffer;
}

async function download(url: string, source: string, note: string): Promise<Found | null> {
  const r = await get(url, 'image/svg+xml,image/png,image/webp,image/*;q=0.8', MAX_IMAGE_BYTES);
  const mime = imageMime(r.buf);
  if (!mime) return null;
  if (mime !== 'image/svg+xml') return { source, note, url: r.url, mime, buf: r.buf };
  const svg = cleanSvg(r.buf.toString('utf8'));
  return svg ? { source, note, url: r.url, mime, buf: Buffer.from(svg) } : null;
}

const hasCjk = (s: string) => /[\u3400-\u9fff]/.test(s);

/** Logo files and the official website from Wikidata items matching the name. */
async function wikidata(company: string): Promise<{ logos: { file: string; note: string }[]; website?: string }> {
  const lang = hasCjk(company) ? 'zh' : 'en';
  const api = config.logoSources.wikidata;
  const json = async (params: string) => JSON.parse((await get(`${api}?format=json&${params}`, 'application/json', MAX_JSON_BYTES)).buf.toString('utf8'));
  const found = await json(`action=wbsearchentities&type=item&limit=5&language=${lang}&uselang=${lang}&search=${encodeURIComponent(company)}`);
  const ids: string[] = (found.search ?? []).map((s: { id: string }) => s.id).filter((id: string) => /^Q\d+$/.test(id));
  if (!ids.length) return { logos: [] };
  const entities = (await json(`action=wbgetentities&props=claims|labels|descriptions&languages=${lang}|en&ids=${ids.join('|')}`)).entities ?? {};
  const logos: { file: string; note: string }[] = [];
  let website: string | undefined;
  for (const id of ids) {
    const e = entities[id];
    if (!e) continue;
    const claim = (p: string) => (e.claims?.[p] ?? []).map((c: any) => c.mainsnak?.datavalue?.value).filter((v: unknown) => typeof v === 'string') as string[];
    const label = e.labels?.[lang]?.value ?? e.labels?.en?.value ?? id;
    const description = e.descriptions?.[lang]?.value ?? e.descriptions?.en?.value ?? '';
    const files = claim('P154');
    if (files.length && !website) website = claim('P856')[0];
    for (const file of files.slice(0, 2)) logos.push({ file, note: `Wikidata「${label}」${description ? `（${description}）` : ''}的 Logo` });
  }
  return { logos: logos.slice(0, 3), website: website ?? undefined };
}

const LOGO_HINT = /logo|brand/i;
const NOT_OURS = /partner|customer|client|trusted|sponsor|investor|press|award|footer-social|social/i;

/** Logo images and inline SVGs on a company's home page, then its large site icon. */
async function websiteLogos(site: string): Promise<{ inline: Found[]; urls: { url: string; note: string }[] }> {
  const page = await get(site, 'text/html,application/xhtml+xml', MAX_PAGE_BYTES);
  if (!page.type.includes('html')) return { inline: [], urls: [] };
  const $ = cheerio.load(page.buf.toString('utf8'));
  const host = new URL(page.url).hostname;
  const hints = (el: any) => {
    const a = el.attribs ?? {};
    return [a.class, a.id, a['aria-label'], a.title, a.alt, a.src, a['data-src']].filter(Boolean).join(' ');
  };
  const near = (el: any): string => {
    const own = hints(el);
    const up = $(el).parents().slice(0, 3).toArray().map(hints).join(' ');
    return `${own} ${up}`;
  };
  const isLogo = (el: any) => {
    const text = near(el);
    return LOGO_HINT.test(text) && !NOT_OURS.test(text);
  };
  // The site's own logo sits in the header or links home; logos elsewhere are mostly customers'.
  const home = (href = '') => {
    try {
      const u = new URL(href, page.url);
      return u.hostname === host && (u.pathname === '/' || /^\/[a-z]{2}(-[a-z]{2})?\/?$/i.test(u.pathname));
    } catch {
      return false;
    }
  };
  const inMasthead = (el: any) =>
    $(el).closest('header, nav, [role=banner]').length > 0 || $(el).parents('a').toArray().some((a: any) => home(a.attribs?.href));
  const byPlace = (els: any[]) => {
    const logos = els.filter(isLogo);
    const top = logos.filter(inMasthead);
    return top.length ? top : logos.slice(0, 1);
  };
  const inline: Found[] = [];
  for (const el of byPlace($('svg').toArray())) {
    if (inline.length >= 2) break;
    if ($(el).find('use').length) continue;
    const svg = cleanSvg($.html(el));
    if (svg) inline.push({ source: '官网', note: `${host} 页面中的 Logo（内嵌 SVG）`, url: page.url, mime: 'image/svg+xml', buf: Buffer.from(svg) });
  }
  const urls: { url: string; note: string }[] = [];
  const add = (src: string | undefined, note: string) => {
    if (!src || src.startsWith('data:')) return;
    try {
      const url = new URL(src.trim(), page.url).href;
      if (!urls.some((u) => u.url === url)) urls.push({ url, note });
    } catch {
      /* not a URL */
    }
  };
  for (const el of byPlace($('img').toArray())) {
    if (urls.length >= 3) break;
    const attribs: Record<string, string> = el.attribs ?? {};
    const srcset = (attribs.srcset ?? '').split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
    add(srcset.at(-1) ?? attribs.src ?? attribs['data-src'], `${host} 页面中的 Logo 图片`);
  }
  const icons = $('link[rel~="apple-touch-icon"], link[rel~="icon"]').toArray();
  const bigIcon =
    icons.find((el) => /svg/.test(el.attribs.type ?? '') || /\.svg(\?|$)/i.test(el.attribs.href ?? '')) ??
    icons.find((el) => /apple-touch-icon/.test(el.attribs.rel ?? '')) ??
    icons.find((el) => Number((el.attribs.sizes ?? '').split('x')[0]) >= 120);
  if (bigIcon) add(bigIcon.attribs.href, `${host} 的网站图标（通常只有图形标志，不含文字）`);
  return { inline, urls };
}

function simpleIconSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/^\./, 'dot-')
    .replace(/\./g, 'dot')
    .replace(/&/g, 'and')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function siteUrl(domain: string): string {
  const d = domain.trim();
  return /^https?:\/\//i.test(d) ? d : `https://${d.replace(/^\/+/, '')}`;
}

/** Candidates that load in a browser, with their sizes (dropped: broken images and favicons). */
async function measure(found: Found[]): Promise<LogoCandidate[]> {
  if (!found.length) return [];
  const html = `<!doctype html><body>${found.map((f, i) => `<img id="c${i}" src="data:${f.mime};base64,${f.buf.toString('base64')}">`).join('')}</body>`;
  const sizes = await withContext({ width: 800, height: 600 }, async (context) => {
    const page = await context.newPage();
    await page.route('**/*', (r) => (r.request().url().startsWith('data:') ? r.continue() : r.abort()));
    await page.setContent(html, { waitUntil: 'load', timeout: 15_000 }).catch(() => {});
    return page.evaluate(() =>
      Promise.all(
        [...document.images].map((img) =>
          img.decode().then(
            () => ({ ok: true, width: img.naturalWidth, height: img.naturalHeight }),
            () => ({ ok: false, width: 0, height: 0 }),
          ),
        ),
      ),
    );
  });
  const out: LogoCandidate[] = [];
  found.forEach((f, i) => {
    const s = sizes[i];
    if (!s?.ok) return;
    let { width, height } = s;
    if (f.mime === 'image/svg+xml') {
      const vb = f.buf.toString('utf8').match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
      if (vb) [width, height] = [Number(vb[1]), Number(vb[2])];
    } else if (Math.min(width, height) < MIN_RASTER_PX) return;
    if (!width || !height) return;
    out.push({ ...f, width: Math.round(width), height: Math.round(height) });
  });
  return out;
}

/** One image of the candidates, numbered, each on a light and a dark background. */
async function previewSheet(candidates: LogoCandidate[]): Promise<string> {
  const cell = (c: LogoCandidate, i: number) => {
    const src = `data:${c.mime};base64,${c.buf.toString('base64')}`;
    return `<div class="cell"><div class="n">${i + 1}</div><div class="bg light"><img src="${src}"></div><div class="bg dark"><img src="${src}"></div></div>`;
  };
  const rows = Math.ceil(candidates.length / 2);
  const height = rows * 190 + 20;
  const html = `<!doctype html><style>
    body{margin:0;padding:10px;background:#e5e7eb;font:600 22px sans-serif;display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .cell{display:flex;gap:6px;align-items:stretch;height:180px}
    .n{width:34px;display:flex;align-items:center;justify-content:center;background:#111827;color:#fff;border-radius:6px}
    .bg{flex:1;display:flex;align-items:center;justify-content:center;border-radius:6px;padding:16px}
    .light{background:#fff}.dark{background:#1f2937}
    img{max-width:100%;max-height:100%;object-fit:contain}
  </style><body>${candidates.map(cell).join('')}</body>`;
  const shot = await withContext({ width: 1200, height }, async (context) => {
    const page = await context.newPage();
    await page.route('**/*', (r) => (r.request().url().startsWith('data:') ? r.continue() : r.abort()));
    await page.setContent(html, { waitUntil: 'load', timeout: 15_000 }).catch(() => {});
    return page.screenshot({ type: 'jpeg', quality: 85 });
  });
  return `data:image/jpeg;base64,${shot.toString('base64')}`;
}

/** Looks up logo candidates for a company; `errors` says what failed along the way. */
export async function findLogos(company: string, domain?: string): Promise<{ candidates: LogoCandidate[]; errors: string[] }> {
  const errors: string[] = [];
  const found: Found[] = [];
  const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${what}：${(e as Error).message}`);
      return undefined;
    }
  };
  const wd = await attempt('Wikidata', () => wikidata(company));
  for (const l of wd?.logos ?? []) {
    const f = await attempt('Wikimedia Commons', () => download(`${config.logoSources.commonsFile}${encodeURIComponent(l.file.replace(/ /g, '_'))}`, 'Wikimedia Commons', l.note));
    if (f) found.push(f);
  }
  const site = domain ? siteUrl(domain) : wd?.website;
  if (site) {
    const web = await attempt('官网', () => websiteLogos(site));
    found.push(...(web?.inline ?? []));
    for (const u of web?.urls ?? []) {
      const f = await attempt('官网图片', () => download(u.url, '官网', u.note));
      if (f) found.push(f);
    }
  }
  const slug = simpleIconSlug(company);
  if (slug && !hasCjk(company)) {
    const f = await attempt('Simple Icons', () => download(`${config.logoSources.simpleIcons}${slug}.svg`, 'Simple Icons', '单色品牌图标（Simple Icons，只有图形标志，黑色）'));
    if (f) found.push(f);
  }
  const seen = new Set<string>();
  const unique = found.filter((f) => {
    const h = createHash('sha1').update(f.buf).digest('hex');
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });
  return { candidates: (await measure(unique)).slice(0, MAX_CANDIDATES), errors };
}

export const LOGO_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'find_logo',
      description:
        '在网上查找公司、机构或产品的官方 Logo（来源：Wikidata / Wikimedia Commons、官网页面、Simple Icons），返回编号的候选列表和一张预览图（每个候选分别放在浅色与深色背景上）。看过预览后用 use_logo 保存要用的那个。用户或模板已经提供 Logo 时直接用提供的，不要再查。',
      parameters: {
        type: 'object',
        properties: {
          company: { type: 'string', description: '公司 / 品牌 / 产品的名称，尽量用官方名称；英文名通常更容易找到（如 "NVIDIA"、"Alibaba Group"）' },
          domain: { type: 'string', description: '官网域名（如 nvidia.com），知道时填写，会从官网页面中查找 Logo' },
        },
        required: ['company'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_logo',
      description: '把 find_logo 找到的一个候选 Logo 保存为本项目的图片素材，返回放进页面的 <img> 代码。',
      parameters: {
        type: 'object',
        properties: {
          company: { type: 'string', description: '与调用 find_logo 时相同的名称' },
          candidate: { type: 'integer', minimum: 1, description: '预览图中的候选编号' },
        },
        required: ['company', 'candidate'],
      },
    },
  },
];

const EXT: Record<string, string> = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const fileSlug = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'logo';
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const ratio = (w: number, h: number) => `${(w / h).toFixed(2).replace(/\.?0+$/, '')}:1`;

/** Logo lookups for a project; parallel page batches share one instance, so results are kept per company. */
export function createLogoTools(db: DB, projectId: string, userId: number): FileTools {
  const results = new Map<string, LogoCandidate[]>();
  const saved = new Map<string, string>();
  const key = (company: string) => company.trim().toLowerCase();
  return {
    defs: LOGO_TOOL_DEFS,
    async execute(name, args): Promise<ToolOutput> {
      const company = typeof args?.company === 'string' ? args.company.trim().slice(0, 100) : '';
      if (!company) return { content: '错误：请提供 company（公司或产品名称）' };
      if (name === 'find_logo') {
        const domain = typeof args.domain === 'string' && args.domain.trim() ? args.domain.trim().slice(0, 200) : undefined;
        const { candidates, errors } = await findLogos(company, domain);
        if (!candidates.length) {
          return {
            content: `没有找到「${company}」的 Logo${errors.length ? `（${errors.join('；')}）` : ''}。可以换用官方全称或英文名、补充 domain（官网域名）再试一次。仍然找不到时不要自己画 Logo：用文字写出名称（按 README 约定的字体与颜色），或在页面上留出 Logo 位置并在总结中提示用户上传。`,
          };
        }
        results.set(key(company), candidates);
        const list = candidates
          .map((c, i) => `${i + 1}. ${c.note}，${c.mime === 'image/svg+xml' ? 'SVG 矢量图' : `${c.mime.split('/')[1].toUpperCase()} ${c.width}×${c.height}`}，宽高比 ${ratio(c.width, c.height)}`)
          .join('\n');
        return {
          content: `找到「${company}」的 ${candidates.length} 个候选 Logo（预览见下一条消息，每个候选左侧是浅色背景、右侧是深色背景）：
${list}
确认哪个是这家公司当前的官方 Logo（名称与图形都对，不是别的同名公司、子品牌或旧版），并选在页面背景上清晰可见的版本，然后调用 use_logo。都不对时换个名称或补充 domain 再查。`,
          images: [{ label: `「${company}」的候选 Logo`, url: await previewSheet(candidates) }],
        };
      }
      if (name === 'use_logo') {
        const candidates = results.get(key(company));
        if (!candidates) return { content: `错误：还没有查找过「${company}」的 Logo，请先调用 find_logo` };
        const n = Number(args.candidate);
        const c = Number.isInteger(n) ? candidates[n - 1] : undefined;
        if (!c) return { content: `错误：candidate 应为 1–${candidates.length}` };
        const hash = createHash('sha1').update(c.buf).digest('hex');
        let id = saved.get(hash);
        if (!id) {
          id = (await saveAsset(db, projectId, userId, `Logo-${fileSlug(company)}.${EXT[c.mime] ?? 'png'}`, c.mime, c.buf, 'embed')).id;
          saved.set(hash, id);
        }
        return {
          content: `已保存「${company}」的 Logo（${c.note}，宽高比 ${ratio(c.width, c.height)}）。把下面的代码放进页面中需要 Logo 的位置；只设高度或宽度之一，保持原始比例，不要拉伸、裁切、改色，也不要在上面叠加或改画图形：
<img src="/api/assets/${id}" alt="${escapeAttr(company)} logo" class="logo-img" style="display:block;height:64px;width:auto;max-width:100%;object-fit:contain">
同一个 Logo 在其他页面上用同一个地址；在深色背景上看不清时，换用更合适的候选（如反白版本）或给 Logo 加浅色底板。`,
        };
      }
      return { content: `错误：没有名为 ${name} 的工具` };
    },
  };
}
