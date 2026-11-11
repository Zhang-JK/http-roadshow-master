import { useState } from 'react';
import type { ElementRef, Job, Version } from '../types';
import { ACTION_LABELS, SCOPE_LABELS, costText, fullTime, timeAgo } from '../lib/format';

interface Props {
  versions: Version[];
  /** Requests that failed: listed among the versions, and anyone may run them again. */
  failedJobs?: Job[];
  pages?: { id: string }[];
  onRetry?: (j: Job) => void;
  /** Continue a failed request from its saved progress. */
  onResume?: (j: Job) => void;
  currentVersionNo: number;
  previewId?: number;
  onPreview: (v: Version) => void;
  onRevert: (v: Version) => void;
  onLocate: (page: number | undefined, eid: string) => void;
}

const cut = (s: string, full: boolean) => (s.length > 160 && !full ? `${s.slice(0, 160)}…` : s);

function ElementList({ title, items, onLocate, kind }: { title: string; items: ElementRef[]; onLocate?: Props['onLocate']; kind: string }) {
  if (!items.length) return null;
  return (
    <div className="el-group">
      <div className={`el-group-title ${kind}`}>{title} {items.length}</div>
      <ul>
        {items.slice(0, 40).map((e) => (
          <li key={e.eid}>
            <button className="el-ref" disabled={!onLocate} onClick={() => onLocate?.(e.page, e.eid)} title={onLocate ? '定位到该元素' : ''}>
              {e.page && <span className="el-page">P{e.page}</span>}
              <code>&lt;{e.tag}&gt;</code>
              <span className="el-text">{e.text || '（无文字）'}</span>
            </button>
          </li>
        ))}
        {items.length > 40 && <li className="muted small">…另有 {items.length - 40} 项</li>}
      </ul>
    </div>
  );
}

const resumed = (n: number | undefined) => (n ? ` · 中断后继续 ${n} 次` : '');

