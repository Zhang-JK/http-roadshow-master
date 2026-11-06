import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { fullTime } from '../lib/format';

interface VersionInfo {
  version: string;
  commit: string;
  source: string;
  ref: string;
  builtAt: string;
}

interface CheckResult {
  source: string;
  ref: string;
  current: string;
  currentVersion: string;
  latest: string;
  latestLabel: string;
  updateAvailable: boolean;
  error: string;
  checkedAt: number;
}

interface UpdateStatus {
  state: 'idle' | 'running' | 'success' | 'failed' | 'rolled_back';
  message: string;
  from: string;
  to: string;
  updatedAt: number;
}

interface SystemInfo {
  version: VersionInfo;
  managed: boolean;
  port: number;
  baseDir: string | null;
  lastCheck: CheckResult | null;
  updateAvailable: boolean;
  status: UpdateStatus;
  uptimeSec: number;
}

const SOURCE_LABELS: Record<string, string> = { git: 'Git 仓库', archive: '发布包清单', local: '本地目录', dev: '开发环境' };
const STATE_LABELS: Record<UpdateStatus['state'], string> = {
  idle: '空闲',
  running: '更新中',
  success: '成功',
  failed: '失败',
  rolled_back: '已回滚',
};

function uptime(s: number) {
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分钟`;
  return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`;
}

