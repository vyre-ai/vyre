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

/** A path no shell line should carry: control characters, newlines and the bidi overrides. @param {string} f */
const unsafe = f => /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(f);
/** POSIX single quotes: nothing inside is special, and a quote becomes '\'' . @param {string} f */
const posixQuote = f => `'${f.replace(/'/g, `'\\''`)}'`;

/**
 * @param {{ project?: string, dir: string }[]} roots
 * @param {{ limit?: number }} [o]
 * @returns {{ files: { project: string|null, file: string, secrets: number, kinds: string[], git: { tracked: boolean, ignored: boolean } | null,
 *   offer: { tool: string, input: { file: string, rewrite: boolean } } | null, command: string | null, unsafePath?: true }[], scanned: number, templates: number, truncated: boolean }}
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
      // The offer is the structured call a surface makes, never a shell string built from a path: a folder named like a command
      // (cloned repos have them) must not become a command when someone pastes the printable line. A path with a control character
      // gets no printable line at all.
      const bad = unsafe(f);
      files.push({ project: r.project || null, file: bad ? f.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?") : f, secrets, kinds, git: gitState(f),
        offer: bad ? null : { tool: "vault.import", input: { file: f, rewrite: true } }, command: bad ? null : `vyre vault import ${posixQuote(f)} --rewrite`, ...(bad ? { unsafePath: /** @type {const} */ (true) } : {}) });
    }
  }
  return { files, scanned, templates, truncated };
}
