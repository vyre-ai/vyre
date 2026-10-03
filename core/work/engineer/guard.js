// @ts-check
// A source-level pre-check for a definition file written as TypeScript against the Vyre SDK (contract 5.6, R6-12 to R6-16). It parses nothing
// into a program and runs nothing: it lexes the text, finds the opaque span of every defineCodeStep(...) call, and rejects, with line numbers,
// what a declarative definition file must not contain OUTSIDE those spans. It is only a pre-check: the records compiler stays the authority, and
// this exists so @Engineer never proposes text the compiler would refuse, and never shows an approval card for it.

export const MAX_SOURCE = 200_000;
export const MAX_CODE_STEP = 20_000;
const SDK = "@vyre/sdk";
const KEYS = new Set(["__proto__", "constructor", "prototype"]);
const NOT_A_TAG = new Set(["return", "typeof", "in", "of", "case", "yield", "await", "void", "delete", "new", "throw", "else", "default", "export"]);

/** @typedef {{ line: number, msg: string }} GuardError */
/** @typedef {{ t: "comment"|"string"|"template"|"ident"|"number"|"punct", text: string, value?: string, line: number, start: number, end: number, subst?: boolean }} Tok */

const lines = (/** @type {string} */ s) => { let n = 0; for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++; return n; };

/** Where a quoted string that starts at `i` ends (index after the closing quote), or -1. @param {string} s @param {number} i */
function skipString(s, i) {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === q) return j + 1;
    if (s[j] === "\n") return -1;
  }
  return -1;
}

/** Where a template literal that starts at `i` ends, whether it has a substitution, or -1. Escapes and nested templates are respected. @param {string} s @param {number} i */
function skipTemplate(s, i) {
  let subst = false;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "`") return { end: j + 1, subst };
    if (c === "$" && s[j + 1] === "{") {
      subst = true;
      let depth = 1;
      for (j += 2; j < s.length && depth > 0; j++) {
        const d = s[j];
        if (d === "{") depth++;
        else if (d === "}") depth--;
        else if (d === "'" || d === '"') { const e = skipString(s, j); if (e < 0) return -1; j = e - 1; }
        else if (d === "`") { const r = skipTemplate(s, j); if (r === -1) return -1; j = r.end - 1; }
      }
      j--;
    }
  }
  return -1;
}

/** @param {string} src @returns {{ toks: Tok[], errors: GuardError[] }} */
function lex(src) {
  /** @type {Tok[]} */ const toks = [];
  /** @type {GuardError[]} */ const errors = [];
  let line = 1;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      let j = src.indexOf("\n", i); if (j < 0) j = src.length;
      toks.push({ t: "comment", text: src.slice(i, j), line, start: i, end: j }); i = j; continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      if (j < 0) { errors.push({ line, msg: "a comment is never closed" }); return { toks, errors }; }
      toks.push({ t: "comment", text: src.slice(i, j + 2), line, start: i, end: j + 2 }); line += lines(src.slice(i, j + 2)); i = j + 2; continue;
    }
    if (c === "'" || c === '"') {
      const e = skipString(src, i);
      if (e < 0) { errors.push({ line, msg: "a string is never closed" }); return { toks, errors }; }
      toks.push({ t: "string", text: src.slice(i, e), value: src.slice(i + 1, e - 1), line, start: i, end: e }); i = e; continue;
    }
    if (c === "`") {
      const r = skipTemplate(src, i);
      if (r === -1) { errors.push({ line, msg: "a template literal is never closed" }); return { toks, errors }; }
      const text = src.slice(i, r.end);
      toks.push({ t: "template", text, line, start: i, end: r.end, subst: r.subst }); line += lines(text); i = r.end; continue;
    }
    if (/[\p{L}_$]/u.test(c)) { let j = i + 1; while (j < src.length && /[\p{L}\p{N}_$]/u.test(src[j])) j++; toks.push({ t: "ident", text: src.slice(i, j), line, start: i, end: j }); i = j; continue; }
    if (/[0-9]/.test(c)) { let j = i + 1; while (j < src.length && /[0-9a-zA-Z_.]/.test(src[j])) j++; toks.push({ t: "number", text: src.slice(i, j), line, start: i, end: j }); i = j; continue; }
    if (c === "." && src[i + 1] === "." && src[i + 2] === ".") { toks.push({ t: "punct", text: "...", line, start: i, end: i + 3 }); i += 3; continue; }
    toks.push({ t: "punct", text: c, line, start: i, end: i + 1 }); i++;
  }
  return { toks, errors };
}

