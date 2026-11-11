import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { JobStats } from '../types';
import { useToast } from '../components/Toast';
import { ACTION_LABELS, SCOPE_LABELS, TYPE_LABELS, duration, fullTime, num, speed, timeAgo } from '../lib/format';

interface Session {
  id: string;
  projectId: string;
  projectName: string | null;
  projectType: 'template' | 'deck' | null;
  userName: string;
  kind: 'create' | 'edit';
  status: 'pending' | 'running' | 'done' | 'error';
  scope: string;
  prompt: string;
  stage: string | null;
  error: string | null;
  endpoints: string[];
  retryOf: string | null;
  retriedBy: string | null;
  resumeCount?: number;
  createdAt: number;
  finishedAt: number | null;
  durationMs: number;
  stats: JobStats | null;
}

interface SessionsResponse {
  total: number;
  liveCount: number;
  last24h: { calls: number; promptTokens: number; completionTokens: number };
  sessions: Session[];
}

interface Call {
  id: number;
  endpoint: string;
  model: string;
  stage: string | null;
  status: 'ok' | 'error';
  error: string | null;
  queuedMs: number;
  startedAt: number;
  firstTokenMs: number | null;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  estimated: boolean;
  tokensPerSec: number | null;
}

const PAGE = 50;

const STATUS: Record<Session['status'], string> = { pending: '排队中', running: '进行中', done: '完成', error: '失败' };

