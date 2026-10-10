// @ts-check
// What a session uses on this computer now (R031-95 2.4): the processor and the memory of its whole process tree, the numbers the person's limits are measured against and the list in Settings shows.
// Linux works out the processor from the tree's CPU time between two samples; macOS asks ps, whose percent is already a recent average. The tree is walked by parent (proctree.js): the sandbox gives the
// agent a process group of its own, so a group id would miss it.
import { allProcs, treeOf } from "./proctree.js";

const TICKS = 100;   // CLK_TCK is 100 on every Linux Vyre runs on

/**
 * @param {{ platform?: string, now?: () => number, procs?: () => import("./proctree.js").Proc[], pageKb?: number }} [o]
 * @returns {{ sample(root: number): { cpuPercent: number, memoryMb: number }, forget(root: number): void }}
 */
export function createUsage(o = {}) {
  const platform = o.platform || process.platform;
  const now = o.now || Date.now;
  const procs = o.procs || (() => allProcs({ platform }));
  const pageKb = o.pageKb || 4;
  /** @type {Map<number, { ticks: number, at: number }>} */ const last = new Map();
  return {
    sample(root) {
      const tree = treeOf(root, procs());
      if (platform === "darwin") return { cpuPercent: Math.round(tree.reduce((n, p) => n + p.pcpu, 0)), memoryMb: Math.round(tree.reduce((n, p) => n + p.kb, 0) / 1024) };
      const ticks = tree.reduce((n, p) => n + p.ticks, 0), pages = tree.reduce((n, p) => n + p.pages, 0);
      const t = now(), prev = last.get(root);
      last.set(root, { ticks, at: t });
      const cpu = prev && t > prev.at && ticks >= prev.ticks ? ((ticks - prev.ticks) / TICKS) / ((t - prev.at) / 1000) * 100 : 0;
      return { cpuPercent: Math.round(cpu), memoryMb: Math.round(pages * pageKb / 1024) };
    },
    forget(root) { last.delete(root); },
  };
}
