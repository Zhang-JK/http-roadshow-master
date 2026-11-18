import { useState } from 'react';
import { api } from '../api';
import type { Folder, Project } from '../types';
import { folderPath, folderTree } from '../lib/folders';
import { Modal } from './Modal';
import { useToast } from './Toast';

/** A folder picker; "" is the top level. */
export function FolderSelect({ folders, value, onChange, testId }: { folders: Folder[]; value: string; onChange: (id: string) => void; testId?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
      <option value="">全部材料（顶层）</option>
      {folderTree(folders).map(({ folder, depth }) => (
        <option key={folder.id} value={folder.id}>
          {`${'\u00a0\u00a0\u00a0\u00a0'.repeat(depth)}📁 ${folder.name}`}
        </option>
      ))}
    </select>
  );
}

/** New folder inside `parentId`, or rename `folder`. */
export function FolderNameDialog({
  folders,
  parentId,
  folder,
  onClose,
  onSaved,
}: {
  folders: Folder[];
  parentId: string | null;
  folder?: Folder;
  onClose: () => void;
  onSaved: (f: Folder) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(folder?.name ?? '');
  const [busy, setBusy] = useState(false);
  const where = folderPath(folders, folder ? folder.parentId : parentId) || '全部材料';
  const save = async () => {
    setBusy(true);
    try {
      const r = folder
        ? await api.patch<{ folder: Folder }>(`/api/folders/${folder.id}`, { name })
        : await api.post<{ folder: Folder }>('/api/folders', { name, parentId });
      toast(folder ? '已重命名' : '已新建文件夹', 'success');
      onSaved(r.folder);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <Modal
      title={folder ? '重命名文件夹' : '新建文件夹'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={save} data-testid="folder-save">
            {folder ? '保存' : '新建'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>文件夹名称</span>
        <input
          autoFocus
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && !busy && save()}
          placeholder="例如：2026 年 Q1 汇报"
          data-testid="folder-name"
        />
      </label>
      <p className="muted small">位置：{where}</p>
    </Modal>
  );
}

/** Moves a deck to another folder. */
export function MoveDialog({ project, folders, onClose, onMoved }: { project: Project; folders: Folder[]; onClose: () => void; onMoved: () => void }) {
  const toast = useToast();
  const [target, setTarget] = useState(project.folderId ?? '');
  const [busy, setBusy] = useState(false);
  const move = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/projects/${project.id}`, { folderId: target || null });
      toast(`已移到「${folderPath(folders, target) || '全部材料'}」`, 'success');
      onMoved();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`移动「${project.name}」`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy || target === (project.folderId ?? '')} onClick={move} data-testid="move-save">
            移动
          </button>
        </>
      }
    >
      <label className="field">
        <span>移到文件夹</span>
        <FolderSelect folders={folders} value={target} onChange={setTarget} testId="move-target" />
      </label>
      <p className="muted small">也可以把材料卡片直接拖到文件夹上。</p>
    </Modal>
  );
}
