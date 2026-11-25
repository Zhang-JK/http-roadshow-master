/**
 * Whole-deck edits split up by the editing model: edit_pages_in_parallel hands groups of pages to
 * sub-agents that rewrite them at the same time, each in its own conversation with the README and
 * the styles as the contract. Every group is tried again on its own when its call fails, and a group
 * that still fails leaves its pages as they were without holding up the others. When all are done the
 * coordinating model gets a report with thumbnails and the layout check of every page the round
 * changed, reviews them all and sends the next round (or fixes small things itself). The same tool
 * serves the coordinator in the self-check and the delivery-check fixes.
 */
import type { DeckDoc } from './deck.js';
import { formatReport, type Draft } from './draft.js';
import { inspectLayout, renderContactSheets } from './render.js';
import type { FileTools, ToolDef, ToolOutput } from './fileTools.js';
import { ADDITIONS_CSS, checkPath, cssFiles, nameFiles, parseFileBlocks } from './files.js';
import { PAGE_BATCH_TRIES, PAGE_REVIEW_ROUNDS, type PageLook } from './generate.js';
import type { ChatMessage, ChatResult, ContentPart } from './llm.js';
import { buildGroupEditPrompt, pageReviewNote, type AssetRef } from './prompts.js';

export const PARALLEL_EDIT_TOOL = 'edit_pages_in_parallel';
const MAX_GROUPS = 16;
const MAX_GROUP_PAGES = 6;

/** Thumbnails per contact sheet returned to the coordinator after a round. */
const OVERVIEW_PER_SHEET = 12;

export interface ParallelEditDeps {
  /** When given, a finished round comes back with thumbnails and the layout check of the pages it changed. */
  resolver?: (html: string) => string;
  /** One sub-agent call; 'review' continues a group's conversation with how its pages rendered. */
  call: (messages: ChatMessage[], stage: string, step: 'pages' | 'review') => Promise<ChatResult>;
  /** Renders pages (one look per page in order); when given, each group checks its rendered pages. */
  lookAt?: (doc: DeckDoc) => Promise<PageLook[]>;
  onStage?: (stage: string) => void;
  /** Groups worked on at the same time. */
  parallel: number;
  /** Pause before a failed group is tried again; doubles with each try. */
  retryDelayMs?: number;
}

export interface ParallelEditContext {
  request: string;
  kind: 'template' | 'deck';
  assets: AssetRef[];
}

interface Group {
  no: number;
  files: string[];
  instructions: string;
}

interface GroupResult {
  changed: Set<string>;
  added: string[];
  css: boolean;
  reviews: number;
  tries: number;
  error?: string;
}

function toolDef(parallel: number): ToolDef {
  return {
    type: 'function',
    function: {
      name: PARALLEL_EDIT_TOOL,
      description: `把整份修改拆成几组页面，交给多个子任务同时修改（同时进行 ${parallel} 组，多出的排队）。每个子任务看到修改要求、你写的本组任务、README、共享样式与本组页面源码，只能改写本组页面、在本组最后一页之后新增页面、向 ${ADDITIONS_CSS} 追加规则；结果直接写入草稿，工具返回每组改了哪些文件。适合要逐页改写很多页的修改；README、共享样式和页面的增删、排序请先自己改好。各组页面不能重复，每组最多 ${MAX_GROUP_PAGES} 页。某组失败（已自动重试）时这组页面保持原样，可以再派一次或自己修改。`,
      parameters: {
        type: 'object',
        properties: {
          groups: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_GROUPS,
            items: {
              type: 'object',
              properties: {
                pages: {
                  type: 'array',
                  minItems: 1,
                  maxItems: MAX_GROUP_PAGES,
                  items: { type: 'string' },
                  description: '本组的页面文件路径 pages/名称.html（也可以写页码，如 "3"）',
                },
                instructions: { type: 'string', description: '这组页面要怎么改：每页的内容、数据、版式与风格要求，以及要与其他页面保持一致的地方' },
              },
              required: ['pages', 'instructions'],
            },
          },
        },
        required: ['groups'],
      },
    },
  };
}

