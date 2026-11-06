import { useState } from 'react';
import { api } from '../api';
import type { Asset } from '../types';
import { fileSize } from '../lib/format';
import { useToast } from './Toast';
import { SLIDES_ACCEPT, TEXT_ACCEPT } from './RefFiles';

export function AssetsPanel({ projectId, assets, onChange }: { projectId: string; assets: Asset[]; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<'embed' | 'reference'>('embed');
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('role', role);
      Array.from(files).forEach((f) => fd.append('files', f, f.name));
      await api.post(`/api/projects/${projectId}/assets`, fd);
      toast('素材已上传，可在修改要求中让 AI 使用它们', 'success');
      onChange();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (a: Asset) => {
    if (!confirm(`删除素材「${a.filename}」？已引用它的页面将无法显示该图片。`)) return;
    await api.del(`/api/projects/${projectId}/assets/${a.id}`).catch((e) => toast(e.message, 'error'));
    onChange();
  };
  return (
    <div className="assets">
      <label className="file-drop compact">
        <input type="file" multiple accept={`image/*,${SLIDES_ACCEPT},${TEXT_ACCEPT}`} onChange={(e) => { upload(e.target.files); e.target.value = ''; }} disabled={busy} />
        <span>{busy ? '上传并处理中…' : '＋ 上传素材'}</span>
        <small>PPT/PDF/HTML 逐页转图片并提取文字；大文件由 AI 按需只读查阅原文</small>
      </label>
      <div className="row gap small asset-role">
        <span className="muted">图片用途：</span>
        <span className="seg seg-xs">
          <button type="button" className={role === 'embed' ? 'on' : ''} onClick={() => setRole('embed')}>嵌入页面</button>
          <button type="button" className={role === 'reference' ? 'on' : ''} onClick={() => setRole('reference')}>仅参考</button>
        </span>
      </div>
      {assets.length === 0 ? (
        <div className="panel-empty muted">暂无素材</div>
      ) : (
        <ul className="asset-list">
          {assets.map((a) => (
            <li key={a.id}>
              {a.kind === 'image' ? (
                <img src={a.url} alt="" />
              ) : a.slideCount ? (
                <img src={a.slideUrls[0]} alt="" title={`${a.slideCount} 页`} />
              ) : (
                <div className="doc-icon">📄</div>
              )}
              <div className="asset-info">
                <div className="asset-name" title={a.filename}>{a.filename}</div>
                <div className="muted small">
                  {fileSize(a.size)}
                  {a.kind === 'image' && (a.role === 'reference' ? ' · 仅参考' : ' · 可嵌入')}
                  {a.kind === 'document' && (a.slideCount ? ` · ${a.slideCount} 页图片` : '')}
                  {a.kind === 'document' && (a.hasText ? ' · 已提取文字' : ' · 无文字')}
                </div>
              </div>
              <button className="icon-btn" onClick={() => remove(a)} title="删除">✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
