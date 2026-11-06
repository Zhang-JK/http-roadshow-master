import { useState } from 'react';
import type { ElementRef, Version } from '../types';
import { ACTION_LABELS, SCOPE_LABELS, fullTime, timeAgo } from '../lib/format';

interface Props {
  versions: Version[];
  currentVersionNo: number;
  previewId?: number;
  onPreview: (v: Version) => void;
  onRevert: (v: Version) => void;
  onLocate: (page: number | undefined, eid: string) => void;
}

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

export function HistoryPanel({ versions, currentVersionNo, previewId, onPreview, onRevert, onLocate }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  if (!versions.length) return <div className="panel-empty muted">暂无历史记录</div>;
  return (
    <div className="history" data-testid="history">
      {versions.map((v) => {
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
          s.cssChanged ? '样式变更' : '',
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
            {v.prompt && <div className="hist-prompt">{v.prompt.length > 160 && !isOpen ? `${v.prompt.slice(0, 160)}…` : v.prompt}</div>}
            {counts.length > 0 && <div className="hist-counts">{counts.join(' · ')}</div>}
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
