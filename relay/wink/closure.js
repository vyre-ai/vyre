// @ts-check
// closure: which repo files a browser page loads, found by following its entry's imports (static, dynamic with a string, and the
// decode Worker made with new URL()). No dependencies; shared by relay/wink/release.js (the camera page) and relay/app/release.js
// (the hosted app's loader, which ships the same scanner for the installed app's first launch).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ENTRY = "relay/wink/wink.js";
export const STYLE = "relay/wink/wink.css";
// Code a page loads at run time without a static import the walk can see: the decode worker is made with new URL().
const EXTRA = ["deck/js/scan-worker.js"];

/** The relative specifiers a module imports: static, dynamic with a string, and new URL("./x", import.meta.url). @param {string} src */
export function specifiers(src) {
  const out = new Set();
  for (const m of src.matchAll(/(?:^|[\s;}])import\s+(?:[^"'`;]*?\sfrom\s+)?["'`]([^"'`]+)["'`]/gm)) out.add(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) out.add(m[1]);
  for (const m of src.matchAll(/new URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url/g)) out.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:\*|\{[^}]*\})\s+from\s+["'`]([^"'`]+)["'`]/gm)) out.add(m[1]);
  return [...out].filter(s => s.startsWith("."));
}

/**
 * Every repo file the page loads, as repo-relative paths with forward slashes.
 * @param {string[]} [entries] @param {string} [root]
 */
export function closure(entries = [ENTRY, ...EXTRA], root = ROOT) {
  /** @type {Set<string>} */ const seen = new Set();
  /** @param {string} rel */
  const walk = rel => {
    if (seen.has(rel)) return;
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) throw new Error(`${rel} is imported but is not in the repo`);
    seen.add(rel);
    if (!/\.m?js$/.test(rel)) return;
    for (const s of specifiers(fs.readFileSync(file, "utf8"))) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), s));
      if (next.startsWith("..")) throw new Error(`${rel} imports ${s}, which is outside the repo`);
      walk(next);
    }
  };
  for (const e of entries) walk(e);
  return [...seen].sort();
}

