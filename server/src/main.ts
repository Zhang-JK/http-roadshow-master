import { buildApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { maskProxy, setupProxy } from './proxy.js';
import { closeBrowser } from './render.js';
import { applyPendingRestore, startPeriodicCheck, versionInfo, writePidFile } from './system.js';

const proxy = setupProxy();
applyPendingRestore(config.dbFile);
const db = openDb();
const app = await buildApp(db, { logger: true });
await app.listen({ port: config.port, host: config.host });
writePidFile();
startPeriodicCheck();
app.log.info(`Roadshow Studio ${versionInfo().version} listening on ${config.host}:${config.port}`);
if (proxy) app.log.info(`Outgoing requests use proxy ${maskProxy(proxy)}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await closeBrowser();
    db.close();
    process.exit(0);
  });
}
