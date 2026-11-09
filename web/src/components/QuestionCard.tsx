import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Job } from '../types';
import { useToast } from './Toast';

/** A question the AI put to the user while its job waits; anyone working on the project may answer. */
export function QuestionCard({ job, onAnswered }: { job: Job; onAnswered: () => void }) {
  const q = job.question!;
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const minutes = Math.max(0, Math.ceil((q.expiresAt - Date.now()) / 60_000));

  const send = async (body: { choice?: number; answer?: string | null }) => {
    setBusy(true);
    try {
      await api.post(`/api/jobs/${job.id}/answer`, { questionId: q.id, ...body });
      setText('');
      onAnswered();
    } catch (e) {
      toast((e as Error).message, 'error');
      onAnswered();
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) send({ answer: text.trim() });
  };

  return (
    <div className="question-card" data-testid="question-card">
      <div className="q-head">
        <span className="q-badge">{q.kind === 'scope' ? '修改范围' : 'AI 提问'}</span>
        <span className="muted small">
          {job.kind === 'create' ? '生成' : '修改'}任务已暂停，等待回答{job.userName ? ` · 发起人：${job.userName}` : ''}
        </span>
      </div>
      <div className="q-text" data-testid="question-text">{q.text}</div>
      {q.options.length > 0 && (
        <div className="q-options">
          {q.options.map((o, i) => (
            <button key={i} className={`btn btn-sm ${i === 0 ? 'btn-primary' : ''}`} disabled={busy} onClick={() => send({ choice: i })} data-testid="question-option">
              {o}
            </button>
          ))}
        </div>
      )}
      <form className="q-reply" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={q.options.length ? '或者输入你的回答…' : '输入你的回答…'} disabled={busy} data-testid="question-input" />
        <button className="btn btn-sm" type="submit" disabled={busy || !text.trim()} data-testid="question-send">回答</button>
        <button className="btn btn-sm btn-ghost" type="button" disabled={busy} onClick={() => send({ answer: null })} data-testid="question-skip">
          跳过
        </button>
      </form>
      <div className="muted small">
        {minutes > 0 ? `${minutes} 分钟内没有回答时，AI 会按自己的判断继续。` : '即将超时，AI 会按自己的判断继续。'}
      </div>
    </div>
  );
}
