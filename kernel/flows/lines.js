// @ts-check
// The lines form of a Flow (e1): a short text, one line a step, that reads and writes in a fraction of the tokens of the TypeScript form (text.js) and means exactly the same Flow.
// Both are projections of the one stored form, so the canvas, the TypeScript text and these lines stay in sync: `sameFlow(parseLines(printLines(f)), f)` for every Flow.
//
//   name: Intake welcome                        a Flow key: value (format is implied; a Code step's hash is derived)
//   trigger: {on: event, event: payment.received}
//   steps:
//     m create type=matter set={client: `trigger.name`}     id kind key=value ... ; `x` is an expression
//     d decide if=`steps.m.count > 0`
//       then:                                   a list of steps, indented
//         a assign to=role:paralegal title="Check the client"
//       on_fail then=continue:                  a failure path: its keys, then its steps
//         n create type=matter set={client: x}
//     f fn language=js inputs={} outputs=[n] source=<<<
//         return { n: 1 };
//       >>>
//   on_failure:
//     ...
//
// A value is a bare word, a number, true, false, null, a "double quoted string", a `backtick expression`, [a list], or {key: value}. A bare word is a string that needs no quotes.
// Parsing is source only and bounded (size, depth, nodes), refuses the keys that reach a prototype, and the result goes through the same checks as every Flow.

import { FLOW_FORMAT } from "./schema.js";

export const LINES_LIMITS = Object.freeze({ source: 1_000_000, depth: 40, nodes: 60_000 });
const BLOCK_NAMES = ["then", "else", "steps", "on_fail"];
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BARE = /^[A-Za-z_][A-Za-z0-9_.:\/@-]*$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WORDS = new Set(["true", "false", "null"]);
const FLOW_KEYS = ["name", "label", "description", "authorship", "caps", "trigger", "concurrency", "lock", "stuck_after_ms"];

export class LinesError extends Error {
  /** @param {string} message @param {number} line */
  constructor(message, line) { super(`line ${line}: ${message}`); this.name = "LinesError"; this.line = line; this.detail = message; }
}

// ---------------------------------------------------------------- printing

/** @param {any} v */
const isStep = v => v && typeof v === "object" && !Array.isArray(v) && typeof v.id === "string" && typeof v.kind === "string";
/** @param {any} v */
const isObj = v => v && typeof v === "object" && !Array.isArray(v);

/** One value, on one line. @param {any} v @returns {string} */
export function enc(v) {
  if (v === null || typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
  if (typeof v === "string") return BARE.test(v) && !WORDS.has(v) ? v : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(enc).join(", ")}]`;
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "expr" && typeof v.expr === "string" && !/[`\n\r\\]/.test(v.expr)) return "`" + v.expr + "`";
    return `{${keys.map(k => `${KEY.test(k) ? k : JSON.stringify(k)}: ${enc(v[k])}`).join(", ")}}`;
  }
  return "null";
}

/** Can a Code step's source be written as a raw block? @param {string} src */
const rawOk = src => !/\r/.test(src) && !src.split("\n").some(l => l.trim() === ">>>");

/** @param {any} s @param {number} ind @param {string[]} out */
function printStep(s, ind, out) {
  const pad = " ".repeat(ind);
  /** @type {[string, any[]][]} */ const blocks = [];
  /** @type {string[]} */ const bits = [];
  let raw = null;
  for (const [k, v] of Object.entries(s)) {
    if (k === "id" || k === "kind") continue;
    if (k === "hash" && s.kind === "fn") continue;
    if (k === "source" && s.kind === "fn" && typeof v === "string" && rawOk(v)) { raw = v; continue; }
    if ((k === "then" || k === "else" || k === "steps") && Array.isArray(v) && v.length && v.every(isStep)) { blocks.push([k, v]); continue; }
    if (k === "on_fail" && isObj(v) && Array.isArray(v.steps) && v.steps.length && v.steps.every(isStep) && Object.keys(v).every(x => x === "steps" || x === "then")) { blocks.push(["on_fail", v]); continue; }
    bits.push(`${k}=${enc(v)}`);
  }
  out.push(`${pad}${s.id} ${s.kind}${bits.length ? " " + bits.join(" ") : ""}${raw !== null ? `${bits.length ? " " : " "}source=<<<` : ""}`);
  if (raw !== null) { for (const l of raw.split("\n")) out.push(l ? `${pad}  ${l}` : ""); out.push(`${pad}>>>`); }
  for (const [name, v] of blocks) {
    if (name === "on_fail") { out.push(`${pad}  on_fail${v.then !== undefined ? ` then=${enc(v.then)}` : ""}:`); for (const c of v.steps) printStep(c, ind + 4, out); }
    else { out.push(`${pad}  ${name}:`); for (const c of v) printStep(c, ind + 4, out); }
  }
}

