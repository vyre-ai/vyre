// @ts-check
// Other `vyre` commands on PATH. An old prototype at ~/.local/bin/vyre answered a user's first
// `vyre up` instead of the one npm had just installed: it printed "vyred running", opened a blank
// browser window and made no ~/.vyre. The postinstall line and `vyre doctor` both look for them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** This install's own command, as its real path. */
export const OURS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vyre");

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/**
 * Every `vyre` on PATH that is not this one, in PATH order, with whether it comes before ours
 * (and so is the one a shell runs). `ours` false: ours is not on PATH at all.
 * `binDir`: the folder npm links ours into, for the postinstall, which runs before that link exists.
 * @param {{ PATH?: string, ours?: string, binDir?: string }} [o]
 * @returns {{ ours: boolean, others: { path: string, target: string, first: boolean }[] }}
 */
export function shadows({ PATH = process.env.PATH || "", ours = OURS, binDir } = {}) {
  const mine = real(ours);
  const others = [];
  let found = false, seen = new Set();
  for (const dir of PATH.split(path.delimiter).filter(Boolean)) {
    if (binDir && path.resolve(dir) === path.resolve(binDir)) { found = true; continue; }
    const p = path.join(dir, "vyre");
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile() || !(st.mode & 0o111)) continue;
    const target = real(p);
    if (seen.has(target)) continue;
    seen.add(target);
    if (target === mine) { found = true; continue; }
    others.push({ path: p, target, first: !found });
  }
  return { ours: found, others };
}
