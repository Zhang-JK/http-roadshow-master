import fs from 'node:fs';
import JSZip from 'jszip';
import { assetPath, fileType, isRawTextFile, isZipFile, slideAssets, type AssetRow } from './assets.js';
import type { DB } from './db.js';

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolOutput {
  content: string;
  /** Images are not allowed in tool messages; the caller forwards them as a follow-up user message. */
  images?: { label: string; url: string }[];
}

export interface FileTools {
  defs: ToolDef[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolOutput>;
}

const DEFAULT_CHARS = 8000;
const MAX_CHARS = 30_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_ENTRY = /\.(png|jpe?g|gif|webp)$/i;
const TEXT_ENTRY = /\.(xml|rels|txt|json|html?|css|csv|md|svg)$/i;

const str = { type: 'string' } as const;
const int = { type: 'integer' } as const;
const fileIdParam = { type: 'string', description: '文件编号，如 F1（见 list_files 或提示中的文件列表）' };

export const FILE_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出本次可读取的全部参考文件（只读）：编号、文件名、类型、页数、文字长度、是否可读取原始内容/压缩包结构。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_text',
      description:
        '读取文件提取出的纯文字（PPT/PDF/Word/HTML/文本）。指定 page 读取某一页的文字；否则按字符偏移分段读取全文，返回中会提示下一段的 offset。',
      parameters: {
        type: 'object',
        properties: { file_id: fileIdParam, page: { ...int, description: '页码，从 1 开始（可选）' }, offset: int, max_chars: { ...int, description: `默认 ${DEFAULT_CHARS}，最大 ${MAX_CHARS}` } },
        required: ['file_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_raw',
      description: '分段读取文本类文件的原始内容（HTML 源码、Markdown、CSV、JSON、XML 等），可用于查看参考 HTML 的结构与 CSS。',
      parameters: { type: 'object', properties: { file_id: fileIdParam, offset: int, max_chars: int }, required: ['file_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在参考文件的文字（含每页文字）和文本类文件原始内容中搜索关键词（不区分大小写），返回匹配片段及所在页码/偏移。',
      parameters: {
        type: 'object',
        properties: { query: { ...str, description: '要搜索的关键词' }, file_id: { ...fileIdParam, description: '只在该文件中搜索（可选）' }, max_results: int },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_page',
      description: '查看文件某一页的渲染图片及该页文字（PPT/PDF/Word/HTML 已逐页导出为图片；图片文件 page=1 即原图）。图片会紧随工具结果提供给你。',
      parameters: { type: 'object', properties: { file_id: fileIdParam, page: int }, required: ['file_id', 'page'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_archive',
      description:
        '列出原始 PPTX/DOCX/ODP 等压缩包内的文件结构（如 ppt/slides/slide1.xml、ppt/notesSlides/、ppt/media/ 图片、ppt/theme/theme1.xml 配色字体）。',
      parameters: { type: 'object', properties: { file_id: fileIdParam, path_prefix: { ...str, description: '只列出该前缀下的条目（可选）' } }, required: ['file_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_archive_entry',
      description: '读取原始 PPTX/DOCX 压缩包内某个条目：XML/文本分段返回内容；PNG/JPEG/GIF/WebP 图片会作为图片提供给你。',
      parameters: { type: 'object', properties: { file_id: fileIdParam, path: str, offset: int, max_chars: int }, required: ['file_id', 'path'] },
    },
  },
];

export function sliceText(text: string, offset: unknown, maxChars: unknown, header: string): string {
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const len = Math.min(MAX_CHARS, Math.max(200, Math.floor(Number(maxChars) || DEFAULT_CHARS)));
  const part = text.slice(start, start + len);
  const end = start + part.length;
  const more = end < text.length ? `\n…（未读完，共 ${text.length} 字符；继续读取请使用 offset=${end}）` : '\n（已到结尾）';
  return `${header}［字符 ${start}–${end} / ${text.length}］\n${part}${more}`;
}

/** File ids shown to the model: F1, F2, … in the given order. */
export function assignFileIds(rows: AssetRow[]): Map<string, AssetRow> {
  return new Map(rows.map((r, i) => [`F${i + 1}`, r]));
}

/**
 * Read-only access to the given uploads. The model can only reach these rows (never arbitrary paths),
 * and nothing here writes to disk or the database.
 */
export function createFileTools(db: DB, files: Map<string, AssetRow>): FileTools {
  const zips = new Map<string, Promise<JSZip>>();
  const pagesOf = (r: AssetRow) => (r.kind === 'document' ? slideAssets(db, r.id) : []);
  const rawText = (r: AssetRow) => fs.readFileSync(assetPath(r.id), 'utf8');
  const zipOf = (r: AssetRow) => {
    if (!zips.has(r.id)) zips.set(r.id, JSZip.loadAsync(fs.readFileSync(assetPath(r.id))));
    return zips.get(r.id)!;
  };
  const label = (id: string, r: AssetRow) => `${id}「${r.filename}」`;
  const dataUrl = (mime: string, buf: Buffer) => `data:${mime};base64,${buf.toString('base64')}`;

  const pick = (args: Record<string, unknown>) => {
    const id = String(args.file_id ?? '').trim().toUpperCase();
    const r = files.get(id);
    if (!r) throw new Error(`没有编号为 ${args.file_id} 的文件，可用编号：${[...files.keys()].join('、') || '（无）'}`);
    return { id, r };
  };

  const tools: Record<string, (args: Record<string, unknown>) => Promise<ToolOutput>> = {
    async list_files() {
      const list = [...files].map(([id, r]) => {
        const pages = pagesOf(r).length;
        return {
          file_id: id,
          name: r.filename,
          type: fileType(r),
          role: r.kind === 'image' ? (r.role === 'reference' ? '仅参考' : '可嵌入页面') : '参考',
          size_bytes: r.size,
          pages: r.kind === 'image' ? 1 : pages,
          text_chars: r.extracted_text?.length ?? 0,
          raw_readable: r.kind === 'document' && isRawTextFile(r.filename, r.mime),
          archive: r.kind === 'document' && isZipFile(r.filename),
          ...(r.kind === 'image' && r.role !== 'reference' ? { url: `/api/assets/${r.id}` } : {}),
        };
      });
      return { content: JSON.stringify(list, null, 1) };
    },

    async read_text(args) {
      const { id, r } = pick(args);
      if (args.page !== undefined && args.page !== null) {
        const pages = pagesOf(r);
        const n = Math.floor(Number(args.page));
        const p = pages[n - 1];
        if (!p) throw new Error(`${label(id, r)} 共 ${pages.length} 页，没有第 ${args.page} 页`);
        return { content: sliceText(p.extracted_text ?? '（该页没有可提取的文字）', args.offset, args.max_chars, `${label(id, r)} 第 ${n} 页文字`) };
      }
      if (!r.extracted_text) throw new Error(`${label(id, r)} 没有提取到文字${r.kind === 'image' ? '（图片文件请使用 view_page）' : ''}`);
      return { content: sliceText(r.extracted_text, args.offset, args.max_chars, `${label(id, r)} 文字`) };
    },

    async read_raw(args) {
      const { id, r } = pick(args);
      if (r.kind !== 'document' || !isRawTextFile(r.filename, r.mime)) {
        throw new Error(`${label(id, r)} 不是文本类文件，无法读取原始内容${isZipFile(r.filename) ? '；PPTX/DOCX 请使用 list_archive / read_archive_entry' : ''}`);
      }
      return { content: sliceText(rawText(r), args.offset, args.max_chars, `${label(id, r)} 原始内容`) };
    },

    async search_files(args) {
      const q = String(args.query ?? '').trim().toLowerCase();
      if (!q) throw new Error('请提供搜索关键词');
      const max = Math.min(50, Math.max(1, Math.floor(Number(args.max_results) || 20)));
      const targets = args.file_id ? [pick(args)] : [...files].map(([id, r]) => ({ id, r }));
      const hits: string[] = [];
      const scan = (text: string, where: string) => {
        const lower = text.toLowerCase();
        for (let i = lower.indexOf(q); i >= 0 && hits.length < max; i = lower.indexOf(q, i + q.length)) {
          const snippet = text.slice(Math.max(0, i - 80), i + q.length + 80).replace(/\s+/g, ' ');
          hits.push(`${where}（偏移 ${i}）：…${snippet}…`);
        }
      };
      for (const { id, r } of targets) {
        const pages = pagesOf(r);
        if (pages.some((p) => p.extracted_text)) pages.forEach((p, i) => p.extracted_text && scan(p.extracted_text, `${label(id, r)} 第 ${i + 1} 页`));
        else if (r.extracted_text) scan(r.extracted_text, `${label(id, r)} 文字`);
        if (r.kind === 'document' && isRawTextFile(r.filename, r.mime)) scan(rawText(r), `${label(id, r)} 原始内容`);
        if (hits.length >= max) break;
      }
      return { content: hits.length ? `找到 ${hits.length} 处匹配${hits.length >= max ? '（已达上限）' : ''}：\n${hits.join('\n')}` : `没有找到“${args.query}”` };
    },

    async view_page(args) {
      const { id, r } = pick(args);
      const n = Math.floor(Number(args.page) || 1);
      if (r.kind === 'image') {
        if (n !== 1) throw new Error(`${label(id, r)} 是图片，只有第 1 页`);
        return {
          content: `${label(id, r)} 原图见下一条消息。`,
          images: [{ label: `${label(id, r)}`, url: dataUrl(r.mime, fs.readFileSync(assetPath(r.id))) }],
        };
      }
      const pages = pagesOf(r);
      const p = pages[n - 1];
      if (!p) throw new Error(pages.length ? `${label(id, r)} 共 ${pages.length} 页，没有第 ${n} 页` : `${label(id, r)} 没有导出页面图片`);
      return {
        content: `${label(id, r)} 第 ${n}/${pages.length} 页，图片见下一条消息。该页文字：\n${p.extracted_text ?? '（无）'}`,
        images: [{ label: `${label(id, r)} 第 ${n} 页`, url: dataUrl('image/jpeg', fs.readFileSync(assetPath(p.id))) }],
      };
    },

    async list_archive(args) {
      const { id, r } = pick(args);
      if (r.kind !== 'document' || !isZipFile(r.filename)) throw new Error(`${label(id, r)} 不是 PPTX/DOCX/ODP 等压缩包格式`);
      const zip = await zipOf(r);
      const prefix = String(args.path_prefix ?? '');
      const entries = Object.values(zip.files)
        .filter((f) => !f.dir && f.name.startsWith(prefix))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const shown = entries.slice(0, 300).map((f) => {
        const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
        return size !== undefined ? `${f.name}  (${size} B)` : f.name;
      });
      return { content: `${label(id, r)} 共 ${entries.length} 个条目${entries.length > 300 ? '（仅列出前 300 个，可用 path_prefix 缩小范围）' : ''}：\n${shown.join('\n')}` };
    },

    async read_archive_entry(args) {
      const { id, r } = pick(args);
      if (r.kind !== 'document' || !isZipFile(r.filename)) throw new Error(`${label(id, r)} 不是 PPTX/DOCX/ODP 等压缩包格式`);
      const zip = await zipOf(r);
      const name = String(args.path ?? '').replace(/^\/+/, '');
      const entry = zip.file(name);
      if (!entry) throw new Error(`${label(id, r)} 中没有条目 ${name}，请先用 list_archive 查看`);
      if (IMAGE_ENTRY.test(name)) {
        const buf = await entry.async('nodebuffer');
        if (buf.length > MAX_IMAGE_BYTES) throw new Error(`${name} 过大（${buf.length} B），无法查看`);
        const ext = name.split('.').pop()!.toLowerCase();
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
        return { content: `${label(id, r)} 中的图片 ${name}（${buf.length} B）见下一条消息。`, images: [{ label: `${label(id, r)} ${name}`, url: dataUrl(mime, buf) }] };
      }
      if (!TEXT_ENTRY.test(name)) throw new Error(`${name} 是二进制文件，无法以文字读取`);
      return { content: sliceText(await entry.async('string'), args.offset, args.max_chars, `${label(id, r)} ${name}`) };
    },
  };

  return {
    defs: FILE_TOOL_DEFS,
    async execute(name, args) {
      const fn = tools[name];
      if (!fn) return { content: `错误：没有名为 ${name} 的工具。可用工具：${Object.keys(tools).join('、')}（全部为只读）` };
      try {
        return await fn(args ?? {});
      } catch (e) {
        return { content: `错误：${(e as Error).message}` };
      }
    },
  };
}
