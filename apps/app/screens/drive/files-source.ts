// The Files screen's reads, over injected sources (the real ones are the Space Drive and linked folders in real.ts; a test gives fakes): a place's rows, and the folders
// under a place for the tree. A place the screen draws on its own (Shared) has no rows.
import { children } from "./space-model.ts";
import { parsePlace, placeId, rowsFromLinked, rowsFromSpace, type FileRow, type TreeNode } from "./files-model.ts";
import type { LinkedEntry } from "./linked-model.ts";
import type { SpaceEntry } from "./space-model.ts";

export type FilesSources = {
  space: { list: (space: string | undefined, prefix: string) => Promise<{ entries: SpaceEntry[]; names?: Record<string, string>; folders?: { path: string; name: string; open: boolean }[]; more: boolean }> };
  linked: { ls: (id: string, path?: string) => Promise<{ path: string; entries: LinkedEntry[] }> };
  linkedNames: () => Record<string, string>;
};

export function filesLoader(s: FilesSources) {
  async function rows(id: string): Promise<FileRow[]> {
    const p = parsePlace(id);
    if (!p) throw new Error(`not a place: ${id}`);
    if (p.root === "space") {
      const r = await s.space.list(undefined, p.path);
      return rowsFromSpace(children(r.entries, p.path, { names: r.names, folders: r.folders }), p.path);
    }
    if (p.root === "linked") {
      if (!p.link) return [];
      const r = await s.linked.ls(p.link, p.path);
      return rowsFromLinked(p.link, s.linkedNames()[p.link] ?? p.link, r.entries);
    }
    return [];
  }
  /** The folders directly inside a place, as tree nodes that may be opened. */
  async function dirs(id: string): Promise<TreeNode[]> {
    const p = parsePlace(id);
    return (await rows(id)).filter((r) => r.dir).map((r) => ({ id: r.place, label: r.name, root: p!.root, kids: [] }));
  }
  return { rows, dirs, placeId };
}
