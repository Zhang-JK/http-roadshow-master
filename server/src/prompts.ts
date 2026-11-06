import type { ChatMessage, ContentPart } from './llm.js';
import { assembleHtml, type DeckDoc, type ElementInfo } from './deck.js';

export interface AssetRef {
  id: string;
  filename: string;
  url: string;
  kind: 'image' | 'document';
  text?: string | null;
  dataUrl?: string;
}

const RULES = (doc: Pick<DeckDoc, 'width' | 'height'>) => `
【硬性技术规范 —— 必须严格遵守】
1. 材料以“页”为单位。每一页是一个 <section class="slide"> 元素，所有页面依次直接放在 <body> 下，不能嵌套。
2. 每页画幅固定为 ${doc.width}×${doc.height} 像素（${doc.width > doc.height ? '横向' : doc.width < doc.height ? '竖向' : '方形'}）。所有内容必须完全容纳在页面内，禁止溢出、禁止滚动，字号与留白要按这个像素尺寸设计（正文通常 28–40px，标题 56–110px）。
3. 页面尺寸、定位基础已由系统提供（.slide 已设置 width/height/position:relative/overflow:hidden），你不需要也不要修改 .slide 的宽高。
4. 所有样式写在 <head> 中唯一的一个 <style> 内，使用语义化的 class（例如 .cover-title、.kpi-card），尽量少用内联 style。可使用 CSS 变量定义主题色。
5. 禁止使用 <script>、<iframe>、外部 JS。图表请用内联 <svg> 或纯 CSS 实现。
6. 字体使用系统字体栈，例如 "PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Helvetica Neue",Arial,sans-serif；如确需网络字体，只能通过 <link rel="stylesheet"> 引入 Google Fonts。
7. 图片：只能使用用户提供的素材 URL（见素材列表），或使用 CSS 渐变、内联 SVG 图形、emoji/图标字符做装饰。禁止编造外部图片链接。
8. 不要使用 position:fixed，不要依赖视口单位（vw/vh），一律使用 px 或 %。
9. 已有元素上的 data-eid 与 data-page-id 属性是系统用于追踪修改历史的标识，修改时必须原样保留在对应元素上；新增元素不需要添加 data-eid。
10. 输出内容只包含一个 \`\`\`html 代码块，不要输出任何解释文字。`;

const SYSTEM = (doc: Pick<DeckDoc, 'width' | 'height'>) =>
  `你是一名顶级的演示文稿视觉设计师兼前端工程师，擅长制作投资路演、产品发布、商业汇报类的 HTML 演示材料。你的作品层次清晰、排版精致、配色专业，信息密度适中，适合投屏和打印。
${RULES(doc)}`;

function assetsBlock(assets: AssetRef[]): string {
  if (!assets.length) return '（无）';
  return assets
    .map((a, i) => {
      if (a.kind === 'image') return `${i + 1}. 图片「${a.filename}」，可在页面中通过 <img src="${a.url}"> 使用（附图见后）`;
      const text = (a.text ?? '').trim();
      return `${i + 1}. 文档「${a.filename}」内容如下：\n<<<\n${text || '（无法提取文字）'}\n>>>`;
    })
    .join('\n\n');
}

function imageParts(assets: AssetRef[], max = 8): ContentPart[] {
  return assets
    .filter((a) => a.kind === 'image' && a.dataUrl)
    .slice(0, max)
    .flatMap((a) => [
      { type: 'text' as const, text: `素材图片「${a.filename}」（URL: ${a.url}）：` },
      { type: 'image_url' as const, image_url: { url: a.dataUrl! } },
    ]);
}

export interface TemplateBrief {
  name: string;
  style: string;
  purpose: string;
  audience?: string;
  colors?: string;
  pageCount?: number;
  notes?: string;
}

export function buildTemplatePrompt(doc: DeckDoc, brief: TemplateBrief, assets: AssetRef[]): ChatMessage[] {
  const text = `请设计一套可复用的「路演材料模板」，以完整 HTML 文档形式输出。

【模板名称】${brief.name}
【设计风格】${brief.style || '由你决定，现代、专业'}
【计划用途】${brief.purpose || '通用商业路演'}
【目标受众】${brief.audience || '未指定'}
【配色偏好】${brief.colors || '由你根据风格决定'}
【其他要求】${brief.notes || '无'}

【模板要求】
- 模板是后续生成具体路演材料的“版式库”，请提供约 ${brief.pageCount || 8} 页代表性版式，例如：封面、目录/议程、章节过渡页、图文内容页、数据/KPI 页、图表页（SVG）、对比或时间线页、团队介绍页、结束/联系方式页，可根据用途调整。
- 每页 <section> 上添加 data-layout 属性标明版式类型（如 data-layout="cover"），并在页面中使用占位性质但真实可信的示例文案（不要写 lorem ipsum）。
- 样式系统要完整：用 CSS 变量定义主色、辅色、强调色、字体、圆角、间距，并为标题、正文、卡片、列表、图表、页脚页码等定义可复用的 class，便于后续材料复用。
- 每页右下角或页脚包含统一的页码/品牌区域。

【可用素材】
${assetsBlock(assets)}`;
  return [
    { role: 'system', content: SYSTEM(doc) },
    { role: 'user', content: [{ type: 'text', text }, ...imageParts(assets)] },
  ];
}

