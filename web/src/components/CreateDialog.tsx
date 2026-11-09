import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Project, ProjectType } from '../types';
import { Modal } from './Modal';
import { SlideFrame } from './SlideFrame';
import { useToast } from './Toast';
import { addFiles, RefFileList, SLIDES_ACCEPT, TEXT_ACCEPT, isSlidesFile, type AssetRole, type RefFile } from './RefFiles';

const STYLE_PRESETS = ['极简商务', '科技深色', '清新活力', '高端金融', '学术严谨', '国潮东方', '杂志排版', '渐变玻璃拟态'];
const PURPOSE_PRESETS = ['融资路演', '产品发布会', '年度工作汇报', '项目立项评审', '招商推介', '课程/培训'];

const ASPECT_OPTIONS = [
  { value: '16:9', label: '横向 16:9（默认，1920×1080）' },
  { value: '4:3', label: '横向 4:3（1440×1080）' },
  { value: 'a4-landscape', label: 'A4 横向' },
  { value: 'a4-portrait', label: 'A4 竖向' },
  { value: '9:16', label: '竖向 9:16（1080×1920）' },
  { value: '1:1', label: '方形 1:1' },
  { value: 'custom', label: '自定义尺寸…' },
];

interface Props {
  type: ProjectType;
  onClose: () => void;
  onCreated: (id: string) => void;
}

