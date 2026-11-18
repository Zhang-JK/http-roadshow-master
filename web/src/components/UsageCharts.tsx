import { useState, type ReactNode } from 'react';
import { num, speed } from '../lib/format';

export interface DailyUsage {
  /** Local date, YYYY-MM-DD. */
  date: string;
  tasks: number;
  failedTasks: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  tokensPerSec: number | null;
}

const W = 560;
const H = 220;
const PAD = { left: 48, right: 40, top: 14, bottom: 28 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const DIVISIONS = 4;

/** A round step (1, 2, 2.5 or 5 × 10ⁿ; 3 instead of 2.5 for counts) so that DIVISIONS of it cover `max`. */
function niceStep(max: number, integer = false): number {
  const raw = max / DIVISIONS;
  if (raw <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const f = raw / exp;
  const steps = integer ? [1, 2, 3, 5, 10] : [1, 2, 2.5, 5, 10];
  const step = steps.find((s) => f <= s)! * exp;
  return integer ? Math.max(1, Math.round(step)) : step;
}

function compact(n: number): string {
  const short = (v: number, unit: string) => `${v.toFixed(v < 10 ? 1 : 0).replace(/\.0$/, '')}${unit}`;
  if (n >= 1e9) return short(n / 1e9, 'B');
  if (n >= 1e6) return short(n / 1e6, 'M');
  if (n >= 1e3) return short(n / 1e3, 'k');
  return String(Math.round(n * 10) / 10);
}

const x = (i: number, n: number) => PAD.left + (PLOT_W / n) * (i + 0.5);
const y = (v: number, max: number) => PAD.top + PLOT_H - (v / max) * PLOT_H;

/** Axes, grid, date labels, hover bands and the tooltip shared by both charts. */
function Frame(props: {
  daily: DailyUsage[];
  leftMax: number;
  leftFormat: (v: number) => string;
  rightMax?: number;
  rightColor?: string;
  label: string;
  empty: boolean;
  tooltip: (d: DailyUsage) => ReactNode;
  testid: string;
  children: ReactNode;
}) {
  const { daily, leftMax, rightMax } = props;
  const n = daily.length;
  const [hover, setHover] = useState<number | null>(null);
  const band = PLOT_W / n;
  const every = Math.ceil(n / 8);
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={props.label} data-testid={props.testid} onMouseLeave={() => setHover(null)}>
        {Array.from({ length: DIVISIONS + 1 }, (_, k) => {
          const ty = PAD.top + PLOT_H - (PLOT_H / DIVISIONS) * k;
          return (
            <g key={k}>
              <line x1={PAD.left} x2={W - PAD.right} y1={ty} y2={ty} className={k ? 'chart-grid' : 'chart-axis'} />
              <text x={PAD.left - 6} y={ty + 4} textAnchor="end" className="chart-tick">{props.leftFormat((leftMax / DIVISIONS) * k)}</text>
              {rightMax !== undefined && (
                <text x={W - PAD.right + 6} y={ty + 4} className="chart-tick" fill={props.rightColor}>{compact((rightMax / DIVISIONS) * k)}</text>
              )}
            </g>
          );
        })}
        {hover !== null && <rect x={PAD.left + band * hover} y={PAD.top} width={band} height={PLOT_H} className="chart-hover" />}
        {props.children}
        {daily.map((d, i) =>
          (n - 1 - i) % every === 0 ? (
            <text key={d.date} x={x(i, n)} y={H - 8} textAnchor="middle" className="chart-tick">{d.date.slice(5)}</text>
          ) : null,
        )}
        {props.empty && <text x={PAD.left + PLOT_W / 2} y={PAD.top + PLOT_H / 2} textAnchor="middle" className="chart-empty">暂无数据</text>}
        {daily.map((d, i) => (
          <rect key={d.date} x={PAD.left + band * i} y={PAD.top} width={band} height={PLOT_H} fill="transparent" onMouseEnter={() => setHover(i)} data-testid={`${props.testid}-day`} />
        ))}
      </svg>
      {hover !== null && (
        <div
          className="chart-tip"
          style={{ left: `${(x(hover, n) / W) * 100}%`, transform: hover > n / 2 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)' }}
          data-testid={`${props.testid}-tip`}
        >
          <strong>{daily[hover].date}</strong>
          {props.tooltip(daily[hover])}
        </div>
      )}
    </div>
  );
}

const TASK_COLOR = '#d97706';

function TokenChart({ daily }: { daily: DailyUsage[] }) {
  const n = daily.length;
  const tokenStep = niceStep(Math.max(0, ...daily.map((d) => d.promptTokens + d.completionTokens)));
  const tokenMax = tokenStep * DIVISIONS;
  const taskMax = niceStep(Math.max(0, ...daily.map((d) => d.tasks)), true) * DIVISIONS;
  const barW = Math.min(28, (PLOT_W / n) * 0.6);
  const empty = daily.every((d) => !d.tasks && !d.promptTokens && !d.completionTokens);
  const line = daily.map((d, i) => `${i ? 'L' : 'M'}${x(i, n).toFixed(1)},${y(d.tasks, taskMax).toFixed(1)}`).join(' ');
  return (
    <div className="chart-box">
      <div className="chart-head">
        <h4>每日 token 用量与任务数</h4>
        <span className="chart-legend">
          <span><i style={{ background: '#a5b4fc' }} />输入 tokens</span>
          <span><i style={{ background: 'var(--primary)' }} />输出 tokens</span>
          <span><i className="line" style={{ background: TASK_COLOR }} />任务数（右轴）</span>
        </span>
      </div>
      <Frame
        daily={daily}
        leftMax={tokenMax}
        leftFormat={compact}
        rightMax={taskMax}
        rightColor={TASK_COLOR}
        label="每日输入、输出 tokens 与任务数"
        empty={empty}
        testid="chart-tokens"
        tooltip={(d) => (
          <>
            <span>输入 {num(d.promptTokens)}</span>
            <span>输出 {num(d.completionTokens)}</span>
            <span>任务 {d.tasks}{d.failedTasks ? `（失败 ${d.failedTasks}）` : ''} · 调用 {d.calls}</span>
          </>
        )}
      >
        {daily.map((d, i) => {
          const inTop = y(d.promptTokens, tokenMax);
          const outTop = y(d.promptTokens + d.completionTokens, tokenMax);
          return (
            <g key={d.date}>
              <rect x={x(i, n) - barW / 2} y={inTop} width={barW} height={PAD.top + PLOT_H - inTop} fill="#a5b4fc" />
              <rect x={x(i, n) - barW / 2} y={outTop} width={barW} height={inTop - outTop} fill="var(--primary)" />
            </g>
          );
        })}
        {!empty && <path d={line} fill="none" stroke={TASK_COLOR} strokeWidth={2} />}
        {!empty && daily.map((d, i) => <circle key={d.date} cx={x(i, n)} cy={y(d.tasks, taskMax)} r={3} fill="#fff" stroke={TASK_COLOR} strokeWidth={2} />)}
      </Frame>
    </div>
  );
}

const SPEED_COLOR = '#059669';

function SpeedChart({ daily }: { daily: DailyUsage[] }) {
  const n = daily.length;
  const max = niceStep(Math.max(0, ...daily.map((d) => d.tokensPerSec ?? 0))) * DIVISIONS;
  // Days without a measurable call break the line instead of dropping to zero.
  const segments: { i: number; v: number }[][] = [[]];
  daily.forEach((d, i) => {
    if (d.tokensPerSec == null) segments.push([]);
    else segments[segments.length - 1].push({ i, v: d.tokensPerSec });
  });
  const path = (pts: { i: number; v: number }[]) => pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i, n).toFixed(1)},${y(p.v, max).toFixed(1)}`).join(' ');
  const base = PAD.top + PLOT_H;
  return (
    <div className="chart-box">
      <div className="chart-head">
        <h4>每日平均输出速度</h4>
        <span className="chart-legend"><span><i className="line" style={{ background: SPEED_COLOR }} />tok/s</span></span>
      </div>
      <Frame
        daily={daily}
        leftMax={max}
        leftFormat={compact}
        label="每日平均输出速度（tokens/秒）"
        empty={daily.every((d) => d.tokensPerSec == null)}
        testid="chart-speed"
        tooltip={(d) => (
          <>
            <span>平均输出速度 {speed(d.tokensPerSec)}</span>
            <span>调用 {d.calls}</span>
          </>
        )}
      >
        {segments.filter((s) => s.length).map((s) => (
          <g key={s[0].i}>
            <path d={`${path(s)} L${x(s[s.length - 1].i, n).toFixed(1)},${base} L${x(s[0].i, n).toFixed(1)},${base} Z`} fill={SPEED_COLOR} opacity={0.08} />
            <path d={path(s)} fill="none" stroke={SPEED_COLOR} strokeWidth={2} />
            {s.map((p) => <circle key={p.i} cx={x(p.i, n)} cy={y(p.v, max)} r={3} fill="#fff" stroke={SPEED_COLOR} strokeWidth={2} />)}
          </g>
        ))}
      </Frame>
    </div>
  );
}

export function UsageCharts({ daily }: { daily: DailyUsage[] }) {
  if (!daily.length) return null;
  return (
    <div className="usage-charts" data-testid="usage-charts">
      <TokenChart daily={daily} />
      <SpeedChart daily={daily} />
    </div>
  );
}
