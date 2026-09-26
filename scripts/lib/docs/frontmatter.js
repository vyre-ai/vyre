// @ts-check
// Front matter for docs pages: the block between a leading `---` line and the next `---` line.
//
// Only the small YAML subset the page template uses (docs/CONTRIBUTING-DOCS.md):
//
//   key: value            a string; surrounding quotes are dropped
//   key: value   # note   a trailing comment after whitespace is dropped
//   key: [a, b]           an inline list
//   key:                  followed by `- item` lines, a block list
//
// Everything else stays a string. A page without front matter returns `{ data: {}, body: text }`
// and the build falls back to the first heading for its title; docs-check is what insists on it.

/**
 * @param {string} text
 * @returns {{ data: Record<string, string | string[]>, body: string, raw: string }}
 *   `raw` is the front matter block as written, including both `---` lines and the newline after.
 */
export function parseFrontMatter(text) {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { data: {}, body: src, raw: "" };
  /** @type {Record<string, string | string[]>} */
  const data = {};
  /** @type {string | null} */
  let listKey = null;
  for (const line of m[1].split("\n")) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) || /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const list = Array.isArray(data[listKey]) ? data[listKey] : (data[listKey] = []);
      /** @type {string[]} */ (list).push(scalar(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = stripComment(kv[2]);
    if (value === "") { data[key] = ""; listKey = key; continue; }
    listKey = null;
    const inline = /^\[(.*)\]$/.exec(value);
    data[key] = inline ? inline[1].split(",").map(s => scalar(s)).filter(Boolean) : scalar(value);
  }
  return { data, body: src.slice(m[0].length), raw: m[0] };
}

/** @param {string} v */
function stripComment(v) {
  // Quoted values keep a `#` inside the quotes.
  const q = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(v.trim());
  if (q) return v.trim().slice(0, q[2].length + 2);
  return v.replace(/\s+#.*$/, "").trim();
}

/** @param {string} v */
function scalar(v) {
  const s = stripComment(v);
  const q = /^(["'])(.*)\1$/.exec(s);
  return q ? q[2] : s;
}

/**
 * A comma separated field (audience) as a list, whichever way it was written.
 * @param {string | string[] | undefined} v
 */
export function listOf(v) {
  if (v === undefined) return [];
  const all = Array.isArray(v) ? v : v.split(",");
  return all.map(s => s.trim()).filter(Boolean);
}
