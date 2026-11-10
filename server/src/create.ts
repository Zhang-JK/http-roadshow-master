import type { DB } from './db.js';
import { HttpError } from './auth.js';
import { ASPECTS } from './deck.js';
import { saveAsset, type AssetRole } from './assets.js';
import { createProject, getProject, projectDoc, startGeneration, type GenerationOptions, type JobRow, type ProjectRow } from './projects.js';

export const MAX_UPLOAD_FILES = 12;

export interface UploadFile {
  filename: string;
  mime: string;
  buf: Buffer;
  role?: AssetRole;
}

/**
 * Validates the create form (web multipart or MCP arguments), stores the files and starts generation.
 * Field names and rules are the ones of the web 新建 dialog.
 */
export async function createFromForm(
  db: DB,
  userId: number,
  fields: Record<string, string | undefined>,
  files: UploadFile[],
  opts: GenerationOptions = {},
): Promise<{ project: ProjectRow; job: JobRow }> {
  if (files.length > MAX_UPLOAD_FILES) throw new HttpError(400, `最多上传 ${MAX_UPLOAD_FILES} 个文件`);
  const type = fields.type === 'deck' ? 'deck' : fields.type === 'template' ? 'template' : null;
  if (!type) throw new HttpError(400, '项目类型必须是 template 或 deck');
  const name = String(fields.name ?? '').trim();
  if (!name) throw new HttpError(400, '请填写名称');
  const aspectKey = fields.aspect && ASPECTS[fields.aspect] ? fields.aspect : '16:9';
  let { width, height } = ASPECTS[aspectKey];
  if (fields.aspect === 'custom') {
    width = Math.round(Number(fields.width));
    height = Math.round(Number(fields.height));
    if (!(width >= 320 && width <= 4000 && height >= 320 && height <= 4000)) throw new HttpError(400, '自定义尺寸需在 320–4000 像素之间');
  }
  const pageCount = fields.pageCount ? Math.max(1, Math.min(40, Number(fields.pageCount) || 0)) || undefined : undefined;
  let brief: Record<string, unknown>;
  let templateId: string | null = null;
  if (type === 'template') {
    if (!String(fields.style ?? '').trim() && !String(fields.purpose ?? '').trim()) throw new HttpError(400, '请至少填写设计风格或计划用途');
    brief = {
      name,
      style: fields.style ?? '',
      purpose: fields.purpose ?? '',
      audience: fields.audience ?? '',
      colors: fields.colors ?? '',
      pageCount,
      notes: fields.notes ?? '',
    };
  } else {
    templateId = String(fields.templateId ?? '').trim() || null;
    if (!templateId) throw new HttpError(400, '请先选择一个模板');
    const tpl = getProject(db, templateId);
    if (!tpl || tpl.type !== 'template') throw new HttpError(400, '所选模板不存在');
    if (tpl.status !== 'ready' || !projectDoc(tpl)?.pages.length) throw new HttpError(400, '所选模板尚未生成完成');
    if (!String(fields.content ?? '').trim()) throw new HttpError(400, '请详细说明需要添加的内容');
    const tdoc = projectDoc(tpl)!;
    if (fields.aspect === undefined || fields.aspect === '' || fields.aspect === 'template') {
      width = tdoc.width;
      height = tdoc.height;
    }
    brief = {
      name,
      purpose: fields.purpose ?? '',
      audience: fields.audience ?? '',
      content: fields.content,
      pageCount,
      notes: fields.notes ?? '',
    };
  }
  const project = createProject(db, userId, {
    type,
    name,
    width,
    height,
    aspect: fields.aspect === 'custom' ? `${width}x${height}` : aspectKey,
    templateId,
    brief: brief as any,
  });
  const defaultRole: AssetRole = type === 'template' ? 'reference' : 'embed';
  for (const f of files) await saveAsset(db, project.id, userId, f.filename, f.mime, f.buf, f.role ?? defaultRole);
  const job = startGeneration(db, project.id, userId, opts);
  return { project: getProject(db, project.id)!, job };
}
