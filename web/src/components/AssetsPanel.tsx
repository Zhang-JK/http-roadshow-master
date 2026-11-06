import { useState } from 'react';
import { api } from '../api';
import type { Asset } from '../types';
import { fileSize } from '../lib/format';
import { useToast } from './Toast';

export function AssetsPanel({ projectId, assets, onChange }: { projectId: string; assets: Asset[]; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
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
        <input type="file" multiple accept="image/*,.pdf,.txt,.md,.csv,.json" onChange={(e) => { upload(e.target.files); e.target.value = ''; }} disabled={busy} />
        <span>{busy ? '上传中…' : '＋ 上传素材'}</span>
        <small>图片可被页面引用；文档提取文字供 AI 参考</small>
      </label>
      {assets.length === 0 ? (
        <div className="panel-empty muted">暂无素材</div>
      ) : (
        <ul className="asset-list">
          {assets.map((a) => (
            <li key={a.id}>
              {a.kind === 'image' ? <img src={a.url} alt="" /> : <div className="doc-icon">📄</div>}
              <div className="asset-info">
                <div className="asset-name" title={a.filename}>{a.filename}</div>
                <div className="muted small">{fileSize(a.size)}{a.kind === 'document' ? (a.hasText ? ' · 已提取文字' : ' · 无文字') : ''}</div>
              </div>
              <button className="icon-btn" onClick={() => remove(a)} title="删除">✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
