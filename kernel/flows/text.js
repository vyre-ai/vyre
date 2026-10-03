// @ts-check
// The text form of a definition: TypeScript against the Vyre SDK (contract 5.6). The stored form is the source of truth; this
// file is its projection and nothing more.
//
//   printFlow(stored)      canonical text (idempotent, comments are not kept, layout is the formatter's)
//   parseModule(text, o)   a SOURCE-ONLY parse of the declarative subset: SDK calls, literals, object and array literals, references
//                          to earlier definitions by name. It never executes anything, never type-checks, never resolves an import.
//   parseFlowText(text)    the Flow(s) a file defines, as stored forms
//
// The parser rejects at the syntax level, before any tree is built: imports of anything but the SDK, dynamic import(), require,
// `export ... from`, triple-slash directives, @ts- pragmas, spreads, computed keys, getters and setters, tagged templates, template
// interpolation outside a Code step's source, and the keys __proto__, constructor and prototype. It enforces limits on source size,
// nesting depth, node count and time. A Code step's source is an opaque span: a template or string literal that is lexed only to
// find its end, so nothing inside it (a `*/`, an escaped backtick, `import`, `require`, `///`) can end it early or trip a rejection.

import { checkFlow, STEP_KINDS, BLOCK_KINDS, FLOW_FORMAT, sourceHash, canonical } from "./schema.js";

export const TEXT_LIMITS = Object.freeze({ source: 1_000_000, depth: 40, nodes: 60_000, ms: 2000, codeSource: 64 * 1024 });
const SDK = "@vyre/sdk";
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class TextError extends Error {
  /** @param {string} message @param {number} line @param {number} col */
  constructor(message, line, col) { super(`line ${line}: ${message}`); this.name = "TextError"; this.line = line; this.col = col; this.detail = message; }
}

// ---------------------------------------------------------------- lexer

/** @typedef {{ t: 'id'|'num'|'str'|'tpl'|'p'|'end', v: any, line: number, col: number }} Tok */

/** @param {string} src @returns {Tok[]} */
function lex(src) {
  if (typeof src !== "string") throw new TextError("the source is text", 1, 1);
  if (src.length > TEXT_LIMITS.source) throw new TextError(`the source is over ${TEXT_LIMITS.source} characters`, 1, 1);
  /** @type {Tok[]} */
  const out = [];
  let i = 0, line = 1, lineStart = 0;
  const t0 = Date.now();
  const col = () => i - lineStart + 1;
  const fail = (/** @type {string} */ m) => { throw new TextError(m, line, col()); };
  const nl = () => { line++; lineStart = i + 1; };
  while (i < src.length) {
    if ((i & 1023) === 0 && Date.now() - t0 > TEXT_LIMITS.ms) fail("the file took too long to read");
    const c = src[i];
    if (c === "\n") { nl(); i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const text = src.slice(i, end < 0 ? src.length : end);
      if (/^\/\/\//.test(text)) fail("triple-slash directives are not allowed");
      if (/@ts-/.test(text)) fail("@ts- pragmas are not allowed");
      i = end < 0 ? src.length : end; continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) fail("a comment is not closed");
      const text = src.slice(i, end + 2);
      if (/@ts-/.test(text)) fail("@ts- pragmas are not allowed");
      for (let k = i; k < end + 2; k++) if (src[k] === "\n") { line++; lineStart = k + 1; }
      i = end + 2; continue;
    }
    const startLine = line, startCol = col();
    if (c === "'" || c === '"') {
      let j = i + 1, s = "";
      for (;;) {
        if (j >= src.length || src[j] === "\n") fail("a string is not closed");
        if (src[j] === c) break;
        if (src[j] === "\\") { const r = unescape(src, j, false); if (!r) fail("a string has a bad escape"); s += r.text; j = r.next; continue; }
        s += src[j++];
      }
      out.push({ t: "str", v: s, line: startLine, col: startCol }); i = j + 1; continue;
    }
    if (c === "`") {
      // An opaque span: read only to find its end. `${` is raw text here and is escaped on the way out; an unescaped one is refused.
      let j = i + 1, s = "";
      for (;;) {
        if (j >= src.length) fail("a template is not closed");
        if (src[j] === "`") break;
        if (src[j] === "\\") { const r = unescape(src, j, true); if (!r) fail("a template has a bad escape"); s += r.text; j = r.next; continue; }
        if (src[j] === "$" && src[j + 1] === "{") fail("a template may not hold ${...}: values are written out, never computed");
        if (src[j] === "\n") { line++; lineStart = j + 1; }
        s += src[j++];
      }
      out.push({ t: "tpl", v: s, line: startLine, col: startCol }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i, i + 40));
      if (!m) fail("a number is malformed");
      out.push({ t: "num", v: Number(m[0]), line: startLine, col: startCol }); i += m[0].length; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j), line: startLine, col: startCol }); i = j; continue;
    }
    if ("{}[](),:;=.-".includes(c)) {
      if (c === "." && src[i + 1] === "." && src[i + 2] === ".") fail("a spread is not allowed");
      out.push({ t: "p", v: c, line: startLine, col: startCol }); i++; continue;
    }
    if (c === "@") fail("decorators are not allowed");
    fail(`unexpected character ${JSON.stringify(c)}`);
  }
  out.push({ t: "end", v: null, line, col: col() });
  return out;
}

