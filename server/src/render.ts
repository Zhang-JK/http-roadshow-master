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

async function withPage<T>(doc: DeckDoc, html: string, fn: (page: import('playwright-core').Page) => Promise<T>): Promise<T> {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: doc.width, height: doc.height }, deviceScaleFactor: 1 });
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
