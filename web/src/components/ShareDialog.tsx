import { useState } from 'react';
import { api } from '../api';
import type { Project, ShareInfo } from '../types';
import { fullTime, TYPE_LABELS } from '../lib/format';
import { Modal } from './Modal';
import { useToast } from './Toast';

const shareUrl = (token: string) => `${window.location.origin}/s/${token}`;

/** The Clipboard API needs a secure context; plain-HTTP deployments fall back to a selection copy. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

interface Props {
  project: Project;
  onChanged: (share: ShareInfo | null) => void;
  onClose: () => void;
}

export function ShareDialog({ project, onChanged, onClose }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const share = project.share;
  const url = share ? shareUrl(share.token) : '';
  const kind = TYPE_LABELS[project.type];

  const run = async (fn: () => Promise<{ share: ShareInfo | null }>, done?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      onChanged(r.share);
      if (done) toast(done, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => toast((await copyText(url)) ? '链接已复制' : '复制失败，请手动选中链接复制', 'success');

  return (
    <Modal
      title={`分享${kind}`}
      onClose={onClose}
      footer={
        share ? (
          <>
            <button
              className="btn"
              disabled={busy}
              onClick={() => confirm('重置后旧链接立即失效，确定生成新链接？') && run(() => api.post(`/api/projects/${project.id}/share`, { reset: true }), '已生成新链接，旧链接已失效')}
              data-testid="share-reset"
            >
              重置链接
            </button>
            <div className="spacer" />
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => confirm('关闭后链接立即失效，确定关闭分享？') && run(() => api.del(`/api/projects/${project.id}/share`), '已关闭分享')}
              data-testid="share-stop"
            >
              关闭分享
            </button>
          </>
        ) : undefined
      }
    >
      {share ? (
        <div className="share-dialog">
          <p>任何拿到链接的人都<b>无需登录</b>即可查看这份{kind}的最新内容；已登录的用户可以从链接直接进入编辑。</p>
          <div className="share-link-row">
            <input readOnly value={url} onFocus={(e) => e.target.select()} data-testid="share-url" />
            <button className="btn btn-primary" onClick={copy} data-testid="share-copy">复制链接</button>
          </div>
          <p className="muted small">
            {share.sharedBy ?? '有人'}
            {share.sharedAt ? ` 于 ${fullTime(share.sharedAt)}` : ''} 开启 ·{' '}
            <a className="link" href={url} target="_blank" rel="noopener noreferrer" data-testid="share-open">在新窗口打开</a>
          </p>
        </div>
      ) : (
        <div className="share-dialog">
          <p>生成一个分享链接：任何拿到链接的人都<b>无需登录</b>即可查看这份{kind}的最新内容；已登录的用户可以从链接直接进入编辑。</p>
          <p className="muted small">随时可以重置或关闭链接，关闭后链接立即失效。</p>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => run(() => api.post(`/api/projects/${project.id}/share`), '已生成分享链接')}
            data-testid="share-create"
          >
            {busy ? '生成中…' : '生成分享链接'}
          </button>
        </div>
      )}
    </Modal>
  );
}
