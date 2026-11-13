import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import type { DeckDoc, ProjectType } from '../types';
import { SlideFrame } from '../components/SlideFrame';
import { fullTime, TYPE_LABELS } from '../lib/format';

interface ShareResponse {
  /** `id` only comes to a signed-in visitor. */
  project: { id?: string; type: ProjectType; name: string; versionNo: number; status: 'generating' | 'ready' | 'error'; updatedAt: number };
  doc: Omit<DeckDoc, 'readme'> | null;
  canEdit: boolean;
}

const NEXT = ['ArrowRight', 'ArrowDown', 'PageDown', ' '];
const PREV = ['ArrowLeft', 'ArrowUp', 'PageUp'];

/** The project behind a share link: read-only, no sign-in needed. Signed-in visitors can open it in the editor. */
export function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const [data, setData] = useState<ShareResponse | null>(null);
  const [error, setError] = useState('');
  const [wanted, setIndex] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api
      .get<ShareResponse>(`/api/share/${token}`)
      .then((r) => {
        setData(r);
        setError('');
      })
      .catch((e) => setError((e as Error).message));
  }, [token]);

  // Signing in or out changes whether the link leads on to the editor.
  useEffect(load, [load, user?.id]);
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const doc = data?.doc;
  const pages = doc?.pages ?? [];
  const index = Math.min(wanted, Math.max(0, pages.length - 1));
  const current = pages[index];
  const editId = data?.canEdit ? data.project.id : undefined;

  useEffect(() => {
    if (data) document.title = `${data.project.name} · 路演工坊`;
  }, [data]);

  // Back from signing in to edit: go straight on to the editor.
  useEffect(() => {
    if (editId && params.get('edit')) nav(`/p/${editId}`, { replace: true });
  }, [editId, params, nav]);

  const go = useCallback((d: number) => setIndex((i) => Math.max(0, Math.min(pages.length - 1, i + d))), [pages.length]);

  const stop = useCallback(() => {
    setPresenting(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, []);

  const present = () => {
    setPresenting(true);
    stageRef.current?.requestFullscreen?.().catch(() => {});
  };

  useEffect(() => {
    const onChange = () => !document.fullscreenElement && setPresenting(false);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el?.closest?.('input, textarea') || (e.key === ' ' && el?.closest?.('button, a'))) return;
      if (NEXT.includes(e.key)) go(1);
      else if (PREV.includes(e.key)) go(-1);
      else if (e.key === 'Home') setIndex(0);
      else if (e.key === 'End') setIndex(pages.length - 1);
      else if (e.key === 'Escape' && presenting) stop();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, pages.length, presenting, stop]);

  if (error)
    return (
      <div className="share-empty">
        <img src="/favicon.svg" alt="" width={48} />
        <h2>{error}</h2>
        <p className="muted">请向分享者索取新的链接。</p>
        {user ? <Link className="btn" to="/decks">进入路演工坊</Link> : <Link className="btn" to="/login">登录路演工坊</Link>}
      </div>
    );
  if (!data) return <div className="center-screen"><div className="spinner" /></div>;

  return (
    <div className="share">
      <header className="share-top">
        <span className="brand">
          <img src="/favicon.svg" alt="" />
          <span>路演工坊</span>
        </span>
        <h1 className="share-title" data-testid="share-title">{data.project.name}</h1>
        <span className="muted small share-meta">
          {TYPE_LABELS[data.project.type]} · v{data.project.versionNo} · 更新于 {fullTime(data.project.updatedAt)}
        </span>
        <div className="spacer" />
        {doc && (
          <button className="btn" onClick={present} data-testid="share-present">▶ 放映</button>
        )}
        {editId ? (
          <Link className="btn btn-primary" to={`/p/${editId}`} data-testid="share-edit">编辑</Link>
        ) : (
          <button className="btn btn-primary" onClick={() => nav('/login', { state: { from: `/s/${token}?edit=1` } })} data-testid="share-login">
            登录后编辑
          </button>
        )}
      </header>

      {!doc ? (
        <div className="gen-state">
          <h2>{data.project.status === 'generating' ? '这份材料正在生成中' : '这份材料还没有可查看的内容'}</h2>
          <p className="muted">{data.project.status === 'generating' ? '生成完成后刷新本页即可查看。' : '请稍后再来，或联系分享者。'}</p>
        </div>
      ) : (
        <div className="share-body">
          <aside className="pages-rail share-rail">
            <div className="rail-head">页面 <span className="muted">{pages.length}</span></div>
            <div className="rail-list">
              {pages.map((p, i) => (
                <div key={p.id} className={`rail-item ${p.id === current?.id ? 'on' : ''}`} onClick={() => setIndex(i)} data-testid="share-thumb">
                  <span className="rail-no">{i + 1}</span>
                  <div className="rail-thumb" style={{ aspectRatio: `${doc.width} / ${doc.height}` }}>
                    <SlideFrame doc={doc} pageId={p.id} width={doc.width} height={doc.height} />
                  </div>
                </div>
              ))}
            </div>
          </aside>
          <section className="stage-col">
            <div className="stage-toolbar">
              <button className="btn btn-sm" onClick={() => go(-1)} disabled={index === 0} data-testid="share-prev">‹ 上一页</button>
              <span className="page-indicator" data-testid="share-indicator">第 {index + 1} / {pages.length} 页</span>
              <button className="btn btn-sm" onClick={() => go(1)} disabled={index >= pages.length - 1} data-testid="share-next">下一页 ›</button>
              <div className="spacer" />
              <span className="muted small hint">← → 翻页 · 放映时单击下一页，Esc 退出</span>
            </div>
            <div
              ref={stageRef}
              className={`stage share-stage ${presenting ? 'presenting' : ''}`}
              onClick={() => presenting && (index < pages.length - 1 ? go(1) : stop())}
              data-testid="share-stage"
            >
              {current && (
                <SlideFrame doc={doc} pageId={current.id} width={doc.width} height={doc.height} fitHeight className="stage-frame" title="页面" />
              )}
              {presenting && (
                <button className="present-exit" onClick={(e) => { e.stopPropagation(); stop(); }} aria-label="退出放映" data-testid="share-exit">
                  ✕
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