/** @param {string} src @param {number} at index of the backslash @param {boolean} tpl @returns {{ text: string, next: number } | null} */
function unescape(src, at, tpl) {
  const n = src[at + 1];
  const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "\\": "\\", "'": "'", '"': '"', "`": "`", $: "$" };
  if (n !== undefined && Object.hasOwn(simple, n)) return { text: /** @type {any} */ (simple)[n], next: at + 2 };
  if (n === "u") {
    if (src[at + 2] === "{") { const end = src.indexOf("}", at + 3); const hex = src.slice(at + 3, end); if (end < 0 || !/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return null; return { text: String.fromCodePoint(parseInt(hex, 16)), next: end + 1 }; }
    const hex = src.slice(at + 2, at + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
    return { text: String.fromCharCode(parseInt(hex, 16)), next: at + 6 };
  }
  if (tpl && n === "\n") return { text: "", next: at + 2 };
  return null;
}

// ---------------------------------------------------------------- parser

/** A call to an SDK function, before a handler turns it into data. @typedef {{ name: string, args: any[], line: number, col: number }} Call */

/**
 * @typedef {{
 *   handlers?: Record<string, (args: any[], at: { line: number, col: number }) => any>,
 *   sdk?: string[],
 * }} ParseOptions
 */

/**
 * Parse a definition file. Returns the named values it exports or binds, in order, and its default export.
 * `handlers` maps an SDK function name (`defineFlow`, `step.create`, `expr`) to the function that builds its value; a call with no
 * handler is an error naming it. Objects are built with a null prototype, then copied to plain objects once everything is checked.
 * @param {string} text @param {ParseOptions} [opts]
 * @returns {{ bindings: Record<string, any>, order: string[], default?: any, imports: string[] }}
 */
export function parseModule(text, opts = {}) {
  const toks = lex(text);
  const handlers = opts.handlers || {};
  let p = 0, nodes = 0;
  const t0 = Date.now();
  /** @type {Map<string, any>} */
  const bound = new Map();
  /** @type {string[]} */
  const order = [];
  /** @type {Set<string>} */
  const imported = new Set();
  /** @type {{ default?: any }} */
  const result = {};

  const cur = () => toks[p];
  const fail = (/** @type {string} */ m, /** @type {Tok} */ t = cur()) => { throw new TextError(m, t.line, t.col); };
  const isP = (/** @type {string} */ v) => cur().t === "p" && cur().v === v;
  const isId = (/** @type {string} */ v) => cur().t === "id" && cur().v === v;
  const needP = (/** @type {string} */ v) => { if (!isP(v)) fail(`expected ${JSON.stringify(v)}`); p++; };
  const tick = (/** @type {number} */ depth) => {
    if (++nodes > TEXT_LIMITS.nodes) fail("the file is too large (too many nodes)");
    if (depth > TEXT_LIMITS.depth) fail("the file nests too deeply");
    if ((nodes & 255) === 0 && Date.now() - t0 > TEXT_LIMITS.ms) fail("the file took too long to read");
  };

  // Syntax-level rejections, on tokens outside every span.
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== "id") continue;
    if (t.v === "require") fail("require is not allowed", t);
    if (t.v === "import" && toks[i + 1].t === "p" && toks[i + 1].v === "(") fail("dynamic import() is not allowed", t);
    if (t.v === "export" && toks.slice(i + 1, i + 40).some((x, k, a) => x.t === "id" && x.v === "from" && (a[k - 1]?.v === "}" || a[k - 1]?.v === "*"))) fail("export ... from is not allowed", t);
    const isKey = toks[i + 1].t === "p" && toks[i + 1].v === ":";
    if (!isKey && (t.v === "eval" || t.v === "Function" || t.v === "new" || t.v === "function" || t.v === "class" || t.v === "async" || t.v === "await")) fail(`${t.v} is not allowed: a definition file only declares`, t);
    if (t.v === "get" || t.v === "set") { const n = toks[i + 1]; if (n.t === "id" && toks[i + 2]?.v === "(") fail("getters and setters are not allowed", t); }
  }

  /** @param {number} d @returns {any} */
  function value(d) {
    tick(d);
    const t = cur();
    if (t.t === "str" || t.t === "tpl") { p++; return t.v; }
    if (t.t === "num") { p++; return t.v; }
    if (isP("-") && toks[p + 1].t === "num") { p++; const n = cur(); p++; return -n.v; }
    if (isP("[")) {
      p++;
      const arr = [];
      while (!isP("]")) {
        if (isP(",")) fail("an array has no holes");
        arr.push(value(d + 1));
        if (isP(",")) { p++; continue; }
        if (!isP("]")) fail("expected , or ]");
      }
      p++;
      return arr;
    }
    if (isP("{")) {
      p++;
      const obj = Object.create(null);
      while (!isP("}")) {
        const k = cur();
        if (isP("[")) fail("computed keys are not allowed");
        if (k.t !== "id" && k.t !== "str") fail("a key is a name or a string");
        if (FORBIDDEN_KEYS.has(k.v)) fail(`${k.v} is not a name a definition may use`, k);
        p++;
        if (!isP(":")) fail(k.t === "id" ? `write ${k.v}: <value>; shorthand and methods are not allowed` : "expected :");
        p++;
        if (Object.hasOwn(obj, k.v)) fail(`the key ${k.v} is given twice`, k);
        obj[k.v] = value(d + 1);
        if (isP(",")) { p++; continue; }
        if (!isP("}")) fail("expected , or }");
      }
      p++;
      return obj;
    }
    if (t.t === "id") {
      if (t.v === "true") { p++; return true; }
      if (t.v === "false") { p++; return false; }
      if (t.v === "null") { p++; return null; }
      if (["undefined", "NaN", "Infinity"].includes(t.v)) fail(`${t.v} is not a value a definition may use`);
      // a call or a reference
      let name = t.v;
      p++;
      if (isP(".")) {
        p++;
        const m = cur();
        if (m.t !== "id") fail("a name must follow the dot");
        if (FORBIDDEN_KEYS.has(m.v)) fail(`${m.v} is not a name a definition may use`, m);
        name += "." + m.v; p++;
      }
      if (isP("(")) {
        const root = name.split(".")[0];
        if (!imported.has(root)) fail(`${root} is not imported from ${SDK}`, t);
        p++;
        const args = [];
        while (!isP(")")) {
          args.push(value(d + 1));
          if (isP(",")) { p++; continue; }
          if (!isP(")")) fail("expected , or )");
        }
        p++;
        if (cur().t === "tpl") fail("tagged templates are not allowed");
        const h = handlers[name];
        if (!h) fail(`${name} is not something a definition file may call here`, t);
        try { return h(args.map(toPlain), { line: t.line, col: t.col }); }
        catch (e) { if (e instanceof TextError) throw e; fail(e instanceof Error ? e.message : String(e), t); }
      }
      if (name.includes(".")) fail("a reference is a plain name", t);
      if (!bound.has(name)) fail(`${name} is not defined above (a definition refers only to ones written before it)`, t);
      return bound.get(name);
    }
    return fail(t.t === "end" ? "the file ends too soon" : `unexpected ${JSON.stringify(t.v)}`);
  }

  // top level
  while (cur().t !== "end") {
    tick(0);
    if (isP(";")) { p++; continue; }
    if (isId("import")) {
      p++;
      if (!isP("{")) fail(`only ${SDK} may be imported, by name: import { ... } from '${SDK}'`);
      p++;
      const names = [];
      while (!isP("}")) {
        const n = cur();
        if (n.t !== "id") fail("expected a name");
        names.push(n.v); p++;
        if (isId("as")) fail("import without renaming");
        if (isP(",")) { p++; continue; }
        if (!isP("}")) fail("expected , or }");
      }
      p++;
      if (!isId("from")) fail("expected from");
      p++;
      const src = cur();
      if (src.t !== "str" || src.v !== SDK) fail(`only ${SDK} may be imported`, src);
      p++;
      if (isP(";")) p++;
      for (const n of names) imported.add(n);
      continue;
    }
    let exported = false, isDefault = false;
    if (isId("export")) { p++; exported = true; if (isId("default")) { p++; isDefault = true; } }
    if (isDefault) { result.default = value(0); if (isP(";")) p++; continue; }
    if (isId("const")) {
      p++;
      const n = cur();
      if (n.t !== "id") fail("expected a name");
      if (FORBIDDEN_KEYS.has(n.v)) fail(`${n.v} is not a name a definition may use`, n);
      if (bound.has(n.v)) fail(`${n.v} is defined twice`, n);
      p++;
      needP("=");
      const v = value(0);
      if (isP(";")) p++;
      bound.set(n.v, v); order.push(n.v);
      void exported;
      continue;
    }
    fail("a definition file has imports, `const name = ...` and `export default ...` only");
  }

  /** @type {Record<string, any>} */
  const bindings = {};
  for (const [k, v] of bound) bindings[k] = toPlain(v);
  return { bindings, order, default: result.default === undefined ? undefined : toPlain(result.default), imports: [...imported] };
}

