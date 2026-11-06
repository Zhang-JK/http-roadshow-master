import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { HttpError, SESSION_COOKIE, createSession, requireAdmin, requireUser, setSessionCookie } from '../auth.js';

const publicUser = (u: any) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  isAdmin: !!u.is_admin,
  createdAt: u.created_at,
});

export function authRoutes(app: FastifyInstance, db: DB) {
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '').trim()) as any;
    if (!u || !bcrypt.compareSync(String(password ?? ''), u.password_hash)) throw new HttpError(401, '用户名或密码错误');
    setSessionCookie(reply, createSession(db, u.id));
    return { user: publicUser(u) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const u = requireUser(req);
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) };
  });

  app.post('/api/auth/password', async (req) => {
    const u = requireUser(req);
    const { oldPassword, newPassword } = (req.body ?? {}) as { oldPassword?: string; newPassword?: string };
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as any;
    if (!bcrypt.compareSync(String(oldPassword ?? ''), row.password_hash)) throw new HttpError(400, '原密码错误');
    if (!newPassword || newPassword.length < 6) throw new HttpError(400, '新密码至少 6 位');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), u.id);
    return { ok: true };
  });

  app.get('/api/users', async (req) => {
    requireUser(req);
    const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
    return { users: rows.map(publicUser) };
  });

  app.post('/api/users', async (req) => {
    requireAdmin(req);
    const { username, password, displayName } = (req.body ?? {}) as Record<string, string>;
    const name = String(username ?? '').trim();
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(name)) throw new HttpError(400, '用户名需为 2–32 位字母、数字、下划线、点或连字符');
    if (!password || password.length < 6) throw new HttpError(400, '密码至少 6 位');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) throw new HttpError(409, '用户名已存在');
    const r = db
      .prepare('INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(name, String(displayName ?? '').trim() || name, bcrypt.hashSync(password, 10), Date.now());
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)) };
  });

  app.patch('/api/users/:id', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as any).id);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    if (!row) throw new HttpError(404, '用户不存在');
    const { password, displayName } = (req.body ?? {}) as Record<string, string>;
    if (password !== undefined) {
      if (password.length < 6) throw new HttpError(400, '密码至少 6 位');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (displayName !== undefined) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName.trim(), id);
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
  });

  app.delete('/api/users/:id', async (req) => {
    const me = requireAdmin(req);
    const id = Number((req.params as any).id);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    if (!row) throw new HttpError(404, '用户不存在');
    if (row.is_admin || id === me.id) throw new HttpError(400, '不能删除管理员账户');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  });
}
