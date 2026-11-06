import type { ChatMessage, ContentPart } from './llm.js';
import { assembleHtml, pageText, type DeckDoc, type ElementInfo } from './deck.js';

export interface AssetRef {
  id: string;
  filename: string;
  url: string;
  kind: 'image' | 'document';
  /** embed: may be placed in pages via <img>; reference: shown to the model only. */
  role?: 'embed' | 'reference';
  text?: string | null;
  dataUrl?: string;
  /** Page images exported from a presentation / PDF / HTML upload. */
  slides?: { page: number; dataUrl?: string }[];
  /** Id the read-only file tools know this file by (F1, F2, …); set when tools are available. */
  fileId?: string;
  fileType?: string;
}

/** Documents longer than this are only previewed inline; the model reads the rest through the file tools. */
const INLINE_CHARS = 6000;
const PREVIEW_CHARS = 1200;
const INLINE_TOTAL = 40_000;

export interface ImageBudget {
  embed: number;
  reference: number;
  slides: number;
}

const CREATE_BUDGET: ImageBudget = { embed: 8, reference: 8, slides: 24 };
const EDIT_BUDGET: ImageBudget = { embed: 4, reference: 6, slides: 12 };

interface ImagePlan {
  images: Set<string>;
  slides: Map<string, number>;
}

/** Decides which images fit the per-request budget so the text block and the attached images agree. */
function planImages(assets: AssetRef[], budget: ImageBudget): ImagePlan {
  const plan: ImagePlan = { images: new Set(), slides: new Map() };
  let embed = budget.embed;
  let reference = budget.reference;
  for (const a of assets) {
    if (a.kind !== 'image' || !a.dataUrl) continue;
    if (a.role === 'reference' ? reference-- > 0 : embed-- > 0) plan.images.add(a.id);
  }
  const decks = assets.filter((a) => a.slides?.some((s) => s.dataUrl));
  let left = budget.slides;
  decks.forEach((a, i) => {
    const fair = Math.ceil(left / (decks.length - i));
    const n = Math.min(a.slides!.length, fair);
    plan.slides.set(a.id, n);
    left -= n;
  });
  return plan;
}

function assetsBlock(assets: AssetRef[], plan?: ImagePlan): string {
  if (!assets.length) return '（无）';
  let inlineLeft = INLINE_TOTAL;
  return assets
    .map((a, i) => {
      const attached = plan?.images.has(a.id);
      const idTag = a.fileId ? `［file_id=${a.fileId}］` : '';
      if (a.kind === 'image') {
        if (a.role === 'reference') {
          return `${i + 1}. 参考图「${a.filename}」${idTag}：仅供参考（借鉴其版式、风格、配色或内容），不要把它嵌入页面${attached ? '（附图见后）' : ''}`;
        }
        return `${i + 1}. 图片「${a.filename}」${idTag}，可在页面中通过 <img src="${a.url}"> 使用${attached ? '（附图见后）' : ''}`;
      }
      const text = (a.text ?? '').trim();
      const shown = plan?.slides.get(a.id) ?? 0;
      const pages = a.slides?.length
        ? `共导出 ${a.slides.length} 页图片${shown ? `，${shown < a.slides.length ? `其中前 ${shown} 页` : '全部'}已附在后面` : ''}${
            a.fileId && shown < a.slides.length ? '，其余页面可用 view_page 查看' : ''
          }。这些页面图片仅供参考（借鉴其版式、风格与内容结构），不要嵌入页面。\n`
        : '';
      let body: string;
      if (!text) body = '（无法提取文字）';
      else if (text.length <= Math.min(INLINE_CHARS, inlineLeft) || !a.fileId) {
        body = text.slice(0, a.fileId ? text.length : 40_000);
        inlineLeft -= body.length;
      } else {
        body = `${text.slice(0, PREVIEW_CHARS)}\n……（全文共 ${text.length} 字符，这里只显示开头；请用 read_text / search_files${a.fileType === 'html' ? ' / read_raw' : ''} 等工具按需读取）`;
      }
      return `${i + 1}. 文件「${a.filename}」${idTag}${pages ? '，' : ''}${pages}文字内容如下：\n<<<\n${body}\n>>>`;
    })
    .join('\n\n');
}