/** `count` is the number of calls known so far: the list reloads when a running job makes another. */
function Calls({ id, count }: { id: string; count: number }) {
  const [calls, setCalls] = useState<Call[] | null>(null);
  useEffect(() => {
    api.get<{ calls: Call[] }>(`/api/admin/sessions/${id}/calls`).then((r) => setCalls(r.calls)).catch(() => setCalls([]));
  }, [id, count]);
  if (!calls) return <div className="muted small">加载中…</div>;
  if (!calls.length) return <div className="muted small">还没有完成的模型调用</div>;
  return (
    <table className="table compact calls-table" data-testid="session-calls">
      <thead>
        <tr><th>开始</th><th>阶段</th><th>接入点</th><th>状态</th><th>排队</th><th>首 token</th><th>用时</th><th>输入 / 输出 tokens</th><th>输出速度</th></tr>
      </thead>
      <tbody>
        {calls.map((c) => (
          <tr key={c.id} data-testid="session-call">
            <td className="nowrap" title={fullTime(c.startedAt)}>{new Date(c.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}</td>
            <td>{c.stage ?? '—'}</td>
            <td>{c.endpoint} <span className="muted small">{c.model}</span></td>
            <td className={c.status === 'error' ? 'err-text' : 'ok-text'} title={c.error ?? ''}>{c.status === 'ok' ? '成功' : `失败：${(c.error ?? '').slice(0, 60)}`}</td>
            <td>{c.queuedMs ? duration(c.queuedMs) : '—'}</td>
            <td>{c.firstTokenMs != null ? duration(c.firstTokenMs) : '—'}</td>
            <td>{c.durationMs != null ? duration(c.durationMs) : '—'}</td>
            <td>{num(c.promptTokens)} / {num(c.completionTokens)}{c.estimated ? <span className="muted small">（估算）</span> : null}</td>
            <td>{speed(c.tokensPerSec)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Every generation and edit job: what runs now and what ran before, with tokens and output speed. */
export function SessionsPage() {
  const toast = useToast();
  const [tab, setTab] = useState<'active' | 'history'>('active');
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<SessionsResponse>(`/api/admin/sessions?status=${tab}&limit=${limit}`)
      .then(setData)
      .catch((e) => toast(e.message, 'error'));
  }, [tab, limit, toast]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const live = !!data?.liveCount;
  useEffect(() => {
    const t = setInterval(load, tab === 'active' || live ? 2000 : 10_000);
    return () => clearInterval(t);
  }, [load, tab, live]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>会话</h1>
          <p className="muted">所有用户的生成与修改任务。进行中的任务每 2 秒刷新：当前阶段、正在使用的接入点、实时输出速度；点击一行查看每次模型调用的排队、首 token、用时与 tokens。</p>
        </div>
      </div>
      <div className="stat-row">
        <div className="stat"><span className="stat-num" data-testid="live-count">{data?.liveCount ?? '—'}</span><span className="muted small">进行中</span></div>
        <div className="stat"><span className="stat-num">{data ? num(data.last24h.calls) : '—'}</span><span className="muted small">24 小时内模型调用</span></div>
        <div className="stat">
          <span className="stat-num">{data ? `${num(data.last24h.promptTokens)} / ${num(data.last24h.completionTokens)}` : '—'}</span>
          <span className="muted small">24 小时内输入 / 输出 tokens</span>
        </div>
      </div>
      <div className="seg sessions-tabs">
        <button className={tab === 'active' ? 'on' : ''} onClick={() => { setTab('active'); setLimit(PAGE); setOpen(null); }} data-testid="sessions-active">
          进行中 {data?.liveCount ? `(${data.liveCount})` : ''}
        </button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => { setTab('history'); setLimit(PAGE); setOpen(null); }} data-testid="sessions-history">
          历史
        </button>
      </div>
      <div className="table-card">
        <table className="table sessions-table">
          <thead>
            <tr>
              <th>状态</th><th>项目</th><th>用户</th><th>任务</th><th>请求</th><th>{tab === 'active' ? '当前阶段' : '结果'}</th>
              <th>接入点</th><th>{tab === 'active' ? '已用' : '耗时'}</th><th>调用</th><th>输入 / 输出 tokens</th><th>输出速度</th>
            </tr>
          </thead>
          <tbody>
            {!data && <tr><td colSpan={11} className="muted center-text">加载中…</td></tr>}
            {data && !data.sessions.length && (
              <tr><td colSpan={11} className="muted center-text">{tab === 'active' ? '当前没有进行中的任务' : '暂无历史任务'}</td></tr>
            )}
            {data?.sessions.map((s) => {
              const lv = s.stats?.live;
              const isOpen = open === s.id;
              return (
                <Fragment key={s.id}>
                  <tr className={`session-row ${isOpen ? 'open' : ''}`} onClick={() => setOpen(isOpen ? null : s.id)} data-testid="session-row">
                    <td className="nowrap">
                      <span className={`status-tag st-${s.status}`}>
                        {(s.status === 'running' || s.status === 'pending') && <span className="spinner tiny" />}
                        {lv?.queued ? '排队等待' : STATUS[s.status]}
                      </span>
                    </td>
                    <td>
                      {s.projectName ? (
                        <Link to={`/p/${s.projectId}`} onClick={(e) => e.stopPropagation()}>{s.projectName}</Link>
                      ) : (
                        <span className="muted">（已删除）</span>
                      )}
                      {s.projectType && <span className="muted small"> · {TYPE_LABELS[s.projectType]}</span>}
                    </td>
                    <td className="nowrap">{s.userName}</td>
                    <td className="nowrap">
                      {ACTION_LABELS[s.kind] ?? s.kind}
                      {s.kind === 'edit' && <span className="muted small"> · {SCOPE_LABELS[s.scope] ?? s.scope}</span>}
                      {s.retryOf && <span className="muted small"> · 重试</span>}
                      {!!s.resumeCount && <span className="muted small"> · 中断后继续 {s.resumeCount} 次</span>}
                    </td>
                    <td className="session-prompt" title={s.prompt}>{s.prompt || '—'}</td>
                    <td className="session-stage">
                      {s.status === 'error' ? (
                        <span className="err-text" title={s.error ?? ''}>{(s.error ?? '').slice(0, 80)}</span>
                      ) : s.status === 'done' ? (
                        <span className="ok-text">已保存</span>
                      ) : (
                        <span>
                          {s.stage ?? '准备中'}
                          {lv && !lv.queued && !lv.tokens && lv.waitingMs > 5000 && <span className="muted small"> · 等待响应 {duration(lv.waitingMs)}</span>}
                          {lv?.queued && <span className="muted small"> · 已排队 {duration(lv.waitingMs)}</span>}
                        </span>
                      )}
                    </td>
                    <td>{lv && !lv.queued ? <strong>{lv.endpoint}</strong> : s.endpoints.join('、') || '—'}</td>
                    <td className="nowrap" title={`开始于 ${fullTime(s.createdAt)}`}>
                      {duration(s.durationMs)}
                      {tab === 'history' && <div className="muted small">{timeAgo(s.finishedAt ?? s.createdAt)}</div>}
                    </td>
                    <td>{s.stats?.calls ?? 0}{s.stats?.failedCalls ? <span className="err-text small">（{s.stats.failedCalls} 失败）</span> : null}</td>
                    <td className="nowrap">
                      {num(s.stats?.promptTokens)} / {num(s.stats?.completionTokens)}
                      {s.stats?.estimated && <span className="muted small">（含估算）</span>}
                    </td>
                    <td className="nowrap" data-testid="session-speed">
                      {lv?.tokensPerSec ? <strong>{speed(lv.tokensPerSec)}</strong> : speed(s.stats?.tokensPerSec)}
                      {lv?.tokensPerSec && s.stats?.tokensPerSec ? <div className="muted small">平均 {speed(s.stats.tokensPerSec)}</div> : null}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="session-detail">
                      <td colSpan={11}>
                        <Calls id={s.id} count={s.stats?.calls ?? 0} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {tab === 'history' && data && data.total > data.sessions.length && (
          <div className="center-text load-more">
            <button className="btn btn-sm" onClick={() => setLimit((l) => l + PAGE)}>加载更多（共 {data.total} 条）</button>
          </div>
        )}
      </div>
    </div>
  );
}