/** The groups as asked for, by page file in deck order; throws with what to fix. */
function readGroups(draft: Draft, args: Record<string, unknown>): Group[] {
  const raw = args.groups;
  if (!Array.isArray(raw) || !raw.length) throw new Error('groups 至少要有一组');
  if (raw.length > MAX_GROUPS) throw new Error(`最多 ${MAX_GROUPS} 组`);
  const files = nameFiles(draft.view().pages).map((p) => p.file!);
  const seen = new Map<string, number>();
  return raw.map((g, i) => {
    const no = i + 1;
    const pages = (g as { pages?: unknown })?.pages;
    const instructions = (g as { instructions?: unknown })?.instructions;
    if (!Array.isArray(pages) || !pages.length) throw new Error(`第 ${no} 组没有 pages`);
    if (pages.length > MAX_GROUP_PAGES) throw new Error(`第 ${no} 组有 ${pages.length} 页，每组最多 ${MAX_GROUP_PAGES} 页；请分成更多组`);
    if (typeof instructions !== 'string' || !instructions.trim()) throw new Error(`第 ${no} 组缺少 instructions`);
    const mine = pages.map((p) => {
      let file: string | undefined;
      if (typeof p === 'number' || (typeof p === 'string' && /^\d+$/.test(p.trim()))) file = files[Number(p) - 1];
      else if (typeof p === 'string') {
        const c = checkPath(p);
        if (c.kind !== 'page') throw new Error(`第 ${no} 组：${c.path} 不是页面文件`);
        file = files.includes(c.path) ? c.path : undefined;
      }
      if (!file) throw new Error(`第 ${no} 组：草稿中没有页面 ${String(p)}（共 ${files.length} 页，用 read_draft 查看文件列表）`);
      const other = seen.get(file);
      if (other !== undefined && other !== no) throw new Error(`${file} 同时在第 ${other} 组和第 ${no} 组中；每页只能分到一组`);
      seen.set(file, no);
      return file;
    });
    return { no, files: files.filter((f) => mine.includes(f)), instructions: instructions.trim() };
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createParallelEditTools(draft: Draft, ctx: ParallelEditContext, deps: ParallelEditDeps): FileTools {
  const parallel = Math.max(1, deps.parallel);

  /** Writes a group's page files and style additions into the draft; returns the paths written. */
  function apply(group: Group, result: GroupResult, text: string, allowNew: boolean): number {
    let n = 0;
    for (const b of parseFileBlocks(text).filter((x) => x.complete)) {
      let c: ReturnType<typeof checkPath>;
      try {
        c = checkPath(b.path);
      } catch {
        continue;
      }
      try {
        if (c.kind === 'css' && c.path === ADDITIONS_CSS) {
          const old = cssFiles(draft.view().css).find((f) => f.path === ADDITIONS_CSS)?.css.trim();
          draft.writeFile(ADDITIONS_CSS, old ? `${old}\n${b.content.trim()}` : b.content.trim());
          result.css = true;
          n++;
        } else if (c.kind === 'page' && group.files.includes(c.path) && draft.pageOf(c.path)) {
          draft.writeFile(c.path, b.content);
          if (!result.added.includes(c.path)) result.changed.add(c.path);
          n++;
        } else if (c.kind === 'page' && allowNew && !draft.pageOf(c.path)) {
          const last = Math.max(...group.files.map((f) => draft.pageOf(f) ?? 0));
          draft.writeFile(c.path, b.content, last);
          group.files.push(c.path);
          result.added.push(c.path);
          n++;
        }
      } catch {
        /* a file without a usable <section> is left out; the others still count */
      }
    }
    return n;
  }

  /** The group's own conversation goes on with screenshots and the layout check of its pages. */
  async function review(group: Group, result: GroupResult, messages: ChatMessage[], reply: string, stage: string) {
    if (!deps.lookAt) return;
    let convo = messages;
    let last = reply;
    for (let round = 1; round <= PAGE_REVIEW_ROUNDS; round++) {
      const pages = nameFiles(draft.view().pages).filter((p) => group.files.includes(p.file!));
      if (!pages.length) return;
      let looks: PageLook[];
      try {
        looks = await deps.lookAt({ ...draft.view(), pages });
      } catch {
        return;
      }
      if (round > 1 && !looks.some((l) => l.issues.some((i) => i.severity === 'error'))) return;
      const parts: ContentPart[] = [{ type: 'text', text: pageReviewNote(pages.map((p, i) => ({ label: p.file!, issues: looks[i]?.issues ?? [] })), round, ctx.kind === 'deck') }];
      pages.forEach((p, i) => {
        const image = looks[i]?.image;
        if (image) parts.push({ type: 'text', text: `【${p.file}】` }, { type: 'image_url', image_url: { url: image } });
      });
      convo = [...convo, { role: 'assistant', content: last || '（无输出）' }, { role: 'user', content: parts }];
      let r: ChatResult;
      try {
        r = await deps.call(convo, `${stage}：检查渲染效果${round > 1 ? `（第 ${round} 轮）` : ''}`, 'review');
      } catch {
        return;
      }
      if (!apply(group, result, r.text, false)) return;
      result.reviews++;
      last = r.text;
    }
  }

  async function runGroup(group: Group, groups: Group[]): Promise<GroupResult> {
    const result: GroupResult = { changed: new Set(), added: [], css: false, reviews: 0, tries: 0 };
    const stage = `并行修改：第 ${group.no} 组（${group.files.length} 页）`;
    const messages = buildGroupEditPrompt(
      draft.view(),
      ctx.kind,
      {
        request: ctx.request,
        instructions: group.instructions,
        files: group.files,
        others: groups.filter((g) => g !== group).flatMap((g) => g.files),
        group: group.no,
        groups: groups.length,
      },
      ctx.assets,
    );
    let r: ChatResult;
    for (result.tries = 1; ; result.tries++) {
      try {
        r = await deps.call(messages, result.tries > 1 ? `${stage}（第 ${result.tries} 次尝试）` : stage, 'pages');
        break;
      } catch (e) {
        if (result.tries >= PAGE_BATCH_TRIES) {
          result.error = e instanceof Error ? e.message : String(e);
          return result;
        }
        await pause((deps.retryDelayMs ?? 0) * 2 ** (result.tries - 1));
      }
    }
    if (apply(group, result, r.text, true)) await review(group, result, messages, r.text, stage);
    else if (r.finishReason === 'length') result.error = '回复达到最大输出长度被截断，没有完整的页面文件（可以把这组拆小后再派一次）';
    return result;
  }

  async function execute(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
    if (name !== PARALLEL_EDIT_TOOL) throw new Error(`未知工具 ${name}`);
    let groups: Group[];
    try {
      groups = readGroups(draft, args);
    } catch (e) {
      return { content: `错误：${(e as Error).message}` };
    }
    const asked = groups.map((g) => [...g.files]);
    const results = new Map<Group, GroupResult>();
    const running = new Set<Group>();
    const report = () => {
      const now = [...running].map((g) => g.no).join('、');
      deps.onStage?.(`并行修改：第 ${now} 组${running.size > 1 ? '同时' : ''}进行（已完成 ${results.size}/${groups.length} 组）`);
    };
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(parallel, groups.length) }, async () => {
        while (next < groups.length) {
          const g = groups[next++];
          running.add(g);
          report();
          const r = await runGroup(g, groups);
          running.delete(g);
          results.set(g, r);
          if (running.size) report();
        }
      }),
    );
    const ok = groups.filter((g) => !results.get(g)!.error).length;
    const lines = groups.map((g, i) => {
      const r = results.get(g)!;
      const head = `- 第 ${g.no} 组（${asked[i].join('、')}）`;
      if (r.error) return `${head}：失败（已尝试 ${r.tries} 次）：${r.error.slice(0, 300)}。这组页面保持原样`;
      const did = [
        r.changed.size ? `改写了 ${[...r.changed].join('、')}` : '',
        r.added.length ? `新增了 ${r.added.join('、')}` : '',
        r.css ? `向 ${ADDITIONS_CSS} 追加了样式` : '',
      ].filter(Boolean);
      return `${head}：${did.length ? did.join('，') : '子任务认为不需要修改'}${r.reviews ? `；看过渲染截图后又修正了 ${r.reviews} 次` : ''}`;
    });
    const touched = groups.flatMap((g) => {
      const r = results.get(g)!;
      return r.error ? [] : [...r.changed, ...r.added];
    });
    const seen = await overview(touched);
    const failedNote = ok < groups.length ? '失败的组可以再派一次，或自己修改；' : '';
    return {
      content: `并行修改完成：${groups.length} 组中 ${ok} 组成功。\n${lines.join('\n')}${seen.text}\n各组是分别完成的，请审阅全部结果：是否符合修改要求与 README，各页的风格、用语与数据是否一致，${
        ctx.kind === 'deck' ? '同类页面的格式是否统一、页面之间有没有讲同一件事、有没有自己画的 Logo，' : ''
      }有没有布局问题${
        seen.images.length ? '' : '（用 render_pages 或 check_project 查看）'
      }。需要返工或还有遗漏的页面，再派下一轮 edit_pages_in_parallel（只派这些页面，写清楚每页的问题和要怎么改）；${failedNote}零散的小问题直接用工具修改。全部满意后用一两句话总结所做的修改。`,
      images: seen.images,
    };
  }

  /** The coordinator's review of a round: thumbnails of every page it changed and their layout check. */
  async function overview(files: string[]): Promise<{ text: string; images: { label: string; url: string }[] }> {
    if (!deps.resolver || !files.length) return { text: '', images: [] };
    try {
      const view = draft.view();
      const named = nameFiles(view.pages);
      const nums = named.flatMap((p, i) => (files.includes(p.file!) ? [i + 1] : []));
      if (!nums.length) return { text: '', images: [] };
      const reports = await inspectLayout(view, deps.resolver, nums.map((n) => named[n - 1].id));
      const sheets = await renderContactSheets({ ...view, pages: nums.map((n) => named[n - 1]) }, deps.resolver, {
        labels: nums.map((n) => `第 ${n} 页 ${named[n - 1].file}`),
        perSheet: OVERVIEW_PER_SHEET,
      });
      return {
        text: `\n\n【本轮审阅】本轮改过的 ${nums.length} 页的缩略图附在后面；自动布局检查：\n${formatReport({ ...view, pages: named }, reports, nums)}`,
        images: sheets.map((s, i) => ({
          label: sheets.length > 1 ? `本轮改过的页面 ${i + 1}/${sheets.length}` : '本轮改过的页面',
          url: `data:image/jpeg;base64,${s.toString('base64')}`,
        })),
      };
    } catch (e) {
      return { text: `\n\n（本轮结果渲染失败：${(e as Error).message.slice(0, 200)}）`, images: [] };
    }
  }

  return { defs: [toolDef(parallel)], execute };
}
