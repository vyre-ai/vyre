// @ts-check
// installed: the apps on this Mac, read from the Applications folders.
//
// No mdfind and no LaunchServices: a folder listing is a few milliseconds, needs no grant, and
// is what a person means by "my apps". Each folder is read one level deep, plus one level into
// plain subfolders (/Applications/Utilities, a vendor's folder of tools). The scan is cached for
// five minutes and the cache expires when read, so nothing runs between calls.
//
// Bundle ids come from each app's Info.plist, and only for the rows a call returns. An XML plist
// is read with a regex; a binary one (it starts "bplist00") goes through `plutil`, which shows no
// dialog and touches no app.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SCAN_TTL_MS = 5 * 60 * 1000;

export const DEFAULT_DIRS = ["/Applications", "/Applications/Utilities", "/System/Applications",
  "/System/Applications/Utilities", path.join(os.homedir(), "Applications")];

/**
 * Every .app one level down in each folder, and one level into its non-.app subfolders. The first
 * folder to have an app by a name wins, so a copy in ~/Applications does not list twice.
 * @param {string[]} dirs
 * @returns {{ name: string, path: string }[]}
 */
export function scan(dirs) {
  /** @type {Map<string, { name: string, path: string }>} */
  const byName = new Map();
  const add = (/** @type {string} */ p) => {
    const name = path.basename(p, ".app");
    if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { name, path: p });
  };
  const read = (/** @type {string} */ dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
  for (const dir of dirs) {
    for (const e of read(dir)) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.name.endsWith(".app")) add(p);
      else if (e.isDirectory()) for (const s of read(p)) if (s.name.endsWith(".app")) add(path.join(p, s.name));
    }
  }
  return [...byName.values()];
}

/**
 * The bundle id in an app's Info.plist, or null.
 * @param {string} appPath @param {import("./env.js").Exec} exec
 */
export async function bundleId(appPath, exec) {
  const file = path.join(appPath, "Contents", "Info.plist");
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.subarray(0, 8).toString("latin1") === "bplist00") {
    try {
      const r = await exec("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", file], { timeoutMs: 5000 });
      return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    } catch { return null; }
  }
  const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(buf.toString("utf8"));
  return m ? m[1].trim() : null;
}

/**
 * Rank a name against a query: 0 the name starts with it, 1 a word in it does, 2 it is somewhere
 * inside, -1 not at all.
 * @param {string} name @param {string} q lowercased
 */
export function rank(name, q) {
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.split(/[\s\-_.]+/).some(w => w.startsWith(q))) return 1;
  return n.includes(q) ? 2 : -1;
}

/**
 * The installed apps, with a cache that expires on read.
 * @param {{ dirs: string[], now: () => number, exec: import("./env.js").Exec }} o
 */
export function installed({ dirs, now, exec }) {
  /** @type {{ at: number, rows: { name: string, path: string }[] } | null} */
  let cache = null;
  /** @type {Map<string, string | null>} bundle ids by path, for as long as the scan they came from. */
  let ids = new Map();
  return {
    /** How many times the folders have been read; the tests count it. */
    scans: 0,
    /**
     * @param {{ q?: string, limit?: number }} o
     * @returns {Promise<{ name: string, path: string, bundleId: string | null }[]>}
     */
    async find({ q = "", limit = 20 }) {
      if (!cache || now() - cache.at > SCAN_TTL_MS) {
        cache = { at: now(), rows: scan(dirs) };
        ids = new Map();
        this.scans++;
      }
      const needle = q.trim().toLowerCase();
      const picked = cache.rows
        .map(r => ({ r, k: needle ? rank(r.name, needle) : 0 }))
        .filter(x => x.k >= 0)
        .sort((a, b) => a.k - b.k || a.r.name.localeCompare(b.r.name))
        .slice(0, Math.max(1, limit))
        .map(x => x.r);
      const out = [];
      for (const r of picked) {
        if (!ids.has(r.path)) ids.set(r.path, await bundleId(r.path, exec));
        out.push({ ...r, bundleId: ids.get(r.path) ?? null });
      }
      return out;
    },
    clear() { cache = null; ids = new Map(); },
  };
}
