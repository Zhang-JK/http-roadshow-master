import { useState } from 'react';
import { useAuth } from '../auth';

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-screen">
      <div className="login-hero">
        <img src="/favicon.svg" alt="" width={56} />
        <h1>路演工坊</h1>
        <p>用对话生成、逐页精修 HTML 路演材料，一键导出 HTML / PDF / PPT。</p>
        <ul>
          <li>先设计可复用的模板，再基于模板生成路演材料</li>
          <li>点击或框选页面元素，精准修改任意部分</li>
          <li>多人协作，每次修改都有据可查</li>
        </ul>
      </div>
      <form className="login-card" onSubmit={submit}>
        <h2>登录</h2>
        <label className="field">
          <span>用户名</span>
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} name="username" />
        </label>
        <label className="field">
          <span>密码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} name="password" />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy || !username || !password}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
