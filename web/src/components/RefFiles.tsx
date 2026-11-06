import { fileSize } from '../lib/format';

export type AssetRole = 'embed' | 'reference';

export interface RefFile {
  file: File;
  role: AssetRole;
}

export const SLIDES_ACCEPT = '.ppt,.pptx,.pps,.ppsx,.odp,.key,.pdf';
export const TEXT_ACCEPT = '.txt,.md,.csv,.json,.html,.xml,.yaml,.yml,.doc,.docx';
export const MAX_REF_FILES = 12;

export const isImageFile = (f: File) => f.type.startsWith('image/');
export const isSlidesFile = (f: File) => /\.(pptx?|ppsx?|potx?|odp|key|pdf|docx?|odt)$/i.test(f.name);

export function addFiles(list: RefFile[], picked: FileList | null, defaultRole: AssetRole): RefFile[] {
  const added = Array.from(picked ?? []).map((file) => ({ file, role: isImageFile(file) ? defaultRole : ('reference' as AssetRole) }));
  return [...list, ...added].slice(0, MAX_REF_FILES);
}

/** Uploads files to a project's assets, one request per role, and returns the new asset ids in pick order. */
export async function uploadRefFiles(
  post: (url: string, body: FormData) => Promise<{ assets: { id: string }[] }>,
  projectId: string,
  files: RefFile[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const role of ['embed', 'reference'] as const) {
    const group = files.filter((f) => f.role === role);
    if (!group.length) continue;
    const fd = new FormData();
    fd.append('role', role);
    group.forEach((f) => fd.append('files', f.file, f.file.name));
    const r = await post(`/api/projects/${projectId}/assets`, fd);
    ids.push(...r.assets.map((a) => a.id));
  }
  return ids;
}

export function RefFileList({ files, onChange }: { files: RefFile[]; onChange: (files: RefFile[]) => void }) {
  if (!files.length) return null;
  return (
    <ul className="file-list ref-files" data-testid="ref-file-list">
      {files.map((f, i) => (
        <li key={`${f.file.name}-${i}`}>
          <span className="ref-name" title={f.file.name}>
            {isImageFile(f.file) ? '🖼' : isSlidesFile(f.file) ? '📊' : '📄'} {f.file.name}
          </span>
          <small>{fileSize(f.file.size)}</small>
          {isImageFile(f.file) ? (
            <span className="seg seg-xs" data-testid="role-toggle">
              {(['embed', 'reference'] as const).map((r) => (
                <button
                  type="button"
                  key={r}
                  className={f.role === r ? 'on' : ''}
                  onClick={() => onChange(files.map((x, j) => (j === i ? { ...x, role: r } : x)))}
                  title={r === 'embed' ? 'AI 可以把这张图片放进页面' : 'AI 只参考它的风格/版式/内容，不放进页面'}
                >
                  {r === 'embed' ? '嵌入页面' : '仅参考'}
                </button>
              ))}
            </span>
          ) : isSlidesFile(f.file) ? (
            <span className="tag" title="每一页会被导出为图片交给模型参考，同时提取文字">逐页转图片参考</span>
          ) : (
            <span className="tag">提取文字</span>
          )}
          <button type="button" className="icon-btn" onClick={() => onChange(files.filter((_, j) => j !== i))} title="移除">✕</button>
        </li>
      ))}
    </ul>
  );
}
