// @ts-check
// What the Basic encrypted backup reads of this computer's projects (team/0.3/DESIGN-basic-backup.md): each project's folders file by file, with the ignore rules applied, and the project rows as
// one row file. Reads only; the backup (memory's) chunks and seals what this lists. Nothing is followed through a symlink, so a link out of a project never pulls another folder in.
import fs from "node:fs";
import path from "node:path";

/** Folder names that are rebuilt (`.git` is kept, so a restored project is still a working repository) from the project or are only caches: never backed up. */
export const IGNORED_DIRS = new Set(["node_modules", ".next", ".nuxt", ".svelte-kit", "dist", "build", "out", "target", "venv", ".venv", "__pycache__", ".cache", ".turbo", ".parcel-cache", ".gradle", "Pods", "DerivedData", ".idea", ".vscode"]);
export const IGNORED_FILES = /(^\.DS_Store$|^Thumbs\.db$|\.log$|\.pyc$|\.tmp$|~$)/;
/** Past this a file is skipped with a notice (a person can still keep it elsewhere). */
export const MAX_FILE = 2 * 1024 ** 3;
const MAX_FILES = 200_000;

/**
 * @param {{ slug: string, name: string, workspaces: string[], home: string, archived_at: number|null, org: string|null }[]} projects this computer's projects
 * @param {{ maxFile?: number }} [o]
 * @returns {{ items: any[], notices: string[] }}
 */
export function backupSources(projects, o = {}) {
  const maxFile = o.maxFile || MAX_FILE;
  /** @type {any[]} */ const items = [];
  /** @type {string[]} */ const notices = [];
  let count = 0;
  for (const p of projects) {
    for (const root of p.workspaces) {
      /** @type {string} */ let top;
      try { top = fs.realpathSync(root); } catch { continue; }
      const base = path.basename(top);
      /** @param {string} dir */
      const walk = dir => {
        /** @type {fs.Dirent[]} */ let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
          if (count >= MAX_FILES) { if (!notices.includes("too many files: the list stops at 200000")) notices.push("too many files: the list stops at 200000"); return; }
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name)) walk(full); continue; }
          if (!e.isFile() || IGNORED_FILES.test(e.name)) continue;
          let st; try { st = fs.statSync(full); } catch { continue; }
          const rel = path.relative(top, full).split(path.sep).join("/");
          const name = `${p.slug}/${base}/${rel}`;
          if (st.size > maxFile) { notices.push(`${name} is over ${Math.round(maxFile / 1024 ** 3)} GB and is not backed up`); continue; }
          items.push({ kind: "file", name, size: st.size, mtime: Math.floor(st.mtimeMs), path: full });
          count++;
        }
      };
      walk(top);
    }
  }
  const rows = projects.map(p => JSON.stringify({ slug: p.slug, name: p.name, org: p.org, home: p.home, workspaces: p.workspaces, archived_at: p.archived_at })).join("\n") + (projects.length ? "\n" : "");
  items.push({ kind: "rows", name: "rows/projects.jsonl", size: Buffer.byteLength(rows), mtime: Date.now(), text: rows });
  return { items, notices };
}
