/**
 * Delivery check: the project is put together exactly as it is exported (README.md, index.html linking
 * styles/*.css with every page, standalone pages/*.html) and loaded in headless Chrome, plus static
 * checks of the README, the style files and the page sources. Errors go back to the model.
 */
import postcss from 'postcss';
import type { DB } from './db.js';
import { bundleFiles } from './bundle.js';
import type { DeckDoc } from './deck.js';
import { cssFiles, nameFiles, README, readmeBody } from './files.js';
import { withContext } from './render.js';

export interface ProjectIssue {
  severity: 'error' | 'warning';
  file: string;
  message: string;
}

export interface CheckInput {
  /** The draft as it would be saved. */
  doc: DeckDoc;
  /** Page sources as the model wrote them (before scripts are stripped), by file. */
  sources: { file: string; html: string }[];
  /** Files the model may change in this job; problems elsewhere are not reported. */
  canEdit: (file: string) => boolean;
  /** Whether README problems are errors (the model owns the whole project) or only warnings. */
  strictReadme: boolean;
}

const README_SECTIONS: [string, string][] = [
  ['需求', '用户的需求：用途、受众、内容要点'],
  ['风格约定', '配色（色值）、字体、版式与组件约定'],
  ['页面规划', '逐页一行：pages/文件名.html ｜ 版式 ｜ 标题 ｜ 要点'],
];

function section(md: string, title: string): string | undefined {
  const m = md.match(new RegExp(`^##\\s*${title}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm'));
  return m?.[1];
}

function checkReadme(input: CheckInput, add: (i: ProjectIssue) => void) {
  const severity = input.strictReadme ? 'error' : 'warning';
  const body = readmeBody(input.doc.readme ?? '');
  if (!body.trim()) {
    add({ severity: 'error', file: README, message: `README.md 为空。它是项目的生成说明，后续每次修改都会先读它；请写入「## 需求」「## 风格约定」「## 页面规划」三节` });
    return;
  }
  for (const [title, hint] of README_SECTIONS) {
    if (section(body, title) === undefined) add({ severity, file: README, message: `缺少「## ${title}」一节（${hint}）` });
  }
  const plan = section(body, '页面规划');
  if (plan === undefined) return;
  const planned = [...new Set(plan.match(/pages\/[A-Za-z0-9][\w.-]*\.html/g) ?? [])];
  const files = nameFiles(input.doc.pages).map((p) => p.file!);
  const missing = planned.filter((p) => !files.includes(p));
  const unlisted = files.filter((f) => !planned.includes(f));
  if (missing.length) add({ severity, file: README, message: `「页面规划」列出的 ${missing.join('、')} 不存在：页面已删除或改名时请同步更新 README` });
  if (unlisted.length) add({ severity, file: README, message: `「页面规划」没有列出 ${unlisted.join('、')}：新增或拆分页面后请把它们按顺序补进页面规划` });
}

const BALANCED_TAGS = ['div', 'section', 'span', 'a', 'ul', 'ol', 'table', 'svg', 'g', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'footer', 'main', 'article', 'aside', 'nav', 'figure', 'button', 'strong', 'em', 'b', 'i'];

/** Elements opened and closed a different number of times (the parser silently re-nests them). */
export function unbalancedTags(html: string): string[] {
  const src = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, '');
  const count = new Map<string, number>();
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
    const tag = m[2].toLowerCase();
    if (!BALANCED_TAGS.includes(tag) || m[3]) continue;
    count.set(tag, (count.get(tag) ?? 0) + (m[1] ? -1 : 1));
  }
  return [...count].filter(([, n]) => n !== 0).map(([tag, n]) => `<${tag}> ${n > 0 ? `多了 ${n} 个开标签（缺少 </${tag}>）` : `多了 ${-n} 个闭标签`}`);
}