const TOOLS_NOTE = `

【只读文件工具】你可以调用工具读取上面列出的参考文件（全部只读，无法修改）：list_files 列出文件；read_text 分段或按页读取文字；read_raw 读取 HTML 等文本文件源码；search_files 搜索关键词；view_page 查看某一页的图片；list_archive / read_archive_entry 查看原始 PPTX/DOCX 内部（幻灯片 XML、演讲者备注、主题配色与字体、媒体图片）。
- 文件较大时请先搜索或按页读取关键内容，不要逐段读完整个文件；每次可并行调用多个工具。
- 信息足够后直接输出最终结果，最终回答仍然只包含一个 \`\`\`html 代码块。`;

const toolsNote = (assets: AssetRef[]) => (assets.some((a) => a.fileId) ? TOOLS_NOTE : '');

function imageParts(assets: AssetRef[], plan: ImagePlan): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const a of assets) {
    if (plan.images.has(a.id)) {
      parts.push(
        { type: 'text', text: a.role === 'reference' ? `参考图「${a.filename}」（仅供参考）：` : `素材图片「${a.filename}」（URL: ${a.url}）：` },
        { type: 'image_url', image_url: { url: a.dataUrl! } },
      );
    }
    const n = plan.slides.get(a.id) ?? 0;
    for (const s of (a.slides ?? []).slice(0, n)) {
      if (!s.dataUrl) continue;
      parts.push({ type: 'text', text: `「${a.filename}」第 ${s.page} 页：` }, { type: 'image_url', image_url: { url: s.dataUrl } });
    }
  }
  return parts;
}

const hasReferences = (assets: AssetRef[]) => assets.some((a) => a.role === 'reference' || a.slides?.length);

const RULES = (doc: Pick<DeckDoc, 'width' | 'height'>, output: 'tools' | 'rewrite') => `
【硬性技术规范 —— 必须严格遵守】
1. 材料以“页”为单位。每一页是一个 <section class="slide"> 元素，所有页面依次直接放在 <body> 下，不能嵌套。
2. 每页画幅固定为 ${doc.width}×${doc.height} 像素（${doc.width > doc.height ? '横向' : doc.width < doc.height ? '竖向' : '方形'}）。所有内容必须完全容纳在页面内，禁止溢出、禁止滚动，字号与留白要按这个像素尺寸设计（正文通常 28–40px，标题 56–110px）。
3. 页面尺寸、定位基础已由系统提供（.slide 已设置 width/height/position:relative/overflow:hidden），你不需要也不要修改 .slide 的宽高。
4. 所有样式写在 <head> 中唯一的一个 <style> 内，使用语义化的 class（例如 .cover-title、.kpi-card），尽量少用内联 style。可使用 CSS 变量定义主题色。
5. 禁止使用 <script>、<iframe>、外部 JS。图表请用内联 <svg> 或纯 CSS 实现。
6. 字体使用系统字体栈，例如 "PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Helvetica Neue",Arial,sans-serif；如确需网络字体，只能通过 <link rel="stylesheet"> 引入 Google Fonts。
7. 图片：只能使用用户提供的素材 URL（见素材列表），或使用 CSS 渐变、内联 SVG 图形、emoji/图标字符做装饰。禁止编造外部图片链接。
8. 不要使用 position:fixed，不要依赖视口单位（vw/vh），一律使用 px 或 %。材料需要导出为 PDF/PPT，因此不要使用 background-clip:text 渐变文字和 mix-blend-mode（导出时会出现瑕疵），强调文字请用纯色、text-shadow 或色块背景。
9. 已有元素上的 data-eid 与 data-page-id 属性是系统用于追踪修改历史的标识，修改时必须原样保留在对应元素上；新增元素不需要添加 data-eid。
10. ${
  output === 'tools'
    ? '本次通过工具直接修改已载入的草稿，不要在回复中输出 HTML 代码块；全部修改完成后，用一两句话说明做了哪些修改。'
    : '输出内容只包含一个 ```html 代码块，不要输出任何解释文字。'
}`;

/** How the model delivers its work: a complete HTML block, or edits made with the draft tools. */
export type EditMode = 'tools' | 'rewrite';

const SYSTEM = (doc: Pick<DeckDoc, 'width' | 'height'>, output: EditMode = 'rewrite') =>
  `你是一名顶级的演示文稿视觉设计师兼前端工程师，擅长制作投资路演、产品发布、商业汇报类的 HTML 演示材料。你的作品层次清晰、排版精致、配色专业，信息密度适中，适合投屏和打印。
