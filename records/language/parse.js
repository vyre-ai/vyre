// @ts-check
// A source-only parser for the definition language (spec 5.6, R6-12). It reads text and builds a
// syntax tree. It never executes anything, never resolves an import, never reads a file and never
// type-checks. The accepted language is a declarative subset of TypeScript:
//
//   import { defineKit, defineType } from '@vyre/sdk';
//   export const Matter = defineType({ name: 'matter', fields: { ... } });
//   export default defineKit({ ... });
//
// Literals, object and array literals, calls to SDK functions (also `defineField.link(...)`),
// references to earlier constants, and nothing else. Template literals may not contain `${`.
// The body of a defineCodeStep is an opaque string with its own size cap.

import { LanguageError } from "./errors.js";

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 1_000_000,      // whole source
  maxNodes: 50_000,         // tokens consumed into nodes
  maxDepth: 40,             // nesting of ( { [
  maxStringBytes: 100_000,  // any one string
  maxCodeBodyBytes: 200_000, // a defineCodeStep body
  maxMillis: 1500,          // wall clock inside the parser (the worker wrapper also enforces it)
});

/** Words that are never allowed to start or appear as a statement or expression in a definition file. */
const FORBIDDEN_WORDS = new Set([
  "await", "async", "function", "class", "new", "if", "else", "for", "while", "do", "switch", "try", "catch",
  "throw", "return", "let", "var", "yield", "delete", "typeof", "void", "with", "this", "super", "eval",
  "require", "process", "globalThis", "Function", "import_meta", "enum", "namespace", "declare", "interface", "type",
]);

/**
 * @typedef {{ t: "id"|"num"|"str"|"punct"|"eof", v: string, line: number, col: number, raw?: string }} Token
 * @typedef {{ type: "Call", callee: string, args: Node[], line: number, col: number }
 *   | { type: "Object", props: { key: string, value: Node, line: number, col: number }[], line: number, col: number }
 *   | { type: "Array", items: Node[], line: number, col: number }
 *   | { type: "Str", value: string, line: number, col: number }
 *   | { type: "Num", value: number, line: number, col: number }
 *   | { type: "Bool", value: boolean, line: number, col: number }
 *   | { type: "Null", line: number, col: number }
 *   | { type: "Ref", name: string, line: number, col: number }} Node
 * @typedef {{ imports: string[], consts: { name: string, exported: boolean, value: Node }[], defaultExport: Node | null }} Program
 */