/** Copy a null-prototype tree to plain objects (every key was checked, so nothing can pollute). @param {any} v @returns {any} */
function toPlain(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(toPlain);
  const o = {};
  for (const k of Object.keys(v)) Object.defineProperty(o, k, { value: toPlain(v[k]), enumerable: true, writable: true, configurable: true });
  return o;
}

// ---------------------------------------------------------------- Flow: text to stored

/** Handlers for the Flow part of the SDK: defineFlow, step.<kind>, expr. */
export const flowHandlers = Object.freeze({
  expr: (/** @type {any[]} */ a) => {
    if (a.length !== 1 || typeof a[0] !== "string") throw new Error("expr takes one string");
    return { expr: a[0] };
  },
  defineFlow: (/** @type {any[]} */ a) => {
    if (a.length !== 1 || !a[0] || typeof a[0] !== "object" || Array.isArray(a[0])) throw new Error("defineFlow takes one object");
    const o = a[0];
    const flow = { format: FLOW_FORMAT, ...o };
    if (Object.hasOwn(o, "format")) throw new Error("format is not written in a definition file");
    return flow;
  },
  ...Object.fromEntries(STEP_KINDS.map(kind => [`step.${kind}`, (/** @type {any[]} */ a) => {
    if (a.length !== 2 || typeof a[0] !== "string" || !a[1] || typeof a[1] !== "object" || Array.isArray(a[1])) throw new Error(`step.${kind} takes an id and an object`);
    const s = { id: a[0], kind, ...a[1] };
    if (Object.hasOwn(a[1], "id") || Object.hasOwn(a[1], "kind")) throw new Error(`step.${kind}: the id is the first argument and the kind is the function`);
    return s;
  }])),
});

