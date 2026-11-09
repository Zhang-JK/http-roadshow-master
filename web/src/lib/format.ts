export function timeAgo(ts: number): string {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** Time since ts as m:ss (or h:mm:ss). */
export function elapsed(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const mmss = `${Math.floor((s % 3600) / 60)}:${String(s % 60).padStart(2, '0')}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss.padStart(5, '0')}` : mmss;
}

/** A length of time in words, e.g. 2.4 秒, 45 秒, 3 分 05 秒, 1 小时 02 分. */
export function duration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} 秒`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} 分`;
}

export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-US');

export const speed = (tps: number | null | undefined) => (tps ? `${tps.toFixed(1)} tok/s` : '—');

/** Totals of a finished job, e.g. 耗时 3 分 05 秒 · 输入 12,000 / 输出 3,400 tokens · 21.5 tok/s. */
export function costText(durationMs: number | null | undefined, stats: { calls: number; promptTokens: number; completionTokens: number; estimated: boolean; tokensPerSec: number | null } | null | undefined): string {
  const parts = [durationMs != null ? `耗时 ${duration(durationMs)}` : ''];
  if (stats?.calls) {
    parts.push(`${stats.calls} 次调用`, `输入 ${num(stats.promptTokens)} / 输出 ${num(stats.completionTokens)} tokens${stats.estimated ? '（估算）' : ''}`);
    if (stats.tokensPerSec) parts.push(speed(stats.tokensPerSec));
  }
  return parts.filter(Boolean).join(' · ');
}

export function fullTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const ACTION_LABELS: Record<string, string> = {
  create: '生成',
  edit: 'AI 修改',
  revert: '恢复版本',
  page_delete: '删除页面',
  page_duplicate: '复制页面',
  page_move: '移动页面',
  rename: '重命名',
  readme: '编辑 README',
};

export const SCOPE_LABELS: Record<string, string> = {
  global: '整份材料',
  page: '单页',
  element: '元素',
};

export const TYPE_LABELS = { template: '模板', deck: '路演材料' } as const;
