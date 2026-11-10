import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db.js';
import { config } from './config.js';

export const SESSION_COOKIE = 'rs_session';

export interface SessionUser {
  id: number;
  username: string;
  display_name: string;
  is_admin: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export function createSession(db: DB, userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    Date.now() + config.sessionDays * 86400_000,
  );
  return token;
}

export function userFromToken(db: DB, token: string | undefined): SessionUser | undefined {
  if (!token) return undefined;
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, Date.now()) as SessionUser | undefined;
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, '请先登录');
  return req.user;
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (!u.is_admin) throw new HttpError(403, '仅管理员可执行此操作');
  return u;
}

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** A new API token for a service account: shown once, only its hash and last characters are kept. */
export function issueToken(db: DB, userId: number): string {
  const token = `rs_mcp_${crypto.randomBytes(24).toString('base64url')}`;
  db.prepare('UPDATE users SET token_hash = ?, token_hint = ?, token_created_at = ? WHERE id = ?').run(hashToken(token), token.slice(-4), Date.now(), userId);
  return token;
}

export interface ServiceUser extends SessionUser {
  mcp_enabled: number;
}

/** The service account a `Authorization: Bearer <token>` header belongs to. */
export function serviceUserFromRequest(db: DB, req: FastifyRequest): ServiceUser | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  if (!m) return undefined;
  return db
    .prepare('SELECT id, username, display_name, is_admin, mcp_enabled FROM users WHERE is_service = 1 AND token_hash = ?')
    .get(hashToken(m[1])) as ServiceUser | undefined;
}

export function requireMcpCaller(db: DB, req: FastifyRequest): ServiceUser {
  const svc = serviceUserFromRequest(db, req);
  if (!svc) throw new HttpError(401, req.headers.authorization ? 'MCP 令牌无效或已被撤销' : '缺少 MCP 令牌（Authorization: Bearer …）');
  if (!svc.mcp_enabled) throw new HttpError(403, '管理员未开启「允许 MCP 请求」');
  return svc;
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: config.sessionDays * 86400,
  });
}