${RULES(doc, output)}`;

/** Larger documents are listed page by page instead of sent in full; the model reads what it needs. */
const INLINE_DOC_CHARS = 60_000;

const TOOL_GUIDE = (scope: EditScope) => `【修改方式】
草稿已载入为当前内容，请用工具直接修改，只改与要求相关的部分，不要重新输出整份 HTML：
- 改文字、样式、属性，增删元素：edit_elements（用 data-eid 精确指定${scope === 'element' ? '，选中元素见上' : ''}，也可用 selector / contains；一次可改多个元素）
- 改样式规则或主题色：find_css 查找，edit_css 修改（CSS 变量在 :root 中）${scope === 'global' ? '' : '；共享样式只读，本页的样式请用内联 style 或新的 class'}
- 多处相同文字：replace_in_draft（all_pages=true 时所有可修改页面一起替换）
- ${scope === 'global' ? '增删、复制、移动页面：insert_page / delete_page / duplicate_page / move_page；' : '本页内容过多时可用 rewrite_page 拆成多页，或用 insert_page 在后面加页；'}只有需要重新设计整页时才用 rewrite_page
- 修改后可用 render_pages 查看效果
全部完成后用一两句话说明做了哪些修改。`;

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
  const plan = planImages(assets, CREATE_BUDGET);
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
- 每页右下角或页脚包含统一的页码/品牌区域。${
    hasReferences(assets)
      ? '\n- 用户上传了参考图片/参考 PPT：请仔细观察这些页面的视觉风格（配色、字体气质、版式结构、装饰元素、信息层级），让模板在整体风格上与之贴近，同时满足上面的技术规范；不要直接嵌入参考截图。'
      : ''
  }

【可用素材】
${assetsBlock(assets, plan)}${toolsNote(assets)}`;
  return [
    { role: 'system', content: SYSTEM(doc) },
    { role: 'user', content: [{ type: 'text', text }, ...imageParts(assets, plan)] },
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
  const plan = planImages(assets, CREATE_BUDGET);
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
${assetsBlock(assets, plan)}

${templateBlock}

【制作要求】
- 内容组织要有路演逻辑（如：痛点→方案→产品→市场→商业模式→竞争→团队→财务→融资计划），但以用户提供的内容为准，不要编造关键事实数据；缺少数据时用合理的定性表述或明显的占位提示。
- 每页一个核心观点，标题提炼结论；数据用 KPI 卡片或 SVG 图表可视化。
- 用户提供的可嵌入图片素材应在合适的页面中使用。${
    hasReferences(assets)
      ? '\n- 用户上传了参考图片/参考 PPT 页面：请从中提取内容要点、数据和页面结构作为依据（例如沿用其章节顺序和关键信息），视觉样式仍以所选模板为准；不要直接嵌入这些参考截图。'
      : ''
  }${toolsNote(assets)}`;
  return [
    { role: 'system', content: SYSTEM(doc) },
    { role: 'user', content: [{ type: 'text', text }, ...imageParts(assets, plan)] },
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
  /** Files attached to this particular edit request (with image data). */
  attachments?: AssetRef[];
}

export function buildEditPrompt(
  doc: DeckDoc,
  req: EditRequest,
  assets: AssetRef[],
  kind: 'template' | 'deck',
  mode: EditMode = 'rewrite',
): ChatMessage[] {
  const tools = mode === 'tools';
  const what = kind === 'template' ? '路演模板' : '路演材料';
  const parts: ContentPart[] = [];
  const attachments = req.attachments ?? [];
  const plan = planImages(attachments, EDIT_BUDGET);
  const attachBlock = attachments.length
    ? `\n\n【本次修改附带的参考文件】（用户随这次修改上传，请结合修改要求使用：可嵌入的图片可以用 <img> 放进页面；参考图和 PPT/PDF 页面截图用于借鉴风格、版式或内容，不要直接嵌入）\n${assetsBlock(attachments, plan)}`
    : '';
  let text: string;
  if (req.scope === 'global') {
    text = `下面是当前的${what}（共 ${doc.pages.length} 页）。用户要求对【整份材料】进行调整。

【修改要求】
${req.prompt}${attachBlock}

${docBlock(doc, tools)}

【可用素材】
${assetsBlock(assets)}

${
      tools
        ? TOOL_GUIDE('global')
        : '请输出修改后的【完整 HTML 文档】（包含全部页面，未涉及修改的页面保持原样，所有已有 data-eid / data-page-id 属性保留）。如用户要求增删页面，可以增删 <section class="slide">。'
    }${toolsNote([...assets, ...attachments])}`;
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
${req.prompt}${attachBlock}

【全局样式（${tools ? '共享，只读' : '只读参考，不要整体输出'}）】
\`\`\`css
${doc.css}
\`\`\`

【第 ${n} 页当前 HTML】
\`\`\`html
${req.pageHtml}
\`\`\`

【可用素材】
${assetsBlock(assets)}

${
      tools
        ? `本次只能修改草稿第 ${n} 页${
            req.scope === 'element' && req.elements?.length ? `，选中元素的 data-eid：${req.elements.map((e) => e.eid).join('、')}（edit_elements 传 eids）` : ''
          }。\n${TOOL_GUIDE(req.scope)}`
        : `【输出格式】
只输出修改后的第 ${n} 页 <section class="slide" ...> 完整元素（保留 data-page-id 与所有已有 data-eid）。如果用户明确要求把这一页拆分成多页，可以连续输出多个 <section>。如需新增 CSS 规则，可在 section 之前附加一个 <style> 块，其中只写新增规则，它会被追加到全局样式中；不要重复输出已有的全局样式。全部放在一个 \`\`\`html 代码块中。`
    }${toolsNote([...assets, ...attachments])}`;
    if (req.screenshot) {
      parts.push({ type: 'text', text: `第 ${n} 页当前渲染截图${req.scope === 'element' ? '（红框为选中元素）' : ''}：` });
      parts.push({ type: 'image_url', image_url: { url: req.screenshot } });
    }
  }
  return [
    { role: 'system', content: SYSTEM(doc, mode) },
    { role: 'user', content: [{ type: 'text', text }, ...parts, ...imageParts(attachments, plan)] },
  ];
}

function docBlock(doc: DeckDoc, tools: boolean): string {
  const full = assembleHtml(doc);
  if (!tools || full.length <= INLINE_DOC_CHARS) return `【当前完整 HTML】\n\`\`\`html\n${full}\n\`\`\``;
  const outline = doc.pages.map((p, i) => `第 ${i + 1} 页：${pageText(p).split('\n')[0]?.slice(0, 40) ?? ''}`).join('\n');
  return `【页面目录】（材料较长，未附上全部源码：请用 read_draft、find_elements、find_css 查看需要修改的部分）\n${outline}`;
}
