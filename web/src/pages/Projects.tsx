import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { Folder, Project, ProjectType } from '../types';
import { SlideFrame } from '../components/SlideFrame';
import { CreateDialog } from '../components/CreateDialog';
import { FolderNameDialog, MoveDialog } from '../components/FolderDialogs';
import { useToast } from '../components/Toast';
import { TYPE_LABELS, timeAgo } from '../lib/format';
import { folderChain, folderPath } from '../lib/folders';

const DRAG_TYPE = 'application/x-roadshow-deck';

export function ProjectsPage({ type }: { type: ProjectType }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [moving, setMoving] = useState<Project | null>(null);
  const [naming, setNaming] = useState<{ folder?: Folder } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const decks = type === 'deck';

  const load = useCallback(() => {
    api
      .get<{ projects: Project[] }>(`/api/projects?type=${type}`)
      .then((r) => setProjects(r.projects))
      .catch((e) => toast(e.message, 'error'));
    if (type === 'deck') {
      api
        .get<{ folders: Folder[] }>('/api/folders')
        .then((r) => {
          setFolders(r.folders);
          setFoldersLoaded(true);
        })
        .catch((e) => toast(e.message, 'error'));
    }
  }, [type, toast]);

  useEffect(() => {
    setProjects(null);
    load();
  }, [load]);

  // Poll faster while something runs; slowly otherwise, to notice edits other users start.
  const running = !!projects?.some((p) => p.status === 'generating' || p.busy);
  useEffect(() => {
    const t = setInterval(load, running ? 3000 : 10_000);
    return () => clearInterval(t);
  }, [running, load]);

  const asked = decks ? params.get('folder') : null;
  // A folder someone else deleted: back to the top level.
  const current = asked && (!foldersLoaded || folders.some((f) => f.id === asked)) ? asked : null;
  const chain = folderChain(folders, current);
  const openFolder = (id: string | null) => {
    setQuery('');
    setParams(id ? { folder: id } : {}, { replace: false });
  };

  const act = async (run: () => Promise<unknown>, done: string) => {
    try {
      await run();
      toast(done, 'success');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const remove = (p: Project) => {
    if (!confirm(`确定删除「${p.name}」？此操作不可恢复。${p.archivedAt ? '' : '\n不再使用但想保留的话，可以选择归档。'}`)) return;
    act(() => api.del(`/api/projects/${p.id}`), '已删除');
  };
  const archive = (p: Project, archived: boolean) =>
    act(() => api.patch(`/api/projects/${p.id}`, { archived }), archived ? `已归档「${p.name}」` : `已取消归档「${p.name}」`);
  const moveTo = (p: Project, folderId: string | null) => {
    if ((p.folderId ?? null) === folderId) return;
    act(() => api.patch(`/api/projects/${p.id}`, { folderId }), `已移到「${folderPath(folders, folderId) || '全部材料'}」`);
  };
  const removeFolder = (f: Folder) => {
    const has = f.deckCount + f.archivedCount + f.folderCount > 0;
    const up = folderPath(folders, f.parentId) || '全部材料';
    if (!confirm(`确定删除文件夹「${f.name}」？${has ? `\n其中的材料和子文件夹不会删除，会移到「${up}」。` : ''}`)) return;
    act(async () => {
      await api.del(`/api/folders/${f.id}`);
      if (chain.some((c) => c.id === f.id)) openFolder(f.parentId);
    }, '已删除文件夹');
  };

  const dropTarget = (id: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropOn(id ?? '');
    },
    onDragLeave: () => setDropOn((d) => (d === (id ?? '') ? null : d)),
    onDrop: (e: DragEvent) => {
      const pid = e.dataTransfer.getData(DRAG_TYPE);
      setDropOn(null);
      const p = projects?.find((x) => x.id === pid);
      if (!p) return;
      e.preventDefault();
      moveTo(p, id);
    },
  });

  const label = TYPE_LABELS[type];
  const q = query.trim().toLowerCase();
  const all = projects ?? [];
  // Searching looks through every folder; otherwise the current folder is shown.
  const here = (p: Project) => (q ? p.name.toLowerCase().includes(q) : !decks || (p.folderId ?? null) === current);
  const list = all.filter((p) => !p.archivedAt && here(p));
  const archived = all.filter((p) => p.archivedAt && here(p));
  const subfolders = decks ? folders.filter((f) => (q ? f.name.toLowerCase().includes(q) : f.parentId === current)) : [];
  const nothing = !list.length && !subfolders.length;

  const card = (p: Project) => (
    <div
      key={p.id}
      className={`project-card ${p.archivedAt ? 'archived' : ''}`}
      onClick={() => nav(`/p/${p.id}`)}
      data-testid="project-card"
      draggable={decks && !p.archivedAt}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, p.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => setDropOn(null)}
    >
      <div className="thumb" style={{ aspectRatio: `${p.width} / ${p.height}` }}>
        {p.status === 'ready' && p.firstPageId ? (
          <SlideFrame src={`/api/projects/${p.id}/html?pageId=${p.firstPageId}&v=${p.versionNo}`} width={p.width} height={p.height} title={p.name} />
        ) : p.status === 'generating' ? (
          <div className="thumb-state"><div className="spinner" /><span>{p.asking ? 'AI 在等你回答问题' : 'AI 生成中…'}</span></div>
        ) : (
          <div className="thumb-state error"><span>生成失败</span></div>
        )}
      </div>
      <div className="card-body">
        <div className="card-title">
          {p.busy && p.status !== 'generating' ? (
            <span className="busy-flag" title={`${p.busy} 个修改任务进行中`} data-testid="busy-badge">
              <span className="spinner tiny" />
            </span>
          ) : null}
          {p.name}
          {p.asking && <span className="pill pill-ask q-flag" data-testid="asking-badge">待回答</span>}
          {p.share && <span className="badge badge-shared" title="有分享链接，无需登录即可查看" data-testid="shared-badge">已分享</span>}
        </div>
        <div className="card-meta">
          <span>{p.pageCount} 页</span>
          <span>·</span>
          <span>v{p.versionNo}</span>
          <span>·</span>
          <span title={new Date(p.updatedAt).toLocaleString()}>
            {p.updatedBy ?? p.createdBy} {timeAgo(p.updatedAt)}
          </span>
          {decks && q && p.folderId && (
            <span className="card-folder" title="所在文件夹" data-testid="card-folder">📁 {folderPath(folders, p.folderId)}</span>
          )}
          {p.archivedAt && (
            <span title={new Date(p.archivedAt).toLocaleString()}>
              · {p.archivedBy ? `${p.archivedBy} ` : ''}归档于 {timeAgo(p.archivedAt)}
            </span>
          )}
        </div>
      </div>
      <div className="card-actions" onClick={(e) => e.stopPropagation()}>
        {decks && (
          <button className="icon-btn" title="移动到文件夹" onClick={() => setMoving(p)} data-testid="card-move">
            📂
          </button>
        )}
        {p.archivedAt ? (
          <button className="icon-btn" title="取消归档" onClick={() => archive(p, false)} data-testid="card-unarchive">
            ↩
          </button>
        ) : (
          <button className="icon-btn" title={type === 'template' ? '归档（不再出现在新建材料的模板中）' : '归档'} onClick={() => archive(p, true)} data-testid="card-archive">
            🗄
          </button>
        )}
        <button className="icon-btn" title="删除" onClick={() => remove(p)} data-testid="card-del">
          🗑
        </button>
      </div>
    </div>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{type === 'template' ? '路演模板' : '路演材料'}</h1>
          <p className="muted">
            {type === 'template' ? '模板定义了风格、配色与版式，是生成路演材料的基础。' : '基于模板，结合你的内容与支持材料生成完整的路演材料。'}
          </p>
        </div>
        <div className="row gap">
          <input className="search" placeholder={decks ? '搜索全部材料与文件夹…' : `搜索${label}…`} value={query} onChange={(e) => setQuery(e.target.value)} />
          {decks && (
            <button className="btn" onClick={() => setNaming({})} data-testid="new-folder-btn">
              ＋ 新建文件夹
            </button>
          )}
          <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="create-btn">
            ＋ 新建{label}
          </button>
        </div>
      </div>

      {decks && (
        <nav className="crumbs" aria-label="文件夹路径" data-testid="crumbs">
          {[null, ...chain].map((f, i) => {
            const id = f?.id ?? null;
            const last = i === chain.length;
            return (
              <span key={id ?? 'root'} className="crumb-item">
                {i > 0 && <span className="crumb-sep">/</span>}
                <button
                  type="button"
                  className={`crumb ${last ? 'current' : ''} ${dropOn === (id ?? '') ? 'drop' : ''}`}
                  onClick={() => !last && openFolder(id)}
                  {...(last ? {} : dropTarget(id))}
                >
                  {f ? f.name : '全部材料'}
                </button>
              </span>
            );
          })}
          {q && <span className="muted small crumb-note">· 正在搜索全部文件夹</span>}
          {chain.length > 0 && !q && (
            <span className="crumb-tools">
              <button className="link" onClick={() => setNaming({ folder: chain[chain.length - 1] })} data-testid="rename-folder">重命名</button>
              <button className="link danger" onClick={() => removeFolder(chain[chain.length - 1])} data-testid="delete-current-folder">删除文件夹</button>
            </span>
          )}
        </nav>
      )}

      {projects === null ? (
        <div className="center"><div className="spinner" /></div>
      ) : nothing && !archived.length ? (
        <div className="empty">
          <div className="empty-icon">{q ? '🔍' : current ? '📁' : type === 'template' ? '🎨' : '📊'}</div>
          <p>{q ? `没有找到「${query.trim()}」` : current ? '这个文件夹还是空的' : `还没有${label}`}</p>
          {!q && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              {current ? `在这里新建${label}` : `新建第一个${label}`}
            </button>
          )}
        </div>
      ) : (
        <>
          {subfolders.length > 0 && (
            <div className="folder-grid" data-testid="folder-grid">
              {subfolders.map((f) => (
                <div
                  key={f.id}
                  className={`folder-card ${dropOn === f.id ? 'drop' : ''}`}
                  onClick={() => openFolder(f.id)}
                  data-testid="folder-card"
                  {...dropTarget(f.id)}
                >
                  <span className="folder-icon" aria-hidden>📁</span>
                  <div className="folder-text">
                    <div className="folder-name">{f.name}</div>
                    <div className="folder-meta">
                      {q && f.parentId ? `${folderPath(folders, f.parentId)} · ` : ''}
                      {f.deckCount} 份材料{f.folderCount ? ` · ${f.folderCount} 个文件夹` : ''}
                      {f.archivedCount ? ` · ${f.archivedCount} 份已归档` : ''}
                    </div>
                  </div>
                  <div className="folder-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" title="重命名" onClick={() => setNaming({ folder: f })} data-testid="folder-rename">✏️</button>
                    <button className="icon-btn" title="删除文件夹（其中的材料移到上一级）" onClick={() => removeFolder(f)} data-testid="folder-del">🗑</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {list.length > 0 ? (
            <div className="card-grid">{list.map(card)}</div>
          ) : (
            nothing && <div className="empty small muted">{q ? `没有找到「${query.trim()}」` : current ? '这个文件夹里没有未归档的材料' : `没有未归档的${label}`}</div>
          )}
          {archived.length > 0 && (
            <details className="archive-section" data-testid="archived-section">
              <summary>
                <span className="archive-caret" aria-hidden>▸</span>
                已归档 <span className="badge">{archived.length}</span>
                <span className="muted small">
                  {type === 'template' ? '归档的模板不会出现在新建路演材料的模板列表中，已有的材料不受影响' : '归档的材料仍可打开、修改和导出'}
                </span>
              </summary>
              <div className="card-grid">{archived.map(card)}</div>
            </details>
          )}
        </>
      )}
      {creating && (
        <CreateDialog
          type={type}
          folderId={current}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            nav(`/p/${id}`);
          }}
        />
      )}
      {moving && (
        <MoveDialog
          project={moving}
          folders={folders}
          onClose={() => setMoving(null)}
          onMoved={() => {
            setMoving(null);
            load();
          }}
        />
      )}
      {naming && (
        <FolderNameDialog
          folders={folders}
          parentId={current}
          folder={naming.folder}
          onClose={() => setNaming(null)}
          onSaved={() => {
            setNaming(null);
            load();
          }}
        />
      )}
    </div>
  );
}
