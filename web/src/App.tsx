import { useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { LoginPage } from './pages/Login';
import { ProjectsPage } from './pages/Projects';
import { EditorPage } from './pages/Editor';
import { UsersPage } from './pages/Users';
import { ModelsPage } from './pages/Models';
import { PasswordDialog } from './components/PasswordDialog';

function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [pwd, setPwd] = useState(false);
  const [menu, setMenu] = useState(false);
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
        </nav>
        <div className="user-menu">
          <button className="user-chip" onClick={() => setMenu((m) => !m)} data-testid="user-menu">
            <span className="avatar">{(user?.displayName || user?.username || '?').slice(0, 1).toUpperCase()}</span>
            <span>{user?.displayName || user?.username}</span>
            {user?.isAdmin && <span className="badge badge-admin">管理员</span>}
          </button>
          {menu && (
            <div className="dropdown" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => { setPwd(true); setMenu(false); }}>修改密码</button>
              <button onClick={logout}>退出登录</button>
            </div>
          )}
        </div>
      </header>
      <main className="main">{children}</main>
      {pwd && <PasswordDialog onClose={() => setPwd(false)} />}
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="center-screen"><div className="spinner" /></div>;
  if (!user) {
    if (loc.pathname !== '/login') return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
    return <LoginPage />;
  }
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/templates" replace />} />
      <Route path="/p/:id" element={<EditorPage />} />
      <Route path="/templates" element={<Shell><ProjectsPage type="template" /></Shell>} />
      <Route path="/decks" element={<Shell><ProjectsPage type="deck" /></Shell>} />
      <Route path="/users" element={<Shell><UsersPage /></Shell>} />
      <Route path="/models" element={<Shell>{user.isAdmin ? <ModelsPage /> : <Navigate to="/templates" />}</Shell>} />
      <Route path="*" element={<Navigate to="/templates" replace />} />
    </Routes>
  );
}
