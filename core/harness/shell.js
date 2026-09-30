// @ts-check
// shell: read a Bash command the way the floor needs to (docs/adr/0004-presence.md, layer 2).
//
// This is not a shell parser. It flattens the text a model could use to hide a word from a
// filter: quotes that split a word, backslashes, $'\x..' strings, ~ and $HOME. Then it cuts the
// result into words, dropping the punctuation that joins commands. Nested commands (sh -c "...",
// $(...), eval, osascript's do script) come out as more words in the same list, which is what the
// rules scan. Reading too much into a command only ever holds a call back; it never lets one through.

import os from "node:os";

/** Decode the escapes of a $'...' string. */
function ansiC(s) {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)/g, (_, e) => {
    if (e[0] === "x" || e[0] === "u") return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: "\n", t: "\t", r: "\r", e: "\x1b", a: "", b: "", f: "", v: "" }[e] ?? e;
  });
}

/**
 * The command as the floor reads it: escapes decoded, quotes gone, home expanded.
 * @param {string} command @param {string} [userHome]
 */
export function flatten(command, userHome = os.homedir()) {
  let s = String(command);
  s = s.replace(/\$'((?:[^'\\]|\\.)*)'/g, (_, body) => ansiC(body));
  s = s.replace(/\\\n/g, "").replace(/\\(.)/g, "$1");
  s = s.replace(/["']/g, "");
  s = s.replace(/\$\{HOME\}|\$HOME\b/g, userHome);
  s = s.replace(/(^|[\s=:(`])~(?=\/|$|[\s;|&)`])/g, (_, pre) => pre + userHome);
  return s;
}

/** Every word, in order, with the characters that join or nest commands treated as spaces. */
export function words(flat) {
  return flat.split(/[\s;&|()`<>{}]+/).filter(Boolean);
}

/** A word whose value is only known when the shell runs it. */
export const dynamic = w => /[$*?[\]]/.test(w);

/** Globs of one path component, as a shell matches them: a leading dot must be written. */
export function componentMatches(glob, name) {
  if (!/[*?[]/.test(glob)) return glob === name;
  if (name.startsWith(".") && !glob.startsWith(".")) return false;
  const re = glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".").replace(/\[!/g, "[^");
  try { return new RegExp(`^${re}$`).test(name); } catch { return true; }
}

/**
 * Could this glob, an absolute path, match `target` or anything inside it? `**` matches any depth.
 * @param {string} glob @param {string} target
 */
export function globReaches(glob, target) {
  const g = glob.split("/").filter(Boolean), t = target.split("/").filter(Boolean);
  for (let i = 0; i < t.length; i++) {
    if (i >= g.length) return false;
    // `**` crosses folders but, like the shell, not into a dot folder unless a later part names one.
    if (g[i] === "**") return g.slice(i + 1).some(c => t.slice(i).some(n => componentMatches(c, n))) || !t.slice(i).some(n => n.startsWith("."));
    if (!componentMatches(g[i], t[i])) return false;
  }
  return true;
}
