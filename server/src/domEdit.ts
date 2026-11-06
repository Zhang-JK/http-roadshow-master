import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import postcss, { type AtRule, type ChildNode, type Container, type Declaration, type Rule } from 'postcss';

/** Attributes the history and the editor rely on; tools may never set or remove them. */
const PROTECTED_ATTRS = new Set(['data-eid', 'data-page-id']);
const MAX_LISTED = 40;

export interface ElementMatch {
  eid?: string;
  tag: string;
  classes: string;
  text: string;
  children: number;
}

export interface ElementTarget {
  selector?: string;
  eids?: string[];
  /** Elements whose own text contains this (the innermost ones). */
  text?: string;
}

export interface ElementEdit {
  text?: string;
  html?: string;
  outer_html?: string;
  attrs?: Record<string, string | null>;
  style?: Record<string, string | null>;
  add_class?: string;
  remove_class?: string;
  remove?: boolean;
  insert?: { position: 'before' | 'after' | 'prepend' | 'append'; html: string };
}

const load = (html: string) => cheerio.load(html, null, false);
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function describe($: cheerio.CheerioAPI, el: Element): ElementMatch {
  const node = $(el);
  return {
    eid: node.attr('data-eid'),
    tag: el.tagName.toLowerCase(),
    classes: node.attr('class') ?? '',
    text: squash(node.text()).slice(0, 60),
    children: node.children().length,
  };
}

export function formatMatch(m: ElementMatch & { page?: number }): string {
  const cls = m.classes ? `.${m.classes.trim().split(/\s+/).join('.')}` : '';
  return `${m.page ? `第 ${m.page} 页 ` : ''}<${m.tag}${cls}>${m.eid ? ` data-eid="${m.eid}"` : ''}${m.children ? `（${m.children} 个子元素）` : ''}${m.text ? `「${m.text}」` : ''}`;
}

function select($: cheerio.CheerioAPI, target: ElementTarget): Element[] {
  let found: cheerio.Cheerio<AnyNode>;
  if (target.eids?.length) {
    found = $.root().find(target.eids.map((e) => `[data-eid="${String(e).replace(/"/g, '')}"]`).join(','));
  } else if (target.selector) {
    try {
      found = $.root().find(target.selector);
    } catch (e) {
      throw new Error(`CSS 选择器无效：${target.selector}（${(e as Error).message}）`);
    }
  } else if (target.text) {
    found = $.root().find('*');
  } else {
    throw new Error('请用 eids、selector 或 text 指定要找的元素');
  }
  let els = found.toArray().filter((n): n is Element => n.type === 'tag');
  if (target.text) {
    const needle = target.text.toLowerCase();
    const hit = (el: Element) => $(el).text().toLowerCase().includes(needle);
    els = els.filter((el) => hit(el) && !$(el).children().toArray().some((c) => c.type === 'tag' && hit(c as Element)));
  }
  return els;
}

/** Elements of one page matching the target, in document order. */
export function findInPage(html: string, target: ElementTarget): ElementMatch[] {
  const $ = load(html);
  return select($, target).map((el) => describe($, el));
}

export function countInPage(html: string, target: ElementTarget): number {
  return select(load(html), target).length;
}

function parseStyle(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of style.split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return out;
}

function checkValue(prop: string, value: string) {
  if (/[{};]/.test(value)) throw new Error(`${prop} 的值不能包含 { } ;：${value}`);
}

function validate(edit: ElementEdit) {
  const ops = (['text', 'html', 'outer_html', 'attrs', 'style', 'add_class', 'remove_class', 'remove', 'insert'] as const).filter(
    (k) => edit[k] !== undefined && edit[k] !== null && edit[k] !== false,
  );
  if (!ops.length) throw new Error('没有指定任何修改（text / html / outer_html / attrs / style / add_class / remove_class / remove / insert）');
  if ((edit.remove || edit.outer_html !== undefined) && ops.length > 1) throw new Error('remove 与 outer_html 不能和其他修改同时使用');
  if (edit.text !== undefined && edit.html !== undefined) throw new Error('text 与 html 只能指定一个');
  for (const name of Object.keys(edit.attrs ?? {})) {
    const n = name.toLowerCase();
    if (PROTECTED_ATTRS.has(n)) throw new Error(`${name} 是系统标识，不能修改`);
    if (n === 'style') throw new Error('请用 style 参数修改内联样式');
    if (!/^[a-z_:][-a-z0-9_:.]*$/.test(n)) throw new Error(`属性名无效：${name}`);
  }
  for (const [prop, value] of Object.entries(edit.style ?? {})) if (value) checkValue(prop, value);
  if (edit.insert && !['before', 'after', 'prepend', 'append'].includes(edit.insert.position)) {
    throw new Error('insert.position 只能是 before / after / prepend / append');
  }
}