/** Fill what the text form leaves out so the stored form is whole: a Code step's hash. @param {any} flow */
export function normalizeFlow(flow) {
  const f = structuredClone(flow);
  const walk = (/** @type {any[]} */ steps) => { for (const s of steps || []) { if (s.kind === "fn" && typeof s.source === "string") s.hash = sourceHash(s.source); for (const b of /** @type {string[]} */ (BLOCK_KINDS[/** @type {keyof typeof BLOCK_KINDS} */ (s.kind)] || [])) if (Array.isArray(s[b])) walk(s[b]); } };
  walk(f.steps);
  return f;
}

/**
 * The Flows a file defines, as stored forms, with the problems found. A file outside the declarative subset is refused with a line.
 * @param {string} text @returns {{ flows: { binding: string|null, flow: any }[], problems: { path: string, message: string }[] }}
 */
export function parseFlowText(text) {
  const mod = parseModule(text, { handlers: flowHandlers });
  const flows = [];
  for (const name of mod.order) if (isFlowLike(mod.bindings[name])) flows.push({ binding: name, flow: normalizeFlow(mod.bindings[name]) });
  if (mod.default !== undefined && isFlowLike(mod.default)) flows.push({ binding: null, flow: normalizeFlow(mod.default) });
  if (!flows.length) throw new TextError("the file defines no Flow (write `export default defineFlow({ ... })`)", 1, 1);
  const problems = [];
  for (const f of flows) for (const pr of checkFlow(f.flow)) problems.push({ path: (f.binding || "default") + (pr.path ? "." + pr.path : ""), message: pr.message });
  return { flows, problems };
}

