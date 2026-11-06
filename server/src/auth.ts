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

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: config.sessionDays * 86400,
  });
}
