import { chromium, type Browser } from 'playwright-core';
import PptxGenJS from 'pptxgenjs';
import { config } from './config.js';
import { assembleHtml, pageText, type DeckDoc } from './deck.js';

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.isConnected()) return b;
  }
  browserPromise = chromium.launch({
    executablePath: config.chromePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  await b?.close().catch(() => {});
}

/**
 * esbuild-based runners (tsx) wrap named functions in `__name(...)`, which also ends up inside functions
 * passed to page.evaluate; the page needs a no-op definition.
 */
const NAME_SHIM = 'globalThis.__name = globalThis.__name || function (f) { return f; };';

async function withPage<T>(doc: DeckDoc, html: string, fn: (page: import('playwright-core').Page) => Promise<T>): Promise<T> {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: doc.width, height: doc.height }, deviceScaleFactor: 1 });
  await context.addInitScript(NAME_SHIM);
  const page = await context.newPage();
  try {
    // External fonts may be unreachable on offline deployments; never block rendering on them for long.
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 }).catch(() => {});
    await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]));
    return await fn(page);
  } finally {
    await context.close();
  }
}

const REF_WIDTH = 1280;

/**
 * Screenshots an uploaded reference HTML page by page: slide-like elements one by one, otherwise the
 * whole document in viewport-sized chunks. Network access is blocked so untrusted uploads cannot make
 * the server fetch anything.
 */
export async function renderHtmlReference(html: string, maxPages: number): Promise<{ images: Buffer[]; texts: string[] }> {
  const browser = await getBrowser();
  const open = async (scale: number) => {
    const context = await browser.newContext({ viewport: { width: REF_WIDTH, height: 720 }, deviceScaleFactor: scale });
    await context.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    await context.addInitScript(NAME_SHIM);
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(300);
    return { context, page };
  };
  const findSlides = (page: import('playwright-core').Page) =>
    page.evaluate((max) => {
      for (const sel of ['section.slide', '.slide', '[data-page-id]', 'section']) {
        const els = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width >= 300 && r.height >= 150 && getComputedStyle(el).visibility !== 'hidden';
        });
        if (els.length >= 2) {
          els.slice(0, max).forEach((el, i) => el.setAttribute('data-rs-ref', String(i)));
          return { count: Math.min(els.length, max), width: Math.max(...els.map((e) => e.getBoundingClientRect().width)) };
        }
      }
      return { count: 0, width: 0 };
    }, maxPages);

  let { context, page } = await open(1);
  try {
    const probe = await findSlides(page);
    if (probe.count) {
      const scale = Math.min(1, REF_WIDTH / probe.width);
      if (scale < 1) {
        await context.close();
        ({ context, page } = await open(scale));
        await findSlides(page);
      }
      const images: Buffer[] = [];
      const texts: string[] = [];
      for (let i = 0; i < probe.count; i++) {
        const el = page.locator(`[data-rs-ref="${i}"]`);
        images.push(await el.screenshot({ type: 'jpeg', quality: 80, timeout: 10_000 }));
        texts.push((await el.innerText().catch(() => '')).trim());
      }
      return { images, texts };
    }
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const images: Buffer[] = [];
    for (let y = 0; y < height && images.length < maxPages; y += 720) {
      images.push(
        await page.screenshot({ type: 'jpeg', quality: 80, fullPage: true, clip: { x: 0, y, width: REF_WIDTH, height: Math.min(720, height - y) } }),
      );
    }
    return { images, texts: images.map(() => '') };
  } finally {
    await context.close();
  }
}

const RENDER_CSS = `<style>body{background:#fff!important}.slide{margin:0!important}</style>`;

export async function renderPdf(doc: DeckDoc, resolveAssets: (html: string) => string): Promise<Buffer> {
  const html = assembleHtml(doc, { extraHead: RENDER_CSS, assetResolver: resolveAssets });
  return withPage(doc, html, async (page) => {
    await page.emulateMedia({ media: 'print' });
    return page.pdf({
      width: `${doc.width}px`,
      height: `${doc.height}px`,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      preferCSSPageSize: true,
    });
  });
}

export interface ScreenshotOptions {
  pageIds?: string[];
  highlight?: string[];
  scale?: number;
  type?: 'png' | 'jpeg';
}

export async function renderPageImages(
  doc: DeckDoc,
  resolveAssets: (html: string) => string,
  opts: ScreenshotOptions = {},
): Promise<{ pageId: string; image: Buffer }[]> {
  const highlightCss = opts.highlight?.length
    ? `<style>${opts.highlight
        .map((e) => `[data-eid="${e}"]`)
        .join(',')}{outline:6px solid #ff2d55!important;outline-offset:2px!important;box-shadow:0 0 0 9999px rgba(0,0,0,0)!important}</style>`
    : '';
  const ids = opts.pageIds ?? doc.pages.map((p) => p.id);
  const html = assembleHtml(doc, {
    pageIds: ids,
    extraHead: RENDER_CSS + highlightCss,
    assetResolver: resolveAssets,
  });
  return withPage(doc, html, async (page) => {
    const out: { pageId: string; image: Buffer }[] = [];
    for (const id of ids) {
      const el = page.locator(`section.slide[data-page-id="${id}"]`).first();
      if (!(await el.count())) continue;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      let image = await el.screenshot({
        type: opts.type ?? 'png',
        quality: opts.type === 'jpeg' ? 75 : undefined,
        animations: 'disabled',
      });
      if (opts.scale && opts.scale !== 1) {
        image = await downscale(page, image, opts.scale, opts.type ?? 'png');
      }
      out.push({ pageId: id, image });
    }
    return out;
  });
}

