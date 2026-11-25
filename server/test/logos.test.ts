import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startMockLlm } from './mockLlm.js';

/** A solid-colour PNG of the given size. */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3])]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const COMMONS_SVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100" onload="alert(1)"><script>alert(2)</script><a href="https://evil.example/"><rect width="300" height="100" fill="#76b900"/></a><foreignObject><div>x</div></foreignObject></svg>`;
const ICON_SVG = '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h24v24H0z"/></svg>';
const OWN_LOGO = png(240, 80, [20, 90, 200]);
const CUSTOMER_LOGO = png(200, 80, [200, 30, 30]);
const TOUCH_ICON = png(180, 180, [20, 90, 200]);
const FAVICON = png(16, 16, [20, 90, 200]);

const hits: string[] = [];
const site = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  hits.push(url.pathname + url.search);
  const send = (type: string, body: string | Buffer) => res.writeHead(200, { 'content-type': type }).end(body);
  if (url.pathname === '/w/api.php') {
    const search = url.searchParams.get('search') ?? '';
    if (url.searchParams.get('action') === 'wbsearchentities') return send('application/json', JSON.stringify({ search: /acme/i.test(search) ? [{ id: 'Q1' }] : [] }));
    return send(
      'application/json',
      JSON.stringify({
        entities: {
          Q1: {
            labels: { en: { value: 'Acme Corp' } },
            descriptions: { en: { value: 'robot maker' } },
            claims: {
              P154: [{ mainsnak: { datavalue: { value: 'Acme logo.svg' } } }],
              P856: [{ mainsnak: { datavalue: { value: `${base}/site/` } } }],
            },
          },
        },
      }),
    );
  }
  if (url.pathname === '/files/Acme_logo.svg') return send('image/svg+xml', COMMONS_SVG);
  if (url.pathname === '/site/') {
    return send(
      'text/html',
      `<html><head><link rel="icon" href="/site/favicon.png"><link rel="apple-touch-icon" href="/site/touch.png"></head><body>
<header><a href="/"><img class="site-logo" src="/site/logo.png" alt="Acme"></a></header>
<section class="customers"><h2>Trusted by</h2><img class="logo" src="/site/customer.png" alt="Other Co logo"></section></body></html>`,
    );
  }
  if (url.pathname === '/site/logo.png') return send('image/png', OWN_LOGO);
  if (url.pathname === '/site/customer.png') return send('image/png', CUSTOMER_LOGO);
  if (url.pathname === '/site/touch.png') return send('image/png', TOUCH_ICON);
  if (url.pathname === '/site/favicon.png') return send('image/png', FAVICON);
  if (url.pathname === '/icons/acme.svg') return send('image/svg+xml', ICON_SVG);
  if (url.pathname === '/redirect') return res.writeHead(302, { location: '/redirect' }).end();
  res.writeHead(404).end();
});
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-logos-'));
process.env.DATA_DIR = tmp;
process.env.LOGO_WIKIDATA_API = `${base}/w/api.php`;
process.env.LOGO_COMMONS_FILE_URL = `${base}/files/`;
process.env.LOGO_SIMPLE_ICONS_URL = `${base}/icons/`;
process.env.LOGO_ALLOW_PRIVATE = '1';

const { config } = await import('../src/config.js');
const { cleanSvg, createLogoTools, findLogos } = await import('../src/logos.js');
const { projectAssets } = await import('../src/assets.js');
type DB = import('../src/db.js').DB;

const toolNames = (body: any): string[] => (body.tools ?? []).map((t: any) => t.function.name);

