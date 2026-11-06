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

export async function buildApp(db: DB, opts: { logger?: boolean; serveWeb?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 20 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 20 } });

  app.addHook('onRequest', async (req) => {
    req.user = userFromToken(db, req.cookies[SESSION_COOKIE]);
  });

  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ error: err.message || '服务器错误' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  authRoutes(app, db);
  llmRoutes(app, db);
  projectRoutes(app, db);

  if (opts.serveWeb !== false && fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: '接口不存在' });
      return reply.type('text/html').send(fs.readFileSync(path.join(config.webDist, 'index.html')));
    });
  }
  return app;
}