export interface LayoutIssue {
  severity: 'error' | 'warning';
  kind: 'overflow' | 'clipped' | 'overlap' | 'broken_image' | 'small_font' | 'empty';
  message: string;
}

export interface PageReport {
  pageId: string;
  issues: LayoutIssue[];
  textChars: number;
}

const MAX_ISSUES_PER_PAGE = 8;

/**
 * Renders the document in headless Chrome and inspects each page's DOM for layout problems the model
 * cannot see in its own source: text pushed outside the page, clipped containers, overlapping text,
 * broken images, unreadably small fonts and empty pages.
 */
export async function inspectLayout(doc: DeckDoc, resolveAssets: (html: string) => string, pageIds?: string[]): Promise<PageReport[]> {
  const html = assembleHtml(doc, { pageIds, extraHead: RENDER_CSS, assetResolver: resolveAssets });
  return withPage(doc, html, (page) =>
    page.evaluate(
      ({ minFont, maxIssues }) => {
        const label = (el: Element) => {
          const text = ((el as HTMLElement).innerText || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ');
          const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
          return `<${el.tagName.toLowerCase()}${cls}>${text ? `「${text.length > 36 ? `${text.slice(0, 36)}…` : text}」` : ''}`;
        };
        const shown = (el: Element) => {
          const cs = getComputedStyle(el);
          return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
        };
        const hasOwnText = (el: Element) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim());
        const textRect = (el: Element) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getBoundingClientRect();
        };
        return Array.from(document.querySelectorAll<HTMLElement>('section.slide')).map((slide) => {
          const sr = slide.getBoundingClientRect();
          const issues: { severity: 'error' | 'warning'; kind: string; message: string }[] = [];
          const add = (severity: 'error' | 'warning', kind: string, message: string) => {
            if (!issues.some((i) => i.message === message)) issues.push({ severity, kind, message });
          };
          const els = Array.from(slide.querySelectorAll('*')).filter(shown);
          const textEls = els.filter(hasOwnText);
          for (const el of textEls) {
            const r = textRect(el);
            if (!r.width || !r.height) continue;
            const out = Math.max(sr.left - r.left, r.right - sr.right, sr.top - r.top, r.bottom - sr.bottom);
            if (out > 4) add('error', 'overflow', `文字超出页面边界 ${Math.round(out)}px：${label(el)}`);
          }
          for (const el of els) {
            const cs = getComputedStyle(el);
            if (!/(hidden|clip|auto|scroll)/.test(cs.overflow + cs.overflowX + cs.overflowY)) continue;
            if (cs.textOverflow === 'ellipsis' || (cs as unknown as { webkitLineClamp?: string }).webkitLineClamp !== 'none') continue;
            if (!(el as HTMLElement).innerText?.trim()) continue;
            const dy = el.scrollHeight - el.clientHeight;
            const dx = el.scrollWidth - el.clientWidth;
            if (dy > 4 || dx > 4) add('error', 'clipped', `内容超出容器被裁切（超出 ${Math.round(Math.max(dx, dy))}px）：${label(el)}`);
          }
          const rects = textEls.slice(0, 200).map((el) => ({ el, r: textRect(el) })).filter((x) => x.r.width > 0 && x.r.height > 0);
          let overlaps = 0;
          for (let i = 0; i < rects.length && overlaps < 3; i++) {
            for (let j = i + 1; j < rects.length && overlaps < 3; j++) {
              const a = rects[i], b = rects[j];
              if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
              const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
              const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
              if (w <= 0 || h <= 0) continue;
              const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
              if ((w * h) / smaller > 0.3) {
                overlaps++;
                add('warning', 'overlap', `文字互相重叠：${label(a.el)} 与 ${label(b.el)}`);
              }
            }
          }
          for (const img of Array.from(slide.querySelectorAll('img'))) {
            if (img.complete && img.naturalWidth === 0) add('error', 'broken_image', `图片无法加载：${img.getAttribute('src')?.slice(0, 80) ?? ''}`);
          }
          const small = textEls.filter((el) => parseFloat(getComputedStyle(el).fontSize) < minFont);
          if (small.length) {
            const px = Math.min(...small.map((el) => parseFloat(getComputedStyle(el).fontSize)));
            add('warning', 'small_font', `有 ${small.length} 处文字字号过小（最小 ${Math.round(px)}px，建议 ≥ ${Math.round(minFont)}px），如：${label(small[0])}`);
          }
          const text = slide.innerText.trim();
          if (!text && !slide.querySelector('img, svg, canvas, video')) add('warning', 'empty', '页面没有任何可见内容');
          issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
          return { pageId: slide.getAttribute('data-page-id') ?? '', issues: issues.slice(0, maxIssues), textChars: text.length };
        });
      },
      { minFont: (16 * Math.min(doc.width, doc.height)) / 1080, maxIssues: MAX_ISSUES_PER_PAGE },
    ),
  ) as Promise<PageReport[]>;
}