/** @param {any} v */
const isFlowLike = v => v && typeof v === "object" && !Array.isArray(v) && v.format === FLOW_FORMAT && Array.isArray(v.steps);

// ---------------------------------------------------------------- Flow: stored to text

const FLOW_ORDER = ["name", "label", "description", "authorship", "caps", "trigger", "steps"];
const TRIGGER_ORDER = ["on", "event", "where", "cron", "every_ms", "at", "path", "input", "type", "stage"];
const STEP_PROP_ORDER = ["label", "type", "from", "match", "record", "to", "assistant", "action", "resource", "method", "url", "language", "over", "as", "if", "for_ms", "until", "event", "where", "timeout_ms", "on_timeout", "limit", "sort", "title", "instructions", "form", "input", "inputs", "outputs", "labels", "needs", "set", "headers", "body", "how", "template", "checker", "output", "await", "max", "then", "else", "steps", "source"];

/** @param {string} s */
export function quote(s) {
  let out = "'";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === "'") out += "\\'";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 32 || c === 0x7f || (c >= 0x2028 && c <= 0x2029)) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + "'";
}

/** A Code step's source as a template literal: only the backslash, the backtick and `${` need escaping. @param {string} s */
export function template(s) {
  return "`" + s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${").replace(/\r/g, "\\r") + "`";
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (/** @type {string} */ k) => (IDENT.test(k) && !FORBIDDEN_KEYS.has(k) ? k : quote(k));

/**
 * Print a value. `ordered` lists the property order for structured objects; free-form maps (set, input, match...) sort their keys,
 * so the text is a function of the canonical content.
 * @param {any} v @param {number} indent @param {string[]|null} order
 */
function pv(v, indent, order) {
  if (v === null) return "null";
  if (typeof v === "string") return quote(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    const inline = "[" + v.map(x => pv(x, 0, null)).join(", ") + "]";
    if (inline.length <= 88 && !inline.includes("\n")) return inline;
    const pad = "  ".repeat(indent + 1);
    return "[\n" + v.map(x => pad + pv(x, indent + 1, null)).join(",\n") + ",\n" + "  ".repeat(indent) + "]";
  }
  if (Object.hasOwn(v, "expr") && Object.keys(v).length === 1) return `expr(${quote(v.expr)})`;
  const keys = Object.keys(v).filter(k => v[k] !== undefined);
  const sorted = order ? [...order.filter(k => keys.includes(k)), ...keys.filter(k => !order.includes(k)).sort()] : keys.sort();
  if (!sorted.length) return "{}";
  const inline = "{ " + sorted.map(k => `${key(k)}: ${pv(v[k], 0, null)}`).join(", ") + " }";
  if (inline.length <= 88 && !inline.includes("\n")) return inline;
  const pad = "  ".repeat(indent + 1);
  return "{\n" + sorted.map(k => `${pad}${key(k)}: ${pv(v[k], indent + 1, null)}`).join(",\n") + ",\n" + "  ".repeat(indent) + "}";
}

/** @param {any} s @param {number} indent */
function printStep(s, indent) {
  const pad = "  ".repeat(indent);
  const props = Object.keys(s).filter(k => k !== "id" && k !== "kind" && k !== "hash" && s[k] !== undefined);
  const ordered = [...STEP_PROP_ORDER.filter(k => props.includes(k)), ...props.filter(k => !STEP_PROP_ORDER.includes(k)).sort()];
  if (!ordered.length) return `${pad}step.${s.kind}(${quote(s.id)}, {})`;
  const lines = ordered.map(k => {
    const v = s[k];
    const ip = "  ".repeat(indent + 1);
    if ((k === "then" || k === "else" || k === "steps") && Array.isArray(v)) {
      return v.length ? `${ip}${k}: [\n${v.map(x => printStep(x, indent + 2)).join(",\n")},\n${ip}]` : `${ip}${k}: []`;
    }
    if (k === "source" && s.kind === "fn" && typeof v === "string") return `${ip}${k}: ${template(v)}`;
    return `${ip}${k}: ${pv(v, indent + 1, null)}`;
  });
  return `${pad}step.${s.kind}(${quote(s.id)}, {\n${lines.join(",\n")},\n${pad}})`;
}

/**
 * The canonical text of a stored Flow. Idempotent: printing what parseFlowText read gives the same text back.
 * @param {any} flow @param {{ exportName?: string }} [o]
 */
export function printFlow(flow, o = {}) {
  const f = normalizeFlow(flow);
  const used = new Set(["defineFlow"]);
  if (JSON.stringify(f).includes('"expr"')) used.add("expr");
  used.add("step");
  const head = `import { ${["defineFlow", "step", ...(used.has("expr") ? ["expr"] : [])].join(", ")} } from '${SDK}';\n\n`;
  const keys = FLOW_ORDER.filter(k => f[k] !== undefined);
  const body = keys.map(k => {
    if (k === "steps") return f.steps.length ? `  steps: [\n${f.steps.map((/** @type {any} */ s) => printStep(s, 2)).join(",\n")},\n  ]` : "  steps: []";
    if (k === "trigger") return `  trigger: ${pv(f.trigger, 1, TRIGGER_ORDER)}`;
    if (k === "caps") return `  caps: ${pv(f.caps, 1, ["action", "resource"])}`;
    return `  ${k}: ${pv(f[k], 1, null)}`;
  }).join(",\n");
  const call = `defineFlow({\n${body},\n})`;
  return head + (o.exportName ? `export const ${o.exportName} = ${call};\n` : `export default ${call};\n`);
}

/** Do two stored Flows mean the same thing? @param {any} a @param {any} b */
export const sameFlow = (a, b) => canonical(normalizeFlow(a)) === canonical(normalizeFlow(b));

/**
 * Parse in a worker with a memory ceiling, so a hostile file cannot stall or exhaust the kernel (R6-12).
 * @param {string} text @returns {Promise<ReturnType<typeof parseFlowText>>}
 */
export async function parseFlowTextBounded(text) {
  const { Worker } = await import("node:worker_threads");
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./text-worker.js", import.meta.url), { workerData: { text }, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } });
    const timer = setTimeout(() => { void w.terminate(); reject(new TextError("the file took too long to read", 1, 1)); }, TEXT_LIMITS.ms * 2);
    w.once("message", m => { clearTimeout(timer); if (m.error) reject(new TextError(m.error.detail || m.error.message, m.error.line || 1, m.error.col || 1)); else resolve(m.ok); });
    w.once("error", e => { clearTimeout(timer); reject(new TextError(`the file could not be read: ${e.message}`, 1, 1)); });
  });
}
