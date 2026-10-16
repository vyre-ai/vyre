// The Files screen's navigation, shared by the sidebar's Files panel (the tree) and the page (the open folder): which place is open, the linked folders and shares that make the roots, and the
// folders each place has shown so far. A store, so the two can sit in different parts of the shell and still agree.
import { create } from "zustand";
import { linked, statusReal } from "./real";
import { linkedNames, loader } from "./files-real";
import type { TreeNode } from "./files-model.ts";
import type { LinkedFolder } from "./linked-model";
import type { Status } from "./real-model";

type Nav = {
  place: string; folders: LinkedFolder[]; status: Status | null; kids: Record<string, TreeNode[]>; tick: number;
  go: (place: string) => void;
  loadRoots: () => void;
  openNode: (id: string) => void;
  setKids: (place: string, nodes: TreeNode[]) => void;
  /** Something moved or changed at a source: forget the folders shown and have the page read its folder again. */
  invalidate: () => void;
};

export const useFilesNav = create<Nav>((set, get) => ({
  place: "space", folders: [], status: null, kids: {}, tick: 0,
  go: (place) => set({ place }),
  loadRoots: () => {
    linked.list().then((fs) => { fs.forEach((f) => { linkedNames[f.id] = f.name; }); set({ folders: fs }); }).catch(() => set({ folders: [] }));
    statusReal().then((status) => set({ status })).catch(() => set({ status: null }));
  },
  openNode: (id) => {
    if (get().kids[id] || ["shared", "linked", "box"].includes(id)) return;
    loader.dirs(id).then((d) => set((s) => ({ kids: { ...s.kids, [id]: d } }))).catch(() => {});
  },
  setKids: (place, nodes) => set((s) => ({ kids: { ...s.kids, [place]: nodes } })),
  invalidate: () => set((s) => ({ kids: {}, tick: s.tick + 1 })),
}));