/**
 * Check a definition file. Rejected outside a defineCodeStep span: imports other than the SDK, dynamic import(), require, export-from,
 * triple-slash directives, ts pragmas, the keys __proto__, constructor and prototype, computed keys, spreads, getters and setters, tagged
 * templates and template substitutions. A code step's body is opaque: nothing inside it ends the span early or trips a rejection; its size is capped.
 * @param {string} source @param {{ maxCodeStep?: number, maxSource?: number }} [o]
 * @returns {{ ok: boolean, errors: GuardError[] }}
 */
export function declarativeGuard(source, { maxCodeStep = MAX_CODE_STEP, maxSource = MAX_SOURCE } = {}) {
  if (typeof source !== "string") return { ok: false, errors: [{ line: 1, msg: "the definition is not text" }] };
  if (source.length > maxSource) return { ok: false, errors: [{ line: 1, msg: `the definition is over ${maxSource} characters` }] };
  const { toks: all, errors } = lex(source);
  if (errors.length) return { ok: false, errors };
  /** @param {string} msg @param {Tok} t */
  const bad = (msg, t) => errors.push({ line: t.line, msg });
  const toks = all;
  /** @type {string[]} */ const stack = [];
  /** @type {Tok|null} */ let prev = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === "comment") {
      if (t.text.startsWith("///")) bad("a triple-slash directive is not allowed", t);
      if (/@ts-/.test(t.text)) bad("a ts pragma is not allowed", t);
      continue;
    }
    const next = toks.slice(i + 1).find(x => x.t !== "comment") || null;
    if (t.t === "ident" && t.text === "defineCodeStep" && next && next.text === "(") {
      // The body is an opaque span: skip to the matching close paren, counting only real punctuation (strings and templates are single tokens).
      let depth = 0, j = i + 1;
      for (; j < toks.length; j++) { const x = toks[j]; if (x.t !== "punct") continue; if (x.text === "(") depth++; else if (x.text === ")" && --depth === 0) break; }
      if (j >= toks.length) { bad("a defineCodeStep call is never closed", t); break; }
      if (toks[j].end - toks[i].start > maxCodeStep) bad(`a code step is over ${maxCodeStep} characters`, t);
      prev = toks[j]; i = j; continue;
    }
    if (t.t === "ident") {
      const member = prev && prev.text === ".";
      if (t.text === "import" && !member) {
        if (next && next.text === "(") bad("dynamic import() is not allowed", t);
        else {
          let j = i + 1, found = null;
          for (; j < toks.length; j++) { const x = toks[j]; if (x.t === "string") { found = x; break; } if (x.text === ";") break; }
          if (!found) bad("an import with no source", t);
          else { if (found.value !== SDK) bad(`only ${SDK} may be imported`, t); i = j; prev = found; continue; }
        }
      } else if (t.text === "require" && !member && next && next.text === "(") bad("require is not allowed", t);
      else if (t.text === "export" && next) {
        if (next.text === "*") bad("export from is not allowed", t);
        else if (next.text === "{") {
          let j = toks.indexOf(next), depth = 0;
          for (; j < toks.length; j++) { if (toks[j].text === "{") depth++; else if (toks[j].text === "}" && --depth === 0) break; }
          const after = toks.slice(j + 1).find(x => x.t !== "comment");
          if (after && after.text === "from") bad("export from is not allowed", t);
        }
      } else if (KEYS.has(t.text)) bad(`the name ${t.text} is not allowed`, t);
      else if ((t.text === "get" || t.text === "set") && stack[stack.length - 1] === "{" && prev && (prev.text === "{" || prev.text === ",") && next && (next.t === "ident" || next.t === "string" || next.t === "number")) {
        const after = toks.slice(toks.indexOf(next) + 1).find(x => x.t !== "comment");
        if (after && after.text === "(") bad("a getter or setter is not allowed", t);
      }
    } else if (t.t === "string") {
      if (KEYS.has(/** @type {string} */ (t.value)) && next && next.text === ":") bad(`the key ${t.value} is not allowed`, t);
    } else if (t.t === "template") {
      if (prev && prev.t !== "comment" && ((prev.t === "ident" && !NOT_A_TAG.has(prev.text)) || prev.text === ")" || prev.text === "]")) bad("a tagged template is not allowed", t);
      else if (t.subst) bad("a template with a substitution computes a value at run time", t);
    } else if (t.t === "punct") {
      if (t.text === "...") bad("a spread is not allowed", t);
      else if (t.text === "{" || t.text === "[" || t.text === "(") {
        if (t.text === "[" && stack[stack.length - 1] === "{" && prev && (prev.text === "{" || prev.text === ",")) bad("a computed key is not allowed", t);
        stack.push(t.text);
      } else if (t.text === "}" || t.text === "]" || t.text === ")") stack.pop();
    }
    prev = t;
  }
  errors.sort((a, b) => a.line - b.line);
  return { ok: errors.length === 0, errors };
}
