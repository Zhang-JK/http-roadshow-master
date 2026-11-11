import { useNotify, type NotifyBlock } from '../notify';

const BLOCK_HINTS: Record<NotifyBlock, string> = {
  insecure: '需通过 HTTPS 或 localhost 访问',
  denied: '已被浏览器阻止，请在网站设置中允许',
  unsupported: '当前浏览器不支持',
};

const BLOCK_TITLES: Record<NotifyBlock, string> = {
  insecure: '浏览器只允许 HTTPS（或 localhost）网页发送通知。请让管理员为本站配置 HTTPS；内网临时使用时，也可以在 Chrome 的 chrome://flags/#unsafely-treat-insecure-origin-as-secure 中加入本站地址。',
  denied: '点击地址栏左侧的网站信息图标，把「通知」改为允许，然后回到这里开启。',
  unsupported: '请使用新版 Chrome、Edge、Firefox 或 Safari。',
};

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/** Asks once per browser, on the first visit, whether to turn notifications on. */
export function NotifyBanner() {
  const n = useNotify();
  if (!n.unasked) return null;
  return (
    <div className="notify-banner" data-testid="notify-banner">
      <BellIcon />
      <div className="notify-banner-text">
        <strong>开启浏览器通知？</strong>
        <span>生成或修改完成、AI 需要你回答时提醒你，切到其他标签页或应用也能收到。之后可在右上角头像菜单中开关。</span>
      </div>
      <button className="btn btn-primary btn-sm" onClick={n.enable} data-testid="notify-enable">
        开启通知
      </button>
      <button className="btn btn-ghost btn-sm" onClick={n.dismiss} data-testid="notify-later">
        暂不
      </button>
    </div>
  );
}

export function NotifyMenuItem() {
  const n = useNotify();
  const hint = n.blocked ? BLOCK_HINTS[n.blocked] : n.enabled ? '任务完成时提醒你' : '已关闭';
  return (
    <label className={`dropdown-switch ${n.blocked ? 'disabled' : ''}`} title={n.blocked ? BLOCK_TITLES[n.blocked] : undefined} data-testid="notify-menu">
      <BellIcon />
      <span className="dropdown-switch-text">
        任务完成通知
        <small data-testid="notify-hint">{hint}</small>
      </span>
      <input
        type="checkbox"
        checked={n.enabled}
        disabled={!!n.blocked}
        onChange={(e) => (e.target.checked ? n.enable() : n.disable())}
        data-testid="notify-toggle"
      />
    </label>
  );
}