export function SystemPage() {
  const toast = useToast();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checkError, setCheckError] = useState('');
  const [monitoring, setMonitoring] = useState(false);
  const [offline, setOffline] = useState(false);
  const [log, setLog] = useState('');
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [showLog, setShowLog] = useState(false);
  const startVersion = useRef('');
  const logRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    const r = await api.get<SystemInfo>('/api/system/info');
    setInfo(r);
    setStatus(r.status);
    if (r.lastCheck) setCheck(r.lastCheck);
    if (r.status.state === 'running' && Date.now() - r.status.updatedAt < 30 * 60_000) {
      startVersion.current = startVersion.current || r.status.from || r.version.version;
      setMonitoring(true);
      setShowLog(true);
    }
    return r;
  }, []);

  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'));
  }, [load, toast]);

  useEffect(() => {
    if (!monitoring) return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await api.get<{ log: string; status: UpdateStatus; version: VersionInfo }>('/api/system/update-log?lines=300');
        if (stopped) return;
        setOffline(false);
        setLog(r.log);
        setStatus(r.status);
        if (r.status.state !== 'running') {
          setMonitoring(false);
          const fresh = await load();
          if (r.status.state === 'success') {
            const changed = fresh.version.version !== startVersion.current;
            toast(changed ? `更新完成，当前版本 ${fresh.version.version}` : r.status.message || '已是最新版本', 'success');
            setCheck(null);
          } else {
            toast(`${STATE_LABELS[r.status.state]}：${r.status.message}`, 'error');
          }
        }
      } catch {
        if (!stopped) setOffline(true);
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [monitoring, load, toast]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log, showLog]);

  const doCheck = async () => {
    setChecking(true);
    setCheckError('');
    try {
      const r = await api.post<{ result: CheckResult }>('/api/system/check');
      setCheck(r.result);
      if (r.result.error) setCheckError(r.result.error);
    } catch (e) {
      setCheckError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const doUpdate = async (force: boolean) => {
    const msg = force
      ? '将重新获取代码并重新部署当前更新源的最新版本，服务会短暂重启。继续？'
      : `确定更新到 ${check?.latestLabel ?? '最新版本'}？更新前会自动备份数据库，失败会自动回滚；服务会短暂重启。`;
    if (!confirm(msg)) return;
    try {
      await api.post('/api/system/update', { force });
      startVersion.current = info?.version.version ?? '';
      setLog('');
      setShowLog(true);
      setMonitoring(true);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const loadLog = async () => {
    setShowLog((s) => !s);
    const r = await api.get<{ log: string }>('/api/system/update-log?lines=300').catch(() => null);
    if (r) setLog(r.log);
  };

  if (!info) return <div className="center"><div className="spinner" /></div>;
  const v = info.version;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>系统更新</h1>
          <p className="muted">检查新版本并一键更新部署。更新前自动备份数据库；新版本健康检查失败时自动回滚到上一个版本并恢复数据。</p>
        </div>
      </div>

      <div className="two-col equal">
        <div className="panel-card">
          <h3>当前版本</h3>
          <div className="kv" data-testid="current-version">
            <span>版本</span><strong>{v.version}</strong>
            <span>提交</span><code>{v.commit ? v.commit.slice(0, 12) : '—'}</code>
            <span>构建时间</span><span>{v.builtAt ? fullTime(Date.parse(v.builtAt)) : '—'}</span>
            <span>更新源</span><span>{SOURCE_LABELS[check?.source ?? v.source] ?? v.source} {check?.ref && <code>{check.ref}</code>}</span>
            <span>端口</span><span>{info.port}</span>
            <span>安装目录</span><span>{info.baseDir ?? '—'}</span>
            <span>已运行</span><span>{uptime(info.uptimeSec)}</span>
          </div>
        </div>

        <div className="panel-card">
          <h3>检查更新</h3>
          {!info.managed ? (
            <div className="notice">
              当前实例不是通过部署脚本安装的（开发模式），无法在线更新。在 Linux 服务器上执行
              <code>sudo bash deploy.sh install</code> 安装后即可在此一键更新。
            </div>
          ) : (
            <>
              <div className="check-box" data-testid="check-result">
                {checking ? (
                  <span className="row gap"><span className="spinner tiny" /> 正在检查…</span>
                ) : checkError ? (
                  <span className="err-text">检查失败：{checkError}</span>
                ) : check ? (
                  check.updateAvailable ? (
                    <span className="update-yes">发现新版本 <strong>{check.latestLabel}</strong></span>
                  ) : (
                    <span className="ok-text">已是最新版本</span>
                  )
                ) : (
                  <span className="muted">尚未检查</span>
                )}
                {check && !checking && <div className="muted small">上次检查：{fullTime(check.checkedAt)}（系统每 6 小时自动检查一次）</div>}
              </div>
              <div className="row gap">
                <button className="btn" onClick={doCheck} disabled={checking || monitoring} data-testid="check-update">检查更新</button>
                <button className="btn btn-primary" onClick={() => doUpdate(false)} disabled={!check?.updateAvailable || monitoring} data-testid="do-update">
                  立即更新
                </button>
                <div className="spacer" />
                <button className="link" onClick={() => doUpdate(true)} disabled={monitoring}>强制重新部署</button>
              </div>
            </>
          )}
        </div>
      </div>

      {info.managed && (
        <div className="panel-card" style={{ marginTop: 20 }}>
          <div className="row gap">
            <h3>更新状态</h3>
            {status && status.state !== 'idle' && (
              <span className={`badge state-${status.state}`} data-testid="update-state">{STATE_LABELS[status.state]}</span>
            )}
            {monitoring && <span className="row gap small muted"><span className="spinner tiny" />{offline ? '服务重启中，等待恢复…' : status?.message}</span>}
            {!monitoring && status && status.state !== 'idle' && (
              <span className="small muted">{status.message}{status.updatedAt ? ` · ${fullTime(status.updatedAt)}` : ''}</span>
            )}
            <div className="spacer" />
            <button className="btn btn-sm" onClick={loadLog}>{showLog ? '隐藏部署日志' : '查看部署日志'}</button>
          </div>
          {showLog && <pre className="log-view" ref={logRef} data-testid="deploy-log">{log || '（暂无日志）'}</pre>}
        </div>
      )}

      <div className="panel-card" style={{ marginTop: 20 }}>
        <h3>命令行</h3>
        <pre className="log-view light">{`sudo bash deploy.sh            # 一键：未安装则安装，已安装则检查并更新
roadshow-studio check          # 检查更新
roadshow-studio update         # 更新部署（自动备份、健康检查、失败回滚）
roadshow-studio rollback       # 回滚到上一个版本
roadshow-studio status | logs -f | restart | stop | start`}</pre>
      </div>
    </div>
  );
}