function Chips({ options, value, onPick }: { options: string[]; value: string; onPick: (v: string) => void }) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button
          type="button"
          key={o}
          className={`chip ${value.includes(o) ? 'chip-on' : ''}`}
          onClick={() => onPick(value.includes(o) ? value.replace(o, '').replace(/^[，,\s]+|[，,\s]+$/g, '') : value ? `${value}，${o}` : o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function FilePicker({ files, setFiles, accept, hint, defaultRole }: { files: RefFile[]; setFiles: (f: RefFile[]) => void; accept: string; hint: string; defaultRole: AssetRole }) {
  return (
    <div className="file-picker">
      <label className="file-drop">
        <input
          type="file"
          multiple
          accept={accept}
          data-testid="file-input"
          onChange={(e) => {
            setFiles(addFiles(files, e.target.files, defaultRole));
            e.target.value = '';
          }}
        />
        <span>📎 点击选择文件</span>
        <small>{hint}</small>
      </label>
      <RefFileList files={files} onChange={setFiles} />
    </div>
  );
}

export function CreateDialog({ type, onClose, onCreated }: Props) {
  const toast = useToast();
  const [step, setStep] = useState(type === 'deck' ? 0 : 1);
  const [templates, setTemplates] = useState<Project[] | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [f, setF] = useState({
    name: '',
    style: '',
    purpose: '',
    audience: '',
    colors: '',
    content: '',
    notes: '',
    pageCount: '',
    aspect: type === 'deck' ? 'template' : '16:9',
    width: '1920',
    height: '1080',
  });
  const [files, setFiles] = useState<RefFile[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    if (type !== 'deck') return;
    api
      .get<{ projects: Project[] }>('/api/projects?type=template')
      .then((r) => setTemplates(r.projects.filter((p) => p.status === 'ready' && p.pageCount > 0)))
      .catch((e) => toast(e.message, 'error'));
  }, [type, toast]);

  const canSubmit =
    f.name.trim() &&
    (type === 'template' ? f.style.trim() || f.purpose.trim() : templateId && f.content.trim()) &&
    !busy;

  const submit = async () => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('type', type);
      Object.entries(f).forEach(([k, v]) => fd.append(k, v));
      if (type === 'deck') fd.append('templateId', templateId);
      fd.append('fileRoles', JSON.stringify(files.map((x) => x.role)));
      files.forEach((x) => fd.append('files', x.file, x.file.name));
      const r = await api.post<{ project: Project }>('/api/projects', fd);
      toast('已创建，AI 正在生成…', 'success');
      onCreated(r.project.id);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  const selectedTemplate = templates?.find((t) => t.id === templateId);

  if (type === 'deck' && step === 0) {
    return (
      <Modal
        title="新建路演材料 · 第 1 步：选择模板"
        onClose={onClose}
        wide
        footer={
          <>
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn btn-primary" disabled={!templateId} onClick={() => setStep(1)} data-testid="next-step">
              下一步
            </button>
          </>
        }
      >
        {templates === null ? (
          <div className="center"><div className="spinner" /></div>
        ) : templates.length === 0 ? (
          <div className="empty small">
            <p>还没有可用的模板。请先在「模板」页创建一个模板。</p>
          </div>
        ) : (
          <div className="template-pick-grid">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`template-pick ${templateId === t.id ? 'on' : ''}`}
                onClick={() => setTemplateId(t.id)}
                data-testid="template-option"
              >
                <div className="thumb" style={{ aspectRatio: `${t.width} / ${t.height}` }}>
                  <SlideFrame src={`/api/projects/${t.id}/html?pageId=${t.firstPageId}&v=${t.versionNo}`} width={t.width} height={t.height} />
                </div>
                <div className="tp-name">{t.name}</div>
                <div className="tp-meta">{t.pageCount} 个版式 · {t.width}×{t.height}</div>
              </button>
            ))}
          </div>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      title={type === 'template' ? '新建路演模板' : '新建路演材料 · 第 2 步：说明内容'}
      onClose={onClose}
      wide
      footer={
        <>
          {type === 'deck' && <button className="btn" onClick={() => setStep(0)}>上一步</button>}
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={submit} data-testid="submit-create">
            {busy ? (files.some((x) => isSlidesFile(x.file)) ? '上传并转换参考文件…' : '提交中…') : '开始生成'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        {type === 'deck' && selectedTemplate && (
          <div className="field full selected-template">
            <span>所选模板</span>
            <div className="row gap">
              <strong>{selectedTemplate.name}</strong>
              <button type="button" className="link" onClick={() => setStep(0)}>更换</button>
            </div>
          </div>
        )}
        <label className="field full">
          <span>{type === 'template' ? '模板名称' : '材料名称'} *</span>
          <input name="name" value={f.name} onChange={(e) => set('name')(e.target.value)} placeholder={type === 'template' ? '例如：科技蓝 · 融资路演模板' : '例如：XX科技 A 轮融资路演'} />
        </label>
        {type === 'template' && (
          <div className="field full">
            <span>设计风格 *</span>
            <textarea name="style" rows={2} value={f.style} onChange={(e) => set('style')(e.target.value)} placeholder="描述你想要的视觉风格，如：深色科技感、霓虹蓝强调色、大字号标题、留白充足" />
            <Chips options={STYLE_PRESETS} value={f.style} onPick={set('style')} />
          </div>
        )}
        <div className="field full">
          <span>{type === 'template' ? '计划用途 *' : '用途/场合'}</span>
          <input name="purpose" value={f.purpose} onChange={(e) => set('purpose')(e.target.value)} placeholder="例如：面向投资人的 A 轮融资路演" />
          <Chips options={PURPOSE_PRESETS} value={f.purpose} onPick={set('purpose')} />
        </div>
        <label className="field">
          <span>目标受众</span>
          <input name="audience" value={f.audience} onChange={(e) => set('audience')(e.target.value)} placeholder="例如：VC 投资经理" />
        </label>
        {type === 'template' ? (
          <label className="field">
            <span>配色偏好</span>
            <input name="colors" value={f.colors} onChange={(e) => set('colors')(e.target.value)} placeholder="例如：品牌色 #1E40AF，搭配青色" />
          </label>
        ) : (
          <label className="field">
            <span>期望页数</span>
            <input name="pageCount" type="number" min={1} max={40} value={f.pageCount} onChange={(e) => set('pageCount')(e.target.value)} placeholder="留空由 AI 决定" />
          </label>
        )}
        {type === 'deck' && (
          <label className="field full">
            <span>需要添加的内容 *</span>
            <textarea
              name="content"
              rows={8}
              value={f.content}
              onChange={(e) => set('content')(e.target.value)}
              placeholder={'详细说明每部分要讲什么，越具体越好，例如：\n1. 公司简介：成立于 2021 年，专注……\n2. 行业痛点：……\n3. 核心产品与技术：……\n4. 关键数据：ARR 1200 万，同比增长 180%……\n5. 融资计划：本轮融资 5000 万，用于……'}
            />
          </label>
        )}
        {type === 'template' && (
          <label className="field">
            <span>版式页数</span>
            <input name="pageCount" type="number" min={3} max={20} value={f.pageCount} onChange={(e) => set('pageCount')(e.target.value)} placeholder="默认 10 页" />
          </label>
        )}
        <label className="field">
          <span>画幅</span>
          <select name="aspect" value={f.aspect} onChange={(e) => set('aspect')(e.target.value)}>
            {type === 'deck' && <option value="template">跟随模板（{selectedTemplate ? `${selectedTemplate.width}×${selectedTemplate.height}` : ''}）</option>}
            {ASPECT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        {f.aspect === 'custom' && (
          <div className="field row gap">
            <label className="field"><span>宽(px)</span><input type="number" value={f.width} onChange={(e) => set('width')(e.target.value)} /></label>
            <label className="field"><span>高(px)</span><input type="number" value={f.height} onChange={(e) => set('height')(e.target.value)} /></label>
          </div>
        )}
        <label className="field full">
          <span>其他要求</span>
          <textarea name="notes" rows={2} value={f.notes} onChange={(e) => set('notes')(e.target.value)} placeholder="例如：每页都要有公司 logo；避免使用红色；语言用英文……" />
        </label>
        <div className="field full">
          <span>{type === 'template' ? '参考图片 / PPT / HTML / Logo（可选）' : '支持材料与参考（可选）'}</span>
          <FilePicker
            files={files}
            setFiles={setFiles}
            defaultRole={type === 'template' ? 'reference' : 'embed'}
            accept={`image/*,${SLIDES_ACCEPT}${type === 'deck' ? `,${TEXT_ACCEPT}` : ''}`}
            hint={
              type === 'template'
                ? '参考图或 PPT/PDF/HTML 会逐页转成图片交给 AI 模仿风格，AI 还可只读查阅原始文件；Logo 等可切换为“嵌入页面”（最多 12 个）'
                : '图片可嵌入页面或仅作参考；PPT/PDF/HTML 会逐页转成图片并提取文字；大文件由 AI 用只读工具按需查阅'
            }
          />
        </div>
      </div>
    </Modal>
  );
}
