import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MOCK_CHART, startMockLlm } from './mockLlm.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-charts-'));
process.env.DATA_DIR = tmp;

const { chartsAvailable, createChartTools, renderChart } = await import('../src/charts.js');
const { CHART_MARK, isChart, projectAssets, toAssetRefs } = await import('../src/assets.js');
type DB = import('../src/db.js').DB;

const toolNames = (body: any): string[] => (body.tools ?? []).map((t: any) => t.function.name);

describe.skipIf(!chartsAvailable())('make_chart', () => {
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
    const { closeBrowser } = await import('../src/render.js');
    await closeBrowser();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('draws every chart type from a JSON spec: an SVG with text kept as text, and a PNG preview', async () => {
    const cats = ['华东', '华南', '华北', '西部'];
    const specs: Record<string, unknown>[] = [
      { type: 'bar', categories: cats, series: [{ name: '销量', values: [3, 7, 5, 9] }], unit: '万' },
      { type: 'bar', horizontal: true, categories: cats, series: [{ name: 'x', values: [3, 7, 5, 9] }], highlight: ['D'] },
      { type: 'bar', stacked: true, categories: cats, series: [{ name: 'x', values: [1, 2, 3, 4] }, { name: 'y', values: [2, 2, 2, 2] }] },
      { type: 'line', categories: cats, series: [{ name: 'p99', values: [48, 40, null, 31] }], unit: ' ms' },
      { type: 'area', categories: cats, series: [{ name: 'x', values: [1, 3, 2, 4] }] },
      { type: 'pie', categories: cats, series: [{ name: '份额', values: [40, 30, 20, 10] }] },
      { type: 'donut', categories: cats, series: [{ name: '份额', values: [40, 30, 20, 10] }], unit: '%', center_text: '100%' },
      { type: 'scatter', series: [{ name: '客户', x: [1, 2, 3], y: [3, 1, 2], labels: ['甲', '乙', '丙'] }] },
      MOCK_CHART,
      { type: 'waterfall', categories: ['期初', '新增', '流失', '期末'], series: [{ name: 'ARR', values: [100, 40, -15, 125] }], totals: [3] },
      { type: 'funnel', categories: ['访问', '注册', '付费'], series: [{ name: '用户', values: [10000, 2400, 310] }] },
      { type: 'heatmap', categories: ['周一', '周二'], series: [{ name: '上午', values: [3, 5] }, { name: '下午', values: [8, 2] }] },
      { type: 'radar', categories: ['速度', '成本', '质量'], series: [{ name: '我们', values: [8, 6, 9] }, { name: '对手', values: [6, 8, 7] }] },
    ];
    for (const spec of specs) {
      const r = await renderChart({ ...spec, width: 960, height: 540 });
      expect(r.svg, String(spec.type)).toMatch(/^<svg[^>]*width="960" height="540" viewBox="0 0 960 540"/);
      expect(r.svg).toContain('<text');
      expect(r.svg).not.toMatch(/<script/i);
      expect(Buffer.from(r.png, 'base64').subarray(1, 4).toString()).toBe('PNG');
      expect([r.width, r.height]).toEqual([960, 540]);
    }
    // Text stays text, in the fonts asked for, with the CJK fallbacks behind them.
    const bar = await renderChart({ ...specs[0], font_family: ['PingFang SC'] });
    expect(bar.svg).toContain('华东');
    expect(bar.svg).toMatch(/font: [\d.]+px 'PingFang SC', 'Noto Sans CJK SC'[^;"]*sans-serif/);
  });

  it('rejects bad specs with a message the model can act on, and ignores colours it cannot use', async () => {
    await expect(renderChart({ type: 'sankey', series: [] })).rejects.toThrow(/sankey/);
    await expect(renderChart({ type: 'bar', categories: ['A'], series: [] })).rejects.toThrow(/series/);
    const r = await renderChart({ type: 'bar', categories: ['A'], series: [{ name: 'x', values: [1], color: 'var(--brand)' }], text_color: 'nope' });
    expect(r.svg).toContain('<svg');
  });

  it('saves the chart as a project image and returns the <img> to place, with a preview', async () => {
    const p = db.prepare(`INSERT INTO projects (id, type, name, meta, status, created_by, updated_by, created_at, updated_at) VALUES ('chartp', 'deck', 'c', '{}', 'ready', 1, 1, 0, 0)`);
    p.run();
    const tools = createChartTools(db, 'chartp', 1);
    expect(tools.defs.map((d) => d.function.name)).toEqual(['make_chart']);
    const out = await tools.execute('make_chart', MOCK_CHART);
    const [row] = projectAssets(db, 'chartp');
    expect(row).toMatchObject({ mime: 'image/svg+xml', kind: 'image', role: 'embed', filename: '图表-2022–2024-年收入与增长率.svg' });
    expect(isChart(row)).toBe(true);
    expect(row.extracted_text!.startsWith(CHART_MARK)).toBe(true);
    const { alt: _alt, ...spec } = MOCK_CHART;
    expect(JSON.parse(row.extracted_text!.slice(CHART_MARK.length))).toEqual(spec);
    expect(out.content).toContain(`<img src="/api/assets/${row.id}" alt="2022–2024 年收入与增长率" class="chart-img"`);
    expect(out.images).toEqual([{ label: '图表预览「2022–2024 年收入与增长率」', url: expect.stringMatching(/^data:image\/png;base64,/) }]);

    // Prompts describe it by its spec; it is never attached as an image (model APIs take raster images only).
    const [ref] = toAssetRefs(db, [row], true);
    expect(ref).toMatchObject({ chart: true, url: `/api/assets/${row.id}`, text: expect.stringContaining('"type":"combo"') });
    expect(ref.dataUrl).toBeUndefined();

    const bad = await tools.execute('make_chart', { type: 'bar', series: 'x' });
    expect(bad.content).toMatch(/^错误：图表没有画出来/);
    expect(projectAssets(db, 'chartp')).toHaveLength(1);
  });

  it('an SVG upload is not mistaken for a chart, and SVGs are served with a script-blocking policy', async () => {
    const { saveAsset } = await import('../src/assets.js');
    const logo = await saveAsset(db, 'chartp', 1, 'logo.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(isChart(logo)).toBe(false);
    const [ref] = toAssetRefs(db, [logo], true);
    expect(ref.chart).toBeUndefined();
    expect(ref.dataUrl).toBeUndefined();
    const r = await req('GET', `/api/assets/${logo.id}`);
    expect(r.headers['content-type']).toBe('image/svg+xml');
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
  });

  it('a deck with data gets charts drawn while its pages are written, even though the template has no chart layout', async () => {
    const tpl = await req('POST', '/api/projects', { type: 'template', name: '无图表模板', style: '简约' });
    expect((await waitJob(tpl.json.job.id)).status).toBe('done');
    const templateCalls = mock.calls.filter((c) => c.text.includes('无图表模板'));
    expect(templateCalls.length).toBeGreaterThan(0);
    expect(templateCalls.every((c) => !toolNames(c.body).includes('make_chart'))).toBe(true);

    const before = mock.calls.length;
    const r = await req('POST', '/api/projects', {
      type: 'deck',
      templateId: tpl.json.project.id,
      name: '融资路演',
      content: '| 年份 | 收入（万元） | 同比 |\n|---|---|---|\n| 2022 | 1200 | 40% |\n| 2023 | 2100 | 75% |\n| 2024 | 3200 | 52% |',
      notes: 'DRAW_CHART',
    });
    const job = await waitJob(r.json.job.id);
    expect(job.error).toBeFalsy();
    expect(job.status).toBe('done');
    const calls = mock.calls.slice(before);
    const plan = calls.find((c) => c.text.includes('本次只输出 README.md 与样式文件'))!;
    expect(plan.text).toContain('【数据图表】');
    expect(toolNames(plan.body)).not.toContain('make_chart');
    const pages = calls.filter((c) => c.text.includes('【本批任务】'));
    expect(pages.every((c) => toolNames(c.body).includes('make_chart') && c.text.includes('【图表工具 make_chart】'))).toBe(true);
    // The model saw the preview it asked for.
    expect(pages.some((c) => c.text.includes('图表预览') && c.images.some((u) => u.startsWith('data:image/png')))).toBe(true);

    const id = r.json.project.id;
    // Each page batch (written side by side) drew its own; the one in the batch holding page 2 is on it.
    const charts = projectAssets(db, id).filter(isChart);
    expect(charts).toHaveLength(pages.filter((c) => toolNames(c.body).includes('make_chart') && !c.text.includes('图表预览')).length);
    const doc = (await req('GET', `/api/projects/${id}`)).json.project.doc;
    const used = charts.find((c) => doc.pages[1].html.includes(`src="/api/assets/${c.id}"`));
    expect(used).toBeTruthy();
    expect(doc.pages[1].html).toContain('class="chart-img"');
    const img = await req('GET', `/api/assets/${used!.id}`);
    expect(img.status).toBe(200);
    expect(img.body.toString('utf8')).toContain('收入');

    // The standalone export inlines it like any other image.
    const exported = await req('GET', `/api/projects/${id}/export?format=html`);
    expect(exported.body.toString('utf8')).toMatch(/src="data:image\/svg\+xml;base64,/);
  });

  it('edits can draw a new chart and place it, and the asset list in the prompt shows the earlier one with its data', async () => {
    const list = (await req('GET', '/api/projects')).json.projects.find((p: any) => p.name === '融资路演');
    const id = list.id;
    const doc = (await req('GET', `/api/projects/${id}`)).json.project.doc;
    const before = mock.calls.length;
    const drawn = projectAssets(db, id).filter(isChart).length;
    const r = await req('POST', `/api/projects/${id}/edit`, { prompt: '第 3 页加一张收入图 DRAW_CHART', scope: 'page', pageId: doc.pages[2].id });
    const job = await waitJob(r.json.job.id);
    expect(job.status).toBe('done');
    const first = mock.calls[before];
    expect(toolNames(first.body)).toContain('make_chart');
    expect(first.text).toContain('【图表工具 make_chart】');
    expect(first.text).toMatch(/图表「图表-2022–2024-年收入与增长率\.svg」（make_chart 生成）[^\n]*"type":"combo"/);
    const charts = projectAssets(db, id).filter(isChart);
    expect(charts).toHaveLength(drawn + 1);
    const after = (await req('GET', `/api/projects/${id}`)).json.project.doc;
    expect(after.pages[2].html).toContain(`src="/api/assets/${charts.at(-1)!.id}"`);
  });
});