function applyEdit($: cheerio.CheerioAPI, el: Element, edit: ElementEdit) {
  const node = $(el);
  const isPage = el.tagName.toLowerCase() === 'section' && !node.parents('section').length;
  if (isPage && (edit.remove || edit.outer_html !== undefined || edit.insert?.position === 'before' || edit.insert?.position === 'after')) {
    throw new Error('不能删除、替换或在外部插入页面根元素 <section>；整页操作请用 rewrite_page / insert_page / delete_page');
  }
  if (edit.remove) {
    node.remove();
    return;
  }
  if (edit.outer_html !== undefined) {
    const repl = load(edit.outer_html);
    const roots = repl.root().children().toArray();
    const eid = node.attr('data-eid');
    if (roots.length === 1 && eid && !repl(roots[0]).attr('data-eid')) repl(roots[0]).attr('data-eid', eid);
    node.replaceWith(repl.html());
    return;
  }
  if (edit.text !== undefined) {
    const kids = node.children().toArray().filter((c) => c.type === 'tag' && !['br', 'wbr'].includes((c as Element).tagName));
    if (kids.length) {
      throw new Error(
        `${formatMatch(describe($, el))} 含有子元素，设置 text 会删掉它们；请改为修改里面的子元素（见 find_elements），或用 html 给出完整的内部 HTML`,
      );
    }
    node.text(edit.text);
  }
  if (edit.html !== undefined) node.html(edit.html);
  for (const [name, value] of Object.entries(edit.attrs ?? {})) {
    if (value === null || value === undefined) node.removeAttr(name);
    else node.attr(name, String(value));
  }
  if (edit.style) {
    const style = parseStyle(node.attr('style') ?? '');
    for (const [prop, value] of Object.entries(edit.style)) {
      const p = prop.trim().toLowerCase();
      if (value === null || value === undefined || String(value).trim() === '') style.delete(p);
      else style.set(p, String(value).trim());
    }
    const s = [...style].map(([k, v]) => `${k}:${v}`).join(';');
    if (s) node.attr('style', s);
    else node.removeAttr('style');
  }
  if (edit.add_class) node.addClass(edit.add_class);
  if (edit.remove_class) node.removeClass(edit.remove_class);
  if (edit.insert) {
    const { position, html } = edit.insert;
    if (position === 'before') node.before(html);
    else if (position === 'after') node.after(html);
    else if (position === 'prepend') node.prepend(html);
    else node.append(html);
  }
}

/** Apply one edit to the matching elements of a page; more than one match needs all=true. */
export function editInPage(html: string, target: ElementTarget, edit: ElementEdit, all: boolean): { html: string; count: number } {
  validate(edit);
  const $ = load(html);
  const els = select($, target);
  if (!els.length) return { html, count: 0 };
  if (target.eids?.length) {
    const missing = target.eids.filter((e) => !els.some((el) => $(el).attr('data-eid') === e));
    if (missing.length) throw new Error(`没有找到 data-eid 为 ${missing.join('、')} 的元素`);
  }
  if (els.length > 1 && !all && !(target.eids && els.length === target.eids.length)) {
    throw tooMany(els.map((el) => describe($, el)));
  }
  // Inner elements first, so editing a parent does not detach a child that is edited after it.
  for (const el of [...els].reverse()) applyEdit($, el, edit);
  return { html: $.html(), count: els.length };
}

export function tooMany(matches: (ElementMatch & { page?: number })[]): Error {
  const list = matches.slice(0, 8).map((m) => `  ${formatMatch(m)}`).join('\n');
  return new Error(
    `匹配到 ${matches.length} 个元素：\n${list}${matches.length > 8 ? '\n  …' : ''}\n请用 eids 指定具体元素，或确认要全部修改时设置 all=true`,
  );
}

export function listMatches(matches: (ElementMatch & { page: number })[]): string {
  if (!matches.length) return '没有匹配的元素。';
  const shown = matches.slice(0, MAX_LISTED).map((m) => formatMatch(m));
  return `共 ${matches.length} 个匹配${matches.length > MAX_LISTED ? `（只列出前 ${MAX_LISTED} 个）` : ''}：\n${shown.join('\n')}`;
}

// ---------------------------------------------------------------- CSS

export interface CssEdit {
  selector: string;
  /** Inside this @media / @supports condition, e.g. "(max-width: 800px)" or "@supports (display:grid)". */
  media?: string;
  set?: Record<string, string | null>;
  remove?: boolean;
}

const normSelector = (s: string) =>
  s
    .split(',')
    .map((p) => squash(p))
    .filter(Boolean)
    .join(', ');

function parseCss(css: string) {
  try {
    return postcss.parse(css);
  } catch (e) {
    throw new Error(`现有 CSS 无法解析（${(e as Error).message.split('\n')[0]}），请改用 replace_in_draft page=0 修改`);
  }
}