function FailedItem({
  job,
  pages,
  canRetry,
  onRetry,
  onResume,
}: {
  job: Job;
  pages: { id: string }[];
  canRetry: boolean;
  onRetry?: (j: Job) => void;
  onResume?: (j: Job) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'' | 'retry' | 'resume'>('');
  const run = async (what: 'retry' | 'resume') => {
    setBusy(what);
    await (what === 'retry' ? onRetry : onResume)?.(job);
    setBusy('');
  };
  const scope = (job.request.scope ?? 'global') as Version['scope'];
  const pageNo = job.request.pageId ? pages.findIndex((p) => p.id === job.request.pageId) + 1 : 0;
  const target =
    job.kind === 'create'
      ? '首次生成'
      : scope === 'global'
        ? '整份材料'
        : `${pageNo ? `第 ${pageNo} 页` : '已删除的页面'}${scope === 'element' ? ` · ${job.request.elementIds?.length ?? 0} 个选中元素` : ''}`;
  const error = job.error ?? '未知错误';
  const at = job.finishedAt ?? job.updatedAt;
  return (
    <div className="hist-item hist-failed" data-testid="history-failed">
      <div className="hist-head">
        <span className="hist-v err">失败</span>
        <span className="avatar sm">{(job.userName ?? '?').slice(0, 1).toUpperCase()}</span>
        <span className="hist-user">{job.userName ?? '某用户'}</span>
        <span className="hist-action">{ACTION_LABELS[job.kind] ?? job.kind}</span>
        <span className="spacer" />
        <span className="muted small" title={fullTime(at)}>{timeAgo(at)}</span>
      </div>
      <div className="hist-target">
        <span className={`scope-tag scope-${scope}`}>{job.kind === 'create' ? '生成' : SCOPE_LABELS[scope]}</span> {target}
      </div>
      {job.request.prompt && <div className="hist-prompt">{job.request.prompt}</div>}
      <div className="hist-error" title={error}>{error.length > 200 && !open ? `${error.slice(0, 200)}…` : error}</div>
      <div className="hist-cost" data-testid="hist-cost">
        {costText(job.durationMs, job.stats)}
        {resumed(job.resumeCount)}
      </div>
      {job.resume && (
        <div className="hist-resume" data-testid="resume-info" title={`进度保存于 ${fullTime(job.resume.savedAt)}`}>
          已保存进度：{job.resume.label}
        </div>
      )}
      <div className="hist-actions">
        {error.length > 200 && <button className="link" onClick={() => setOpen(!open)}>{open ? '收起' : '完整错误'}</button>}
        {job.resume && (
          <button className="link strong" disabled={!!busy} data-testid="resume-btn" onClick={() => run('resume')}>
            {busy === 'resume' ? '提交中…' : '从中断处继续'}
          </button>
        )}
        {job.retriedBy ? (
          <span className="muted small" data-testid="retried">已重试</span>
        ) : (
          canRetry && (
            <button className="link" disabled={!!busy} data-testid="retry-btn" onClick={() => run('retry')}>
              {busy === 'retry' ? '提交中…' : job.resume ? '从头重试' : '重试'}
            </button>
          )
        )}
      </div>
    </div>
  );
}

export function HistoryPanel({ versions, failedJobs = [], pages = [], onRetry, onResume, currentVersionNo, previewId, onPreview, onRevert, onLocate }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  if (!versions.length && !failedJobs.length) return <div className="panel-empty muted">暂无历史记录</div>;
  const items = [
    ...versions.map((v) => ({ at: v.createdAt, v })),
    ...failedJobs.map((j) => ({ at: j.finishedAt ?? j.updatedAt, j })),
  ].sort((a, b) => b.at - a.at);
  return (
    <div className="history" data-testid="history">
      {items.map((item) => {
        if ('j' in item) {
          const j = item.j;
          return (
            <FailedItem key={j.id} job={j} pages={pages} canRetry={j.kind === 'edit' || currentVersionNo === 0} onRetry={onRetry} onResume={onResume} />
          );
        }
        const v = item.v;
        const s = v.summary;
        const target =
          v.scope === 'global'
            ? '整份材料'
            : `第 ${(v.pageIndex ?? 0) + 1} 页${v.scope === 'element' ? ` · ${v.elementIds.length} 个选中元素` : ''}`;
        const counts = [
          s.pagesAdded?.length ? `新增 ${s.pagesAdded.length} 页` : '',
          s.pagesRemoved?.length ? `删除 ${s.pagesRemoved.length} 页` : '',
          s.pagesChanged?.length ? `改动 ${s.pagesChanged.length} 页` : '',
          s.elementsChanged?.length ? `修改 ${s.elementsChanged.length} 个元素` : '',
          s.elementsAdded?.length && v.action !== 'create' ? `新增 ${s.elementsAdded.length} 个元素` : '',
          s.elementsRemoved?.length ? `移除 ${s.elementsRemoved.length} 个元素` : '',
          s.cssChanged ? (s.stylesChanged?.length ? `样式变更（${s.stylesChanged.join('、')}）` : '样式变更') : '',
          s.readmeChanged && v.action !== 'create' ? 'README 更新' : '',
        ].filter(Boolean);
        const isOpen = open === v.id;
        return (
          <div key={v.id} className={`hist-item ${previewId === v.id ? 'previewing' : ''}`} data-testid="history-item">
            <div className="hist-head" onClick={() => setOpen(isOpen ? null : v.id)}>
              <span className="hist-v">v{v.versionNo}</span>
              <span className="avatar sm">{v.userName.slice(0, 1).toUpperCase()}</span>
              <span className="hist-user">{v.userName}</span>
              <span className="hist-action">{ACTION_LABELS[v.action] ?? v.action}</span>
              <span className="spacer" />
              <span className="muted small" title={fullTime(v.createdAt)}>{timeAgo(v.createdAt)}</span>
            </div>
            <div className="hist-target">
              <span className={`scope-tag scope-${v.scope}`}>{SCOPE_LABELS[v.scope]}</span> {target}
              {v.versionNo === currentVersionNo && <span className="badge badge-current">当前</span>}
            </div>
            {s.textEdit ? (
              <button className="hist-text" data-testid="hist-text" title="定位到该元素" onClick={() => onLocate(s.textEdit!.page, s.textEdit!.eid)}>
                <del>{cut(s.textEdit.before, isOpen)}</del>
                <span className="hist-arrow">→</span>
                <ins>{cut(s.textEdit.after, isOpen)}</ins>
              </button>
            ) : (
              v.prompt && <div className="hist-prompt">{cut(v.prompt, isOpen)}</div>
            )}
            {counts.length > 0 && <div className="hist-counts">{counts.join(' · ')}</div>}
            {v.jobId && (
              <div className="hist-cost" data-testid="hist-cost">
                {costText(v.durationMs, v.stats)}
                {resumed(v.resumeCount)}
              </div>
            )}
            {isOpen && (
              <div className="hist-detail">
                {s.pagesRemoved?.length > 0 && <div className="small">删除页面：{s.pagesRemoved.join('、')}</div>}
                {s.pagesAdded?.length > 0 && v.action !== 'create' && <div className="small">新增页面：第 {s.pagesAdded.join('、')} 页</div>}
                <ElementList title="修改的元素" kind="chg" items={s.elementsChanged ?? []} onLocate={onLocate} />
                {v.action !== 'create' && <ElementList title="新增的元素" kind="add" items={s.elementsAdded ?? []} onLocate={onLocate} />}
                <ElementList title="移除的元素" kind="del" items={s.elementsRemoved ?? []} />
              </div>
            )}
            <div className="hist-actions">
              <button className="link" onClick={() => setOpen(isOpen ? null : v.id)}>{isOpen ? '收起' : '详情'}</button>
              <button className="link" onClick={() => onPreview(v)}>预览</button>
              {v.versionNo !== currentVersionNo && <button className="link" onClick={() => onRevert(v)}>恢复</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
