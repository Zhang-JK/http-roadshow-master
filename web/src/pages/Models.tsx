import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Endpoint, ParallelTestResult, TestResult } from '../types';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { duration, fullTime, num, speed } from '../lib/format';

interface Form {
  id?: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  weight: number;
  enabled: boolean;
  extraBody: string;
  maxConcurrency: number;
  useProxy: boolean;
}

const EMPTY: Form = {
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  model: '',
  weight: 1,
  enabled: true,
  extraBody: '{}',
  maxConcurrency: 0,
  useProxy: true,
};

const PARALLEL_MAX = 5;

/** Addresses a proxy elsewhere usually cannot reach: this machine, private networks, single-label host names. */
function isLocalAddress(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /\.(local|lan|internal|home\.arpa)$/.test(host) ||
    (!host.includes('.') && !host.includes(':')) ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '::1' ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host)
  );
}

interface Usage {
  username: string | null;
  endpoint: string | null;
  calls: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
  tokensPerSec: number | null;
}

interface ModelStats {
  endpointId: number;
  endpoint: string;
  model: string;
  calls: number;
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  tokensPerSec: number | null;
  firstTokenMs: number | null;
  queuedMs: number | null;
  inflight: number;
  maxConcurrency: number;
}

export function ModelsPage() {
  const toast = useToast();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [assignments, setAssignments] = useState<{ userId: number; username: string; endpointName: string | null }[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [models, setModels] = useState<ModelStats[]>([]);
  const [settings, setSettings] = useState<{
    attachScreenshots: boolean;
    selfCheck: boolean;
    selfCheckRounds: number;
    maxTokens: number;
    temperature: number;
    llmIdleTimeoutSec: number;
    llmMaxCallMinutes: number;
    editMode: 'tools' | 'rewrite';
    editToolRounds: number;
    contextTokens: number;
    generateMode: 'files' | 'single';
    genPagesPerCall: number;
    askUser: boolean;
    askTimeoutMinutes: number;
  } | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [testing, setTesting] = useState<number | 'form' | null>(null);
  const [formTest, setFormTest] = useState<TestResult | null>(null);
  const [systemProxy, setSystemProxy] = useState<string | null>(null);
  const [parallelRunning, setParallelRunning] = useState<number[]>([]);
  const [parallel, setParallel] = useState<{ ep: Endpoint; result?: ParallelTestResult; error?: string } | null>(null);
  /** Endpoint whose running parallel test the open dialog is waiting for. */
  const parallelShown = useRef<number | null>(null);

  const load = useCallback(() => {
    api
      .get<{ endpoints: Endpoint[]; systemProxy: string | null }>('/api/llm/endpoints')
      .then((r) => {
        setEndpoints(r.endpoints);
        setSystemProxy(r.systemProxy);
      })
      .catch((e) => toast(e.message, 'error'));
    api.get<{ assignments: typeof assignments }>('/api/llm/assignments').then((r) => setAssignments(r.assignments));
    api.get<{ usage: Usage[]; models: ModelStats[] }>('/api/llm/usage').then((r) => {
      setUsage(r.usage);
      setModels(r.models ?? []);
    });
    api.get<{ settings: typeof settings }>('/api/settings').then((r) => setSettings(r.settings));
  }, [toast]);
  useEffect(load, [load]);

  const save = async () => {
    if (!form) return;
    try {
      const body = { ...form, apiKey: form.apiKey || undefined };
      if (form.id) await api.put(`/api/llm/endpoints/${form.id}`, body);
      else await api.post('/api/llm/endpoints', body);
      toast('已保存', 'success');
      setForm(null);
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const test = async (ep: Endpoint) => {
    setTesting(ep.id);
    try {
      const r = await api.post<{ result: TestResult }>(`/api/llm/endpoints/${ep.id}/test`);
      toast(r.result.message, r.result.ok ? 'success' : 'error');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setTesting(null);
    }
  };

  const testForm = async () => {
    if (!form) return;
    setTesting('form');
    setFormTest(null);
    try {
      const r = await api.post<{ result: TestResult }>('/api/llm/test', { ...form, apiKey: form.apiKey || undefined });
      setFormTest(r.result);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setTesting(null);
    }
  };

  const showParallel = (p: typeof parallel) => {
    parallelShown.current = p && !p.result && !p.error ? p.ep.id : null;
    setParallel(p);
  };

  const testParallel = async (ep: Endpoint) => {
    showParallel({ ep });
    setParallelRunning((ids) => [...ids, ep.id]);
    let outcome: { result?: ParallelTestResult; error?: string };
    try {
      outcome = { result: (await api.post<{ result: ParallelTestResult }>(`/api/llm/endpoints/${ep.id}/parallel-test`)).result };
    } catch (e) {
      outcome = { error: (e as Error).message };
    }
    setParallelRunning((ids) => ids.filter((id) => id !== ep.id));
    if (parallelShown.current === ep.id) showParallel({ ep, ...outcome });
    else toast(`「${ep.name}」并发测试：${outcome.result?.message ?? outcome.error}`, outcome.result?.maxParallel ? 'success' : 'error');
  };

  const applyParallel = async (ep: Endpoint, maxConcurrency: number) => {
    try {
      await api.put(`/api/llm/endpoints/${ep.id}`, { maxConcurrency });
      toast(`「${ep.name}」的并发上限已设为 ${maxConcurrency || '不限'}`, 'success');
      showParallel(null);
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const toggle = async (ep: Endpoint) => {
    await api.put(`/api/llm/endpoints/${ep.id}`, { enabled: !ep.enabled }).catch((e) => toast(e.message, 'error'));
    load();
  };

  const remove = async (ep: Endpoint) => {
    if (!confirm(`删除接入点「${ep.name}」？`)) return;
    await api.del(`/api/llm/endpoints/${ep.id}`);
    load();
  };

  const saveSettings = async (patch: Partial<NonNullable<typeof settings>>) => {
    try {
      const r = await api.put<{ settings: NonNullable<typeof settings> }>('/api/settings', patch);
      setSettings(r.settings);
      toast('设置已保存', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const totalCost = usage.reduce((a, u) => a + (u.cost ?? 0), 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>模型接入</h1>
          <p className="muted">
            配置兼容 OpenAI Chat Completions 协议的大模型接入点（模型必须支持图像输入）。启用多个接入点时，<strong>每个请求</strong>单独选择接入点：优先发往该用户的首选接入点（利用提示词缓存），它正在处理其他请求时改发最空闲的接入点，因此不同请求（包括同一用户的）可以并行；接入点故障时自动切换到下一个。设置了「并发上限」的接入点满载时，新请求在本地排队等待，排队时间不计入无响应超时。
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => { setForm({ ...EMPTY }); setFormTest(null); }} data-testid="add-endpoint">＋ 添加接入点</button>
      </div>

      <div className="table-card">
        <table className="table">
          <thead>
            <tr><th>名称</th><th>模型</th><th>接入地址</th><th>Token</th><th>权重</th><th title="正在处理的请求 / 并发上限">并发</th><th>状态</th><th>联通测试</th><th className="right">操作</th></tr>
          </thead>
          <tbody>
            {endpoints.length === 0 && (
              <tr><td colSpan={9} className="muted center-text">尚未配置接入点，AI 生成功能不可用</td></tr>
            )}
            {endpoints.map((ep) => (
              <tr key={ep.id} data-testid="endpoint-row">
                <td><strong>{ep.name}</strong></td>
                <td><code>{ep.model}</code></td>
                <td className="muted small">
                  {ep.baseUrl}
                  {!ep.useProxy && <> <span className="tag" title="不经过系统代理，直接连接接入地址" data-testid="endpoint-direct">直连</span></>}
                </td>
                <td><code>{ep.apiKeyMasked}</code></td>
                <td>{ep.weight}</td>
                <td className="nowrap" data-testid="endpoint-concurrency">{ep.inflight} / {ep.maxConcurrency || '不限'}</td>
                <td>
                  <label className="switch">
                    <input type="checkbox" checked={ep.enabled} onChange={() => toggle(ep)} />
                    <span>{ep.enabled ? '启用' : '停用'}</span>
                  </label>
                </td>
                <td className="small">
                  {ep.lastTestAt ? (
                    <span className={ep.lastTestOk ? 'ok-text' : 'err-text'} title={ep.lastTestMessage ?? ''} data-testid="test-status">
                      {ep.lastTestOk ? '✓ ' : '✗ '}{ep.lastTestMessage?.slice(0, 40)}
                      <br /><span className="muted">{fullTime(ep.lastTestAt)}</span>
                    </span>
                  ) : <span className="muted">未测试</span>}
                </td>
                <td className="right nowrap">
                  <button className="btn btn-sm" disabled={testing === ep.id} onClick={() => test(ep)} data-testid="test-endpoint">{testing === ep.id ? '测试中…' : '测试'}</button>{' '}
                  <button
                    className="btn btn-sm"
                    disabled={parallelRunning.includes(ep.id)}
                    onClick={() => testParallel(ep)}
                    title={`依次同时发送 1–${PARALLEL_MAX} 个请求，测出接入点能同时处理几个`}
                    data-testid="parallel-test"
                  >
                    {parallelRunning.includes(ep.id) ? '并发测试中…' : '并发测试'}
                  </button>{' '}
                  <button className="btn btn-sm" onClick={() => { setForm({ id: ep.id, name: ep.name, baseUrl: ep.baseUrl, apiKey: '', model: ep.model, weight: ep.weight, enabled: ep.enabled, extraBody: ep.extraBody, maxConcurrency: ep.maxConcurrency, useProxy: ep.useProxy }); setFormTest(null); }}>编辑</button>{' '}
                  <button className="btn btn-sm btn-danger" onClick={() => remove(ep)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel-card usage-card" data-testid="usage-card">
        <h3>用量统计 <span className="muted small">合计 ${totalCost.toFixed(4)}</span></h3>
        <p className="muted small">输出速度 = 输出 tokens ÷（最后一个 token − 第一个 token 的时间），不含排队与模型读取输入的时间；首 token 延迟包含模型读取输入的时间。</p>
        <table className="table compact" data-testid="model-stats">
          <thead>
            <tr><th>接入点</th><th>模型</th><th>调用</th><th>失败</th><th>输入/输出 tokens</th><th>平均输出速度</th><th>平均首 token</th><th>平均排队</th><th>当前并发</th></tr>
          </thead>
          <tbody>
            {models.length === 0 && <tr><td colSpan={9} className="muted center-text">暂无调用记录</td></tr>}
            {models.map((m) => (
              <tr key={m.endpointId} data-testid="model-stats-row">
                <td><strong>{m.endpoint}</strong></td>
                <td><code>{m.model}</code></td>
                <td>{num(m.calls)}</td>
                <td className={m.failedCalls ? 'err-text' : ''}>{num(m.failedCalls)}</td>
                <td>{num(m.promptTokens)} / {num(m.completionTokens)}</td>
                <td data-testid="model-speed"><strong>{speed(m.tokensPerSec)}</strong></td>
                <td>{m.firstTokenMs != null ? duration(m.firstTokenMs) : '—'}</td>
                <td>{m.queuedMs ? duration(m.queuedMs) : '—'}</td>
                <td>{m.inflight} / {m.maxConcurrency || '不限'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h4>按用户</h4>
        <table className="table compact">
          <thead><tr><th>用户</th><th>接入点</th><th>任务</th><th>输入/输出 tokens</th><th>平均输出速度</th><th>费用</th></tr></thead>
          <tbody>
            {usage.map((u, i) => (
              <tr key={i}>
                <td>{u.username ?? '—'}</td>
                <td>{u.endpoint ?? '（已删除）'}</td>
                <td>{u.calls}</td>
                <td>{num(u.promptTokens)} / {num(u.completionTokens)}</td>
                <td>{speed(u.tokensPerSec)}</td>
                <td>{u.cost != null ? `$${u.cost.toFixed(4)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="two-col">
        <div className="panel-card">
          <h3>用户 → 首选接入点</h3>
          <p className="muted small">基于加权一致性哈希（Rendezvous Hashing），增删接入点时只有少量用户会被重新分配。首选接入点忙时，请求会改发最空闲的接入点。</p>
          <table className="table compact">
            <tbody>
              {assignments.map((a) => (
                <tr key={a.userId}><td>{a.username}</td><td>{a.endpointName ?? <span className="muted">—</span>}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel-card">
          <h3>生成设置</h3>
          {settings && (
            <div className="settings-form">
              <label className="switch">
                <input type="checkbox" checked={settings.attachScreenshots} onChange={(e) => saveSettings({ attachScreenshots: e.target.checked })} />
                <span>修改单页/元素时附带页面截图（红框标出选中元素，利用多模态能力）</span>
              </label>
              <label className="switch">
                <input type="checkbox" checked={settings.selfCheck} onChange={(e) => saveSettings({ selfCheck: e.target.checked })} data-testid="self-check-toggle" />
                <span>生成后自检：在无头浏览器中渲染草稿、检查布局，由模型查看截图并用工具修复后再保存（之后的交付检查始终运行：组装 index.html、检查 README 与各文件，有错误时交回模型修复）</span>
              </label>
              <label className="switch">
                <input type="checkbox" checked={settings.askUser} onChange={(e) => saveSettings({ askUser: e.target.checked })} data-testid="ask-user-toggle" />
                <span>允许 AI 向用户提问：需求含糊时先确认（任务暂停，在编辑页回答）；修改选中元素后发现其他页面有同类内容时，询问是否一起修改（修改要求里写明「全部 / 统一」时不再询问）</span>
              </label>
              {settings.askUser && (
                <label className="field inline" title="超时或跳过时，AI 按自己的判断继续；同类内容不会扩大修改范围">
                  <span>等待回答最长（分钟）</span>
                  <input type="number" min="1" max="1440" defaultValue={settings.askTimeoutMinutes} onBlur={(e) => saveSettings({ askTimeoutMinutes: Number(e.target.value) })} data-testid="ask-timeout" />
                </label>
              )}
              <label className="field inline" title="分步生成：先写 README（需求、风格约定、页面规划）与样式文件，再每次生成几页，单次输出短、被截断也只需重做一页；单次生成：一次输出整份 HTML">
                <span>生成方式</span>
                <select value={settings.generateMode} onChange={(e) => saveSettings({ generateMode: e.target.value as 'files' | 'single' })} data-testid="generate-mode">
                  <option value="files">分步生成多文件（推荐）</option>
                  <option value="single">单次生成整份 HTML</option>
                </select>
              </label>
              {settings.generateMode !== 'single' && (
                <label className="field inline" title="分步生成时每次调用生成的页数；模型较慢或页面复杂时调小">
                  <span>每次生成页数</span>
                  <input type="number" min="1" max="10" defaultValue={settings.genPagesPerCall} onBlur={(e) => saveSettings({ genPagesPerCall: Number(e.target.value) })} data-testid="pages-per-call" />
                </label>
              )}
              <label className="field inline" title="工具修改：模型用结构化工具只改动相关元素和样式，输出量小、速度快；整页重写：模型重新输出整页（或整份）HTML，适合不擅长调用工具的模型">
                <span>AI 修改方式</span>
                <select value={settings.editMode} onChange={(e) => saveSettings({ editMode: e.target.value as 'tools' | 'rewrite' })} data-testid="edit-mode">
                  <option value="tools">工具修改（推荐，只改相关部分）</option>
                  <option value="rewrite">整页重写</option>
                </select>
              </label>
              {settings.editMode === 'tools' && (
                <label className="field inline">
                  <span>修改最多工具轮数</span>
                  <input type="number" min="2" max="40" defaultValue={settings.editToolRounds} onBlur={(e) => saveSettings({ editToolRounds: Number(e.target.value) })} />
                </label>
              )}
              <label className="field inline">
                <span>自检最多工具轮数</span>
                <input type="number" min="1" max="20" defaultValue={settings.selfCheckRounds} onBlur={(e) => saveSettings({ selfCheckRounds: Number(e.target.value) })} />
              </label>
              <label className="field inline">
                <span>最大输出 tokens</span>
                <input type="number" defaultValue={settings.maxTokens} onBlur={(e) => saveSettings({ maxTokens: Number(e.target.value) })} data-testid="max-tokens" />
              </label>
              <label className="field inline" title="模型的上下文窗口（输入 + 输出）。每次调用会自动把输出上限收窄到剩余空间，对话过长时自动压缩早先的工具结果与截图">
                <span>模型上下文 tokens</span>
                <input type="number" min="8000" defaultValue={settings.contextTokens} onBlur={(e) => saveSettings({ contextTokens: Number(e.target.value) })} data-testid="context-tokens" />
              </label>
              <label className="field inline">
                <span>Temperature</span>
                <input type="number" step="0.1" min="0" max="2" defaultValue={settings.temperature} onBlur={(e) => saveSettings({ temperature: Number(e.target.value) })} />
              </label>
              <label className="field inline" title="模型持续这么久没有返回任何数据（包括长输入的预填充阶段）才判定为卡住并中止">
                <span>无响应超时（秒）</span>
                <input type="number" min="30" max="7200" defaultValue={settings.llmIdleTimeoutSec} onBlur={(e) => saveSettings({ llmIdleTimeoutSec: Number(e.target.value) })} data-testid="idle-timeout" />
              </label>
              <label className="field inline" title="单次模型调用（即使一直在输出）的最长时间">
                <span>单次调用上限（分钟）</span>
                <input type="number" min="5" max="1440" defaultValue={settings.llmMaxCallMinutes} onBlur={(e) => saveSettings({ llmMaxCallMinutes: Number(e.target.value) })} />
              </label>
              <p className="muted small">
                只要模型还在持续输出就不会中止。按输出速度估算：「最大输出 tokens」÷ 每秒 tokens 数 ≈ 一次调用的最长耗时，例如 65536 tokens 在 20 tokens/秒 下约 55 分钟；单次调用上限应大于该值。分步生成时每次只输出几页（通常几千 tokens），回复被截断时会自动续写或重做缺失的页面。
              </p>
            </div>
          )}
        </div>
      </div>

      {form && (
        <Modal
          title={form.id ? '编辑接入点' : '添加接入点'}
          onClose={() => setForm(null)}
          footer={
            <>
              <button className="btn" disabled={testing === 'form'} onClick={testForm} data-testid="test-form">{testing === 'form' ? '测试中…' : '联通测试'}</button>
              <div className="spacer" />
              <button className="btn" onClick={() => setForm(null)}>取消</button>
              <button className="btn btn-primary" onClick={save} data-testid="save-endpoint">保存</button>
            </>
          }
        >
          <label className="field"><span>名称</span><input name="ep-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>接入地址（Base URL）</span><input name="ep-base" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://openrouter.ai/api/v1" /></label>
          <label className="field"><span>模型名称</span><input name="ep-model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="例如 deepseek/deepseek-v4.1-flash-1017" /></label>
          <label className="field"><span>API Token{form.id ? '（留空则保持不变）' : ''}</span><input name="ep-key" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." /></label>
          <div className="row gap">
            <label className="field"><span>权重（1–100）</span><input type="number" min={1} max={100} value={form.weight} onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })} /></label>
            <label className="field" title="同一时间最多发给这个接入点的请求数，0 表示不限。模型一次只能处理少量请求（例如自部署、单卡）时设置，超出的请求在本地排队，不会因等待而触发无响应超时">
              <span>并发上限（0 = 不限）</span>
              <input type="number" min={0} max={64} value={form.maxConcurrency} onChange={(e) => setForm({ ...form, maxConcurrency: Number(e.target.value) })} data-testid="ep-max-concurrency" />
            </label>
            <label className="switch" style={{ marginTop: 22 }}><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /><span>启用</span></label>
          </div>
          <div className="field">
            <label className="switch">
              <input type="checkbox" checked={form.useProxy} onChange={(e) => setForm({ ...form, useProxy: e.target.checked })} data-testid="ep-use-proxy" />
              <span>使用系统代理</span>
            </label>
            <span className="field-hint" data-testid="proxy-hint">
              {systemProxy
                ? `服务器访问模型时经过代理 ${systemProxy}（HTTPS_PROXY / HTTP_PROXY）。模型部署在本机或内网、代理访问不到时关闭，直接连接接入地址。`
                : '服务器未配置系统代理（HTTPS_PROXY / HTTP_PROXY），所有接入点都直接连接，此选项暂不起作用。'}
            </span>
            {systemProxy && form.useProxy && isLocalAddress(form.baseUrl) && (
              <span className="field-hint warn" data-testid="proxy-local-warning">接入地址是本机或内网地址，经过代理通常无法访问，建议关闭「使用系统代理」。</span>
            )}
          </div>
          <label className="field"><span>附加请求参数（JSON，可选，会合并进请求体）</span><textarea rows={3} value={form.extraBody} onChange={(e) => setForm({ ...form, extraBody: e.target.value })} placeholder='例如 {"reasoning":{"effort":"low"}}' /></label>
          {formTest && (
            <div className={`test-result ${formTest.ok ? 'ok' : 'err'}`} data-testid="form-test-result">
              <strong>{formTest.ok ? '✓ 测试通过' : '✗ 测试未通过'}</strong>（{formTest.latencyMs} ms）
              <div>文本：{formTest.textOk ? '正常' : '失败'} · 多模态：{formTest.visionOk ? '支持' : '不支持/失败'}</div>
              <div className="small">{formTest.message}</div>
            </div>
          )}
        </Modal>
      )}

      {parallel && (() => {
        const ep = endpoints.find((e) => e.id === parallel.ep.id) ?? parallel.ep;
        const r = parallel.result;
        return (
          <Modal
            wide
            title={`并发测试 · ${ep.name}`}
            onClose={() => showParallel(null)}
            footer={
              <>
                <span className="muted small">当前并发上限：{ep.maxConcurrency || '不限'}</span>
                <div className="spacer" />
                <button className="btn" onClick={() => showParallel(null)}>关闭</button>
                {r && r.suggested !== null && r.suggested !== ep.maxConcurrency && (
                  <button className="btn btn-primary" onClick={() => applyParallel(ep, r.suggested!)} data-testid="apply-parallel">
                    将并发上限设为 {r.suggested || '不限'}
                  </button>
                )}
              </>
            }
          >
            <p className="muted small">
              依次同时发送 1、2 … {PARALLEL_MAX} 个相同的请求（让模型从 1 开始数数），每轮等全部请求完成再进行下一轮。某轮出现失败，或接入点要等前面的请求完成才开始回答后面的请求（服务端排队）时停止。为免把偶尔偏慢的首 token 当成排队，输出很快的模型会数得更多（最多到 600），看起来在排队的一轮会复测一次。测试请求不受「并发上限」限制，也不计入用量统计。
            </p>
            {!r && !parallel.error && (
              <div className="parallel-running" data-testid="parallel-running"><span className="spinner tiny" />正在测试，取决于模型速度，可能需要几分钟…</div>
            )}
            {parallel.error && <div className="test-result err" data-testid="parallel-result">{parallel.error}</div>}
            {r && (
              <>
                <div className={`test-result ${r.maxParallel === 0 ? 'err' : r.suggested === 0 ? 'ok' : 'warn'}`} data-testid="parallel-result">
                  <strong>
                    {r.maxParallel === 0 ? '✗ 测试未通过' : r.suggested === 0 ? `✓ ${PARALLEL_MAX} 个请求都能同时处理` : `最多可同时处理 ${r.maxParallel} 个请求`}
                  </strong>
                  <div className="small">{r.message}</div>
                </div>
                {r.busy > 0 && (
                  <div className="test-result warn small" style={{ marginTop: 8 }} data-testid="parallel-busy">
                    测试开始时这个接入点上还有 {r.busy} 个生成任务的请求在运行，结果可能偏低，建议空闲时再测一次。
                  </div>
                )}
                <div className="muted small" style={{ marginTop: 10 }} data-testid="parallel-count">每个请求让模型从 1 数到 {r.count}</div>
                <table className="table compact parallel-levels" data-testid="parallel-levels">
                  <thead>
                    <tr>
                      <th>同时请求</th>
                      <th>成功</th>
                      <th title="第一个请求完成之前已经开始输出的请求数">同时在输出</th>
                      <th>总耗时</th>
                      <th title="从发出请求到收到第一个 token 的最长等待">最慢首 token</th>
                      <th>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.levels.map((l) => (
                      <tr key={l.n} data-testid="parallel-level">
                        <td>{l.n}</td>
                        <td>{l.ok} / {l.n}</td>
                        <td>{l.ok ? l.concurrent : '—'}</td>
                        <td>{duration(l.wallMs)}</td>
                        <td>{l.maxFirstTokenMs != null ? duration(l.maxFirstTokenMs) : '—'}</td>
                        <td>
                          {l.ok < l.n ? (
                            <span className="err-text" title={l.error}>✗ 失败</span>
                          ) : l.queued ? (
                            <span className="warn-text" title="连续两次都有请求要等其他请求完成才开始输出">排队</span>
                          ) : (
                            <span className="ok-text" title={l.rechecked ? '第一次像是在排队，复测时各请求同时输出（只是首 token 偶尔偏慢）' : undefined}>
                              ✓ 并行{l.rechecked ? '（复测）' : ''}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Modal>
        );
      })()}
    </div>
  );
}
