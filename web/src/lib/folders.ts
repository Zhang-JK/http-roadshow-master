import type { Folder } from '../types';

/** The folder's ancestors and itself, from the top level down. */
export function folderChain(folders: Folder[], id: string | null | undefined): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain: Folder[] = [];
  for (let f = id ? byId.get(id) : undefined; f && !chain.includes(f); f = f.parentId ? byId.get(f.parentId) : undefined) chain.unshift(f);
  return chain;
}

export const folderPath = (folders: Folder[], id: string | null | undefined) =>
  folderChain(folders, id)
    .map((f) => f.name)
    .join(' / ');

/** Every folder in tree order (siblings by name), with its depth, for pickers. */
export function folderTree(folders: Folder[]): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    folders
      .filter((f) => f.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      .forEach((f) => {
        out.push({ folder: f, depth });
        walk(f.id, depth + 1);
      });
  };
  walk(null, 0);
  return out;
}
