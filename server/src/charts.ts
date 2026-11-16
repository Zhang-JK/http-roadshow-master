/**
 * make_chart: the model describes a chart (type, data, colours) and server/scripts/chart.py draws it
 * with matplotlib. The model never sends code — only this JSON spec — so user data cannot run
 * anything on the server. The SVG is saved as a project image and placed in pages with <img>.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';
import type { DB } from './db.js';
import { CHART_MARK, saveAsset, type AssetRow } from './assets.js';
import type { FileTools, ToolDef, ToolOutput } from './fileTools.js';

export const chartScript = () => path.join(config.appRoot, 'server', 'scripts', 'chart.py');

export const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'donut', 'scatter', 'combo', 'waterfall', 'funnel', 'heatmap', 'radar'] as const;

let available: boolean | undefined;
/** Whether Python with matplotlib is installed (checked once). */
export function chartsAvailable(): boolean {
  if (available === undefined) {
    const r = spawnSync(config.python, ['-c', 'import matplotlib'], { timeout: 20_000, stdio: 'ignore' });
    available = r.status === 0;
  }
  return available;
}

export interface ChartResult {
  svg: string;
  /** Small PNG preview, base64: what the model looks at to check the chart. */
  png: string;
  width: number;
  height: number;
}

const MAX_RUNNING = 3;
let running = 0;
const waiting: (() => void)[] = [];

/** Runs chart.py on one spec (at most a few at once: parallel page batches may all draw). */
export async function renderChart(spec: Record<string, unknown>): Promise<ChartResult> {
  if (running >= MAX_RUNNING) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await new Promise<ChartResult>((resolve, reject) => {
      const p = spawn(config.python, [chartScript()], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      p.stdout.on('data', (c: Buffer) => out.push(c));
      p.stderr.on('data', (c: Buffer) => err.push(c));
      p.on('error', reject);
      p.on('close', (code, signal) => {
        if (code === 0) {
          try {
            return resolve(JSON.parse(Buffer.concat(out).toString('utf8')));
          } catch (e) {
            return reject(new Error(`图表程序输出无法解析：${(e as Error).message}`));
          }
        }
        const msg = Buffer.concat(err).toString('utf8').trim().split('\n').pop();
        reject(new Error(signal ? `绘制超时（${signal}）` : msg || `图表程序退出码 ${code}`));
      });
      p.stdin.end(JSON.stringify(spec));
    });
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const seriesSchema = {
  type: 'array',
  description:
    '数据系列。一般为 [{name, values}]，values 与 categories 一一对应（缺失值用 null）；combo 每项再加 type（bar|line）与 axis（left|right）；scatter 为 [{name, x:[…], y:[…], labels:[…]}]；heatmap 每个系列是一行',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      values: { type: 'array', items: { type: 'number' }, description: '缺失值用 null' },
      type: { type: 'string', enum: ['bar', 'line'] },
      axis: { type: 'string', enum: ['left', 'right'] },
      color: { type: 'string' },
      x: { type: 'array', items: { type: 'number' } },
      y: { type: 'array', items: { type: 'number' } },
      labels: { type: 'array', items: { type: 'string' } },
    },
    required: ['name'],
  },
};