/** @param {string} source @param {typeof DEFAULT_LIMITS} limits @returns {Token[]} */
function tokenize(source, limits) {
  /** @type {Token[]} */
  const out = [];
  let i = 0, line = 1, col = 1;
  const started = Date.now();
  const n = source.length;
  const adv = (k = 1) => { for (let j = 0; j < k; j++) { if (source[i] === "\n") { line++; col = 1; } else col++; i++; } };
  const fail = (code, msg, l = line, c = col) => { throw new LanguageError(code, msg, { line: l, col: c }); };
  while (i < n) {
    if ((out.length & 255) === 0 && Date.now() - started > limits.maxMillis) fail("limit_time", "The file took too long to read");
    if (out.length > limits.maxNodes) fail("limit_nodes", `The file has more than ${limits.maxNodes} items`);
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { adv(); continue; }
    if (ch === "/" && source[i + 1] === "/") {
      // pragmas and directives are rejected even though they sit in comments
      let j = i; while (j < n && source[j] !== "\n") j++;
      const text = source.slice(i, j);
      if (/^\/\/\s*(@ts-|\/\s*<reference)/.test(text) || /^\/\/\/\s*</.test(text)) fail("forbidden_syntax", "Directives and @ts- pragmas are not allowed");
      adv(j - i); continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) fail("syntax", "A comment is never closed");
      const text = source.slice(i, end + 2);
      if (/@ts-/.test(text)) fail("forbidden_syntax", "Directives and @ts- pragmas are not allowed");
      adv(end + 2 - i); continue;
    }
    const sl = line, sc = col;
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1; while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
      out.push({ t: "id", v: source.slice(i, j), line: sl, col: sc });
      adv(j - i); continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i; while (j < n && /[0-9_.eE]/.test(source[j])) j++;
      const raw = source.slice(i, j);
      if (!/^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) fail("syntax", `Not a number: ${raw}`);
      out.push({ t: "num", v: raw.replace(/_/g, ""), line: sl, col: sc });
      adv(j - i); continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch; let j = i + 1; let val = "";
      for (;;) {
        if (j >= n) fail("syntax", "A string is never closed", sl, sc);
        const c = source[j];
        if (c === "\\") {
          const e = source[j + 1];
          const map = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "`": "`", $: "$", "0": "\0" };
          if (e === "u" || e === "x") fail("forbidden_syntax", "Unicode and hex escapes are not allowed in a string", line, col);
          if (!(e in map)) fail("syntax", `Unknown escape \\${e}`, sl, sc);
          val += map[e]; j += 2; continue;
        }
        if (c === q) break;
        if (q !== "`" && c === "\n") fail("syntax", "A string runs onto the next line", sl, sc);
        if (q === "`" && c === "$" && source[j + 1] === "{") fail("forbidden_syntax", "A template string cannot contain ${...}", sl, sc);
        val += c; j++;
        if (val.length > limits.maxCodeBodyBytes) fail("limit_string", "A string is too long", sl, sc);
      }
      out.push({ t: "str", v: val, line: sl, col: sc, raw: q });
      adv(j + 1 - i); continue;
    }
    if ("(){}[],:;.=-".includes(ch)) {
      if (ch === "=" && source[i + 1] === ">") fail("forbidden_syntax", "Arrow functions are not allowed", sl, sc);
      if (ch === "." && source[i + 1] === ".") fail("forbidden_syntax", "Spread is not allowed", sl, sc);
      out.push({ t: "punct", v: ch, line: sl, col: sc }); adv(); continue;
    }
    fail("syntax", `Unexpected character ${JSON.stringify(ch)}`);
  }
  out.push({ t: "eof", v: "", line, col });
  return out;
}

/**
 * Parse a definition file. Throws LanguageError on any violation.
 * @param {string} source
 * @param {Partial<typeof DEFAULT_LIMITS>} [limitOverrides]
 * @returns {Program}
 */
