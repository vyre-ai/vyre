// GENERATED from lib/siteops/pickfields.js by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.
// @ts-check
// pickfields: from a learned answer and the fields a person wants ("name, headline, location"), the pick paths that return exactly those, so nobody writes a path by hand. PURE.
//
// The answer a site gives is large and nested; the operation should hand back a few named fields per item. This finds, for each wanted name, the key in the sample answer (under the operation's
// extract path) whose name is the same word (firstName, first_name and firstname are one), preferring the shallowest string, number or boolean; a name with no match is reported, never guessed.

import { getPath } from "./extract.js";

/** Lower-case letters and digits only: firstName, first_name and FIRSTNAME are one word. @param {string} s */
const word = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * @param {any} answer a parsed sample answer @param {string[]} wanted the field names a person asked for @param {{ extract?: string }} [o] the operation's extract path, so paths are relative to an item
 * @returns {{ pick: string[], missing: string[], at: Record<string, string> }}
 */
export function suggestPick(answer, wanted, o = {}) {
  const root = o.extract ? getPath(answer, o.extract) : answer;
  const item = Array.isArray(root) ? root[0] : root;
  /** @type {Map<string, { path: string, depth: number }>} */ const best = new Map();
  /** @param {any} v @param {string} path @param {number} depth */
  const walk = (v, path, depth) => {
    if (depth > 6 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { if (v.length) walk(v[0], `${path}[0]`, depth + 1); return; }
    for (const [k, c] of Object.entries(v)) {
      const p = path ? (/^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`) : (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `[${JSON.stringify(k)}]`);
      if (c === null || typeof c !== "object") {
        const w = word(k), cur = best.get(w);
        if (!cur || depth < cur.depth) best.set(w, { path: p, depth });
      } else walk(c, p, depth + 1);
    }
  };
  walk(item, "", 0);
  /** @type {string[]} */ const pick = [], missing = [];
  /** @type {Record<string, string>} */ const at = {};
  for (const name of wanted) {
    const hit = best.get(word(name));
    if (!hit) { missing.push(name); continue; }
    // the output key is the wanted name; the path is where it was found
    pick.push(hit.path === name ? name : `${name}=${hit.path}`);
    at[name] = hit.path;
  }
  return { pick, missing, at };
}
