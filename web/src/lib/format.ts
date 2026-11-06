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