/** The lines form of a stored Flow. @param {any} flow @returns {string} */
export function printLines(flow) {
  /** @type {string[]} */ const out = [];
  for (const k of FLOW_KEYS) if (flow[k] !== undefined) out.push(`${k}: ${enc(flow[k])}`);
  for (const k of Object.keys(flow)) if (!["format", "steps", "on_failure", ...FLOW_KEYS].includes(k)) out.push(`${k}: ${enc(flow[k])}`);
  out.push("steps:");
  for (const s of flow.steps || []) printStep(s, 2, out);
  if (Array.isArray(flow.on_failure) && flow.on_failure.length) { out.push("on_failure:"); for (const s of flow.on_failure) printStep(s, 2, out); }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- parsing

/** One value parser over a single line. */
class Reader {
  /** @param {string} s @param {number} line @param {{ nodes: number }} budget */
  constructor(s, line, budget) { this.s = s; this.i = 0; this.line = line; this.budget = budget; }
  /** @param {string} m @returns {never} */
  fail(m) { throw new LinesError(m, this.line); }
  ws() { while (this.s[this.i] === " ") this.i++; }
  eol() { this.ws(); return this.i >= this.s.length; }
  /** @param {number} depth @returns {any} */
  value(depth = 0) {
    if (depth > LINES_LIMITS.depth) this.fail("nested too deeply");
    if (++this.budget.nodes > LINES_LIMITS.nodes) this.fail("too many values");
    const s = this.s, c = s[this.i];
    if (c === '"') return this.string();
    if (c === "`") { const j = s.indexOf("`", this.i + 1); if (j < 0) this.fail("an expression opens with ` and has no closing `"); const e = s.slice(this.i + 1, j); this.i = j + 1; return { expr: e }; }
    if (c === "[") {
      this.i++; /** @type {any[]} */ const a = [];
      this.ws();
      if (s[this.i] === "]") { this.i++; return a; }
      for (;;) {
        this.ws(); a.push(this.value(depth + 1)); this.ws();
        if (s[this.i] === ",") { this.i++; continue; }
        if (s[this.i] === "]") { this.i++; return a; }
        this.fail("a list continues with , or ends with ]");
      }
    }
    if (c === "{") {
      this.i++; /** @type {Record<string, any>} */ const o = {};
      this.ws();
      if (s[this.i] === "}") { this.i++; return o; }
      for (;;) {
        this.ws();
        const k = s[this.i] === '"' ? this.string() : this.word(KEY);
        if (BAD_KEYS.has(k)) this.fail(`${k} is not allowed as a key`);
        this.ws();
        if (s[this.i] !== ":") this.fail(`expected : after ${k}`);
        this.i++; this.ws();
        o[k] = this.value(depth + 1); this.ws();
        if (s[this.i] === ",") { this.i++; continue; }
        if (s[this.i] === "}") { this.i++; return o; }
        this.fail("an object continues with , or ends with }");
      }
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?=[\s,\]}]|$)/.exec(s.slice(this.i));
    if (m) { this.i += m[0].length; return Number(m[0]); }
    const w = this.word(BARE);
    return w === "true" ? true : w === "false" ? false : w === "null" ? null : w;
  }
  string() {
    const s = this.s; let j = this.i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
    if (j >= s.length) this.fail('a string opens with " and has no closing "');
    const raw = s.slice(this.i, j + 1);
    this.i = j + 1;
    try { return JSON.parse(raw); } catch { this.fail("that string is not valid"); }
  }
  /** @param {RegExp} re */
  word(re) {
    const m = (re === KEY ? /^[A-Za-z_][A-Za-z0-9_]*/ : /^[A-Za-z_][A-Za-z0-9_.:\/@-]*/).exec(this.s.slice(this.i));
    const w = m ? m[0] : "";
    if (!w) this.fail(`expected a ${re === KEY ? "name" : "value"} at "${this.s.slice(this.i, this.i + 12)}"`);
    this.i += w.length;
    return w;
  }
}

/**
 * The Flow in some lines. Returns the stored form (call normalizeFlow on it to fill the derived keys). Throws LinesError with the line.
 * @param {string} text
 */
