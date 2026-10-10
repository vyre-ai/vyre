// @ts-check
// Syntax colours for a fenced code block: a small tokenizer per family of languages, never a parser. It turns code into lines of { k, v } where k is a kind the renderer maps to a colour role of the design tokens:
// kw (keyword), str (string), com (comment), num (number), key (a JSON key or a CSS property), tag (a markup tag), plain. It cannot throw, runs in one pass, and gives up (plain) on very long code.

/** @typedef {{ k: "kw" | "str" | "com" | "num" | "key" | "tag" | "plain", v: string }} Tok */

const WORDS = (/** @type {string} */ s) => new Set(s.split(" "));
const JS = WORDS("const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of this super null undefined true false void yield static get set interface type enum implements public private protected readonly as");
const PY = WORDS("def class return if elif else for while in not and or is None True False import from as with try except finally raise lambda yield pass break continue global nonlocal async await self");
const SH = WORDS("if then else elif fi for while do done case esac function return in export local echo cd ls cat grep sed awk npm node git sudo set unset exit source");
const SQL = WORDS("select from where and or not insert into values update set delete create table drop alter add join left right inner outer on group by order having limit offset as distinct null is in like between count sum avg min max union all primary key foreign references index");
const GO = WORDS("package import func return if else for range switch case break continue go defer chan select struct interface map type var const nil true false make new");
const RUST = WORDS("fn let mut pub struct enum impl trait use mod match if else for while loop return self Self true false None Some Ok Err const static async await move ref as in where");
const CLIKE = WORDS("int long short char float double void bool class struct enum public private protected static final return if else for while do switch case break continue new this null true false const unsigned signed typedef namespace using include template virtual override");

/** @type {Record<string, { kw?: Set<string>, line?: string[], block?: [string, string][], str?: string, fold?: boolean }>} */
const LANG = {
  js: { kw: JS, line: ["//"], block: [["/*", "*/"]], str: "\"'`" }, ts: { kw: JS, line: ["//"], block: [["/*", "*/"]], str: "\"'`" },
  py: { kw: PY, line: ["#"], str: "\"'" }, sh: { kw: SH, line: ["#"], str: "\"'" }, sql: { kw: SQL, line: ["--"], block: [["/*", "*/"]], str: "\"'", fold: true },
  go: { kw: GO, line: ["//"], block: [["/*", "*/"]], str: "\"'`" }, rust: { kw: RUST, line: ["//"], block: [["/*", "*/"]], str: "\"'" },
  c: { kw: CLIKE, line: ["//"], block: [["/*", "*/"]], str: "\"'" }, yaml: { kw: WORDS("true false null yes no"), line: ["#"], str: "\"'" },
  json: { kw: WORDS("true false null"), str: "\"" }, css: { line: [], block: [["/*", "*/"]], str: "\"'" }, html: { block: [["<!--", "-->"]], str: "\"'" },
};
const ALIAS = /** @type {Record<string, string>} */ ({
  javascript: "js", jsx: "js", mjs: "js", cjs: "js", typescript: "ts", tsx: "ts", python: "py", bash: "sh", shell: "sh", zsh: "sh", console: "sh", sh: "sh", golang: "go", rs: "rust", java: "c", cpp: "c", "c++": "c", cs: "c", csharp: "c", swift: "c", kotlin: "c",
  yml: "yaml", jsonc: "json", scss: "css", less: "css", xml: "html", svg: "html", htm: "html", postgres: "sql", mysql: "sql", sqlite: "sql",
});

/** The language family for a fence's label, or "" for an unknown one. @param {string} lang */
export const familyOf = (lang) => { const l = String(lang || "").toLowerCase(); return LANG[l] ? l : ALIAS[l] && LANG[ALIAS[l]] ? ALIAS[l] : ""; };

const MAX = 30_000;

/**
 * @param {string} code @param {string} lang
 * @returns {Tok[][]} the code as lines of tokens
 */
export function highlight(code, lang) {
  const text = String(code ?? "");
  const fam = familyOf(lang);
  if (!fam || text.length > MAX) return text.split("\n").map((l) => [{ k: "plain", v: l }]);
  const L = LANG[fam];
  /** @type {Tok[]} */ const toks = [];
  let plain = "";
  const push = (/** @type {Tok["k"]} */ k, /** @type {string} */ v) => { if (k === "plain") { plain += v; return; } if (plain) { toks.push({ k: "plain", v: plain }); plain = ""; } toks.push({ k, v }); };
  const keyword = (/** @type {string} */ w) => (L.kw ? L.kw.has(L.fold ? w.toLowerCase() : w) : false);
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i, i + 4);
    const bl = L.block && L.block.find(([o]) => text.startsWith(o, i));
    if (bl) { const end = text.indexOf(bl[1], i + bl[0].length); const e = end < 0 ? text.length : end + bl[1].length; push("com", text.slice(i, e)); i = e; continue; }
    const ln = L.line && L.line.find((o) => text.startsWith(o, i));
    if (ln) { const end = text.indexOf("\n", i); const e = end < 0 ? text.length : end; push("com", text.slice(i, e)); i = e; continue; }
    const c = text[i];
    if (L.str && L.str.includes(c)) {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(text[j] === "\n" && c !== "`")) { if (text[j] === "\\") j++; j++; }
      const e = Math.min(j + 1, text.length);
      const s = text.slice(i, e);
      // in JSON a string before a colon is a key
      push(fam === "json" && /^\s*:/.test(text.slice(e, e + 8)) ? "key" : "str", s); i = e; continue;
    }
    if (fam === "html" && c === "<" && /[a-zA-Z/!]/.test(text[i + 1] || "")) { const end = text.indexOf(">", i); const e = end < 0 ? text.length : end + 1; push("tag", text.slice(i, e)); i = e; continue; }
    if (/[0-9]/.test(c) && !/[\w$]/.test(text[i - 1] || "")) { const m = /^(0x[0-9a-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?[a-zA-Z%]*)/.exec(text.slice(i, i + 40)); if (m) { push("num", m[0]); i += m[0].length; continue; } }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1; while (j < text.length && /[\w$-]/.test(text[j]) && !(text[j] === "-" && fam !== "css" && fam !== "sh" && fam !== "yaml")) j++;
      const w = text.slice(i, j);
      if (fam === "css" && /^\s*:/.test(text.slice(j, j + 4)) && !/^\s*::?\w/.test(text.slice(j, j + 1))) push("key", w);
      else if (fam === "yaml" && /^\s*:(\s|$)/.test(text.slice(j, j + 3))) push("key", w);
      else push(keyword(w) ? "kw" : "plain", w);
      i = j; continue;
    }
    void rest;
    plain += c; i++;
  }
  if (plain) toks.push({ k: "plain", v: plain });
  // split at newlines so a token that spans lines (a comment, a template string) draws line by line
  /** @type {Tok[][]} */ const lines = [[]];
  for (const t of toks) {
    const parts = t.v.split("\n");
    parts.forEach((p, n) => { if (n > 0) lines.push([]); if (p) lines[lines.length - 1].push({ k: t.k, v: p }); });
  }
  return lines;
}
