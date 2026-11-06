import { useState } from 'react';
import { api } from '../api';
import { Modal } from './Modal';
import { useToast } from './Toast';

export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/api/auth/password', { oldPassword, newPassword });
      toast('密码已修改', 'success');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="修改密码"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy || !oldPassword || !newPassword} onClick={submit}>保存</button>
        </>
      }
    >
      <label className="field">
        <span>原密码</span>
        <input type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} />
      </label>
      <label className="field">
        <span>新密码（至少 6 位）</span>
        <input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} />
      </label>
    </Modal>
  );
}