function checkPages(input: CheckInput, add: (i: ProjectIssue) => void) {
  for (const { file, html } of input.sources) {
    if (!input.canEdit(file)) continue;
    const js = [
      /<script\b/i.test(html) && '<script>',
      /<(iframe|object|embed)\b/i.test(html) && '<iframe>/<object>',
      /\son[a-z]+\s*=/i.test(html) && '事件属性（onclick 等）',
      /(href|src)\s*=\s*["']?\s*javascript:/i.test(html) && 'javascript: 链接',
    ].filter(Boolean);
    if (js.length) {
      add({
        severity: 'error',
        file,
        message: `包含 ${js.join('、')}：材料不运行 JavaScript（多人共享、导出 PDF/PPTX 时也无法执行），保存时会被移除。请删除它们，动效用 CSS 动画/过渡，图表用内联 SVG 或纯 CSS`,
      });
    }
    if (/<style\b/i.test(html)) add({ severity: 'warning', file, message: '页面内含 <style>：样式请放进 styles/ 下的样式文件，便于各页共用' });
  }
}

function checkStyles(input: CheckInput, add: (i: ProjectIssue) => void) {
  const files = cssFiles(input.doc.css);
  if (!files.length) {
    add({ severity: 'error', file: 'styles/', message: '没有任何样式文件：请用 write_file 写入 styles/theme.css（设计变量）与 styles/components.css（组件样式）' });
    return;
  }
  const defined = new Set<string>();
  for (const text of [input.doc.css, ...input.doc.pages.map((p) => p.html)]) for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  for (const f of files) {
    if (!input.canEdit(f.path)) continue;
    if (!f.css.trim()) {
      add({ severity: 'warning', file: f.path, message: '样式文件为空' });
      continue;
    }
    try {
      postcss.parse(f.css);
    } catch (e) {
      const err = e as { line?: number; reason?: string; message: string };
      add({ severity: 'error', file: f.path, message: `CSS 语法错误${err.line ? `（第 ${err.line} 行）` : ''}：${err.reason ?? err.message}` });
    }
    for (const m of f.css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) {
      if (!/^(https?:)?\/\//i.test(m[1])) {
        add({ severity: 'error', file: f.path, message: `@import ${m[1]}：样式文件之间不要互相 @import，index.html 和每个页面都会按顺序引用全部样式文件` });
      }
    }
    const undef = [...new Set([...f.css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]).filter((v) => !defined.has(v)))];
    if (undef.length) add({ severity: 'warning', file: f.path, message: `使用了未定义的 CSS 变量 ${undef.slice(0, 6).join('、')}${undef.length > 6 ? ' 等' : ''}（没有后备值时该属性无效）` });
  }
}

const ORIGIN = 'http://project.check';

interface Loaded {
  slides: number;
  size: { w: number; h: number } | null;
  sheets: { href: string; rules: number }[];
  brokenImages: string[];
}

