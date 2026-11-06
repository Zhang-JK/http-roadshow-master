import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ProjectFile } from '../types';
import { useToast } from './Toast';

interface Props {
  projectId: string;
  versionNo: number;
  /** Show the files of this past version (read-only) instead of the current ones. */
  previewVersionId?: number;
  onLocatePage: (pageId: string) => void;
  onChange: () => void;
}

const GROUPS: { kind: ProjectFile['kind']; title: string }[] = [
  { kind: 'readme', title: '生成说明' },
  { kind: 'css', title: '样式' },
  { kind: 'page', title: '页面' },
];

export function FilesPanel({ projectId, versionNo, previewVersionId, onLocatePage, onChange }: Props) {
  const toast = useToast();
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [generated, setGenerated] = useState(false);
  const [open, setOpen] = useState('README.md');
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .get<{ files: ProjectFile[]; generatedReadme: boolean }>(`/api/projects/${projectId}/files${previewVersionId ? `?version=${previewVersionId}` : ''}`)
      .then((r) => {
        if (!live) return;
        setFiles(r.files);
        setGenerated(r.generatedReadme);
      })
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [projectId, versionNo, previewVersionId]);

  useEffect(() => {
    if (previewVersionId) setEditing(null);
  }, [previewVersionId]);

  const save = async () => {
    if (editing === null) return;
    setSaving(true);
    try {
      await api.put(`/api/projects/${projectId}/readme`, { readme: editing });
      toast('README 已保存为新版本，之后的 AI 修改会以它为准', 'success');
      setEditing(null);
      onChange();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!files) return <div className="panel-empty muted">加载中…</div>;
  if (!files.length) return <div className="panel-empty muted">暂无文件</div>;
  const current = files.find((f) => f.path === open) ?? files[0];
  return (
    <div className="files" data-testid="files-panel">
      <div className="file-tree">
        {GROUPS.map((g) => {
          const items = files.filter((f) => f.kind === g.kind);
          if (!items.length) return null;
          return (
            <div key={g.kind} className="file-group">
              <div className="file-group-title muted small">{g.title}</div>
              {items.map((f) => (
                <button key={f.path} className={`file-item ${current.path === f.path ? 'on' : ''}`} onClick={() => setOpen(f.path)} data-testid="file-item">
                  <code>{f.path}</code>
                  <span className="muted small">{f.kind === 'page' ? `P${f.page}` : `${f.chars.toLocaleString()} 字`}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="file-view">
        <div className="file-view-head">
          <code>{current.path}</code>
          <span className="spacer" />
          {current.kind === 'page' && current.pageId && !previewVersionId && (
            <button className="btn btn-ghost btn-xs" onClick={() => onLocatePage(current.pageId!)}>定位到此页</button>
          )}
          {current.kind === 'readme' && !previewVersionId && editing === null && (
            <button className="btn btn-ghost btn-xs" onClick={() => setEditing(current.content)} data-testid="readme-edit">编辑</button>
          )}
        </div>
        {current.kind === 'readme' && (
          <p className="muted small file-note">
            README 记录用户的需求、风格约定与页面规划，AI 每次修改前都会先读它；修改记录由系统自动追加。
            {generated && ' 此项目创建于 README 功能之前，下面是根据创建时的需求自动整理的版本。'}
          </p>
        )}
        {editing !== null && current.kind === 'readme' ? (
          <div className="readme-editor">
            <textarea value={editing} onChange={(e) => setEditing(e.target.value)} rows={18} data-testid="readme-text" />
            <div className="row gap">
              <button className="btn btn-primary btn-sm" disabled={saving || !editing.trim()} onClick={save} data-testid="readme-save">
                {saving ? '保存中…' : '保存为新版本'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>取消</button>
            </div>
          </div>
        ) : (
          <pre className={`file-content ${current.kind}`} data-testid="file-content">{current.content}</pre>
        )}
      </div>
    </div>
  );
}
