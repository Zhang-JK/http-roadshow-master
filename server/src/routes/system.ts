import type { FastifyInstance } from 'fastify';
import { HttpError, requireAdmin, requireUser } from '../auth.js';
import { config } from '../config.js';
import { checkForUpdates, deployLogTail, getLastCheck, isManaged, startUpdate, updateStatus, versionInfo } from '../system.js';

export function systemRoutes(app: FastifyInstance) {
  app.get('/api/system/info', async (req) => {
    const user = requireUser(req);
    const base = { version: versionInfo(), managed: isManaged() };
    if (!user.is_admin) return { ...base, updateAvailable: !!getLastCheck()?.updateAvailable };
    return {
      ...base,
      port: config.port,
      baseDir: config.baseDir ?? null,
      lastCheck: getLastCheck(),
      updateAvailable: !!getLastCheck()?.updateAvailable,
      status: updateStatus(),
      uptimeSec: Math.round(process.uptime()),
    };
  });

  app.post('/api/system/check', async (req) => {
    requireAdmin(req);
    try {
      return { result: await checkForUpdates() };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  app.post('/api/system/update', async (req) => {
    requireAdmin(req);
    const { force } = (req.body ?? {}) as { force?: boolean };
    try {
      startUpdate(!!force);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return { started: true };
  });

  app.get('/api/system/update-log', async (req) => {
    requireAdmin(req);
    const { lines } = req.query as { lines?: string };
    return { log: deployLogTail(Math.min(1000, Number(lines) || 200)), status: updateStatus(), version: versionInfo() };
  });
}
