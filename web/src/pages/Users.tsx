import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import type { User } from '../types';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { fullTime } from '../lib/format';

export function UsersPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [form, setForm] = useState({ username: '', displayName: '', password: '' });
  const [newPwd, setNewPwd] = useState('');

  const load = useCallback(() => {
    api.get<{ users: User[] }>('/api/users').then((r) => setUsers(r.users)).catch((e) => toast(e.message, 'error'));
  }, [toast]);
  useEffect(load, [load]);

  const create = async () => {
    try {
      await api.post('/api/users', form);
      toast(`已创建用户 ${form.username}`, 'success');
      setCreating(false);
      setForm({ username: '', displayName: '', password: '' });
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const reset = async () => {
    if (!resetting) return;
    try {
      await api.patch(`/api/users/${resetting.id}`, { password: newPwd });
      toast('密码已重置', 'success');
      setResetting(null);
      setNewPwd('');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const remove = async (u: User) => {
    if (!confirm(`确定删除用户「${u.username}」？其修改历史会保留但显示为已删除用户。`)) return;
    try {
      await api.del(`/api/users/${u.id}`);
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>用户管理</h1>
          <p className="muted">所有用户都可以创建和修改任意模板与路演材料；只有管理员可以创建用户和配置模型接入。</p>
        </div>
        {me?.isAdmin && <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="add-user">＋ 新建用户</button>}
      </div>
      <div className="table-card">
        <table className="table">
          <thead>
            <tr><th>用户名</th><th>显示名</th><th>角色</th><th>创建时间</th>{me?.isAdmin && <th className="right">操作</th>}</tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} data-testid="user-row">
                <td><span className="avatar sm">{u.username.slice(0, 1).toUpperCase()}</span> {u.username}</td>
                <td>{u.displayName}</td>
                <td>{u.isAdmin ? <span className="badge badge-admin">管理员</span> : <span className="badge">成员</span>}</td>
                <td className="muted">{fullTime(u.createdAt)}</td>
                {me?.isAdmin && (
                  <td className="right">
                    <button className="btn btn-sm" onClick={() => setResetting(u)}>重置密码</button>{' '}
                    {!u.isAdmin && <button className="btn btn-sm btn-danger" onClick={() => remove(u)}>删除</button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && (
        <Modal
          title="新建用户"
          onClose={() => setCreating(false)}
          footer={<><button className="btn" onClick={() => setCreating(false)}>取消</button><button className="btn btn-primary" onClick={create} data-testid="save-user">创建</button></>}
        >
          <label className="field"><span>用户名（登录用）</span><input name="new-username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
          <label className="field"><span>显示名</span><input name="new-display" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label>
          <label className="field"><span>初始密码（至少 6 位）</span><input name="new-password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        </Modal>
      )}
      {resetting && (
        <Modal
          title={`重置 ${resetting.username} 的密码`}
          onClose={() => setResetting(null)}
          footer={<><button className="btn" onClick={() => setResetting(null)}>取消</button><button className="btn btn-primary" onClick={reset}>重置</button></>}
        >
          <label className="field"><span>新密码（至少 6 位）</span><input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} /></label>
          <p className="muted small">重置后该用户的所有登录会话将失效。</p>
        </Modal>
      )}
    </div>
  );
}
