import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, download } from '../api';
import { useAuth } from '../auth';
import type { Asset, DeckDoc, Job, Project, SelectedElement, Version } from '../types';
import { reviewText } from '../types';
import { SlideFrame } from '../components/SlideFrame';
import { useToast } from '../components/Toast';
import { HistoryPanel } from '../components/HistoryPanel';
import { AssetsPanel } from '../components/AssetsPanel';
import { addFiles, RefFileList, SLIDES_ACCEPT, uploadRefFiles, type RefFile } from '../components/RefFiles';
import { TYPE_LABELS } from '../lib/format';

interface ProjectResponse {
  project: Project;
  template: { id: string; name: string } | null;
  assets: Asset[];
}

type ScopeMode = 'global' | 'page';

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [data, setData] = useState<ProjectResponse | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [pageId, setPageId] = useState<string>('');
  const [selection, setSelection] = useState<SelectedElement[]>([]);
  const [scopeMode, setScopeMode] = useState<ScopeMode>('global');
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<RefFile[]>([]);
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState<'history' | 'assets'>('history');
  const [preview, setPreview] = useState<{ version: Version; doc: DeckDoc } | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportMenu, setExportMenu] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const frameRef = useRef<HTMLIFrameElement>(null);
  const versionRef = useRef(-1);
  const myJobs = useRef(new Set<string>());

  const project = data?.project;
  const liveDoc = project?.doc;
  const doc = preview?.doc ?? liveDoc;
  const pages = doc?.pages ?? [];
  const pageIndex = Math.max(0, pages.findIndex((p) => p.id === pageId));
  const currentPage = pages[pageIndex];

  const loadProject = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.get<ProjectResponse>(`/api/projects/${id}`);
      if (r.project.versionNo !== versionRef.current) {
        versionRef.current = r.project.versionNo;
        setData(r);
        api.get<{ versions: Version[] }>(`/api/projects/${id}/versions`).then((v) => setVersions(v.versions));
      } else {
        setData((d) => (d ? { ...d, assets: r.assets, project: { ...d.project, status: r.project.status, error: r.project.error, name: r.project.name } } : r));
      }
    } catch (e) {
      toast((e as Error).message, 'error');
      if ((e as { status?: number }).status === 404) nav('/templates');
    }
  }, [id, nav, toast]);

  const loadJobs = useCallback(async () => {
    if (!id) return;
    const r = await api.get<{ jobs: Job[] }>(`/api/projects/${id}/jobs?active=1`).catch(() => null);
    if (!r) return;
    setJobs(r.jobs);
    const active = new Set(r.jobs.map((j) => j.id));
    for (const jid of [...myJobs.current]) {
      if (active.has(jid)) continue;
      myJobs.current.delete(jid);
      const { job } = await api.get<{ job: Job }>(`/api/jobs/${jid}`);
      if (job.status === 'done')
        toast(`${job.kind === 'create' ? '生成完成' : '修改已应用'}${job.review ? `（${reviewText(job.review)}）` : ''}`, 'success');
      else if (job.status === 'error') toast(`${job.kind === 'create' ? '生成' : '修改'}失败：${job.error}`, 'error');
      loadProject();
    }
  }, [id, toast, loadProject]);

  useEffect(() => {
    versionRef.current = -1;
    setData(null);
    setPreview(null);
    setSelection([]);
    loadProject();
    loadJobs();
  }, [id, loadProject, loadJobs]);

  useEffect(() => {
    const t1 = setInterval(loadProject, 4000);
    const t2 = setInterval(loadJobs, jobs.length ? 1500 : 4000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [loadProject, loadJobs, jobs.length]);

  // Track jobs started by me (including the initial generation) so I get notified when they finish.
  useEffect(() => {
    for (const j of jobs) if (j.userId === user?.id) myJobs.current.add(j.id);
  }, [jobs, user]);

  useEffect(() => {
    if (!pages.length) return;
    if (!pages.some((p) => p.id === pageId)) setPageId(pages[0].id);
  }, [pages, pageId]);

  useEffect(() => {
    setSelection([]);
  }, [pageId, preview]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.source !== 'rs-frame' || e.source !== frameRef.current?.contentWindow) return;
      setSelection(e.data.items as SelectedElement[]);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const goPage = useCallback(
    (delta: number) => {
      if (!pages.length) return;
      const next = Math.max(0, Math.min(pages.length - 1, pageIndex + delta));
      setPageId(pages[next].id);
    },
    [pages, pageIndex],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') goPage(1);
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') goPage(-1);
      if (e.key === 'Escape') setSelection([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPage]);

  const postToFrame = (msg: unknown) => frameRef.current?.contentWindow?.postMessage(msg, '*');
  const clearSelection = () => postToFrame({ type: 'rs-set-selection', eids: [] });

  const pageOnlySelected = selection.length === 1 && selection[0].isPage;
  const effectiveScope: 'global' | 'page' | 'element' =
    selection.length && !pageOnlySelected ? 'element' : pageOnlySelected ? 'page' : scopeMode;

  const scopeText =
    effectiveScope === 'element'
      ? `第 ${pageIndex + 1} 页 · 选中 ${selection.length} 个元素`
      : effectiveScope === 'page'
        ? `第 ${pageIndex + 1} 页（整页）`
        : `整份材料（共 ${pages.length} 页）`;

  const send = async () => {
    if (!prompt.trim() || !project) return;
    setSending(true);
    try {
      const attachmentIds = attachments.length ? await uploadRefFiles(api.post, project.id, attachments) : [];
      const r = await api.post<{ job: Job }>(`/api/projects/${project.id}/edit`, {
        prompt: prompt.trim(),
        scope: effectiveScope,
        pageId: effectiveScope === 'global' ? undefined : currentPage?.id,
        elementIds: effectiveScope === 'element' ? selection.map((s) => s.eid) : [],
        attachmentIds,
      });
      if (attachmentIds.length) {
        setAttachments([]);
        loadProject();
      }
      myJobs.current.add(r.job.id);
      setJobs((j) => [...j, { ...r.job, userName: user?.displayName }]);
      setPrompt('');
      toast(`已提交：${scopeText}`, 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };

  const pageOp = async (op: 'delete' | 'duplicate' | 'move', pid: string, toIndex?: number) => {
    if (!project) return;
    if (op === 'delete' && !confirm('确定删除这一页？（可在历史记录中恢复）')) return;
    try {
      await api.post(`/api/projects/${project.id}/pages/${pid}/${op}`, { toIndex });
      await loadProject();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const doExport = async (format: 'html' | 'pdf' | 'pdf-image' | 'pptx') => {
    if (!project) return;
    setExportMenu(false);
    setExporting(format === 'pdf-image' ? 'pdf' : format);
    try {
      const v = preview ? `&version=${preview.version.id}` : '';
      const ext = format === 'pdf-image' ? 'pdf' : format;
      await download(`/api/projects/${project.id}/export?format=${format}${v}`, `${project.name}.${ext}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setExporting(null);
    }
  };

  const openPreview = async (v: Version) => {
    const r = await api.get<{ doc: DeckDoc }>(`/api/projects/${id}/versions/${v.id}`);
    setPreview({ version: v, doc: r.doc });
  };

  const revert = async (v: Version) => {
    if (!confirm(`确定将项目恢复到 v${v.versionNo}？当前内容会保留在历史记录中。`)) return;
    try {
      await api.post(`/api/projects/${id}/versions/${v.id}/revert`);
      setPreview(null);
      toast(`已恢复到 v${v.versionNo}`, 'success');
      loadProject();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const locateElement = (pageNo: number | undefined, eid: string) => {
    if (preview) setPreview(null);
    const target = pageNo ? pages[pageNo - 1] : undefined;
    if (target && target.id !== pageId) setPageId(target.id);
    setTimeout(() => postToFrame({ type: 'rs-flash', eid }), target && target.id !== pageId ? 600 : 50);
  };

  const saveName = async () => {
    setEditingName(false);
    if (!project || !nameDraft.trim() || nameDraft.trim() === project.name) return;
    try {
      await api.patch(`/api/projects/${project.id}`, { name: nameDraft.trim() });
      loadProject();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const createJob = jobs.find((j) => j.kind === 'create');
  const editJobs = jobs.filter((j) => j.kind === 'edit');
  const initialSelection = useMemo(() => selection.map((s) => s.eid), [doc]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) return <div className="center-screen"><div className="spinner" /></div>;
  const backTo = project.type === 'template' ? '/templates' : '/decks';
  const hasContent = !!liveDoc?.pages.length;

  return (
    <div className="editor">
      <header className="editor-top">
        <Link to={backTo} className="btn btn-ghost">← 返回</Link>
        <span className={`badge badge-${project.type}`}>{TYPE_LABELS[project.type]}</span>
        {editingName ? (
          <input
            className="name-input"
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === 'Enter' && saveName()}
          />
        ) : (
          <h1 className="editor-title" title="点击重命名" onClick={() => { setNameDraft(project.name); setEditingName(true); }}>
            {project.name}
          </h1>
        )}
        <span className="muted small">v{project.versionNo} · {liveDoc?.width}×{liveDoc?.height}</span>
        {data?.template && (
          <Link className="muted small link" to={`/p/${data.template.id}`}>模板：{data.template.name}</Link>
        )}
        <div className="spacer" />
        {jobs.length > 0 && <span className="pill pill-busy"><span className="dot" /> {jobs.length} 个任务进行中</span>}
        <div className="export">
          <button className="btn btn-primary" disabled={!hasContent || !!exporting} onClick={() => setExportMenu((m) => !m)} data-testid="export-btn">
            {exporting ? `正在导出 ${exporting.toUpperCase()}…` : `导出${preview ? `（v${preview.version.versionNo}）` : ''} ▾`}
          </button>
          {exportMenu && (
            <div className="dropdown right" onMouseLeave={() => setExportMenu(false)}>
              <button onClick={() => doExport('html')}>下载 HTML（可直接演示）</button>
              <button onClick={() => doExport('pdf')}>导出 PDF（矢量，可选中文字）</button>
              <button onClick={() => doExport('pdf-image')}>导出 PDF（图片，与预览完全一致）</button>
              <button onClick={() => doExport('pptx')}>导出 PPT（.pptx）</button>
            </div>
          )}
        </div>
      </header>

      {!hasContent ? (
        <div className="gen-state">
          {project.status === 'error' ? (
            <>
              <div className="gen-icon">⚠️</div>
              <h2>生成失败</h2>
              <pre className="error-box">{project.error}</pre>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  try {
                    const r = await api.post<{ job: Job }>(`/api/projects/${project.id}/regenerate`);
                    myJobs.current.add(r.job.id);
                    loadProject();
                    loadJobs();
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
              >
                重新生成
              </button>
            </>
          ) : (
            <>
              <div className="spinner big" />
              <h2>AI 正在生成{TYPE_LABELS[project.type]}…</h2>
              <p className="muted">
                {createJob?.progress
                  ? `${createJob.progress.stage}${createJob.progress.chars ? ` · ${createJob.progress.chars.toLocaleString()} 字符` : ''}`
                  : '正在准备请求…'}
              </p>
              <p className="muted small">生成完整材料通常需要 1–3 分钟，你可以离开此页面，稍后回来查看。</p>
            </>
          )}
        </div>
      ) : (
        <div className="editor-body">
          <aside className="pages-rail">
            <div className="rail-head">页面 <span className="muted">{pages.length}</span></div>
            <div className="rail-list">
              {pages.map((p, i) => (
                <div key={p.id} className={`rail-item ${p.id === currentPage?.id ? 'on' : ''}`} onClick={() => setPageId(p.id)} data-testid="page-thumb">
                  <span className="rail-no">{i + 1}</span>
                  <div className="rail-thumb" style={{ aspectRatio: `${doc!.width} / ${doc!.height}` }}>
                    <SlideFrame doc={doc} pageId={p.id} width={doc!.width} height={doc!.height} />
                  </div>
                  {!preview && (
                    <div className="rail-ops" onClick={(e) => e.stopPropagation()}>
                      <button title="上移" disabled={i === 0} onClick={() => pageOp('move', p.id, i - 1)}>↑</button>
                      <button title="下移" disabled={i === pages.length - 1} onClick={() => pageOp('move', p.id, i + 1)}>↓</button>
                      <button title="复制此页" onClick={() => pageOp('duplicate', p.id)}>⧉</button>
                      <button title="删除此页" disabled={pages.length <= 1} onClick={() => pageOp('delete', p.id)} data-testid="page-delete">🗑</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </aside>

          <section className="stage-col">
            {preview && (
              <div className="preview-banner">
                正在预览历史版本 <strong>v{preview.version.versionNo}</strong>（{preview.version.userName}）
                <div className="spacer" />
                <button className="btn btn-sm" onClick={() => revert(preview.version)}>恢复此版本</button>
                <button className="btn btn-sm btn-ghost" onClick={() => setPreview(null)}>退出预览</button>
              </div>
            )}
            <div className="stage-toolbar">
              <button className="btn btn-sm" onClick={() => goPage(-1)} disabled={pageIndex === 0}>‹ 上一页</button>
              <span className="page-indicator" data-testid="page-indicator">第 {pageIndex + 1} / {pages.length} 页</span>
              <button className="btn btn-sm" onClick={() => goPage(1)} disabled={pageIndex >= pages.length - 1}>下一页 ›</button>
              <div className="spacer" />
              {!preview && <span className="muted small hint">单击选择元素 · Shift/⌘ 多选 · 拖动框选 · Esc 取消</span>}
            </div>
            <div className="stage">
              {currentPage && (
                <SlideFrame
                  ref={frameRef}
                  key={preview ? `pv-${preview.version.id}` : 'live'}
                  doc={doc}
                  pageId={currentPage.id}
                  width={doc!.width}
                  height={doc!.height}
                  editor={!preview}
                  initialSelection={initialSelection}
                  fitHeight
                  className="stage-frame"
                  title="页面预览"
                />
              )}
            </div>

            {!preview && (
              <div className="composer">
                {editJobs.length > 0 && (
                  <div className="job-list">
                    {editJobs.map((j) => (
                      <div key={j.id} className="job-item">
                        <div className="spinner tiny" />
                        <span className="job-user">{j.userName ?? '某用户'}</span>
                        <span className="job-scope">
                          {j.request.scope === 'global'
                            ? '整份材料'
                            : `第 ${pages.findIndex((p) => p.id === j.request.pageId) + 1} 页${j.request.scope === 'element' ? ` · ${j.request.elementIds?.length} 个元素` : ''}`}
                        </span>
                        <span className="job-prompt" title={j.request.prompt}>{j.request.prompt}</span>
                        <span className="muted small">{j.progress ? `${j.progress.stage} ${j.progress.chars ? `${j.progress.chars.toLocaleString()} 字符` : ''}` : '排队中'}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="scope-bar">
                  <span className="muted small">修改范围：</span>
                  {selection.length && !pageOnlySelected ? (
                    <>
                      <span className="scope-chip scope-element" data-testid="scope-chip">第 {pageIndex + 1} 页 · {selection.length} 个元素</span>
                      {selection.map((s, i) => (
                        <span key={s.eid} className="sel-chip" title={`<${s.tag}> ${s.text}`} onMouseEnter={() => postToFrame({ type: 'rs-flash', eid: s.eid })}>
                          <b>{i + 1}</b> {s.label}
                          {s.text && <em>“{s.text.slice(0, 14)}{s.text.length > 14 ? '…' : ''}”</em>}
                        </span>
                      ))}
                      <button className="btn btn-xs" onClick={() => postToFrame({ type: 'rs-select-parent' })}>选择上级</button>
                      <button className="btn btn-xs btn-ghost" onClick={clearSelection}>✕ 取消选择</button>
                    </>
                  ) : (
                    <div className="seg" data-testid="scope-seg">
                      <button className={effectiveScope === 'global' ? 'on' : ''} onClick={() => { if (pageOnlySelected) clearSelection(); setScopeMode('global'); }}>
                        整份材料
                      </button>
                      <button className={effectiveScope === 'page' ? 'on' : ''} onClick={() => setScopeMode('page')}>
                        仅第 {pageIndex + 1} 页
                      </button>
                    </div>
                  )}
                </div>
                <RefFileList files={attachments} onChange={setAttachments} />
                <div className="composer-row">
                  <label className="attach-btn" title="附加参考图片 / PPT / PDF / HTML：图片可嵌入页面或仅作参考，PPT/PDF/HTML 逐页转成图片交给 AI，并可只读查阅原文件">
                    <input
                      type="file"
                      multiple
                      accept={`image/*,${SLIDES_ACCEPT}`}
                      data-testid="attach-input"
                      onChange={(e) => {
                        setAttachments(addFiles(attachments, e.target.files, 'embed'));
                        e.target.value = '';
                      }}
                    />
                    📎
                  </label>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder={
                      effectiveScope === 'element'
                        ? '描述如何修改选中的元素，例如：把这个标题改成“三年营收增长 5 倍”，字号加大并改用强调色'
                        : effectiveScope === 'page'
                          ? `描述如何修改第 ${pageIndex + 1} 页，例如：改成左右分栏布局，右侧加一个柱状图`
                          : '描述对整份材料的调整，例如：整体换成深色主题；在第 3 页后新增一页竞品对比'
                    }
                    data-testid="prompt-input"
                  />
                  <button className="btn btn-primary send-btn" disabled={!prompt.trim() || sending} onClick={send} data-testid="send-btn">
                    {sending ? (attachments.length ? '上传中…' : '提交中…') : '发送'}
                    <small>⌘/Ctrl + Enter</small>
                  </button>
                </div>
              </div>
            )}
          </section>

          <aside className="side-panel">
            <div className="tabs">
              <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>修改历史 <span className="muted">{versions.length}</span></button>
              <button className={tab === 'assets' ? 'on' : ''} onClick={() => setTab('assets')}>素材 <span className="muted">{data?.assets.length ?? 0}</span></button>
            </div>
            {tab === 'history' ? (
              <HistoryPanel
                versions={versions}
                currentVersionNo={project.versionNo}
                previewId={preview?.version.id}
                onPreview={openPreview}
                onRevert={revert}
                onLocate={locateElement}
              />
            ) : (
              <AssetsPanel projectId={project.id} assets={data?.assets ?? []} onChange={loadProject} />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
