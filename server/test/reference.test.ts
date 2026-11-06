import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startMockLlm } from './mockLlm.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ref-'));
process.env.DATA_DIR = tmp;

const hasTools = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v soffice && command -v pdftoppm'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockLlm>>;
let cookie = '';
let pptx: Buffer;

async function makePptx(titles: string[]): Promise<Buffer> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const Ctor = PptxGenJS as unknown as new () => import('pptxgenjs').default;
  const p = new Ctor();
  p.layout = 'LAYOUT_WIDE';
  for (const t of titles) {
    const s = p.addSlide();
    s.background = { color: '1E3A8A' };
    s.addText(t, { x: 0.8, y: 2.8, w: 11, h: 1.5, fontSize: 40, color: 'FFFFFF' });
  }
  return (await p.write({ outputType: 'nodebuffer' })) as Buffer;
}

function multipart(fields: Record<string, string>, files: { filename: string; type: string; data: Buffer }[]) {
  const boundary = '----rs' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`),
      f.data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie } };
}

async function req(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
  return { status: res.statusCode, json: res.json() };
}

async function waitJob(id: string) {
  for (let i = 0; i < 300; i++) {
    const { json } = await req('GET', `/api/jobs/${id}`);
    if (json.job.status === 'done' || json.job.status === 'error') return json.job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job timeout');
}

beforeAll(async () => {
  mock = await startMockLlm();
  const { openDb } = await import('../src/db.js');
  const { buildApp } = await import('../src/app.js');
  app = await buildApp(openDb(path.join(tmp, 'test.db')), { serveWeb: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } });
  cookie = String(login.headers['set-cookie']).split(';')[0];
  await req('POST', '/api/llm/endpoints', { name: 'mock', baseUrl: mock.url, apiKey: 'good-key', model: 'mock-vision' });
  pptx = await makePptx(['参考封面 ALPHA', '参考数据页 BETA', '参考团队页 GAMMA']);
});

afterAll(async () => {
  await app.close();
  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!hasTools)('reference images and PPT uploads', () => {
  let templateId = '';
  let deckId = '';

  it('slides-to-images exports every slide of a PPTX and of a PDF', async () => {
    const { exportSlides } = await import('../src/assets.js');
    const file = path.join(tmp, 'deck.pptx');
    fs.writeFileSync(file, pptx);
    const r = await exportSlides(file);
    expect(r.images).toHaveLength(3);
    expect(r.images[0].subarray(0, 3).toString('hex')).toBe('ffd8ff');
    const pdf = path.join(tmp, 'deck.pdf');
    fs.writeFileSync(pdf, r.pdf!);
    expect((await exportSlides(pdf, 2)).images).toHaveLength(2);
  });

  it('template creation sends each PPT slide and reference images to the model', async () => {
    const mp = multipart(
      { type: 'template', name: '参考模板', style: '仿照参考 PPT', fileRoles: JSON.stringify(['reference', 'reference', 'embed']) },
      [
        { filename: '参考.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', data: pptx },
        { filename: 'mood.png', type: 'image/png', data: PNG_1x1 },
        { filename: 'logo.png', type: 'image/png', data: PNG_1x1 },
      ],
    );
    const r = await app.inject({ method: 'POST', url: '/api/projects', payload: mp.payload, headers: mp.headers });
    expect(r.statusCode).toBe(200);
    templateId = r.json().project.id;
    expect((await waitJob(r.json().job.id)).status).toBe('done');
    const call = mock.calls.at(-1)!;
    expect(call.images.filter((i) => i.startsWith('data:image/jpeg'))).toHaveLength(3);
    expect(call.images.filter((i) => i.startsWith('data:image/png'))).toHaveLength(2);
    expect(call.text).toContain('「参考.pptx」第 1 页');
    expect(call.text).toContain('「参考.pptx」第 3 页');
    expect(call.text).toContain('参考团队页 GAMMA'); // text extracted from the converted PDF
    expect(call.text).toContain('参考图「mood.png」');
    expect(call.text).toMatch(/图片「logo\.png」［file_id=F3］，可在页面中通过 <img src="\/api\/assets\//);
    expect(call.text).toContain('参考 PPT');

    const p = await req('GET', `/api/projects/${templateId}`);
    expect(p.json.assets).toHaveLength(3);
    const deck = p.json.assets.find((a: any) => a.filename === '参考.pptx');
    expect(deck).toMatchObject({ kind: 'document', role: 'reference', slideCount: 3 });
    const img = await app.inject({ method: 'GET', url: deck.slideUrls[1] });
    expect(img.headers['content-type']).toContain('image/jpeg');
    expect(p.json.assets.find((a: any) => a.filename === 'mood.png').role).toBe('reference');
    expect(p.json.assets.find((a: any) => a.filename === 'logo.png').role).toBe('embed');
  });

  it('deck creation treats PPT pages as content references while keeping the template style', async () => {
    const mp = multipart({ type: 'deck', name: '参考材料', templateId, content: '按照上传的旧版 PPT 重做' }, [
      { filename: '旧版.pptx', type: 'application/octet-stream', data: pptx },
    ]);
    const r = await app.inject({ method: 'POST', url: '/api/projects', payload: mp.payload, headers: mp.headers });
    deckId = r.json().project.id;
    expect((await waitJob(r.json().job.id)).status).toBe('done');
    const call = mock.calls.at(-1)!;
    expect(call.images.filter((i) => i.startsWith('data:image/jpeg'))).toHaveLength(3);
    expect(call.text).toContain('视觉样式仍以所选模板为准');
  });

  it('an edit can carry its own reference attachments', async () => {
    const up = multipart({ role: 'reference' }, [{ filename: '竞品.pptx', type: 'application/octet-stream', data: await makePptx(['竞品页 DELTA']) }]);
    const u = await app.inject({ method: 'POST', url: `/api/projects/${deckId}/assets`, payload: up.payload, headers: up.headers });
    const attachment = u.json().assets[0];
    expect(attachment.slideCount).toBe(1);
    const before = mock.calls.length;
    const r = await req('POST', `/api/projects/${deckId}/edit`, { prompt: '参考附件改版', scope: 'global', attachmentIds: [attachment.id] });
    expect((await waitJob(r.json.job.id)).status).toBe('done');
    const call = mock.calls.at(-1)!;
    expect(mock.calls.length).toBe(before + 2); // one round of edit tools, then the summary
    expect(call.text).toContain('本次修改附带的参考文件');
    expect(call.text).toContain('「竞品.pptx」第 1 页');
    expect(call.text).toContain('竞品页 DELTA');
    expect(call.images.filter((i) => i.startsWith('data:image/jpeg'))).toHaveLength(1);
    expect(call.body.tools.map((t: any) => t.function.name)).toContain('read_archive_entry');

    const before2 = mock.calls.length;
    const r2 = await req('POST', `/api/projects/${deckId}/edit`, { prompt: 'USE_TOOLS 按附件改版', scope: 'global', attachmentIds: [attachment.id] });
    const job2 = await waitJob(r2.json.job.id);
    expect(job2.status).toBe('done');
    expect(mock.calls.length).toBe(before2 + 4);
    const files = JSON.parse(mock.calls.at(-1)!.body.messages.find((m: any) => m.role === 'tool').content);
    expect(files.find((f: any) => f.name === '竞品.pptx')).toMatchObject({ type: 'presentation', pages: 1, archive: true });
  });

  it('an HTML upload is rendered page by page with its text extracted', async () => {
    const html = `<!DOCTYPE html><html><head><style>.slide{width:1920px;height:1080px;background:#123}</style>
      <script>window.secret = "SCRIPT-ONLY"</script></head><body>
      ${[1, 2, 3].map((i) => `<section class="slide"><h1>HTML 参考第 ${i} 页 PAGE${i}</h1></section>`).join('')}
      <img src="http://169.254.169.254/latest/meta-data/x.png"></body></html>`;
    const up = multipart({ role: 'reference' }, [{ filename: 'ref.html', type: 'text/html', data: Buffer.from(html) }]);
    const u = await app.inject({ method: 'POST', url: `/api/projects/${deckId}/assets`, payload: up.payload, headers: up.headers });
    const a = u.json().assets[0];
    expect(a).toMatchObject({ kind: 'document', slideCount: 3, hasText: true });
    const { openDb } = await import('../src/db.js');
    const db = openDb(path.join(tmp, 'test.db'));
    const row = db.prepare('SELECT extracted_text FROM assets WHERE id = ?').get(a.id) as { extracted_text: string };
    expect(row.extracted_text).toContain('HTML 参考第 3 页');
    expect(row.extracted_text).not.toContain('SCRIPT-ONLY');
    const pages = db.prepare('SELECT extracted_text FROM assets WHERE parent_id = ? ORDER BY page_no').all(a.id) as { extracted_text: string }[];
    expect(pages.map((p) => p.extracted_text)).toEqual(['HTML 参考第 1 页 PAGE1', 'HTML 参考第 2 页 PAGE2', 'HTML 参考第 3 页 PAGE3']);
    const img = await app.inject({ method: 'GET', url: a.slideUrls[0] });
    expect(img.rawPayload.subarray(0, 3).toString('hex')).toBe('ffd8ff');
  });

  it('large files are previewed and the model reads them through read-only tools', async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `第 ${i} 行：市场数据与说明文字。`).join('\n') + '\n结论 NEEDLE-42：毛利率 63%';
    const html = '<html><head><style>.slide{width:1280px;height:720px}</style></head><body><section class="slide"><h1>H1</h1></section><section class="slide"><h1>H2</h1></section><p class="raw-marker">RAW</p></body></html>';
    const mp = multipart({ type: 'template', name: '工具模板', style: '参考附件', notes: 'USE_TOOLS' }, [
      { filename: '旧版.pptx', type: 'application/octet-stream', data: pptx },
      { filename: 'big.txt', type: 'text/plain', data: Buffer.from(big) },
      { filename: 'site.html', type: 'text/html', data: Buffer.from(html) },
    ]);
    const before = mock.calls.length;
    const r = await app.inject({ method: 'POST', url: '/api/projects', payload: mp.payload, headers: mp.headers });
    const job = await waitJob(r.json().job.id);
    expect(job.status).toBe('done');
    const calls = mock.calls.slice(before);
    expect(calls).toHaveLength(3);

    const first = calls[0];
    expect(first.body.tools.map((t: any) => t.function.name).sort()).toEqual(
      ['list_archive', 'list_files', 'read_archive_entry', 'read_raw', 'read_text', 'search_files', 'view_page'],
    );
    expect(first.text).toContain('［file_id=F2］');
    expect(first.text).toContain('全文共');
    expect(first.text).not.toContain('NEEDLE-42'); // the tail of the big file is not inlined
    expect(first.text).toContain('只读文件工具');

    const toolMsgs = calls[2].body.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content as string);
    expect(toolMsgs).toHaveLength(7);
    expect(JSON.parse(toolMsgs[0]).map((f: any) => [f.file_id, f.type, f.pages])).toEqual([
      ['F1', 'presentation', 3],
      ['F2', 'text', 0],
      ['F3', 'html', 2],
    ]);
    expect(toolMsgs[1]).toContain('第 2/3 页');
    expect(toolMsgs[1]).toContain('参考数据页 BETA');
    expect(toolMsgs[2]).toContain('NEEDLE-42：毛利率 63%');
    expect(toolMsgs[3]).toContain('ppt/slides/slide1.xml');
    expect(toolMsgs[3]).toContain('参考封面 ALPHA');
    expect(toolMsgs[4]).toContain('raw-marker');
    expect(toolMsgs[5]).toContain('没有编号为 F99 的文件');
    expect(toolMsgs[6]).toContain('没有名为 write_file 的工具');
    const imageMsg = calls[2].body.messages.find((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.text?.includes('工具调用返回的图片'));
    expect(imageMsg.content.some((p: any) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg'))).toBe(true);
    expect(calls[2].body.tool_choice).toBe('auto');
    expect(job.cost).toBeCloseTo(0.0004, 6); // three draft rounds plus the self-check reply
  });

  it('deleting a PPT asset removes its slide images', async () => {
    const p = await req('GET', `/api/projects/${deckId}`);
    const deck = p.json.assets.find((a: any) => a.filename === '旧版.pptx');
    const slideUrl = deck.slideUrls[0];
    expect((await req('DELETE', `/api/projects/${deckId}/assets/${deck.id}`)).status).toBe(200);
    expect((await app.inject({ method: 'GET', url: slideUrl })).statusCode).toBe(404);
  });
});
