// @ts-check
// dirs: the box's folders, for starting a session or opening a terminal in one (ADR 0024).
//
// files.dirs lists the folders directly inside a folder (by default, inside every root), or
// finds folders by name under the roots with a small, bounded walk. files.recent lists the
// folders sessions last worked in, from Recall's index and the switchboard's threads. Every
// folder either returns has passed the files guard, so a folder outside the roots, Vyre's home,
// the vault, a secret or a dot folder never appears, and a symlink that leads out is refused.

import fs from "node:fs";
import path from "node:path";
import { Refused } from "./safety.js";

/** Bounds for a name search: how deep, how many entries read, how many folders returned. */
export const LIMITS = { depth: 4, entries: 2000, results: 200, list: 1000 };

/** files.recent lists the folders other sessions worked in, so a model is not among its callers. */
const PERSON_AND_MODULE = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module"];
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/** A folder's name may be shown: no dot folders at all here, nothing the guard's name rules refuse. */
const listable = (g, name) => !name.startsWith(".") && name !== "node_modules" && g.nameAllowed(name);

/** Is any segment of a checked path below its root a dot name? */
function hidden(safe) {
  const base = inside(safe.path, safe.root.given) ? safe.root.given : safe.root.real;
  return path.relative(base, safe.path).split(path.sep).some(s => s.startsWith(".") || s === "node_modules");
}

/**
 * Register files.dirs and files.recent.
 * @param {any} ctx
 * @param {{ role: string, g: ReturnType<typeof import("./safety.js").guard>, target: (s?: string) => string,
 *   forward: (tool: string, input: object) => Promise<any> }} o
 */