export function parse(source, limitOverrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  if (typeof source !== "string") throw new LanguageError("syntax", "The source must be text");
  if (Buffer.byteLength(source, "utf8") > limits.maxBytes) throw new LanguageError("limit_size", `The file is larger than ${limits.maxBytes} bytes`);
  if (/^﻿/.test(source)) source = source.slice(1);
  const toks = tokenize(source, limits);
  let p = 0, depth = 0, nodes = 0;
  const started = Date.now();
  const peek = () => toks[p];
  const next = () => toks[p++];
  /** @param {Token} t @param {string} code @param {string} msg */
  const bad = (t, code, msg) => { throw new LanguageError(code, msg, { line: t.line, col: t.col }); };
  const isP = (t, v) => t.t === "punct" && t.v === v;
  const eatP = (v) => { const t = next(); if (!isP(t, v)) bad(t, "syntax", `Expected "${v}" but found ${t.t === "eof" ? "the end of the file" : JSON.stringify(t.v)}`); return t; };
  const tick = (t) => {
    if (++nodes > limits.maxNodes) bad(t, "limit_nodes", `The file has more than ${limits.maxNodes} items`);
    if ((nodes & 255) === 0 && Date.now() - started > limits.maxMillis) bad(t, "limit_time", "The file took too long to read");
  };
  const enter = (t) => { if (++depth > limits.maxDepth) bad(t, "limit_depth", `Nesting is deeper than ${limits.maxDepth}`); };
  const leave = () => { depth--; };

  /** @returns {Node} */
  function expr(inCodeStepBody = false) {
    const t = next(); tick(t);
    if (t.t === "str") {
      if (Buffer.byteLength(t.v, "utf8") > limits.maxStringBytes && !inCodeStepBody) bad(t, "limit_string", `A string is longer than ${limits.maxStringBytes} bytes`);
      return { type: "Str", value: t.v, line: t.line, col: t.col };
    }
    if (t.t === "num") return { type: "Num", value: Number(t.v), line: t.line, col: t.col };
    if (isP(t, "-")) { const n2 = next(); if (n2.t !== "num") bad(n2, "syntax", "A minus sign must be followed by a number"); return { type: "Num", value: -Number(n2.v), line: t.line, col: t.col }; }
    if (isP(t, "[")) {
      enter(t); /** @type {Node[]} */ const items = [];
      while (!isP(peek(), "]")) { items.push(expr()); if (isP(peek(), ",")) next(); else break; }
      eatP("]"); leave();
      return { type: "Array", items, line: t.line, col: t.col };
    }
    if (isP(t, "{")) {
      enter(t); const props = [];
      while (!isP(peek(), "}")) {
        const k = next(); tick(k);
        let key;
        if (k.t === "id") { key = k.v; if (k.v === "__proto__" || k.v === "constructor" || k.v === "prototype") bad(k, "forbidden_syntax", `The key ${k.v} is not allowed`); }
        else if (k.t === "str") { key = k.v; if (key === "__proto__" || key === "constructor" || key === "prototype") bad(k, "forbidden_syntax", `The key ${key} is not allowed`); }
        else if (k.t === "num") key = k.v;
        else bad(k, "syntax", "Expected a property name");
        const isBody = key === "body" && inCodeStepBodyContext;
        if (!isP(peek(), ":")) bad(peek(), "forbidden_syntax", "Shorthand properties, methods and spread are not allowed: write key: value");
        next();
        const v = expr(isBody);
        props.push({ key, value: v, line: k.line, col: k.col });
        if (isP(peek(), ",")) next(); else break;
      }
      eatP("}"); leave();
      return { type: "Object", props, line: t.line, col: t.col };
    }
    if (t.t === "id") {
      if (t.v === "true" || t.v === "false") return { type: "Bool", value: t.v === "true", line: t.line, col: t.col };
      if (t.v === "null") return { type: "Null", line: t.line, col: t.col };
      if (t.v === "import") bad(t, "forbidden_syntax", "Dynamic import is not allowed");
      if (FORBIDDEN_WORDS.has(t.v)) bad(t, "forbidden_syntax", `"${t.v}" is not allowed in a definition file`);
      let name = t.v;
      while (isP(peek(), ".")) { next(); const m = next(); if (m.t !== "id") bad(m, "syntax", "Expected a name after the dot"); if (FORBIDDEN_WORDS.has(m.v)) bad(m, "forbidden_syntax", `"${m.v}" is not allowed in a definition file`); name += "." + m.v; }
      if (isP(peek(), "(")) {
        next(); enter(t); const args = [];
        const isCodeStep = name === "defineCodeStep";
        while (!isP(peek(), ")")) {
          const saved = inCodeStepBodyContext; inCodeStepBodyContext = isCodeStep;
          try { args.push(expr()); } finally { inCodeStepBodyContext = saved; }
          if (isP(peek(), ",")) next(); else break;
        }
        eatP(")"); leave();
        return { type: "Call", callee: name, args, line: t.line, col: t.col };
      }
      if (name.includes(".")) bad(t, "forbidden_syntax", "Property access is only allowed in a call, such as defineField.link(...)");
      return { type: "Ref", name, line: t.line, col: t.col };
    }
    return bad(t, "syntax", t.t === "eof" ? "The file ends in the middle of a definition" : `Unexpected ${JSON.stringify(t.v)}`);
  }
  let inCodeStepBodyContext = false;

  /** @type {Program} */
  const program = { imports: [], consts: [], defaultExport: null };
  while (peek().t !== "eof") {
    const t = next();
    if (isP(t, ";")) continue;
    if (t.t !== "id") bad(t, "syntax", `Unexpected ${JSON.stringify(t.v)} at the start of a statement`);
    if (t.v === "import") {
      if (isP(peek(), "(")) bad(t, "forbidden_syntax", "Dynamic import is not allowed");
      if (!isP(peek(), "{")) bad(peek(), "forbidden_syntax", "Only named imports from @vyre/sdk are allowed: import { defineKit } from '@vyre/sdk'");
      eatP("{");
      const names = [];
      while (!isP(peek(), "}")) { const nm = next(); if (nm.t !== "id") bad(nm, "syntax", "Expected a name to import"); names.push(nm.v); if (isP(peek(), ",")) next(); else break; }
      eatP("}");
      const from = next(); if (!(from.t === "id" && from.v === "from")) bad(from, "syntax", 'Expected "from"');
      const spec = next(); if (spec.t !== "str") bad(spec, "syntax", "Expected the name of the SDK in quotes");
      if (spec.v !== "@vyre/sdk") bad(spec, "forbidden_syntax", `Only @vyre/sdk can be imported, not ${JSON.stringify(spec.v)}`);
      if (isP(peek(), ";")) next();
      program.imports.push(...names);
      continue;
    }
    if (t.v === "export") {
      const n2 = next();
      if (n2.t === "id" && n2.v === "default") { program.defaultExport = expr(); if (isP(peek(), ";")) next(); continue; }
      if (n2.t === "id" && n2.v === "const") {
        const nm = next(); if (nm.t !== "id") bad(nm, "syntax", "Expected a name"); if (FORBIDDEN_WORDS.has(nm.v)) bad(nm, "forbidden_syntax", `"${nm.v}" cannot be a name`);
        if (isP(peek(), ":")) bad(peek(), "forbidden_syntax", "Type annotations are not allowed; the SDK already types the call");
        eatP("="); program.consts.push({ name: nm.v, exported: true, value: expr() }); if (isP(peek(), ";")) next(); continue;
      }
      if (n2.t === "id" && n2.v === "from") bad(n2, "forbidden_syntax", "export ... from is not allowed");
      bad(n2, "forbidden_syntax", "Only export const and export default are allowed");
    }
    if (t.v === "const") {
      const nm = next(); if (nm.t !== "id") bad(nm, "syntax", "Expected a name"); if (FORBIDDEN_WORDS.has(nm.v)) bad(nm, "forbidden_syntax", `"${nm.v}" cannot be a name`);
      if (isP(peek(), ":")) bad(peek(), "forbidden_syntax", "Type annotations are not allowed; the SDK already types the call");
      eatP("="); program.consts.push({ name: nm.v, exported: false, value: expr() }); if (isP(peek(), ";")) next(); continue;
    }
    if (t.v === "require" || t.v === "eval") bad(t, "forbidden_syntax", `"${t.v}" is not allowed in a definition file`);
    bad(t, "forbidden_syntax", `"${t.v}" is not allowed at the top level of a definition file`);
  }
  return program;
}