export const CHART_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'make_chart',
      description: `根据数据绘制一张图表（matplotlib 渲染为 SVG 矢量图，透明背景，文字可选中），保存为本项目的图片素材，返回可直接放进页面的 <img> 代码和一张预览图。只传数据与样式参数，不要传代码。
选择图表类型：时间趋势 → line（多指标量级相近时多条线）或 area；类别比较/排名 → bar（类别多或名称长时 horizontal=true，按数值排序）；构成/占比 → donut 或 pie（≤6 项），多组构成 → bar + stacked=true；规模与比率同时展示（如收入与增长率）→ combo（柱为规模、线为比率放右轴）；增减拆解（期初→变化→期末）→ waterfall；转化漏斗 → funnel；两个数值变量的关系 → scatter；矩阵/时段分布 → heatmap；多维能力对比 → radar。
数值请原样给出（不要编造或估算），单位放在 unit（如 "%"、"万元"、"ms"）。`,
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...CHART_TYPES] },
          categories: { type: 'array', items: { type: 'string' }, description: 'x 轴类别 / 饼图各项 / 漏斗各步 / 热力图的列 / 雷达图各维度' },
          series: seriesSchema,
          title: { type: 'string', description: '图内标题（可选；页面上已有结论式标题时不要重复）' },
          x_label: { type: 'string' },
          y_label: { type: 'string' },
          y2_label: { type: 'string', description: 'combo 右轴名称' },
          unit: { type: 'string', description: '数值单位，显示在数据标签上' },
          unit2: { type: 'string', description: 'combo 右轴的单位' },
          decimals: { type: 'integer', description: '小数位数（默认按数据自动）' },
          horizontal: { type: 'boolean', description: 'bar：横向条形图' },
          stacked: { type: 'boolean', description: 'bar / area：堆叠' },
          show_values: { type: 'boolean', description: '显示数据标签（默认数据点不多时显示）' },
          highlight: { type: 'array', items: { type: 'string' }, description: 'bar（单系列）：要突出的类别，用强调色，其余变灰' },
          totals: { type: 'array', items: { type: 'integer' }, description: 'waterfall：哪些类别（从 0 开始的序号）是合计值，第 0 项总是起点' },
          center_text: { type: 'string', description: 'donut：圆环中心的文字（默认显示合计）' },
          colors: { type: 'array', items: { type: 'string' }, description: '配色（十六进制），按 README 风格约定的主色、辅色、强调色顺序给出' },
          text_color: { type: 'string', description: '文字颜色：深色背景的页面用浅色' },
          muted_color: { type: 'string', description: '坐标轴、网格与弱化元素的颜色' },
          background: { type: 'string', description: '默认 transparent（透明，叠在页面背景上）' },
          font_family: { type: 'array', items: { type: 'string' }, description: '字体，与页面一致（如 ["PingFang SC","Noto Sans CJK SC"]）' },
          width: { type: 'integer', description: '图表在页面上的宽度（px），按放置它的区域给出，默认 1200' },
          height: { type: 'integer', description: '高度（px），默认 675' },
          font_size: { type: 'integer', description: '基础字号（px），默认约为宽度的 1/54；与页面正文字号相当' },
          alt: { type: 'string', description: '图表的文字说明（用于 alt 和素材名称），如「2021–2024 年收入与增长率」' },
        },
        required: ['type', 'series'],
      },
    },
  },
];

const slug = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'chart';
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Charts drawn for a project, saved as its images; `onSaved` hears about each one. */
export function createChartTools(db: DB, projectId: string, userId: number, onSaved?: (row: AssetRow) => void): FileTools {
  return {
    defs: CHART_TOOL_DEFS,
    async execute(name, args): Promise<ToolOutput> {
      if (name !== 'make_chart') return { content: `错误：没有名为 ${name} 的工具` };
      const { alt, ...spec } = args ?? {};
      let r: ChartResult;
      try {
        r = await renderChart(spec);
      } catch (e) {
        return { content: `错误：图表没有画出来：${(e as Error).message}。请修正参数后重试。` };
      }
      const label = String(alt || spec.title || `${spec.type} 图表`).slice(0, 80);
      const row = await saveAsset(db, projectId, userId, `图表-${slug(label)}.svg`, 'image/svg+xml', Buffer.from(r.svg), 'embed');
      db.prepare('UPDATE assets SET extracted_text = ? WHERE id = ?').run(CHART_MARK + JSON.stringify(spec), row.id);
      onSaved?.(row);
      const url = `/api/assets/${row.id}`;
      return {
        content: `已生成图表「${label}」（${r.width}×${r.height}，透明背景），预览见下一条消息。把下面的代码放进页面中合适的区域（容器按这个宽高比留出空间；没有现成位置时调整版式或新增一页来放它），结论写在页面标题或图注里：
<img src="${url}" alt="${escapeAttr(label)}" class="chart-img" style="display:block;width:100%;height:auto;max-height:100%;object-fit:contain">
数据或样式需要调整时，用 make_chart 重新生成，再把 src 换成新地址。`,
        images: [{ label: `图表预览「${label}」`, url: `data:image/png;base64,${r.png}` }],
      };
    },
  };
}