/** Loads index.html and every page file from the bundle in Chrome and reports what does not work. */
async function checkInBrowser(db: DB | undefined, input: CheckInput, add: (i: ProjectIssue) => void) {
  const { doc } = input;
  const files = bundleFiles(db, doc, doc.readme ?? '');
  const pageFiles = nameFiles(doc.pages).map((p) => p.file!);
  const styleText = new Map(cssFiles(doc.css).map((f) => [f.path, f.css]));
  await withContext({ width: doc.width, height: doc.height }, async (context) => {
    let current = 'index.html';
    const missing = new Map<string, Set<string>>();
    const blame = (referer?: string) => {
      const from = referer?.startsWith(ORIGIN) ? referer.slice(ORIGIN.length + 1).split('?')[0] : '';
      return from.endsWith('.css') ? from : current;
    };
    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = req.url();
      if (url.startsWith('data:')) return route.continue();
      if (!url.startsWith(`${ORIGIN}/`)) {
        return route.continue().catch(() => {});
      }
      const path = decodeURIComponent(url.slice(ORIGIN.length + 1).split(/[?#]/)[0]);
      const body = files.get(path);
      if (body === undefined) {
        const who = blame(req.headers().referer);
        if (!missing.has(who)) missing.set(who, new Set());
        missing.get(who)!.add(path);
        return route.fulfill({ status: 404, body: 'not found' });
      }
      const type = path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : undefined;
      return route.fulfill({ status: 200, body, contentType: type });
    });
    const failedExternal = new Set<string>();
    context.on('requestfailed', (req) => {
      if (!req.url().startsWith(ORIGIN) && !req.url().startsWith('data:')) failedExternal.add(req.url().slice(0, 120));
    });
    const page = await context.newPage();
    const jsErrors: string[] = [];
    page.on('pageerror', (e) => jsErrors.push(`${current}：${e.message.slice(0, 200)}`));
    const load = async (path: string): Promise<Loaded | null> => {
      current = path;
      try {
        await page.goto(`${ORIGIN}/${path}`, { waitUntil: 'load', timeout: 20_000 });
      } catch (e) {
        add({ severity: 'error', file: path, message: `无法在浏览器中打开：${(e as Error).message.split('\n')[0]}` });
        return null;
      }
      return page.evaluate(() => {
        const slides = [...document.querySelectorAll('section.slide')];
        const r = slides[0]?.getBoundingClientRect();
        const sheets = [...document.styleSheets]
          .filter((s) => s.href)
          .map((s) => {
            let rules = -1;
            try {
              rules = s.cssRules.length;
            } catch {
              /* unreadable */
            }
            return { href: new URL(s.href!).pathname.slice(1), rules };
          });
        const brokenImages = [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => (i.getAttribute('src') ?? '').slice(0, 100));
        return { slides: slides.length, size: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null, sheets, brokenImages };
      });
    };

    const index = await load('index.html');
    if (index) {
      if (index.slides !== pageFiles.length) {
        add({ severity: 'error', file: 'index.html', message: `浏览器中只渲染出 ${index.slides} 个 section.slide，应为 ${pageFiles.length} 页：检查页面文件的 <section class="slide"> 与标签嵌套` });
      }
      if (index.size && (Math.abs(index.size.w - doc.width) > 2 || Math.abs(index.size.h - doc.height) > 2)) {
        add({
          severity: 'error',
          file: 'index.html',
          message: `页面尺寸为 ${index.size.w}×${index.size.h}，应为 ${doc.width}×${doc.height}：样式中不要覆盖 .slide 的 width / height / transform`,
        });
      }
      for (const s of index.sheets) {
        if (s.rules === 0 && (styleText.get(s.href) ?? '').trim() && input.canEdit(s.href)) {
          add({ severity: 'error', file: s.href, message: '浏览器没有从这个样式文件中解析出任何规则（语法错误，或内容不是 CSS）' });
        }
      }
    }
    for (const f of pageFiles) {
      const r = await load(f);
      if (!r || !input.canEdit(f)) continue;
      if (r.slides !== 1) add({ severity: 'error', file: f, message: `单独打开时有 ${r.slides} 个 section.slide，每个页面文件应正好包含一个` });
      if (r.brokenImages.length) add({ severity: 'error', file: f, message: `图片无法加载：${r.brokenImages.slice(0, 4).join('、')}（只能使用提示中提供的素材地址或 data: URI）` });
    }
    for (const [who, paths] of missing) {
      const list = [...paths].map((p) => (p.startsWith('api/assets/') ? `/${p}（素材不存在）` : p));
      if (who === 'index.html' || input.canEdit(who)) add({ severity: 'error', file: who, message: `引用的文件不存在：${list.slice(0, 5).join('、')}` });
    }
    for (const e of [...new Set(jsErrors)].slice(0, 5)) add({ severity: 'error', file: e.split('：')[0], message: `脚本错误：${e.slice(e.indexOf('：') + 1)}` });
    if (failedExternal.size) {
      add({
        severity: 'warning',
        file: 'styles/',
        message: `外部资源加载失败：${[...failedExternal].slice(0, 3).join('、')}。离线部署时无法使用外部字体/图片，请确保有本地后备（如系统字体栈）`,
      });
    }
  });
}

export async function checkProject(db: DB | undefined, input: CheckInput): Promise<ProjectIssue[]> {
  const issues: ProjectIssue[] = [];
  const add = (i: ProjectIssue) => issues.push(i);
  checkReadme(input, add);
  checkStyles(input, add);
  checkPages(input, add);
  await checkInBrowser(db, input, add);
  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

export function formatProjectReport(doc: DeckDoc, issues: ProjectIssue[]): string {
  const styles = cssFiles(doc.css).length;
  const scope = `已组装 README.md、index.html、${styles} 个样式文件和 ${doc.pages.length} 个页面文件并在浏览器中加载`;
  if (!issues.length) return `${scope}：交付检查通过。`;
  const errors = issues.filter((i) => i.severity === 'error').length;
  const lines = issues.map((i) => `${i.severity === 'error' ? '✗' : '△'} ${i.file}：${i.message}`);
  return `${scope}，发现 ✗ 错误 ${errors} 处、△ 提醒 ${issues.length - errors} 处：\n${lines.join('\n')}`;
}