/**
 * Parse in a worker with a memory ceiling and a hard time limit, so a hostile file can never hold
 * the daemon (R6-12). Same result as parse().
 * @param {string} source
 * @param {Partial<typeof DEFAULT_LIMITS>} [limitOverrides]
 * @returns {Promise<Program>}
 */
export async function parseSafely(source, limitOverrides = {}) {
  const { Worker } = await import("node:worker_threads");
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  if (typeof source === "string" && Buffer.byteLength(source, "utf8") > limits.maxBytes) throw new LanguageError("limit_size", `The file is larger than ${limits.maxBytes} bytes`);
  const url = new URL("./parse-worker.js", import.meta.url);
  return new Promise((resolve, reject) => {
    const w = new Worker(url, { workerData: { source, limits }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } });
    const timer = setTimeout(() => { w.terminate(); reject(new LanguageError("limit_time", "The file took too long to read")); }, limits.maxMillis + 500);
    w.once("message", (m) => { clearTimeout(timer); if (m.ok) resolve(m.program); else reject(new LanguageError(m.code, m.message.replace(/ \(line \d+, column \d+\)$/, ""), { line: m.line, col: m.col })); });
    w.once("error", (e) => { clearTimeout(timer); reject(new LanguageError("limit_memory", /memory/i.test(String(e.message)) ? "The file used too much memory" : `The reader stopped: ${e.message}`)); });
  });
}
