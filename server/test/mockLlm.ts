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

const FULL_DOC = (title: string, n = 3) => `下面是结果：
\`\`\`html
<!DOCTYPE html><html><head><title>${title}</title>
<style>:root{--brand:#1e40af}.title{font-size:96px;color:var(--brand)}.body{font-size:36px}</style></head><body>
${Array.from({ length: n }, (_, i) => `<section class="slide" data-layout="${i === 0 ? 'cover' : 'content'}"><h1 class="title">第${i + 1}页标题</h1><p class="body">第${i + 1}页正文内容</p><ul><li>要点A${i + 1}</li><li>要点B${i + 1}</li></ul></section>`).join('\n')}
</body></html>
\`\`\``;

export interface MockOptions {
  delayMs?: number;
}

export async function startMockLlm(opts: MockOptions = {}) {
  const calls: MockCall[] = [];
  const server = http.createServer(async (req, res) => {
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
      if (typeof m.content === 'string') texts.push(m.content);
      else
        for (const p of m.content) {
          if (p.type === 'text') texts.push(p.text);
          if (p.type === 'image_url') images.push(p.image_url.url);
        }
    }
    const text = texts.join('\n');
    calls.push({ model: body.model, stream: !!body.stream, user: body.user, text, images, body });

    let reply: string;
    if (text.includes('Connectivity test')) {
      const px = images[0] ? firstPixel(images[0]) : null;
      reply = body.model.includes('textonly') || !px ? 'I cannot see images' : colourName(px);
    } else if (text.includes('只输出修改后的第')) {
      const m = text.match(/【第 (\d+) 页当前 HTML】\n```html\n([\s\S]*?)\n```/);
      let page = m ? m[2] : '<section class="slide"><h1>?</h1></section>';
      const target = text.match(/data-eid="(e[0-9a-z]{8})"，/);
      if (target) {
        page = page.replace(new RegExp(`(<[^>]*data-eid="${target[1]}"[^>]*>)([^<]*)`), `$1已修改：${text.includes('MARK') ? 'MARK' : 'X'}`);
      } else {
        page = page.replace('</section>', '<p class="body">整页新增段落</p></section>');
      }
      reply = `\`\`\`html\n<style>.added{color:red}</style>\n${page}\n\`\`\``;
    } else if (text.includes('请输出修改后的【完整 HTML 文档】')) {
      const m = text.match(/【当前完整 HTML】\n```html\n([\s\S]*?)\n```/);
      reply = `\`\`\`html\n${(m ? m[1] : '').replace('--brand:#1e40af', '--brand:#111827')}\n\`\`\``;
    } else {
      const title = text.match(/【(?:模板|材料)名称】(.*)/)?.[1] ?? 'Mock';
      reply = FULL_DOC(title.trim());
    }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const usage = { prompt_tokens: Math.round(text.length / 2), completion_tokens: Math.round(reply.length / 2), cost: 0.0001 };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = reply.match(/[\s\S]{1,200}/g) ?? [];
      for (const c of chunks) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    brokenUrl: `http://127.0.0.1:${port}/broken/v1`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
