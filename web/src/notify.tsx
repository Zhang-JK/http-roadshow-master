import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { useToast } from './components/Toast';
import { TYPE_LABELS } from './lib/format';
import type { Job, ProjectType } from './types';

/** 'on' / 'off' once the user has chosen in this browser; absent until then. */
const PREF_KEY = 'rs-notify';
const ICON = '/notification-icon.png';

/** Why this browser can't show notifications for the app. */
export type NotifyBlock = 'insecure' | 'unsupported' | 'denied';

interface MyJob extends Job {
  projectName: string | null;
  projectType: ProjectType | null;
}

interface MyJobs {
  now: number;
  active: MyJob[];
  finished: MyJob[];
}

interface NotifyState {
  /** The user turned notifications on and the browser allows them. */
  enabled: boolean;
  /** Not asked yet in this browser, and asking could work. */
  unasked: boolean;
  blocked: NotifyBlock | null;
  enable: () => Promise<void>;
  disable: () => void;
  /** Not now: leave them off without asking the browser. */
  dismiss: () => void;
}

const Ctx = createContext<NotifyState>(null as unknown as NotifyState);

const hasApi = () => 'Notification' in window;

function readPref(): 'on' | 'off' | null {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === 'on' || v === 'off' ? v : null;
  } catch {
    return null;
  }
}

function writePref(v: 'on' | 'off') {
  try {
    localStorage.setItem(PREF_KEY, v);
  } catch {
    /* storage disabled: the choice lasts until the page reloads */
  }
}

function show(title: string, body: string, tag: string, onClick?: () => void) {
  try {
    const n = new Notification(title, { body, tag, icon: ICON, lang: 'zh-CN' });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    /* mobile Chrome only shows notifications from a service worker */
  }
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);

function finishedText(j: MyJob): [string, string] {
  const name = j.projectName ? `「${j.projectName}」` : '';
  const created = j.kind === 'create';
  const label = TYPE_LABELS[j.projectType ?? 'deck'];
  if (j.status === 'done') return created ? [`${label}生成完成`, `${name}已生成，点击打开查看`] : ['修改已应用', clip(`${name}：${j.request.prompt ?? ''}`)];
  return [created ? `${label}生成失败` : '修改失败', clip(`${name}：${j.error ?? '未知错误'}`)];
}

export function NotifyProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [pref, setPref] = useState(readPref);
  const [permission, setPermission] = useState<NotificationPermission>(() => (hasApi() ? Notification.permission : 'denied'));
  const navRef = useRef(nav);
  const pathRef = useRef(pathname);
  useEffect(() => {
    navRef.current = nav;
    pathRef.current = pathname;
  }, [nav, pathname]);

  const blocked: NotifyBlock | null = !window.isSecureContext ? 'insecure' : !hasApi() ? 'unsupported' : permission === 'denied' ? 'denied' : null;
  // Permission granted before the user chose here (e.g. by another account in this browser) counts as on.
  const enabled = !blocked && permission === 'granted' && pref !== 'off';
  const unasked = !blocked && pref === null && permission !== 'granted';

  const choose = useCallback((v: 'on' | 'off') => {
    writePref(v);
    setPref(v);
  }, []);

  // Follow changes made in the site settings and in other tabs.
  useEffect(() => {
    const sync = () => {
      if (hasApi()) setPermission(Notification.permission);
      setPref(readPref());
    };
    let status: PermissionStatus | undefined;
    navigator.permissions
      ?.query({ name: 'notifications' })
      .then((s) => {
        status = s;
        s.onchange = sync;
      })
      .catch(() => {});
    window.addEventListener('focus', sync);
    window.addEventListener('storage', sync);
    return () => {
      if (status) status.onchange = null;
      window.removeEventListener('focus', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const enable = useCallback(async () => {
    if (blocked) return;
    let p = Notification.permission;
    if (p === 'default') p = await Notification.requestPermission();
    setPermission(p);
    if (p === 'granted') {
      choose('on');
      show('任务通知已开启', '生成或修改完成、AI 需要你回答时，会在这里提醒你。', 'rs-notify-on');
      toast('已开启任务通知', 'success');
    } else {
      choose('off');
      toast(
        p === 'denied' ? '浏览器拒绝了通知权限：请在地址栏左侧的网站设置中允许通知，再到右上角头像菜单开启' : '没有获得通知权限，之后可在右上角头像菜单开启',
        p === 'denied' ? 'error' : 'info',
      );
    }
  }, [blocked, choose, toast]);

  const disable = useCallback(() => {
    choose('off');
    toast('已关闭任务通知', 'info');
  }, [choose, toast]);

  const dismiss = useCallback(() => {
    choose('off');
    toast('之后可在右上角头像菜单开启任务通知', 'info');
  }, [choose, toast]);

  const uid = user?.id;
  useEffect(() => {
    if (!uid || !enabled) return;
    /** `since`: the server time of the last poll; `running`: job ids active then. */
    const poll = { stopped: false, since: 0, running: [] as string[], timer: undefined as ReturnType<typeof setTimeout> | undefined };
    const told = new Set<string>();
    // Someone looking at the project's editor already sees its toasts and question cards.
    const watching = (projectId: string) => document.visibilityState === 'visible' && document.hasFocus() && pathRef.current === `/p/${projectId}`;
    const tell = (tag: string, j: MyJob, [title, body]: [string, string]) => {
      if (told.has(tag)) return;
      told.add(tag);
      if (!watching(j.projectId)) show(title, body, tag, () => navRef.current(`/p/${j.projectId}`));
    };
    const tick = async () => {
      const qs = new URLSearchParams();
      if (poll.since) qs.set('since', String(poll.since));
      if (poll.running.length) qs.set('ids', poll.running.join(','));
      try {
        const r = await api.get<MyJobs>(`/api/jobs/mine?${qs}`);
        if (poll.stopped) return;
        poll.since = r.now;
        poll.running = r.active.map((j) => j.id);
        for (const j of r.active) {
          if (j.question) tell(`rs-q-${j.question.id}`, j, ['AI 在等你回答', clip(`${j.projectName ? `「${j.projectName}」` : ''}：${j.question.text}`)]);
        }
        // A failed job continued from its saved progress finishes again: each run is told once.
        for (const j of r.finished) tell(`rs-job-${j.id}${j.resumeCount ? `-${j.resumeCount}` : ''}`, j, finishedText(j));
      } catch {
        /* offline for a moment: try again on the next tick */
      }
      if (!poll.stopped) poll.timer = setTimeout(tick, poll.running.length ? 3000 : 10_000);
    };
    tick();
    return () => {
      poll.stopped = true;
      clearTimeout(poll.timer);
    };
  }, [uid, enabled]);

  return <Ctx.Provider value={{ enabled, unasked, blocked, enable, disable, dismiss }}>{children}</Ctx.Provider>;
}

export const useNotify = () => useContext(Ctx);
