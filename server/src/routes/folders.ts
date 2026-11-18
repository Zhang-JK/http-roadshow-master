import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { requireUser } from '../auth.js';
import { createFolder, deleteFolder, folderArg, folderCounts, listFolders, updateFolder, type FolderRow } from '../folders.js';

function publicFolder(f: FolderRow, names: Map<number, string>, counts: ReturnType<typeof folderCounts>) {
  const c = counts.get(f.id);
  return {
    id: f.id,
    name: f.name,
    parentId: f.parent_id,
    deckCount: c?.decks ?? 0,
    archivedCount: c?.archived ?? 0,
    folderCount: c?.folders ?? 0,
    createdBy: f.created_by ? names.get(f.created_by) ?? null : null,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
  };
}

function userNames(db: DB): Map<number, string> {
  const rows = db.prepare('SELECT id, username, display_name FROM users').all() as { id: number; username: string; display_name: string }[];
  return new Map(rows.map((r) => [r.id, r.display_name || r.username]));
}

export function folderRoutes(app: FastifyInstance, db: DB) {
  const one = (f: FolderRow) => publicFolder(f, userNames(db), folderCounts(db));

  app.get('/api/folders', async (req) => {
    requireUser(req);
    const names = userNames(db);
    const counts = folderCounts(db);
    return { folders: listFolders(db).map((f) => publicFolder(f, names, counts)) };
  });

  app.post('/api/folders', async (req) => {
    const user = requireUser(req);
    const { name, parentId } = (req.body ?? {}) as { name?: string; parentId?: string | null };
    return { folder: one(createFolder(db, user.id, name, folderArg(db, parentId))) };
  });

  app.patch('/api/folders/:id', async (req) => {
    requireUser(req);
    const { name, parentId } = (req.body ?? {}) as { name?: string; parentId?: string | null };
    return { folder: one(updateFolder(db, (req.params as { id: string }).id, { name, parentId })) };
  });

  /** Only the folder goes; what it held moves up a level. */
  app.delete('/api/folders/:id', async (req) => {
    requireUser(req);
    return { ok: true, ...deleteFolder(db, (req.params as { id: string }).id) };
  });
}
