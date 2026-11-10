import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import type { User } from '../types';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { fullTime } from '../lib/format';

const TOKEN_PLACEHOLDER = '<令牌>';

/** navigator.clipboard only exists on https and localhost; LAN installs are often plain http. */
async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('浏览器不允许复制，请手动选择文本复制');
}

function CopyBox({ value, testId }: { value: string; testId?: string }) {
  const toast = useToast();
  const copy = () => copyText(value).then(() => toast('已复制', 'success'), (e) => toast((e as Error).message, 'error'));
  return (
    <div className="copy-box">
      <pre data-testid={testId}>{value}</pre>
      <button type="button" className="btn btn-sm" onClick={copy}>复制</button>
    </div>
  );
}

const clientConfig = (url: string, token: string) =>
  JSON.stringify({ mcpServers: { roadshow: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);

function McpCard({ user, onChange }: { user: User; onChange: (u: User) => void }) {
  const toast = useToast();
  const [token, setToken] = useState<string | null>(null);
  const url = `${window.location.origin}/mcp`;

  const issue = async () => {
    if (user.tokenHint && !confirm('重新生成后，正在使用旧令牌的客户端会立即失效。确定重新生成？')) return;
    try {
      const r = await api.post<{ token: string; user: User }>(`/api/users/${user.id}/token`);
      setToken(r.token);
      onChange(r.user);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const revoke = async () => {
    if (!confirm('撤销后所有 MCP 客户端都无法再连接，直到生成新令牌。确定撤销？')) return;
    try {
      onChange((await api.del<{ user: User }>(`/api/users/${user.id}/token`)).user);
      toast('令牌已撤销', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="panel-card mcp-card" data-testid="mcp-card">
      <h3>MCP 接入</h3>
      <p className="muted small">
        AI 助手（Cursor、Claude 等）可以通过 MCP 用 <code>{user.username}</code> 账户创建路演材料：先列出可用模板，再上传完整的测试数据、结果与图片生成材料。
        创建的材料出现在「路演材料」中，所有用户都可以继续修改。
      </p>
      <div className="kv">
        <span>状态</span>
        <span>{user.mcpEnabled ? <span className="ok-text">已允许 MCP 请求</span> : <span className="warn-text">未允许 MCP 请求（在上方 {user.username} 行开启）</span>}</span>
        <span>令牌</span>
        <span className="row gap wrap">
          {user.tokenHint ? (
            <span data-testid="mcp-token-hint">
              <code>rs_mcp_…{user.tokenHint}</code> <span className="muted">创建于 {fullTime(user.tokenCreatedAt ?? 0)}</span>
            </span>
          ) : (
            <span className="muted">尚未生成</span>
          )}
          <button type="button" className="btn btn-sm" onClick={issue} data-testid="mcp-token">{user.tokenHint ? '重新生成令牌' : '生成令牌'}</button>
          {user.tokenHint && <button type="button" className="btn btn-sm btn-danger" onClick={revoke} data-testid="mcp-revoke">撤销令牌</button>}
        </span>
        <span>服务地址</span>
        <span><code data-testid="mcp-url">{url}</code>（Streamable HTTP，请求头 <code>Authorization: Bearer {TOKEN_PLACEHOLDER}</code>）</span>
        <span>工具</span>
        <span>
          <code>list_roadshow_templates</code> 列出模板 · <code>create_roadshow_slides</code> 创建路演材料 · <code>get_roadshow_slides_status</code> 查询进度与下载链接
        </span>
      </div>
      <h4 className="mcp-sub">Cursor / Claude Desktop（mcp.json）</h4>
      <CopyBox value={clientConfig(url, TOKEN_PLACEHOLDER)} />
      <h4 className="mcp-sub">Claude Code</h4>
      <CopyBox value={`claude mcp add --transport http roadshow ${url} --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`} />
      <h4 className="mcp-sub">Python 示例（examples/mcp_create_roadshow.py）</h4>
      <CopyBox value={`ROADSHOW_MCP_TOKEN=${TOKEN_PLACEHOLDER} python3 examples/mcp_create_roadshow.py --url ${url} --demo`} />

      {token && (
        <Modal
          title="MCP 令牌"
          onClose={() => setToken(null)}
          footer={<button className="btn btn-primary" onClick={() => setToken(null)} data-testid="mcp-token-done">我已保存</button>}
        >
          <div className="notice">令牌只显示这一次，关闭后无法再查看。重新生成或撤销后，旧令牌立即失效。</div>
          <CopyBox value={token} testId="mcp-token-value" />
          {!user.mcpEnabled && <p className="warn-text small">「允许 MCP 请求」尚未开启，开启后客户端才能连接。</p>}
          <h4 className="mcp-sub">客户端配置</h4>
          <CopyBox value={clientConfig(url, token)} />
        </Modal>
      )}
    </div>
  );
}

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

  const replace = (u: User) => setUsers((list) => list.map((x) => (x.id === u.id ? u : x)));

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

  const setMcp = async (u: User, enabled: boolean) => {
    replace({ ...u, mcpEnabled: enabled });
    try {
      replace((await api.patch<{ user: User }>(`/api/users/${u.id}`, { mcpEnabled: enabled })).user);
      toast(enabled ? '已允许 MCP 请求' : '已关闭 MCP 请求', 'success');
    } catch (e) {
      replace(u);
      toast((e as Error).message, 'error');
    }
  };

  const mcpUser = users.find((u) => u.isService);

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
                <td>
                  {u.isService ? (
                    <>
                      <span className="badge badge-service">MCP 服务账户</span>{' '}
                      {!me?.isAdmin && <span className="muted small">{u.mcpEnabled ? '已开启' : '已关闭'}</span>}
                    </>
                  ) : u.isAdmin ? (
                    <span className="badge badge-admin">管理员</span>
                  ) : (
                    <span className="badge">成员</span>
                  )}
                </td>
                <td className="muted">{fullTime(u.createdAt)}</td>
                {me?.isAdmin && (
                  <td className="right">
                    {u.isService ? (
                      <label className="switch" title="关闭后所有 MCP 请求都会被拒绝（令牌保留）">
                        <input type="checkbox" checked={!!u.mcpEnabled} onChange={(e) => setMcp(u, e.target.checked)} data-testid="mcp-toggle" />
                        <span>允许 MCP 请求</span>
                      </label>
                    ) : (
                      <>
                        <button className="btn btn-sm" onClick={() => setResetting(u)}>重置密码</button>{' '}
                        {!u.isAdmin && <button className="btn btn-sm btn-danger" onClick={() => remove(u)}>删除</button>}
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {me?.isAdmin && mcpUser && <McpCard user={mcpUser} onChange={replace} />}

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