export function dirs(ctx, { g, target, forward }) {
  /** Project homes and folders, real path to slug. A failure means no badges, never no listing. */
  async function projects() {
    const map = new Map();
    try {
      const r = await ctx.call("projects.list", {});
      for (const p of (r && r.data && r.data.projects) || []) {
        for (const f of [p.home, ...(Array.isArray(p.workspaces) ? p.workspaces : [])]) {
          if (typeof f !== "string" || !f) continue;
          let real = f;
          try { real = fs.realpathSync(f); } catch {}
          if (!map.has(real)) map.set(real, p.slug);
          if (!map.has(f)) map.set(f, p.slug);
        }
      }
    } catch {}
    return map;
  }

  /** One folder entry, or null when the guard refuses it or it is not a folder. */
  function entry(p, rs, slugs) {
    let safe;
    try { safe = g.resolveSafe(p, rs); } catch { return null; }
    let st;
    try { st = fs.statSync(safe.real); } catch { return null; }
    if (!st.isDirectory()) return null;
    let git = false;
    try { fs.lstatSync(path.join(safe.real, ".git")); git = true; } catch {}
    const project = slugs.get(safe.real) || slugs.get(safe.path);
    return { name: path.basename(safe.path), path: safe.path, mtime: st.mtime.toISOString(), git, ...(project ? { project } : {}) };
  }

  /** The folders directly inside one real folder, by name, capped. */
  function children(dirGiven, dirReal, rs, slugs) {
    let list = [];
    try { list = fs.readdirSync(dirReal, { withFileTypes: true }); } catch { return { dirs: [], truncated: false }; }
    const out = [];
    let truncated = false;
    for (const e of list) {
      if (!(e.isDirectory() || e.isSymbolicLink()) || !listable(g, e.name)) continue;
      if (out.length >= LIMITS.list) { truncated = true; break; }
      const d = entry(path.join(dirGiven, e.name), rs, slugs);
      if (d) out.push(d);
    }
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return { dirs: out, truncated };
  }

  /**
   * Folders whose name holds q, under the given starting folders, breadth first. Never follows a
   * symlinked folder, never enters a dot folder, node_modules or a denied place.
   */
  function find(starts, q, rs, slugs, limit) {
    const needle = q.toLowerCase();
    const found = [];
    const queue = starts.map(s => ({ dir: s, depth: 0 }));
    let seen = 0;
    while (queue.length && found.length < limit && seen < LIMITS.entries) {
      const { dir, depth } = /** @type {{ dir: string, depth: number }} */ (queue.shift());
      let list = [];
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of list) {
        if (++seen > LIMITS.entries || found.length >= limit) break;
        if (!e.isDirectory() || !listable(g, e.name)) continue;
        const p = path.join(dir, e.name);
        if (!g.walkable(p, e.name)) continue;
        if (depth + 1 < LIMITS.depth) queue.push({ dir: p, depth: depth + 1 });
        if (e.name.toLowerCase().includes(needle)) {
          const d = entry(p, rs, slugs);
          if (d) found.push(d);
        }
      }
    }
    return { dirs: found, truncated: queue.length > 0 && (found.length >= limit || seen >= LIMITS.entries) };
  }

  ctx.tool("files.dirs", {
    description: "List folders inside a folder (default: every root), or with q, folders under it matching the name, each marked git or not, with its project.",
    input: { type: "object", properties: { path: { type: "string" }, source: { type: "string", enum: ["mac", "box"] },
      q: { type: "string", description: "folder name to match; walks below path, bounded" }, limit: { type: "integer" } } },
    run: async ({ path: p, source, q, limit }) => {
      if (target(source) === "box") return forward("files.dirs", { ...(p ? { path: p } : {}), ...(q ? { q } : {}), ...(limit ? { limit } : {}) });
      const rs = g.roots();
      const roots = rs.live.map(r => ({ path: r.given, name: path.basename(r.given) || r.given }));
      const slugs = await projects();
      let here = null, parent = null, starts;
      if (p) {
        const safe = g.resolveSafe(p, rs);
        // A dot folder the guard lets a file through (.github) is still not a place to work in.
        if (hidden(safe)) throw new Refused();
        if (!fs.statSync(safe.real).isDirectory()) throw new Error("not a folder");
        here = safe.path;
        const given = safe.root.given;
        const up = path.dirname(here);
        parent = here !== given && here !== safe.root.real && inside(up, given) ? up : null;
        starts = [{ given: here, real: safe.real }];
      } else starts = rs.live.map(r => ({ given: r.given, real: r.real }));
      const needle = typeof q === "string" ? q.trim() : "";
      if (needle) {
        const r = find(starts.map(s => s.given), needle, rs, slugs, clamp(limit ?? LIMITS.results, 1, LIMITS.results));
        return { path: here, parent, roots, q: needle, dirs: r.dirs, ...(r.truncated ? { truncated: true } : {}) };
      }
      const all = [];
      let truncated = false;
      for (const s of starts) {
        const r = children(s.given, s.real, rs, slugs);
        all.push(...r.dirs);
        truncated = truncated || r.truncated;
      }
      return { path: here, parent, roots, dirs: all, ...(truncated ? { truncated: true } : {}) };
    },
  });

  ctx.tool("files.recent", {
    callers: PERSON_AND_MODULE,
    description: "The folders sessions worked in lately, newest first, with how many sessions ran in each. Only folders inside the roots the user chose.",
    input: { type: "object", properties: { limit: { type: "integer" }, source: { type: "string", enum: ["mac", "box"] } } },
    run: async ({ limit, source }) => {
      if (target(source) === "box") return forward("files.recent", { ...(limit ? { limit } : {}) });
      const want = clamp(limit ?? 20, 1, 200);
      /** cwd -> { last, ids } */
      const by = new Map();
      const add = (cwd, last, id) => {
        if (typeof cwd !== "string" || !cwd) return;
        const f = by.get(cwd) || { last: 0, ids: new Set() };
        f.last = Math.max(f.last, Number(last) || 0);
        if (id) f.ids.add(String(id));
        by.set(cwd, f);
      };
      const [sessions, threads] = await Promise.all([
        ctx.call("recall.sessions", { limit: 200 }).catch(() => null),
        ctx.call("threads.list", { all: true }).catch(() => null),
      ]);
      for (const s of (sessions && Array.isArray(sessions.data) ? sessions.data : [])) add(s.cwd, s.ended || s.started, s.id);
      for (const t of (threads && Array.isArray(threads.data) ? threads.data : [])) add(t.cwd, t.last || t.started, t.id);
      const rs = g.roots();
      const out = [];
      for (const [cwd, f] of [...by].sort((a, b) => b[1].last - a[1].last)) {
        if (out.length >= want) break;
        let safe;
        try { safe = g.resolveSafe(cwd, rs); } catch { continue; }
        try { if (!fs.statSync(safe.real).isDirectory()) continue; } catch { continue; }
        // Hidden folders stay hidden here too, even ones the guard would let a file through.
        if (hidden(safe)) continue;
        if (out.some(o => o.path === safe.path)) continue;
        out.push({ path: safe.path, last: f.last, sessions: f.ids.size || 1 });
      }
      return out;
    },
  });
}