function atRuleKey(media: string): { name: string; params: string } {
  const m = media.trim().match(/^@(\w[\w-]*)\s*(.*)$/s);
  return m ? { name: m[1].toLowerCase(), params: squash(m[2]) } : { name: 'media', params: squash(media) };
}

const contextOf = (rule: Rule): string => {
  const p = rule.parent;
  return p && p.type === 'atrule' ? `@${(p as AtRule).name} ${squash((p as AtRule).params)}` : '';
};

function findRule(root: postcss.Root, selector: string, media?: string): Rule | undefined {
  const want = normSelector(selector);
  const ctx = media ? atRuleKey(media) : null;
  let hit: Rule | undefined;
  root.walkRules((rule) => {
    if (normSelector(rule.selector) !== want) return;
    const p = rule.parent;
    const inAt = p && p.type === 'atrule' ? (p as AtRule) : null;
    if (ctx ? inAt && inAt.name.toLowerCase() === ctx.name && squash(inAt.params) === ctx.params : !inAt) hit = rule;
  });
  return hit;
}

export function hasCssRule(css: string, selector: string, media?: string): boolean {
  try {
    return !!findRule(postcss.parse(css), selector, media);
  } catch {
    return false;
  }
}

/** Rules whose selector (or a declaration) mentions the query, printed in full. */
export function findCssRules(css: string, query: string, label = ''): string[] {
  const root = parseCss(css);
  const q = query.trim().toLowerCase();
  const out: string[] = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /keyframes$/i.test((rule.parent as AtRule).name)) return;
    const inSel = rule.selector.toLowerCase().includes(q);
    const inDecl = !inSel && rule.nodes.some((n) => n.type === 'decl' && `${n.prop}:${n.value}`.toLowerCase().includes(q));
    if (!q || inSel || inDecl) {
      const ctx = contextOf(rule);
      out.push(`${label}${ctx ? `${ctx} { ` : ''}${squash(rule.toString())}${ctx ? ' }' : ''}`);
    }
  });
  return out;
}

function setDecl(rule: Rule, prop: string, value: string | null) {
  const p = prop.trim();
  const existing = rule.nodes.filter((n): n is Declaration => n.type === 'decl' && n.prop.toLowerCase() === p.toLowerCase());
  if (value === null || value === undefined || String(value).trim() === '') {
    existing.forEach((d) => d.remove());
    return;
  }
  let v = String(value).trim();
  checkValue(p, v);
  const important = /!\s*important$/i.test(v);
  if (important) v = v.replace(/!\s*important$/i, '').trim();
  if (existing.length) {
    const last = existing.at(-1)!;
    existing.slice(0, -1).forEach((d) => d.remove());
    last.value = v;
    last.important = important;
  } else {
    rule.append(postcss.decl({ prop: p, value: v, important }));
  }
}

/** Change, create or delete one rule; returns the new stylesheet and what happened. */
export function editCss(css: string, edit: CssEdit): { css: string; action: 'updated' | 'created' | 'removed'; rule: string } {
  const selector = normSelector(edit.selector ?? '');
  if (!selector) throw new Error('selector 不能为空');
  if (/[{}]/.test(selector)) throw new Error('selector 中不能包含 { }');
  if (!edit.remove && !Object.keys(edit.set ?? {}).length) throw new Error('请用 set 给出要修改的属性（值为 null 表示删除该属性），或设置 remove=true 删除整条规则');
  const root = parseCss(css);
  let rule = findRule(root, selector, edit.media);
  if (edit.remove) {
    if (!rule) throw new Error(`没有找到规则 ${edit.media ? `${edit.media} 中的 ` : ''}${selector}`);
    const parent = rule.parent as Container<ChildNode> | undefined;
    rule.remove();
    if (parent && parent.type === 'atrule' && !parent.nodes?.length) parent.remove();
    return { css: root.toString(), action: 'removed', rule: selector };
  }
  let action: 'updated' | 'created' = 'updated';
  if (!rule) {
    action = 'created';
    rule = postcss.rule({ selector });
    if (edit.media) {
      const key = atRuleKey(edit.media);
      let at: AtRule | undefined;
      root.each((n) => {
        if (n.type === 'atrule' && n.name.toLowerCase() === key.name && squash(n.params) === key.params) at = n;
      });
      if (!at) {
        at = postcss.atRule({ name: key.name, params: key.params });
        root.append(at);
      }
      at.append(rule);
    } else {
      root.append(rule);
    }
  }
  for (const [prop, value] of Object.entries(edit.set ?? {})) setDecl(rule, prop, value);
  if (!rule.nodes.length && action === 'created') throw new Error('新规则中没有任何属性');
  return { css: root.toString(), action, rule: squash(rule.toString()) };
}
