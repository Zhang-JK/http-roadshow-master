import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import type { DB } from './db.js';
import { HttpError, SESSION_COOKIE, userFromToken } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { llmRoutes } from './routes/llm.js';
import { projectRoutes } from './routes/projects.js';
import { sessionRoutes } from './routes/sessions.js';
import { shareRoutes } from './routes/share.js';
import { systemRoutes } from './routes/system.js';
import { mcpRoutes } from './mcp.js';
import { versionInfo } from './system.js';

export async function buildApp(db: DB, opts: { logger?: boolean; serveWeb?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 20 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 20 } });

  app.addHook('onRequest', async (req) => {
    req.user = userFromToken(db, req.cookies[SESSION_COOKIE]);
  });

  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ error: err.message || '服务器错误' });
  });

  app.get('/api/health', async () => ({ ok: true, version: versionInfo().version }));
  authRoutes(app, db);
  llmRoutes(app, db);
  projectRoutes(app, db);
  sessionRoutes(app, db);
  shareRoutes(app, db);
  systemRoutes(app);
  await mcpRoutes(app, db);

  if (opts.serveWeb !== false && fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      // MCP clients probe /.well-known for OAuth metadata; the SPA page would look like a broken answer.
      if (/^\/(api|mcp|\.well-known)(\/|\?|$)/.test(req.url)) return reply.status(404).send({ error: '接口不存在' });
      return reply.type('text/html').send(fs.readFileSync(path.join(config.webDist, 'index.html')));
    });
  }
  return app;
}
