import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

export type DB = Database.Database;

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE llm_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    extra_body TEXT NOT NULL DEFAULT '{}',
    last_test_at INTEGER,
    last_test_ok INTEGER,
    last_test_message TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('template','deck')),
    name TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    template_id TEXT,
    doc TEXT,
    status TEXT NOT NULL DEFAULT 'generating',
    error TEXT,
    version_no INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE project_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    scope TEXT NOT NULL,
    page_index INTEGER,
    page_id TEXT,
    element_ids TEXT NOT NULL DEFAULT '[]',
    prompt TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '{}',
    doc TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_versions_project ON project_versions(project_id, version_no);
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL,
    extracted_text TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    request TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    version_id INTEGER,
    endpoint_id INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    cost REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_jobs_project ON jobs(project_id, created_at);
  `,
  `
  ALTER TABLE assets ADD COLUMN parent_id TEXT REFERENCES assets(id) ON DELETE CASCADE;
  ALTER TABLE assets ADD COLUMN page_no INTEGER;
  ALTER TABLE assets ADD COLUMN role TEXT NOT NULL DEFAULT 'embed';
  CREATE INDEX idx_assets_parent ON assets(parent_id, page_no);
  `,
  `
  ALTER TABLE jobs ADD COLUMN review TEXT;
  `,
  // The old default output limit (32000) was too small for long decks; saved copies of it move to the new default.
  `
  UPDATE settings SET value = '65536' WHERE key = 'maxTokens' AND value = '32000';
  `,
  `
  ALTER TABLE jobs ADD COLUMN questions TEXT;
  `,
  `
  CREATE TABLE llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
    user_id INTEGER,
    endpoint_id INTEGER,
    model TEXT,
    stage TEXT,
    queued_ms INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    first_token_at INTEGER,
    ended_at INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    estimated INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT
  );
  CREATE INDEX idx_llm_calls_job ON llm_calls(job_id);
  CREATE INDEX idx_llm_calls_endpoint ON llm_calls(endpoint_id, started_at);
  ALTER TABLE llm_endpoints ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN finished_at INTEGER;
  ALTER TABLE jobs ADD COLUMN retry_of TEXT;
  ALTER TABLE jobs ADD COLUMN retried_by TEXT;
  CREATE INDEX idx_jobs_status ON jobs(status, created_at);
  `,
  `
  ALTER TABLE llm_endpoints ADD COLUMN use_proxy INTEGER NOT NULL DEFAULT 1;
  `,
  `
  ALTER TABLE users ADD COLUMN is_service INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN mcp_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN token_hash TEXT;
  ALTER TABLE users ADD COLUMN token_hint TEXT;
  ALTER TABLE users ADD COLUMN token_created_at INTEGER;
  CREATE UNIQUE INDEX idx_users_token ON users(token_hash) WHERE token_hash IS NOT NULL;
  `,
];

/** Service account the MCP endpoint acts as; it has a token instead of a password. */
export const MCP_USERNAME = 'mcp';

export function openDb(file = config.dbFile): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY)');
  const done = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map((r) => r.version),
  );
  MIGRATIONS.forEach((sql, i) => {
    if (done.has(i + 1)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (version) VALUES (?)').run(i + 1);
    })();
  });
  ensureAdmin(db);
  ensureMcpAccount(db);
  // Jobs interrupted by a restart can never finish.
  db.prepare(`UPDATE jobs SET status='error', error='服务重启，任务中断', finished_at=updated_at WHERE status IN ('pending','running')`).run();
  db.prepare(`UPDATE projects SET status='error', error='服务重启，生成中断' WHERE status='generating'`).run();
  return db;
}

function ensureAdmin(db: DB) {
  const exists = db.prepare('SELECT 1 FROM users WHERE is_admin = 1 LIMIT 1').get();
  if (exists) return;
  db.prepare(
    'INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, 1, ?)',
  ).run(config.adminUsername, '管理员', bcrypt.hashSync(config.adminPassword, 10), Date.now());
}

/** MCP requests are off until an admin turns them on and creates a token. */
function ensureMcpAccount(db: DB) {
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(MCP_USERNAME)) {
    db.prepare('UPDATE users SET is_service = 1 WHERE username = ? AND is_admin = 0').run(MCP_USERNAME);
    return;
  }
  db.prepare(
    `INSERT INTO users (username, display_name, password_hash, is_admin, is_service, created_at) VALUES (?, 'MCP', ?, 0, 1, ?)`,
  ).run(MCP_USERNAME, bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 4), Date.now());
}

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  attachScreenshots: true,
  selfCheck: true,
  selfCheckRounds: 10,
  maxTokens: 65536,
  contextTokens: 200000,
  generateMode: 'files',
  genPagesPerCall: 3,
  temperature: 0.7,
  editMode: 'tools',
  editToolRounds: 12,
  llmIdleTimeoutSec: 600,
  llmMaxCallMinutes: 120,
  askUser: true,
  askTimeoutMinutes: 30,
};

export function getSettings(db: DB): typeof DEFAULT_SETTINGS {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

export function setSettings(db: DB, patch: Record<string, unknown>) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (k in DEFAULT_SETTINGS) stmt.run(k, JSON.stringify(v));
    }
  })();
}