/** Thumbnails of many pages tiled into a few labelled overview images, so the model can see a whole deck cheaply. */
export async function renderContactSheets(
  doc: DeckDoc,
  resolveAssets: (html: string) => string,
  opts: { labels?: string[]; cols?: number; thumbWidth?: number; perSheet?: number } = {},
): Promise<Buffer[]> {
  const cols = opts.cols ?? 3;
  const thumbWidth = opts.thumbWidth ?? 640;
  const perSheet = opts.perSheet ?? 12;
  const shots = await renderPageImages(doc, resolveAssets, { type: 'jpeg' });
  const thumbHeight = Math.round((thumbWidth * doc.height) / doc.width);
  const sheets: Buffer[] = [];
  const browser = await getBrowser();
  for (let start = 0; start < shots.length; start += perSheet) {
    const group = shots.slice(start, start + perSheet);
    const cells = group
      .map(
        ({ image }, i) =>
          `<figure><img src="data:image/jpeg;base64,${image.toString('base64')}"><figcaption>${
            opts.labels?.[start + i] ?? `第 ${start + i + 1} 页`
          }</figcaption></figure>`,
      )
      .join('');
    const width = cols * thumbWidth + (cols + 1) * 12;
    const context = await browser.newContext({ viewport: { width, height: 400 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      await page.setContent(
        `<html><head><style>body{margin:0;padding:12px;background:#1f2430;display:grid;grid-template-columns:repeat(${cols},${thumbWidth}px);gap:12px;font:600 20px/1.2 sans-serif}
figure{margin:0;position:relative}img{display:block;width:${thumbWidth}px;height:${thumbHeight}px;outline:1px solid #555}
figcaption{position:absolute;left:0;top:0;background:#ff2d55;color:#fff;padding:4px 10px}</style></head><body>${cells}</body></html>`,
        { waitUntil: 'load' },
      );
      sheets.push(await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true }));
    } finally {
      await context.close();
    }
  }
  return sheets;
}

async function downscale(page: import('playwright-core').Page, img: Buffer, scale: number, type: 'png' | 'jpeg') {
  const dataUrl = await page.evaluate(
    async ({ src, scale, type }) => {
      const im = new Image();
      im.src = src;
      await im.decode();
      const c = document.createElement('canvas');
      c.width = Math.round(im.width * scale);
      c.height = Math.round(im.height * scale);
      c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height);
      return c.toDataURL(`image/${type}`, 0.8);
    },
    { src: `data:image/${type};base64,${img.toString('base64')}`, scale, type },
  );
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

/** PDF built from page screenshots: pixel-identical to the preview, but text is not selectable. */
export async function renderImagePdf(doc: DeckDoc, resolveAssets: (html: string) => string): Promise<Buffer> {
  const images = await renderPageImages(doc, resolveAssets, { type: 'png' });
  const html = `<!DOCTYPE html><html><head><style>@page{size:${doc.width}px ${doc.height}px;margin:0}html,body{margin:0}
img{display:block;width:${doc.width}px;height:${doc.height}px;break-after:page}</style></head><body>${images
    .map(({ image }) => `<img src="data:image/png;base64,${image.toString('base64')}">`)
    .join('')}</body></html>`;
  return withPage(doc, html, (page) =>
    page.pdf({ width: `${doc.width}px`, height: `${doc.height}px`, printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } }),
  );
}

export async function renderPptx(doc: DeckDoc, resolveAssets: (html: string) => string): Promise<Buffer> {
  const images = await renderPageImages(doc, resolveAssets, { type: 'png' });
  const Ctor = PptxGenJS as unknown as new () => import('pptxgenjs').default;
  const pptx = new Ctor();
  const widthIn = 13.333;
  const heightIn = +(widthIn * (doc.height / doc.width)).toFixed(3);
  pptx.defineLayout({ name: 'RS_LAYOUT', width: widthIn, height: heightIn });
  pptx.layout = 'RS_LAYOUT';
  pptx.title = doc.title;
  pptx.author = 'Roadshow Studio';
  for (const { pageId, image } of images) {
    const slide = pptx.addSlide();
    slide.addImage({ data: `data:image/png;base64,${image.toString('base64')}`, x: 0, y: 0, w: widthIn, h: heightIn });
    const page = doc.pages.find((p) => p.id === pageId);
    if (page) slide.addNotes(pageText(page));
  }
  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return out;
}
