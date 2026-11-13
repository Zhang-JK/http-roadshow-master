import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';

export interface MockCall {
  model: string;
  stream: boolean;
  user?: string;
  text: string;
  images: string[];
  body: any;
}

/** Text that sticks out of the right edge of the page: the self-check must catch and fix it. */
const OVERFLOW = '<p class="body" style="position:absolute;left:1800px;top:200px;white-space:nowrap">OVERFLOW-TEXT 这一行文字超出了页面右边界</p>';

/** Decode the first pixel of a PNG data URL (enough for the solid-colour connectivity test). */
function firstPixel(dataUrl: string): [number, number, number] | null {
  try {
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    let off = 8;
    const idat: Buffer[] = [];
    while (off < buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
      off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    return [raw[1], raw[2], raw[3]];
  } catch {
    return null;
  }
}

function colourName([r, g, b]: [number, number, number]) {
  if (r > 200 && g > 200) return 'yellow';
  if (r > g && r > b) return 'red';
  if (g > r && g > b) return 'green';
  return 'blue';
}

/** The general components a template must offer (two SVG charts, a table, a timeline), with placeholder data. */
const TPL_PARTS =
  '<div class="parts"><svg class="chart" viewBox="0 0 200 100" width="200" height="100"><rect x="10" y="40" width="20" height="60"/><rect x="40" y="20" width="20" height="80"/><rect x="70" y="50" width="20" height="50"/><text x="10" y="98">类别 A</text></svg>' +
  '<svg class="chart" viewBox="0 0 200 100" width="200" height="100"><polyline points="0,80 50,40 100,60 150,20" fill="none" stroke="#1e40af"/><circle cx="50" cy="40" r="3"/><circle cx="100" cy="60" r="3"/></svg>' +
  '<table class="data-table"><tr><th>指标</th><th>数值</th></tr><tr><td>指标 A</td><td>XX%</td></tr></table><div class="timeline"><div class="step">阶段一</div><div class="step">阶段二</div></div></div>';

/** COPY_REF: page 2 of a template copies a sentence of the reference file (the delivery check must catch it). */
export const LEAKED = 'ACME 量子科技有限公司 2023 年营收 1234.5 万元';

const FULL_DOC = (title: string, n = 3, broken = false, tpl = false) => `下面是结果：
\`\`\`html
<!DOCTYPE html><html><head><title>${title}</title>
<style>:root{--brand:#1e40af}.title{font-size:96px;color:var(--brand)}.body{font-size:36px}</style></head><body>
${Array.from({ length: n }, (_, i) => `<section class="slide" data-layout="${i === 0 ? 'cover' : 'content'}"><h1 class="title">第${i + 1}页标题</h1><p class="body">第${i + 1}页正文内容</p><ul><li>要点A${i + 1}</li><li>要点B${i + 1}</li></ul>${broken && i === 1 ? OVERFLOW : ''}${tpl && i === 0 ? TPL_PARTS : ''}</section>`).join('\n')}
</body></html>
\`\`\``;

const PAGE = (n: number, layout: string, broken: boolean, extra = '', tpl = false) =>
  `<section class="slide" data-layout="${layout}"><h1 class="title">第${n}页标题</h1><p class="body">第${n}页正文内容</p><ul><li>要点A${n}</li><li>要点B${n}</li></ul>${broken && n === 2 ? OVERFLOW : ''}${n === 2 ? extra : ''}${tpl && n === 1 ? TPL_PARTS : ''}</section>`;

/** Text mixed with child elements, and an SVG chart's labels, for typing over a run of text in place (MIXED_TEXT). */
export const MIXED = '<p class="note">收入 <b class="num">3,200</b> 万元，同比 <i>+180%</i></p><div class="tag"><span class="dot"></span>重点客户<br><small>12 家</small></div>' +
  '<svg class="mini" viewBox="0 0 200 60" width="600" height="180"><rect x="0" y="0" width="200" height="60" fill="#eef2ff"/><text x="10" y="38" font-size="20" fill="#1e3a8a">营收</text><text x="140" y="38" font-size="20" fill="#1e3a8a" text-anchor="middle">3,200</text><text x="60" y="38" font-size="20">底层</text><text x="60" y="38" font-size="20">顶层</text></svg>' +
  '<div class="legend" style="position:relative;width:400px"><span>图例说明</span><div class="veil" style="position:absolute;left:0;top:0;width:100%;height:100%"></div></div>';

/** Page 2 extras that the delivery check must catch: BAD_PAGE_JS (a script and an onclick handler). */
const pageExtra = (text: string) =>
  `${text.includes('MIXED_TEXT') ? MIXED : ''}${text.includes('BAD_IMG') ? '<img src="/api/assets/no-such-image" alt="缺失">' : ''}${text.includes('BAD_PAGE_JS') ? '<script>alert(1)</script><button onclick="go()">下一步</button>' : ''}${text.includes('COPY_REF') ? `<p class="body">${LEAKED}</p>` : ''}`;

const README_DOC = (title: string, n: number, notes: string) => `# ${title}

## 需求
- 名称：${title}
- MOCK-README-NEED
- 其他要求：${notes}

## 风格约定
- 主色 --brand: #1e40af；标题 .title 96px，正文 .body 36px

## 页面规划
${Array.from({ length: n }, (_, i) => `${i + 1}. pages/${i === 0 ? 'cover' : `content-${i}`}.html ｜ ${i === 0 ? 'cover' : 'content'} ｜ 第${i + 1}页标题 ｜ 要点${i + 1}`).join('\n')}
`;

/** Plan step of a staged generation: README with the page plan and two style files. */
const PLAN_REPLY = (title: string, n: number, notes = '') => `<file path="README.md">
${README_DOC(title, n, notes)}
</file>

<file path="styles/theme.css">
:root{--brand:#1e40af}
</file>

<file path="styles/components.css">
.title{font-size:96px;color:var(--brand)}.body{font-size:36px}
</file>`;

/** Page step: the files listed under 【本批任务】. */
function pagesReply(text: string, broken: boolean, stray: boolean): string {
  const extra = pageExtra(text);
  const tpl = text.includes('制作这份路演模板的页面文件');
  const task = text.slice(text.indexOf('【本批任务】'));
  const lines = [...task.matchAll(/^- 第 (\d+) 页：(pages\/[\w.-]+\.html) ｜ (\w+)/gm)];
  // SKIP_PAGE: the model never manages to write page 2.
  return lines
    .filter(([, , path]) => !(text.includes('SKIP_PAGE') && path === 'pages/content-1.html'))
    .map(([, n, path, layout]) => `<file path="${stray ? path.replace('pages/', 'pages/x-') : path}">\n${PAGE(Number(n), layout, broken, extra, tpl)}\n</file>`)
    .join('\n\n');
}

/**
 * Scripted tool use: round 1 lists the files; round 2 inspects the first presentation (page image,
 * archive XML), searches for NEEDLE-42 and probes an unknown file and a non-existent write tool.
 */
function mockToolRound(toolMsgs: { content: string }[]): { name: string; args: Record<string, unknown> }[] | null {
  if (toolMsgs.length === 0) return [{ name: 'list_files', args: {} }];
  if (toolMsgs.length === 1) {
    let files: { file_id: string; type: string; archive: boolean }[] = [];
    try {
      files = JSON.parse(toolMsgs[0].content);
    } catch {
      /* no files */
    }
    const deck = files.find((f) => f.type === 'presentation') ?? files[0];
    const html = files.find((f) => f.type === 'html');
    return [
      { name: 'view_page', args: { file_id: deck?.file_id, page: 2 } },
      { name: 'search_files', args: { query: 'NEEDLE-42' } },
      { name: 'read_archive_entry', args: { file_id: deck?.file_id, path: 'ppt/slides/slide1.xml', max_chars: 3000 } },
      ...(html ? [{ name: 'read_raw', args: { file_id: html.file_id, max_chars: 2000 } }] : []),
      { name: 'read_text', args: { file_id: 'F99' } },
      { name: 'overwrite_reference', args: { file_id: deck?.file_id, content: 'x' } },
    ];
  }
  return null;
}

/**
 * Scripted self-check: look at the layout report and outline, then fix the overflowing page with an
 * exact replacement (plus one replacement that cannot match and, for page edits, one on a read-only page).
 */
function mockReviewRound(toolMsgs: { content: string }[]): { name: string; args: Record<string, unknown> }[] | null {
  if (toolMsgs.length === 0) return [{ name: 'check_layout', args: {} }, { name: 'read_draft', args: {} }];
  if (toolMsgs.length === 2) {
    const bad = Number(toolMsgs[0].content.match(/第 (\d+) 页(?:（[^）]*）)?：\n\s+✗ 文字超出页面边界/)?.[1] ?? 0);
    if (!bad) return null;
    const readOnly = toolMsgs[1].content.match(/第 (\d+) 页［只读］/)?.[1];
    return [
      { name: 'render_pages', args: { pages: [bad] } },
      { name: 'read_draft', args: { page: bad } },
      { name: 'replace_in_draft', args: { page: bad, old_text: 'left:1800px', new_text: 'left:120px' } },
      { name: 'replace_in_draft', args: { page: bad, old_text: 'NOT-IN-THE-SOURCE', new_text: 'x' } },
      ...(readOnly ? [{ name: 'replace_in_draft', args: { page: Number(readOnly), old_text: '<', new_text: '<' } }] : []),
    ];
  }
  return null;
}

/**
 * Scripted fix after a failed delivery check (the last user message has 【交付检查】): remove scripts
 * from the pages named in the report and list the files, then rewrite the README with every section
 * and a page plan of the actual files; pages reported as not written and missing style sheets are
 * written with write_file. Markers: CHECK_STUBBORN never fixes anything.
 */
function mockCheckRound(report: string, after: { content: string }[], stubborn: boolean): { name: string; args: Record<string, unknown> }[] | null {
  if (stubborn) return null;
  if (after.length === 0) {
    const scripted = [...report.matchAll(/✗ (pages\/[\w.-]+\.html)：包含 /g)].map((m) => m[1]);
    const leaked = [...report.matchAll(/✗ (pages\/[\w.-]+\.html)：含有从参考资料中照搬的具体内容/g)].map((m) => m[1]);
    const unwritten = [...report.matchAll(/✗ (pages\/[\w.-]+\.html)：页面 \S+ 还没有写出/g)].map((m) => m[1]);
    const noStyles = /✗ styles\/：没有任何样式文件/.test(report);
    return [
      { name: 'read_draft', args: {} },
      { name: 'read_draft', args: { path: 'README.md' } },
      ...(noStyles
        ? [
            { name: 'write_file', args: { path: 'styles/theme.css', content: ':root{--brand:#0f766e} /* CHECK-WROTE-STYLES */' } },
            { name: 'write_file', args: { path: 'styles/components.css', content: '.title{font-size:96px;color:var(--brand)}.body{font-size:36px}' } },
          ]
        : []),
      ...unwritten.map((path) => ({
        name: 'write_file',
        args: { path, after: 1, content: '<section class="slide" data-layout="content"><h1 class="title">CHECK-WROTE-PAGE</h1><p class="body">补写的页面</p></section>' },
      })),
      ...leaked.map((path) => ({ name: 'replace_in_draft', args: { path, old_text: LEAKED, new_text: '「公司名称」YYYY 年营收 X,XXX 万元' } })),
      ...scripted.flatMap((path) => [
        { name: 'edit_elements', args: { path, selector: 'script', remove: true, all: true } },
        { name: 'edit_elements', args: { path, selector: '[onclick]', attrs: { onclick: null }, all: true } },
      ]),
    ];
  }
  const list = after[0].content;
  if (!/✗ README\.md/.test(report) || after.some((m) => m.content.includes('已写入 README.md'))) return null;
  const pages = [...list.matchAll(/^(pages\/[\w.-]+\.html) — 第 (\d+) 页/gm)].map((m) => `${m[2]}. ${m[1]} ｜ content ｜ 第${m[2]}页 ｜ 要点`);
  const old = after[1].content.replace(/^.*\n/, '').replace(/\n（已到结尾）$/, '').replace(/\n## 页面规划[\s\S]*?(?=\n## |$)/, '');
  const add = [
    !/^## 需求/m.test(old) && '## 需求\n- CHECK-FIXED-README',
    !/^## 风格约定/m.test(old) && '## 风格约定\n- 主色 #1e40af',
    `## 页面规划\n${pages.join('\n')}`,
  ].filter(Boolean);
  const content = `${old.trim()}\n\n${add.join('\n\n')}\n`;
  return [{ name: 'write_file', args: { path: 'README.md', content } }];
}

const EDIT_TOOLS = new Set(['write_file', 'delete_file', 'edit_elements', 'edit_css', 'replace_in_draft', 'rewrite_page', 'insert_page', 'delete_page', 'duplicate_page', 'move_page']);

/**
 * Scripted tool-first edit (the edit prompt has 【修改方式】): one round of structured edits, the same
 * changes the rewrite-mode replies below make, then a short summary.
 */
function mockEditRound(text: string, messages: any[]): { name: string; args: Record<string, unknown> }[] | null {
  const called = (name: string) => messages.some((m) => m.role === 'assistant' && m.tool_calls?.some((c: any) => c.function.name === name));
  const result = (name: string) => {
    const ids = messages.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).filter((c: any) => c.function.name === name).map((c: any) => c.id) : []));
    // Mock tool call ids repeat across rounds (call_0, call_1…): the latest match is the answer.
    return [...messages].reverse().find((m) => m.role === 'tool' && ids.includes(m.tool_call_id))?.content as string | undefined;
  };
  // ASK_ME / SIMILAR count only in the user's request (the README may mention them from earlier jobs).
  const request = text.match(/【修改要求】\n([^\n]*)/)?.[1] ?? '';
  if (request.includes('ASK_ME') && !called('ask_user')) {
    return [{ name: 'ask_user', args: { question: 'MOCK-QUESTION 改成什么颜色？', options: ['红色', '蓝色'] } }];
  }
  const done = messages.some((m) => m.role === 'assistant' && m.tool_calls?.some((c: any) => EDIT_TOOLS.has(c.function.name)));
  // SIMILAR: after the local edit, look for the same title on the other pages and ask to widen the scope.
  if (done && request.includes('SIMILAR')) {
    if (!called('extend_scope')) {
      return [
        { name: 'find_elements', args: { selector: 'h1.title' } },
        { name: 'extend_scope', args: { summary: 'MOCK-SIMILAR 其他页面也有同样的标题', pages: [1, 3] } },
      ];
    }
    if (/已开放/.test(result('extend_scope') ?? '') && !called('delete_file')) {
      return [
        { name: 'edit_elements', args: { selector: 'h1.title', all: true, text: 'SIMILAR-DONE' } },
        { name: 'edit_css', args: { selector: '.title', set: { color: '#ff0000' } } },
        { name: 'delete_file', args: { path: 'pages/cover.html' } },
      ];
    }
    return null;
  }
  if (done) return null;
  const overflow = text.includes('FIX_DRAFT') ? [{ name: 'edit_elements', args: { selector: 'section', insert: { position: 'append', html: OVERFLOW } } }] : [];
  const eids = text.match(/选中元素的 data-eid：([^（]+)（/)?.[1].split('、');
  if (eids) {
    return [
      ...eids.map((eid) => ({ name: 'edit_elements', args: { eids: [eid], text: `已修改：${text.includes('MARK') ? 'MARK' : 'X'}` } })),
      { name: 'edit_css', args: { selector: '.added', set: { color: 'red' } } },
      ...overflow,
    ];
  }
  if (text.includes('本次只能修改草稿第')) {
    return [{ name: 'edit_elements', args: { selector: 'section', insert: { position: 'append', html: '<p class="body">整页新增段落</p>' } } }, ...overflow];
  }
  // Whole-document markers: DELETE_LAST drops the last page without touching the README plan;
  // EDIT_ADD_JS puts a script into every page.
  if (text.includes('DELETE_LAST')) return [{ name: 'delete_file', args: { path: 'pages/content-2.html' } }];
  if (text.includes('EDIT_ADD_JS')) return [{ name: 'edit_elements', args: { selector: 'section', all: true, insert: { position: 'append', html: '<script>track()</script>' } } }];
  return [
    { name: 'find_css', args: { query: '--brand' } },
    { name: 'edit_css', args: { selector: ':root', set: { '--brand': '#111827' } } },
  ];
}

