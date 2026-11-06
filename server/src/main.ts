import { buildApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { closeBrowser } from './render.js';

const db = openDb();
const app = await buildApp(db, { logger: true });
await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await closeBrowser();
    db.close();
    process.exit(0);
  });
}