export interface DeckBrief {
  name: string;
  purpose?: string;
  audience?: string;
  content: string;
  pageCount?: number;
  notes?: string;
}

export function buildDeckPrompt(doc: DeckDoc, template: DeckDoc | null, brief: DeckBrief, assets: AssetRef[]): ChatMessage[] {
  const templateBlock = template
    ? `【所选模板】
以下是用户选择的模板 HTML。请严格沿用它的 <style> 样式系统（可原样复制全部 CSS 后按需少量扩展）、配色、字体、版式结构和页脚设计，根据内容选择合适的版式页并复制其结构来填充真实内容。模板中的示例文案必须全部替换为本次路演的真实内容。
\`\`\`html
${assembleHtml(template)}
\`\`\``
    : '【所选模板】无，请自行设计专业的风格。';
  const text = `请根据以下资料制作一份完整的路演材料，以完整 HTML 文档形式输出。

【材料名称】${brief.name}
【用途/场合】${brief.purpose || '未指定'}
【目标受众】${brief.audience || '未指定'}
【期望页数】${brief.pageCount ? `约 ${brief.pageCount} 页` : '根据内容决定（通常 8–15 页）'}
【需要呈现的内容】
${brief.content}
【其他要求】${brief.notes || '无'}

【支持材料】
${assetsBlock(assets)}

${templateBlock}

【制作要求】
- 内容组织要有路演逻辑（如：痛点→方案→产品→市场→商业模式→竞争→团队→财务→融资计划），但以用户提供的内容为准，不要编造关键事实数据；缺少数据时用合理的定性表述或明显的占位提示。
- 每页一个核心观点，标题提炼结论；数据用 KPI 卡片或 SVG 图表可视化。
- 用户提供的图片素材应在合适的页面中使用。`;
  return [
    { role: 'system', content: SYSTEM(doc) },
    { role: 'user', content: [{ type: 'text', text }, ...imageParts(assets)] },
  ];
}

export type EditScope = 'global' | 'page' | 'element';

export interface EditRequest {
  scope: EditScope;
  prompt: string;
  pageIndex?: number;
  pageHtml?: string;
  elements?: ElementInfo[];
  screenshot?: string;
}

export function buildEditPrompt(doc: DeckDoc, req: EditRequest, assets: AssetRef[], kind: 'template' | 'deck'): ChatMessage[] {
  const what = kind === 'template' ? '路演模板' : '路演材料';
  const parts: ContentPart[] = [];
  let text: string;
  if (req.scope === 'global') {
    text = `下面是当前的${what}（共 ${doc.pages.length} 页）。用户要求对【整份材料】进行调整。

【修改要求】
${req.prompt}

【当前完整 HTML】
\`\`\`html
${assembleHtml(doc)}
\`\`\`

【可用素材】
${assetsBlock(assets)}

请输出修改后的【完整 HTML 文档】（包含全部页面，未涉及修改的页面保持原样，所有已有 data-eid / data-page-id 属性保留）。如用户要求增删页面，可以增删 <section class="slide">。`;
  } else {
    const n = req.pageIndex! + 1;
    const target =
      req.scope === 'element' && req.elements?.length
        ? `【修改范围】第 ${n} 页中用户选中的 ${req.elements.length} 个元素（截图中以红色粗边框标出）：
${req.elements
  .map(
    (e, i) =>
      `元素${i + 1}: 第 ${n} 页的 <${e.tag}> 元素，data-eid="${e.eid}"${e.classes ? `，class="${e.classes}"` : ''}${
        e.text ? `，文字内容“${e.text}”` : ''
      }\n当前 HTML：\n${e.html}`,
  )
  .join('\n\n')}

请只修改上述选中元素（可修改其内容、样式、子元素，必要时可微调同页其他元素的布局以避免重叠或溢出），不要改动与本次要求无关的部分。`
        : `【修改范围】第 ${n} 页整页（页面 data-page-id="${doc.pages[req.pageIndex!].id}"）。只修改这一页。`;
    text = `下面是当前${what}（共 ${doc.pages.length} 页）的第 ${n} 页。

${target}

【修改要求】
${req.prompt}

【全局样式（只读参考，不要整体输出）】
\`\`\`css
${doc.css}
\`\`\`

【第 ${n} 页当前 HTML】
\`\`\`html
${req.pageHtml}
\`\`\`

【可用素材】
${assetsBlock(assets)}

【输出格式】
只输出修改后的第 ${n} 页 <section class="slide" ...> 完整元素（保留 data-page-id 与所有已有 data-eid）。如果用户明确要求把这一页拆分成多页，可以连续输出多个 <section>。如需新增 CSS 规则，可在 section 之前附加一个 <style> 块，其中只写新增规则，它会被追加到全局样式中；不要重复输出已有的全局样式。全部放在一个 \`\`\`html 代码块中。`;
    if (req.screenshot) {
      parts.push({ type: 'text', text: `第 ${n} 页当前渲染截图${req.scope === 'element' ? '（红框为选中元素）' : ''}：` });
      parts.push({ type: 'image_url', image_url: { url: req.screenshot } });
    }
  }
  return [
    { role: 'system', content: SYSTEM(doc) },
    { role: 'user', content: [{ type: 'text', text }, ...parts, ...imageParts(assets, 4)] },
  ];
}
