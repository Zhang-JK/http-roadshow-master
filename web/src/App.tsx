import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { SystemPage } from './pages/System';
import { useAuth } from './auth';
import { LoginPage } from './pages/Login';
import { ProjectsPage } from './pages/Projects';
import { EditorPage } from './pages/Editor';
import { UsersPage } from './pages/Users';
import { ModelsPage } from './pages/Models';
import { SessionsPage } from './pages/Sessions';
import { SharePage } from './pages/Share';
import { PasswordDialog } from './components/PasswordDialog';
import { NotifyBanner, NotifyMenuItem } from './components/Notify';

const GITHUB_URL = 'https://github.com/Zhang-JK/http-roadshow-master';

function GithubIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [pwd, setPwd] = useState(false);
  const [menu, setMenu] = useState(false);
  const [sys, setSys] = useState<{ version: { version: string }; updateAvailable: boolean } | null>(null);
  useEffect(() => {
    api.get<typeof sys>('/api/system/info').then(setSys).catch(() => {});
  }, []);
  return (
    <div className="app">
      <header className="topnav">
        <NavLink to="/templates" className="brand">
          <img src="/favicon.svg" alt="" />
          <span>路演工坊</span>
        </NavLink>
        <nav>
          <NavLink to="/templates">模板</NavLink>
          <NavLink to="/decks">路演材料</NavLink>
          <NavLink to="/users">用户管理</NavLink>
          {user?.isAdmin && <NavLink to="/models">模型接入</NavLink>}
          {user?.isAdmin && <NavLink to="/sessions" data-testid="nav-sessions">会话</NavLink>}
          {user?.isAdmin && (
            <NavLink to="/system">
              系统更新{sys?.updateAvailable && <span className="nav-dot" title="有新版本" data-testid="update-dot" />}
            </NavLink>
          )}
        </nav>
        <div className="user-menu">
          <button className="user-chip" onClick={() => setMenu((m) => !m)} data-testid="user-menu">
            <span className="avatar">{(user?.displayName || user?.username || '?').slice(0, 1).toUpperCase()}</span>
            <span>{user?.displayName || user?.username}</span>
            {user?.isAdmin && <span className="badge badge-admin">管理员</span>}
          </button>
          {menu && (
            <div className="dropdown" onMouseLeave={() => setMenu(false)}>
              {sys && <div className="dropdown-note">版本 {sys.version.version}</div>}
              <NotifyMenuItem />
              <button onClick={() => { setPwd(true); setMenu(false); }}>修改密码</button>
              <button onClick={logout}>退出登录</button>
              <div className="dropdown-author" data-testid="author">
                <span>Author: Zhang Jiekai</span>
                <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" title="GitHub" aria-label="GitHub" data-testid="github-link">
                  <GithubIcon />
                </a>
              </div>
            </div>
          )}
        </div>
      </header>
      <main className="main">
        <NotifyBanner />
        {children}
      </main>
      {pwd && <PasswordDialog onClose={() => setPwd(false)} />}
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="center-screen"><div className="spinner" /></div>;
  // Share links open without signing in.
  if (/^\/s\/[^/]+\/?$/.test(loc.pathname)) {
    return (
      <Routes>
        <Route path="/s/:token" element={<SharePage />} />
      </Routes>
    );
  }
  if (!user) {
    if (loc.pathname !== '/login') return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
    return <LoginPage />;
  }
  const from = (loc.state as { from?: string } | null)?.from;
  return (
    <Routes>
      <Route path="/login" element={<Navigate to={from?.startsWith('/') && !from.startsWith('//') ? from : '/templates'} replace />} />
      <Route path="/p/:id" element={<EditorPage />} />
      <Route path="/templates" element={<Shell><ProjectsPage type="template" /></Shell>} />
      <Route path="/decks" element={<Shell><ProjectsPage type="deck" /></Shell>} />
      <Route path="/users" element={<Shell><UsersPage /></Shell>} />
      <Route path="/models" element={<Shell>{user.isAdmin ? <ModelsPage /> : <Navigate to="/templates" />}</Shell>} />
      <Route path="/sessions" element={<Shell>{user.isAdmin ? <SessionsPage /> : <Navigate to="/templates" />}</Shell>} />
      <Route path="/system" element={<Shell>{user.isAdmin ? <SystemPage /> : <Navigate to="/templates" />}</Shell>} />
      <Route path="*" element={<Navigate to="/templates" replace />} />
    </Routes>
  );
}
