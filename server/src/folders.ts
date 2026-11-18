import { nanoid } from 'nanoid';
import type { DB } from './db.js';
import { HttpError } from './auth.js';
import type { ProjectRow } from './projects.js';

/** Folders hold decks (路演材料) and other folders; templates are never in a folder. */
export interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

export const MAX_FOLDER_NAME = 100;
export const MAX_FOLDER_DEPTH = 8;

export const getFolder = (db: DB, id: string) => db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;

export const listFolders = (db: DB) => db.prepare('SELECT * FROM folders ORDER BY name COLLATE NOCASE, created_at').all() as FolderRow[];

/** The folder's ancestors and itself, from the top level down. */
export function folderChain(db: DB, id: string | null): FolderRow[] {
  const chain: FolderRow[] = [];
  const seen = new Set<string>();
  for (let f = id ? getFolder(db, id) : undefined; f && !seen.has(f.id); f = f.parent_id ? getFolder(db, f.parent_id) : undefined) {
    seen.add(f.id);
    chain.unshift(f);
  }
  return chain;
}

/** "A / B / C"; empty for the top level. */
export const folderPath = (db: DB, id: string | null) =>
  folderChain(db, id)
    .map((f) => f.name)
    .join(' / ');

export function cleanFolderName(raw: unknown): string {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) throw new HttpError(400, '文件夹名称不能为空');
  if (name.length > MAX_FOLDER_NAME) throw new HttpError(400, `文件夹名称最多 ${MAX_FOLDER_NAME} 个字`);
  return name;
}

/** The folder a request names: null for the top level (missing, null or ""), else it must exist. */
export function folderArg(db: DB, raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = String(raw).trim();
  if (!id) return null;
  if (!getFolder(db, id)) throw new HttpError(400, '所选文件夹不存在');
  return id;
}

const sibling = (db: DB, parentId: string | null, name: string, except?: string) =>
  db
    .prepare('SELECT * FROM folders WHERE parent_id IS ? AND name = ? COLLATE NOCASE AND id IS NOT ?')
    .get(parentId, name, except ?? null) as FolderRow | undefined;

/** A folder of that name in `parentId`, if any (names are unique among siblings, ignoring case). */
export const findFolder = (db: DB, parentId: string | null, name: string) => sibling(db, parentId, name);

export function createFolder(db: DB, userId: number, rawName: unknown, parentId: string | null): FolderRow {
  const name = cleanFolderName(rawName);
  if (parentId && folderChain(db, parentId).length >= MAX_FOLDER_DEPTH) throw new HttpError(400, `文件夹最多 ${MAX_FOLDER_DEPTH} 层`);
  if (sibling(db, parentId, name)) throw new HttpError(409, `「${folderPath(db, parentId) || '全部材料'}」中已有名为「${name}」的文件夹`);
  const now = Date.now();
  const id = nanoid(12);
  db.prepare('INSERT INTO folders (id, name, parent_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, parentId, userId, now, now);
  return getFolder(db, id)!;
}

/** Renames and/or moves a folder; it cannot go inside itself. */
export function updateFolder(db: DB, id: string, patch: { name?: unknown; parentId?: unknown }): FolderRow {
  const folder = getFolder(db, id);
  if (!folder) throw new HttpError(404, '文件夹不存在');
  const name = patch.name === undefined ? folder.name : cleanFolderName(patch.name);
  const parentId = patch.parentId === undefined ? folder.parent_id : folderArg(db, patch.parentId);
  if (parentId && folderChain(db, parentId).some((f) => f.id === id)) throw new HttpError(400, '不能把文件夹移到它自己或它的子文件夹中');
  if (parentId !== folder.parent_id && folderChain(db, parentId).length + subtreeDepth(db, id) > MAX_FOLDER_DEPTH) {
    throw new HttpError(400, `文件夹最多 ${MAX_FOLDER_DEPTH} 层`);
  }
  if (sibling(db, parentId, name, id)) throw new HttpError(409, `「${folderPath(db, parentId) || '全部材料'}」中已有名为「${name}」的文件夹`);
  db.prepare('UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?').run(name, parentId, Date.now(), id);
  return getFolder(db, id)!;
}

function subtreeDepth(db: DB, id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  const kids = db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(id) as { id: string }[];
  return 1 + Math.max(0, ...kids.map((k) => subtreeDepth(db, k.id, seen)));
}

/**
 * Deletes the folder only: its decks and subfolders move up to its parent (a subfolder whose name is
 * taken there gets a numbered name).
 */
export function deleteFolder(db: DB, id: string): { movedDecks: number; movedFolders: number } {
  const folder = getFolder(db, id);
  if (!folder) throw new HttpError(404, '文件夹不存在');
  return db.transaction(() => {
    const decks = db.prepare('UPDATE projects SET folder_id = ? WHERE folder_id = ?').run(folder.parent_id, id).changes;
    const kids = db.prepare('SELECT * FROM folders WHERE parent_id = ?').all(id) as FolderRow[];
    for (const k of kids) {
      let name = k.name;
      for (let n = 2; sibling(db, folder.parent_id, name, k.id); n++) name = `${k.name} (${n})`;
      db.prepare('UPDATE folders SET parent_id = ?, name = ? WHERE id = ?').run(folder.parent_id, name, k.id);
    }
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    return { movedDecks: decks, movedFolders: kids.length };
  })();
}

/** Decks (not archived) and subfolders directly in each folder. */
export function folderCounts(db: DB): Map<string, { decks: number; archived: number; folders: number }> {
  const out = new Map<string, { decks: number; archived: number; folders: number }>();
  const at = (id: string) => out.get(id) ?? (out.set(id, { decks: 0, archived: 0, folders: 0 }), out.get(id)!);
  const decks = db
    .prepare(`SELECT folder_id, archived_at IS NOT NULL AS archived, COUNT(*) AS c FROM projects WHERE type = 'deck' AND folder_id IS NOT NULL GROUP BY 1, 2`)
    .all() as { folder_id: string; archived: number; c: number }[];
  for (const d of decks) at(d.folder_id)[d.archived ? 'archived' : 'decks'] += d.c;
  const kids = db.prepare('SELECT parent_id, COUNT(*) AS c FROM folders WHERE parent_id IS NOT NULL GROUP BY parent_id').all() as { parent_id: string; c: number }[];
  for (const k of kids) at(k.parent_id).folders += k.c;
  return out;
}

/** Moves a deck to a folder (null: the top level). */
export function moveToFolder(db: DB, project: ProjectRow, folderId: string | null) {
  if (project.type !== 'deck') throw new HttpError(400, '只有路演材料可以放进文件夹');
  db.prepare('UPDATE projects SET folder_id = ? WHERE id = ?').run(folderId, project.id);
}

/** Archived projects stay usable but are listed apart; archived templates cannot start new decks. */
export function setArchived(db: DB, projectId: string, userId: number, archived: boolean) {
  db.prepare('UPDATE projects SET archived_at = ?, archived_by = ? WHERE id = ?').run(archived ? Date.now() : null, archived ? userId : null, projectId);
}
