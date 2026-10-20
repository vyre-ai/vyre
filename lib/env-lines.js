// @ts-check
// env-lines: reading and writing the lines of a .env file, pure (no disk), so the vault's import (core/vault/envfiles.js) and the Vault screen's "Paste from .env" and "Copy as .env" share one
// parser. Two readings of an unquoted value:
//   - the import's (the default): the value loses a trailing ` # comment` and the spaces around it, as it always has;
//   - exact (the Vault screen's paste): the value is every character after the "=" as written, spaces included, so the screen can say "This value ends with a space" and let the person
//     remove it. A value is never changed behind the person's back (the owner's rule, 20 Oct 2026: values are stored byte-exact). A ` # comment` is still a comment.
// Quoted values read the same both ways: double quotes take escapes and may run across lines, single quotes are literal.

/**
 * @typedef {{ key: string, value: string, start: number, end: number, exported: boolean }} Entry
 *   one variable and the lines it spans, [start, end)
 */

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const safeKey = (/** @type {string} */ s) => s.replace(/[^\x21-\x7e]/g, "?").slice(0, 64);

/**
 * Every variable in a .env file with the lines it spans, for the rewrite. Same rules as the import
 * always had: `export` is allowed, double quotes take escapes and may run across lines, single
 * quotes are literal, an unquoted value loses a trailing ` # comment`, a later line wins.
 * @param {string} text
 * @param {{ exact?: boolean }} [o] exact: keep an unquoted value's own spaces (the paste path)
 * @returns {{ entries: Entry[], skipped: string[] }}
 */
export function envEntries(text, { exact = false } = {}) {
  /** @type {Map<string, Entry>} */
  const found = new Map();
  /** @type {string[]} */
  const skipped = [];
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n|\r/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = exact ? /^\s*(export\s+)?([^\s=#]+)\s*=(.*)$/.exec(line) : /^\s*(export\s+)?([^\s=#]+)\s*=\s*(.*)$/.exec(line);
    if (!m) { skipped.push(`line ${n + 1}: not NAME=value`); continue; }
    const key = m[2];
    const start = n;
    let rest = m[3];
    // exact: one space after "=" before a quote is layout, not part of a quoted value
    if (exact && /^ +["']/.test(rest)) rest = rest.replace(/^ +/, "");
    let value;
    if (rest.startsWith('"')) {
      // Double quotes: escapes, and the value may run across lines until the closing quote.
      let out = "";
      let i = 1;
      let closed = false;
      let j = n;
      for (;;) {
        for (; i < rest.length; i++) {
          const c = rest[i];
          if (c === "\\" && i + 1 < rest.length) {
            const e = rest[++i];
            out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === '"' ? '"' : e === "\\" ? "\\" : "\\" + e;
          } else if (c === '"') { closed = true; break; }
          else out += c;
        }
        if (closed || j + 1 >= lines.length) break;
        out += "\n";
        rest = lines[++j];
        i = 0;
      }
      if (!closed) { skipped.push(`${safeKey(key)}: no closing double quote`); continue; }
      n = j;
      value = out;
    } else if (rest.startsWith("'")) {
      const close = rest.indexOf("'", 1);
      if (close < 0) { skipped.push(`${safeKey(key)}: no closing single quote`); continue; }
      value = rest.slice(1, close);
    } else if (exact) {
      value = rest.replace(/\s+#.*$/, "");
      if (value.trim().startsWith("#")) value = "";
    } else {
      value = rest.replace(/\s+#.*$/, "").trim();
      if (value.startsWith("#")) value = "";
    }
    if (!KEY.test(key)) { skipped.push(`${safeKey(key)}: not a usable variable name`); continue; }
    if (value === "") { skipped.push(`${key}: empty value`); continue; }
    if (found.has(key)) { skipped.push(`${key}: set more than once, the last one is kept`); found.delete(key); }
    found.set(key, { key, value, start, end: n + 1, exported: Boolean(m[1]) });
  }
  return { entries: [...found.values()], skipped };
}

/**
 * One KEY=value line that envEntries reads back to exactly the same value: a value that is plain text stays bare, anything else (spaces at an end, a quote, a #, a backslash, a
 * new line, a tab) goes in double quotes with its escapes. Byte-exact both ways.
 * @param {string} key @param {string} value
 */
export function envLine(key, value) {
  const v = String(value);
  if (/^[A-Za-z0-9_./:@+,=%~^-]+$/.test(v)) return `${key}=${v}`;
  return `${key}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}