function streamToolCalls(res: http.ServerResponse, toolCalls: { name: string; args: Record<string, unknown> }[], text: string, stream: boolean) {
  const usage = { prompt_tokens: Math.round(text.length / 2), completion_tokens: 20, cost: 0.0001 };
  if (!stream) {
    const tool_calls = toolCalls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls }, finish_reason: 'tool_calls' }], usage }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  toolCalls.forEach((c, index) => {
    const args = JSON.stringify(c.args);
    const half = Math.ceil(args.length / 2);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: c.name, arguments: args.slice(0, half) } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(half) } }] } }] })}\n\n`);
  });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
}

export interface MockOptions {
  delayMs?: number;
  /** Pause between streamed chunks, so the output has a measurable speed. */
  chunkDelayMs?: number;
}

export async function startMockLlm(opts: MockOptions = {}) {
  const calls: MockCall[] = [];
  /** Requests made during the self-check phase (kept apart so draft-phase assertions stay simple). */
  const reviewCalls: MockCall[] = [];
  /** Requests answering a failed delivery check (also counted in calls / reviewCalls). */
  const checkCalls: MockCall[] = [];
  const failedOnce = new Set<string>();
  let offlineCalls = 0;
  /**
   * The model went away (as a local model does while it restarts): every request fails until
   * setOnline() or POST /__mock/online. Markers take it offline, each once per request:
   * OFFLINE_AT_PAGES at the second batch of pages, OFFLINE_IN_EDIT at the second round of a tool
   * edit, OFFLINE_IN_CHECK when the model is asked to fix a failed delivery check,
   * OFFLINE_AT_CONTINUE when a cut-off reply is to be continued.
   */
  let offline = false;
  const tripped = new Set<string>();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/__mock/online') {
      offline = false;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    if (req.url.startsWith('/broken')) {
      res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'down' } }));
      return;
    }
    if (req.headers.authorization !== 'Bearer good-key') {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad key' } }));
      return;
    }
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const texts: string[] = [];
    const images: string[] = [];
    for (const m of body.messages) {
      if (m.content === null || m.content === undefined) continue;
      if (typeof m.content === 'string') texts.push(m.content);
      else
        for (const p of m.content) {
          if (p.type === 'text') texts.push(p.text);
          if (p.type === 'image_url') images.push(p.image_url.url);
        }
    }
    const text = texts.join('\n');
    const lastUserMsg = [...body.messages].reverse().find((m: any) => m.role === 'user');
    const lastUserStr = typeof lastUserMsg?.content === 'string' ? (lastUserMsg.content as string) : '';
    // Only the request itself counts: the README lists earlier edit requests, markers included.
    const key = text.match(/【修改要求】\n([^\n]*)/)?.[1] ?? text.match(/【其他要求】(.*)/)?.[1] ?? text.match(/^- 其他要求：(.*)$/m)?.[1] ?? '';
    const trip = (marker: string, now: boolean) => {
      if (!now || !key.includes(marker) || tripped.has(`${marker}|${key}`)) return;
      tripped.add(`${marker}|${key}`);
      offline = true;
    };
    trip('OFFLINE_AT_PAGES', text.includes('【本批任务】') && !text.includes('（无，本批是第一批）'));
    trip('OFFLINE_IN_EDIT', text.includes('【修改方式】') && !text.includes('【自检阶段】') && body.messages.some((m: any) => m.role === 'tool'));
    trip('OFFLINE_IN_CHECK', lastUserStr.includes('【交付检查】'));
    trip('OFFLINE_AT_CONTINUE', lastUserStr.includes('请从中断处继续输出'));
    if (offline) {
      offlineCalls++;
      res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'model offline (MOCK)' } }));
      return;
    }
    // FAIL_ONCE in an edit request: the first attempt on each model fails as if it were overloaded, a retry works.
    const editRequest = text.match(/【修改要求】\n([^\n]*)/)?.[1] ?? '';
    if (editRequest.includes('FAIL_ONCE') && !failedOnce.has(`${body.model}|${editRequest}`)) {
      failedOnce.add(`${body.model}|${editRequest}`);
      res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'model overloaded (FAIL_ONCE)' } }));
      return;
    }
    if (text.startsWith('Parallel test:')) {
      const counted = Array.from({ length: 100 }, (_, i) => i + 1).join(' ');
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: counted }, finish_reason: 'stop' }] }));
        return;
      }
      // Paced, so requests sent together visibly overlap.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const c of counted.match(/.{1,30}/g)!) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 15));
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    const review = text.includes('【自检阶段】');
    (review ? reviewCalls : calls).push({ model: body.model, stream: !!body.stream, user: body.user, text, images, body });

    const toolMsgs = body.messages.filter((m: any) => m.role === 'tool');
    const canCall = body.tools && body.tool_choice !== 'none';
    const lastUserAt = body.messages.map((m: any) => m.role).lastIndexOf('user');
    const lastUserText = typeof body.messages[lastUserAt]?.content === 'string' ? (body.messages[lastUserAt].content as string) : '';
    const checkPhase = lastUserText.includes('【交付检查】');
    if (checkPhase) checkCalls.push({ model: body.model, stream: !!body.stream, user: body.user, text: lastUserText, images, body });
    const toolEdit = !review && text.includes('【修改方式】') && !/FULL_REWRITE|NO_CHANGE/.test(text);
    const planStep = text.includes('本次只输出 README.md 与样式文件');
    const pageStep = text.includes('【本批任务】');
    const toolCalls = !canCall
      ? null
      : checkPhase
        ? mockCheckRound(lastUserText, body.messages.slice(lastUserAt + 1).filter((m: any) => m.role === 'tool'), text.includes('CHECK_STUBBORN'))
      : review
        ? text.includes('FIX_DRAFT')
          ? mockReviewRound(toolMsgs)
          : null
        : planStep && text.includes('ASK_ME') && !toolMsgs.length
          ? [{ name: 'ask_user', args: { question: 'MOCK-QUESTION 面向谁？', options: ['投资人', '客户'] } }]
        : toolEdit
          ? ((text.includes('USE_TOOLS') ? mockToolRound(toolMsgs) : null) ?? mockEditRound(text, body.messages))
          : text.includes('USE_TOOLS') && !pageStep
            ? mockToolRound(toolMsgs)
            : null;
    if (toolCalls) {
      streamToolCalls(res, toolCalls, text, !!body.stream);
      return;
    }

    let reply: string;
    let finish = 'stop';
    const title = (text.match(/【(?:模板|材料)名称】(.*)/)?.[1] ?? 'Mock').trim();
    const broken = text.includes('FIX_DRAFT') || text.includes('BROKEN_ONLY');
    const lastUser = [...body.messages].reverse().find((m: any) => m.role === 'user');
    const continuing = typeof lastUser?.content === 'string' && lastUser.content.includes('你上一条回复没有完成');
    if (planStep && !continuing && text.includes('TRUNCATE_PLAN')) {
      reply = PLAN_REPLY(title, 3).slice(0, 120);
      finish = 'length';
    } else if (planStep && text.includes('NO_CSS')) {
      reply = PLAN_REPLY(title, 3).replace(/<file path="styles[\s\S]*$/, '');
    } else if (planStep && text.includes('CSS_FENCED')) {
      reply = PLAN_REPLY(title, 3).replace(/<file path="(styles\/[\w.-]+)">\n([\s\S]*?)\n<\/file>/g, '### $1\n```css\n$2\n```');
    } else if (planStep) {
      const answers = toolMsgs.map((m: any) => String(m.content)).filter((c: string) => /用户|回答/.test(c)).join(' ');
      reply = PLAN_REPLY(title, text.includes('MANY_PAGES') ? 7 : 3, `${(text.match(/【其他要求】(.*)/)?.[1] ?? '').trim()}${answers ? ` ASK-RESULT ${answers}` : ''}`);
    } else if (pageStep) {
      reply = pagesReply(text, broken, text.includes('STRAY_NAMES'));
      if (text.includes('TRUNCATE_PAGES') && text.includes('（无，本批是第一批）')) {
        const second = reply.indexOf('<file', 10);
        reply = second > 0 ? reply.slice(0, second + 60) : reply.slice(0, 80);
        finish = 'length';
      }
    } else if (typeof lastUser?.content === 'string' && lastUser.content.includes('请从中断处继续输出')) {
      const full = FULL_DOC(title, 3, broken, text.includes('可复用的「路演材料模板」'));
      reply = full.slice(full.length / 2);
    } else if (checkPhase) {
      reply = '已按交付检查修复。';
    } else if (toolEdit) {
      reply = '已按要求修改。';
    } else if (text.includes('NO_CHANGE')) {
      reply = '我认为不需要修改。';
    } else if (review) {
      reply = text.includes('EMPTY_FINAL') ? '' : text.includes('FIX_DRAFT') ? '已修复：把超出页面右边界的文字移回页面内。' : '无需修改。';
    } else if (text.includes('Connectivity test')) {
      const px = images[0] ? firstPixel(images[0]) : null;
      reply = body.model.includes('textonly') || !px ? 'I cannot see images' : colourName(px);
    } else if (text.includes('只输出修改后的第')) {
      const m = text.match(/【第 (\d+) 页当前 HTML[^】]*】\n```html\n([\s\S]*?)\n```/);
      let page = m ? m[2] : '<section class="slide"><h1>?</h1></section>';
      const target = text.match(/data-eid="(e[0-9a-z]{8})"，/);
      if (target) {
        page = page.replace(new RegExp(`(<[^>]*data-eid="${target[1]}"[^>]*>)([^<]*)`), `$1已修改：${text.includes('MARK') ? 'MARK' : 'X'}`);
      } else {
        page = page.replace('</section>', '<p class="body">整页新增段落</p></section>');
      }
      if (text.includes('FIX_DRAFT')) page = page.replace(/<\/section>\s*$/, `${OVERFLOW}</section>`);
      reply = `\`\`\`html\n<style>.added{color:red}</style>\n${page}\n\`\`\``;
    } else if (text.includes('只输出需要修改或新增的文件')) {
      const css = [...text.matchAll(/<file path="(styles\/[\w.-]+\.css)">\n([\s\S]*?)\n<\/file>/g)].find((m) => m[2].includes('--brand'));
      reply = css ? `<file path="${css[1]}">\n${css[2].replace('--brand:#1e40af', '--brand:#111827')}\n</file>` : '（没有找到样式文件）';
    } else {
      const full = FULL_DOC(title, 3, broken, text.includes('可复用的「路演材料模板」'));
      if (text.includes('TRUNCATE_SINGLE')) {
        reply = full.slice(0, full.length / 2);
        finish = 'length';
      } else reply = full;
    }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const usage = { prompt_tokens: Math.round(text.length / 2), completion_tokens: Math.round(reply.length / 2), cost: 0.0001 };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = reply.match(/[\s\S]{1,200}/g) ?? [];
      for (const c of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
        if (opts.chunkDelayMs) await new Promise((r) => setTimeout(r, opts.chunkDelayMs));
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: finish }], usage }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    brokenUrl: `http://127.0.0.1:${port}/broken/v1`,
    calls,
    reviewCalls,
    checkCalls,
    get offline() {
      return offline;
    },
    get offlineCalls() {
      return offlineCalls;
    },
    setOnline: () => {
      offline = false;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
