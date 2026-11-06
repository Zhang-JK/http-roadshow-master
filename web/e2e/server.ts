// Test server for browser e2e: fresh data dir, mock LLM endpoint pre-configured, built web app served.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm } from '../../server/test/mockLlm.ts';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-e2e-'));
process.env.DATA_DIR = dataDir;
process.env.WEB_DIST = path.resolve(import.meta.dirname, '../dist');

const mock = await startMockLlm({ delayMs: 1500 });
const { openDb } = await import('../../server/src/db.ts');
const { buildApp } = await import('../../server/src/app.ts');
const db = openDb();
db.prepare(
  `INSERT INTO llm_endpoints (name, base_url, api_key, model, weight, enabled, extra_body, created_at) VALUES (?, ?, ?, ?, 1, 1, '{}', ?)`,
).run('Mock LLM', mock.url, 'good-key', 'mock-vision', Date.now());
fs.writeFileSync(path.join(dataDir, 'mock-url.txt'), mock.url);
const app = await buildApp(db);
const port = Number(process.env.E2E_PORT ?? 8799);
await app.listen({ port, host: '127.0.0.1' });
console.log(`e2e server on ${port}, data ${dataDir}, mock ${mock.url}`);