describe('find_logo / use_logo', () => {
  let db: DB;
  let app: FastifyInstance;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let cookie = '';

  const req = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
    let json: any = null;
    try {
      json = r.json();
    } catch {
      /* not JSON */
    }
    return { status: r.statusCode, json, headers: r.headers, body: r.rawPayload };
  };

  const waitJob = async (jobId: string) => {
    for (let i = 0; i < 400; i++) {
      const r = await req('GET', `/api/jobs/${jobId}`);
      if (r.json.job.status === 'done' || r.json.job.status === 'error') return r.json.job;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error('job timeout');
  };

  beforeAll(async () => {
    mock = await startMockLlm();
    const { openDb } = await import('../src/db.js');
    const { buildApp } = await import('../src/app.js');
    db = openDb(path.join(tmp, 'test.db'));
    app = await buildApp(db, { serveWeb: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } });
    cookie = String(login.headers['set-cookie']).split(';')[0];
    await req('POST', '/api/llm/endpoints', { name: 'mock', baseUrl: mock.url, apiKey: 'good-key', model: 'mock-vision' });
  });

  afterAll(async () => {
    await app?.close();
    await mock?.close();
    site.close();
    const { closeBrowser } = await import('../src/render.js');
    await closeBrowser();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('strips scripts, event handlers and links out of SVG logos', () => {
    const svg = cleanSvg(COMMONS_SVG)!;
    expect(svg).toContain('<rect');
    expect(svg).not.toMatch(/script|onload|foreignObject|evil\.example/);
    expect(cleanSvg('<p>not an svg</p>')).toBeNull();
  });

  it('collects candidates from Wikidata / Commons, the site masthead and Simple Icons, skipping customer logos and favicons', async () => {
    const { candidates, errors } = await findLogos('Acme');
    expect(errors).toEqual([]);
    expect(candidates.map((c) => c.source)).toEqual(['Wikimedia Commons', '官网', '官网', 'Simple Icons']);
    const [commons, own, icon, simple] = candidates;
    expect(commons).toMatchObject({ mime: 'image/svg+xml', width: 300, height: 100 });
    expect(commons.note).toContain('Acme Corp');
    expect(commons.buf.toString()).not.toContain('script');
    expect(own).toMatchObject({ mime: 'image/png', width: 240, height: 80, url: `${base}/site/logo.png` });
    expect(icon).toMatchObject({ width: 180, url: `${base}/site/touch.png` });
    expect(simple).toMatchObject({ mime: 'image/svg+xml', width: 24 });
    expect(hits).not.toContain('/site/customer.png');
    expect(hits).not.toContain('/site/favicon.png');
  });

  it('finds, previews and saves a logo as a project image, once per picture', async () => {
    db.prepare(`INSERT INTO projects (id, type, name, meta, status, created_by, updated_by, created_at, updated_at) VALUES ('logop', 'deck', 'l', '{}', 'ready', 1, 1, 0, 0)`).run();
    const tools = createLogoTools(db, 'logop', 1);
    expect(tools.defs.map((d) => d.function.name)).toEqual(['find_logo', 'use_logo']);
    expect((await tools.execute('use_logo', { company: 'Acme', candidate: 1 })).content).toContain('请先调用 find_logo');

    const found = await tools.execute('find_logo', { company: 'Acme' });
    expect(found.content).toMatch(/找到「Acme」的 4 个候选 Logo/);
    expect(found.content).toContain('1. Wikidata「Acme Corp」（robot maker）的 Logo，SVG 矢量图，宽高比 3:1');
    expect(found.images).toEqual([{ label: '「Acme」的候选 Logo', url: expect.stringMatching(/^data:image\/jpeg;base64,/) }]);

    expect((await tools.execute('use_logo', { company: 'acme', candidate: 9 })).content).toContain('candidate 应为 1–4');
    const used = await tools.execute('use_logo', { company: 'acme', candidate: 2 });
    const [row] = projectAssets(db, 'logop');
    expect(row).toMatchObject({ filename: 'Logo-acme.png', mime: 'image/png', role: 'embed', kind: 'image' });
    expect(used.content).toContain(`<img src="/api/assets/${row.id}" alt="acme logo" class="logo-img"`);
    expect(used.content).toContain('宽高比 3:1');
    await tools.execute('use_logo', { company: 'Acme', candidate: 2 });
    expect(projectAssets(db, 'logop')).toHaveLength(1);
    const img = await req('GET', `/api/assets/${row.id}`);
    expect(img.status).toBe(200);
    expect(Buffer.compare(img.body, OWN_LOGO)).toBe(0);
  });

  it('tells the model to write the name instead of drawing when nothing is found', async () => {
    const tools = createLogoTools(db, 'logop', 1);
    const out = await tools.execute('find_logo', { company: '不存在的公司' });
    expect(out.content).toMatch(/^没有找到「不存在的公司」的 Logo/);
    expect(out.content).toContain('不要自己画 Logo');
    expect(out.images).toBeUndefined();
  });

  it('never fetches from this machine or private networks for a real server, and caps redirects', async () => {
    config.logoAllowPrivate = false;
    try {
      const { candidates, errors } = await findLogos('Acme', `${base}/site/`);
      expect(candidates).toEqual([]);
      expect(errors.join('\n')).toContain('不能访问内网地址（127.0.0.1）');
      const before = hits.length;
      for (const domain of ['localhost', 'http://10.0.0.8/', 'http://[::1]/', 'intranet']) {
        const r = await findLogos('不存在的公司', domain);
        expect(r.errors.join('\n')).toContain('不能访问内网地址');
      }
      expect(hits.length).toBe(before);
    } finally {
      config.logoAllowPrivate = true;
    }
    const looped = await findLogos('不存在的公司', `${base}/redirect`);
    expect(looped.errors.join('\n')).toContain('重定向过多');
  });

  it('page reviews and parallel sub-tasks of decks check the shared formats, overlap and logos', async () => {
    const { buildGroupEditPrompt, pageReviewNote } = await import('../src/prompts.js');
    const deckNote = pageReviewNote([{ label: 'pages/a.html', issues: [] }], 1, true);
    expect(deckNote).toContain('同类页面与 README「同类页面格式」一致');
    expect(deckNote).toContain('不能是自己用 SVG / CSS 画的图形');
    expect(pageReviewNote([{ label: 'pages/a.html', issues: [] }], 1)).not.toContain('同类页面');
    const doc = { width: 1280, height: 720, css: '.a{}', readme: '# R', pages: [{ id: 'p1', file: 'pages/a.html', html: '<section class="slide"><h1>A</h1></section>' }] } as any;
    const task = { request: '改', instructions: '改第 1 页', files: ['pages/a.html'], others: [] };
    const text = (m: any[]) => m.map((x) => (typeof x.content === 'string' ? x.content : '')).join('\n');
    expect(text(buildGroupEditPrompt(doc, 'deck', task, []))).toContain('按 README「同类页面格式」中的统一格式写');
    expect(text(buildGroupEditPrompt(doc, 'template', task, []))).not.toContain('同类页面格式');
  });

  it('decks get the logo tools and rules while planning, writing and reviewing; templates only a placeholder', async () => {
    const tpl = await req('POST', '/api/projects', { type: 'template', name: 'Logo 模板', style: '简约' });
    expect((await waitJob(tpl.json.job.id)).status).toBe('done');
    const templateCalls = mock.calls.filter((c) => c.text.includes('Logo 模板'));
    expect(templateCalls.length).toBeGreaterThan(0);
    expect(templateCalls.every((c) => !toolNames(c.body).includes('find_logo'))).toBe(true);
    expect(templateCalls[0].text).toContain('写着「Logo」的占位框');

    const before = mock.calls.length;
    const reviewsBefore = mock.reviewCalls.length;
    const r = await req('POST', '/api/projects', { type: 'deck', templateId: tpl.json.project.id, name: 'Acme 路演', content: '方案一、方案二、方案三的对比' });
    const job = await waitJob(r.json.job.id);
    expect(job.error).toBeFalsy();
    const calls = mock.calls.slice(before);
    const plan = calls.find((c) => c.text.includes('本次只输出 README.md 与样式文件'))!;
    expect(toolNames(plan.body)).toEqual(expect.arrayContaining(['find_logo', 'use_logo']));
    expect(plan.text).toContain('【Logo】');
    expect(plan.text).toContain('Logo 绝不能自己画');
    expect(plan.text).toContain('## 同类页面格式');
    expect(plan.text).toContain('「共 N 页」');
    expect(plan.text).toContain('同类页面统一格式');
    expect(plan.text).toContain('任意两页不能讲同一个或高度相关的问题');
    const pages = calls.filter((c) => c.text.includes('【本批任务】'));
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.every((c) => toolNames(c.body).includes('find_logo') && c.text.includes('【Logo 工具 find_logo / use_logo】'))).toBe(true);
    expect(pages.every((c) => c.text.includes('严格套用 README「同类页面格式」'))).toBe(true);
    const review = mock.reviewCalls.slice(reviewsBefore).find((c) => c.text.includes('【自检阶段】'))!;
    expect(review.text).toContain('页面之间没有重叠');
    expect(review.text).toContain('同类页面（方案一 / 二 / 三、改动 1 / 2 / 3 等）格式统一');
    expect(toolNames(review.body)).toContain('find_logo');
  });
});