export function parseLines(text) {
  if (typeof text !== "string" || text.length > LINES_LIMITS.source) throw new LinesError("that text is too large", 1);
  if (/\t/.test(text)) throw new LinesError("indent with spaces, two a level", 1);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const budget = { nodes: 0 };
  let at = 0;
  /** @type {Record<string, any>} */ const flow = { format: FLOW_FORMAT };

  const indentOf = (/** @type {string} */ l) => l.length - l.trimStart().length;
  const skip = () => { while (at < lines.length && (!lines[at].trim() || lines[at].trim().startsWith("#"))) at++; };

  /** @param {number} ind @param {number} depth @returns {any[]} */
  function steps(ind, depth) {
    if (depth > LINES_LIMITS.depth) throw new LinesError("steps nested too deeply", at + 1);
    /** @type {any[]} */ const list = [];
    for (;;) {
      skip();
      if (at >= lines.length || indentOf(lines[at]) !== ind) {
        if (at < lines.length && indentOf(lines[at]) > ind) throw new LinesError("this line is indented more than the step above it", at + 1);
        return list;
      }
      list.push(step(ind, depth));
    }
  }

  /** @param {number} ind @param {number} depth */
  function step(ind, depth) {
    const n = at + 1, line = lines[at];
    const r = new Reader(line, n, budget);
    r.i = ind;
    const id = r.word(KEY); r.ws();
    const kind = r.word(KEY);
    /** @type {Record<string, any>} */ const s = { id, kind };
    let rawAt = null;
    for (;;) {
      if (r.eol()) break;
      const k = r.word(KEY);
      if (BAD_KEYS.has(k)) r.fail(`${k} is not allowed as a key`);
      if (line[r.i] !== "=") r.fail(`expected = after ${k}`);
      r.i++;
      if (line.startsWith("<<<", r.i)) { r.i += 3; if (!r.eol()) r.fail("<<< ends the line"); rawAt = k; break; }
      s[k] = r.value();
      if (r.i < line.length && line[r.i] !== " ") r.fail(`expected a space after the value of ${k}`);
    }
    at++;
    if (rawAt !== null) {
      /** @type {string[]} */ const body = [];
      const base = ind + 2;
      for (;;) {
        if (at >= lines.length) throw new LinesError("a <<< block has no closing >>>", n);
        const l = lines[at];
        if (l.trim() === ">>>") { at++; break; }
        body.push(l.startsWith(" ".repeat(base)) ? l.slice(base) : l.trim() === "" ? "" : l.trimStart());
        at++;
      }
      s[rawAt] = body.join("\n");
    }
    // nested lists
    for (;;) {
      skip();
      if (at >= lines.length || indentOf(lines[at]) !== ind + 2) break;
      const l = lines[at].trim();
      const head = /^(then|else|steps|on_fail)((?: [A-Za-z_][A-Za-z0-9_]*=[^:]*)?):$/.exec(l);
      if (!head) throw new LinesError("expected then:, else:, steps: or on_fail: here", at + 1);
      const name = head[1];
      if (Object.hasOwn(s, name)) throw new LinesError(`${name} is given twice`, at + 1);
      const hn = at + 1;
      /** @type {Record<string, any>} */ const opts = {};
      if (head[2]) { const hr = new Reader(head[2].trim(), hn, budget); const k = hr.word(KEY); if (head[2].trim()[hr.i] !== "=") hr.fail("expected ="); hr.i++; opts[k] = hr.value(); }
      at++;
      const kids = steps(ind + 4, depth + 1);
      if (!kids.length) throw new LinesError(`${name} has no steps`, hn);
      if (name === "on_fail") { for (const k of Object.keys(opts)) if (k !== "then") throw new LinesError(`${k} is not part of on_fail`, hn); s.on_fail = { ...opts, steps: kids }; }
      else s[name] = kids;
    }
    return s;
  }

  skip();
  while (at < lines.length) {
    const l = lines[at];
    if (indentOf(l) !== 0) throw new LinesError("a Flow key starts at the left edge", at + 1);
    const n = at + 1;
    const m = /^([A-Za-z_][A-Za-z0-9_]*):(?: (.*))?$/.exec(l);
    if (!m) throw new LinesError("expected key: value, steps: or on_failure:", n);
    const key = m[1];
    if (BAD_KEYS.has(key)) throw new LinesError(`${key} is not allowed as a key`, n);
    if (key === "steps" || key === "on_failure") {
      if (m[2]) throw new LinesError(`${key}: is followed by indented steps`, n);
      if (Object.hasOwn(flow, key)) throw new LinesError(`${key} is given twice`, n);
      at++;
      flow[key] = steps(2, 0);
    } else {
      if (Object.hasOwn(flow, key)) throw new LinesError(`${key} is given twice`, n);
      if (m[2] === undefined) throw new LinesError(`${key} has no value`, n);
      const r = new Reader(m[2], n, budget);
      flow[key] = r.value();
      if (!r.eol()) r.fail("nothing may follow the value");
      at++;
    }
    skip();
  }
  if (!Array.isArray(flow.steps)) flow.steps = [];
  return flow;
}
