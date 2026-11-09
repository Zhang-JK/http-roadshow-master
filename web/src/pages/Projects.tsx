import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { Project, ProjectType } from '../types';
import { SlideFrame } from '../components/SlideFrame';
import { CreateDialog } from '../components/CreateDialog';
import { useToast } from '../components/Toast';
import { TYPE_LABELS, timeAgo } from '../lib/format';

export function ProjectsPage({ type }: { type: ProjectType }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const nav = useNavigate();
  const toast = useToast();

  const load = useCallback(() => {
    api
      .get<{ projects: Project[] }>(`/api/projects?type=${type}`)
      .then((r) => setProjects(r.projects))
      .catch((e) => toast(e.message, 'error'));
  }, [type, toast]);

  useEffect(() => {
    setProjects(null);
    load();
  }, [load]);

  useEffect(() => {
    if (!projects?.some((p) => p.status === 'generating')) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [projects, load]);

  const remove = async (p: Project) => {
    if (!confirm(`确定删除「${p.name}」？此操作不可恢复。`)) return;
    try {
      await api.del(`/api/projects/${p.id}`);
      toast('已删除', 'success');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const label = TYPE_LABELS[type];
  const list = (projects ?? []).filter((p) => !query || p.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{type === 'template' ? '路演模板' : '路演材料'}</h1>
          <p className="muted">
            {type === 'template'
              ? '模板定义了风格、配色与版式，是生成路演材料的基础。'
              : '基于模板，结合你的内容与支持材料生成完整的路演材料。'}
          </p>
        </div>
        <div className="row gap">
          <input className="search" placeholder={`搜索${label}…`} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="create-btn">
            ＋ 新建{label}
          </button>
        </div>
      </div>

      {projects === null ? (
        <div className="center"><div className="spinner" /></div>
      ) : list.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">{type === 'template' ? '🎨' : '📊'}</div>
          <p>还没有{label}</p>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>新建第一个{label}</button>
        </div>
      ) : (
        <div className="card-grid">
          {list.map((p) => (
            <div key={p.id} className="project-card" onClick={() => nav(`/p/${p.id}`)} data-testid="project-card">
              <div className="thumb" style={{ aspectRatio: `${p.width} / ${p.height}` }}>
                {p.status === 'ready' && p.firstPageId ? (
                  <SlideFrame
                    src={`/api/projects/${p.id}/html?pageId=${p.firstPageId}&v=${p.versionNo}`}
                    width={p.width}
                    height={p.height}
                    title={p.name}
                  />
                ) : p.status === 'generating' ? (
                  <div className="thumb-state"><div className="spinner" /><span>{p.asking ? 'AI 在等你回答问题' : 'AI 生成中…'}</span></div>
                ) : (
                  <div className="thumb-state error"><span>生成失败</span></div>
                )}
              </div>
              <div className="card-body">
                <div className="card-title">{p.name}{p.asking && <span className="pill pill-ask q-flag" data-testid="asking-badge">待回答</span>}</div>
                <div className="card-meta">
                  <span>{p.pageCount} 页</span>
                  <span>·</span>
                  <span>v{p.versionNo}</span>
                  <span>·</span>
                  <span title={new Date(p.updatedAt).toLocaleString()}>
                    {p.updatedBy ?? p.createdBy} {timeAgo(p.updatedAt)}
                  </span>
                </div>
              </div>
              <button
                className="card-del icon-btn"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(p);
                }}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}
      {creating && (
        <CreateDialog
          type={type}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            nav(`/p/${id}`);
          }}
        />
      )}
    </div>
  );
}
