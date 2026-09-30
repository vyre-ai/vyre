// @ts-check
// envscan: the .env files sitting in a person's project folders, found for them to import.
//
// Names and counts only, never a value: for each file, how many of its variables are secret, what
// kind, whether git tracks it (then its values are in history whatever the vault does), and what
// to run to bring it in. The import itself is vault.import with rewrite, which asks for presence;
// nothing here reads more than the files' variable names and writes nothing.

import path from "node:path";
import fs from "node:fs";
import { findEnvFiles, readEnv, gitState } from "./envfiles.js";

const MAX_ROOTS = 40;

/**
 * @param {{ project?: string, dir: string }[]} roots
 * @param {{ limit?: number }} [o]
 * @returns {{ files: { project: string|null, file: string, secrets: number, kinds: string[], git: { tracked: boolean, ignored: boolean } | null, offer: string }[], scanned: number, templates: number, truncated: boolean }}
 */
export function scanEnvFiles(roots, { limit = 100 } = {}) {
  /** @type {Set<string>} */ const seen = new Set();
  const files = [];
  let scanned = 0, templates = 0, truncated = false;
  for (const r of roots.slice(0, MAX_ROOTS)) {
    let dir;
    try { dir = fs.realpathSync(r.dir); } catch { continue; }
    let found;
    try { found = findEnvFiles(dir, { depth: 4, limit }); } catch { continue; }
    templates += found.templates.length;
    if (found.truncated) truncated = true;
    for (const f of found.files) {
      if (seen.has(f)) continue;
      seen.add(f);
      scanned++;
      if (files.length >= limit) { truncated = true; continue; }
      let text = "";
      try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
      const read = readEnv(text, { file: f, root: dir });
      const secrets = read.item ? Object.keys(read.item.fields).length : 0;
      if (!secrets) continue;
      const kinds = [...new Set(read.vars.filter(v => v.secret).map(v => v.provider || v.type))].slice(0, 8);
      files.push({ project: r.project || null, file: f, secrets, kinds, git: gitState(f), offer: `vyre vault import ${JSON.stringify(f).replace(/^"|"$/g, "")} --rewrite` });
    }
  }
  return { files, scanned, templates, truncated };
}
