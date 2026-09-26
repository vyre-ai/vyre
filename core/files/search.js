// @ts-check
// search — the ways the files module finds candidates: Spotlight on the Mac, a folder walk plus
// ripgrep on the box. None of them decides what may be shown. They only propose paths, and
// index.js passes every one through the safety guard before it becomes a result.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Run a program and collect its output lines, stopping once `max` lines have arrived or the
 * timeout passes. Spotlight can return tens of thousands of paths for a short query; reading
 * them all to keep fifty wastes seconds, so the process is killed as soon as there are enough.
 * A missing program rejects with code ENOENT so a caller can say what is not installed.
 * @param {string} bin @param {string[]} args
 * @param {{ max?: number, timeout?: number, okCodes?: number[] }} [opts]
 * @returns {Promise<string[]>}
 */
export function lines(bin, args, { max = 1000, timeout = 8000, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    const out = [];
    let rest = "", done = false;
    const finish = (err) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      if (err) reject(err); else resolve(out.slice(0, max));
    };
    // A timeout returns what arrived so far: partial results beat none for a search box.
    const timer = setTimeout(() => finish(null), timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop() || "";
      for (const l of parts) if (l) out.push(l);
      if (out.length >= max) finish(null);
    });
    child.on("error", err => finish(err));
    child.on("close", code => {
      if (rest) out.push(rest);
      if (code === null || okCodes.includes(code)) finish(null);
      else finish(Object.assign(new Error(`${bin} exited with ${code}`), { code: "EXIT" }));
    });
  });
}

/** The real binaries. Tests replace them through the seams in index.js. */
export const defaults = {
  mdfind: (args, opts = {}) => lines("mdfind", args, opts),
  // ripgrep exits 1 when nothing matched, which is not a failure.
  rg: (args, opts = {}) => lines("rg", args, { ...opts, okCodes: [0, 1] }),
};

/**
 * Find names containing q under the roots, breadth first, bounded. Skips what the guard says
 * not to enter (denied places, dot folders, node_modules, .git) and never follows a symlinked
 * folder, so a link cannot lead the walk out of a root or round in a loop.
 * @param {string[]} roots @param {string} q
 * @param {{ walkable: (dir: string, name: string) => boolean, nameAllowed: (n: string) => boolean }} g
 * @param {{ max: number, entries?: number }} opts
 */
export function walk(roots, q, g, { max, entries = 50_000 }) {
  const needle = q.toLowerCase();
  const found = [];
  const queue = [...roots];
  let seen = 0;
  while (queue.length && found.length < max && seen < entries) {
    const dir = /** @type {string} */ (queue.shift());
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      if (++seen > entries || found.length >= max) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!g.walkable(p, e.name)) continue;
        queue.push(p);
      } else if (!g.nameAllowed(e.name)) continue;
      if (e.name.toLowerCase().includes(needle)) found.push(p);
    }
  }
  return found;
}
