// @ts-check
// The Expression language for conditions, filters and values inside a Flow (contract 5.2, "Expression"). No eval, no
// Function, no regular expressions: a hand-written tokenizer and a Pratt parser, an AST, and an evaluator that counts its
// own steps. A condition can read its scope and call a fixed list of pure functions; it cannot do anything else.
//
//   trigger.amount > 100 and lower(client.name) contains "harlow"
//   steps.research.rows[0].size in ["small", "medium"] or not (stage == "Closed")
//
// Operators, loosest to tightest: or, and, not, comparison (== != < <= > >= in contains), + -, * / %, unary -, member and call.

const LIMITS = Object.freeze({ source: 2000, depth: 24, nodes: 400, steps: 5000 });
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export class ExprError extends Error {
  /** @param {string} message @param {number} [at] */
  constructor(message, at) { super(message); this.name = "ExprError"; this.at = at; }
}

/** @typedef {{ t: 'num'|'str'|'id'|'op'|'end', v: any, at: number }} Tok */

/** @param {string} src @returns {Tok[]} */
function tokenize(src) {
  if (typeof src !== "string") throw new ExprError("an expression is a string");
  if (src.length > LIMITS.source) throw new ExprError(`an expression is at most ${LIMITS.source} characters`);
  const out = [];
  let i = 0;
  const OPS3 = ["=="], OPS2 = ["!=", "<=", ">=", "&&", "||"], OPS1 = "+-*/%<>()[].,!";
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
      if (src[j] === "." && src[j + 1] >= "0" && src[j + 1] <= "9") { j++; while (j < src.length && src[j] >= "0" && src[j] <= "9") j++; }
      out.push({ t: "num", v: Number(src.slice(i, j)), at: i }); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") {
          const n = src[j + 1];
          if (n === undefined) throw new ExprError("a string ends in a backslash", j);
          s += n === "n" ? "\n" : n === "t" ? "\t" : n; j += 2; continue;
        }
        s += src[j++];
      }
      if (j >= src.length) throw new ExprError("a string is not closed", i);
      out.push({ t: "str", v: s, at: i }); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j), at: i }); i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS3.includes(two) || OPS2.includes(two)) { out.push({ t: "op", v: two === "&&" ? "and" : two === "||" ? "or" : two, at: i }); i += 2; continue; }
    if (OPS1.includes(c)) { out.push({ t: "op", v: c, at: i }); i++; continue; }
    throw new ExprError(`unexpected character ${JSON.stringify(c)}`, i);
  }
  out.push({ t: "end", v: null, at: src.length });
  return out;
}

/**
 * @typedef {{ k: 'lit', v: any } | { k: 'id', name: string } | { k: 'member', obj: Node, name: string }
 *   | { k: 'index', obj: Node, idx: Node } | { k: 'call', fn: string, args: Node[] } | { k: 'un', op: string, a: Node }
 *   | { k: 'bin', op: string, a: Node, b: Node } | { k: 'list', items: Node[] }} Node
 */

/** @param {string} src @returns {Node} */
export function parse(src) {
  const toks = tokenize(src);
  let p = 0, nodes = 0;
  const peek = () => toks[p];
  const isOp = (/** @type {string} */ v) => toks[p].t === "op" && toks[p].v === v;
  const isWord = (/** @type {string} */ v) => toks[p].t === "id" && toks[p].v === v;
  const need = (/** @type {string} */ v) => { if (!isOp(v)) throw new ExprError(`expected ${JSON.stringify(v)}`, toks[p].at); p++; };
  const bump = (/** @type {number} */ depth) => { if (++nodes > LIMITS.nodes) throw new ExprError("the expression is too large"); if (depth > LIMITS.depth) throw new ExprError("the expression is nested too deeply"); };

  /** @param {number} d @returns {Node} */
  function or(d) { bump(d); let a = and(d + 1); while (isWord("or") || isOp("or")) { p++; a = { k: "bin", op: "or", a, b: and(d + 1) }; } return a; }
  /** @param {number} d @returns {Node} */
  function and(d) { bump(d); let a = not(d + 1); while (isWord("and") || isOp("and")) { p++; a = { k: "bin", op: "and", a, b: not(d + 1) }; } return a; }
  /** @param {number} d @returns {Node} */
  function not(d) { bump(d); if (isWord("not") || isOp("!")) { p++; return { k: "un", op: "not", a: not(d + 1) }; } return cmp(d + 1); }
  /** @param {number} d @returns {Node} */
  function cmp(d) {
    bump(d);
    let a = add(d + 1);
    for (;;) {
      const t = peek();
      const op = t.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v) ? t.v : t.t === "id" && (t.v === "in" || t.v === "contains") ? t.v : null;
      if (!op) return a;
      p++; a = { k: "bin", op, a, b: add(d + 1) };
    }
  }
  /** @param {number} d @returns {Node} */
  function add(d) { bump(d); let a = mul(d + 1); while (isOp("+") || isOp("-")) { const op = toks[p++].v; a = { k: "bin", op, a, b: mul(d + 1) }; } return a; }
  /** @param {number} d @returns {Node} */
  function mul(d) { bump(d); let a = unary(d + 1); while (isOp("*") || isOp("/") || isOp("%")) { const op = toks[p++].v; a = { k: "bin", op, a, b: unary(d + 1) }; } return a; }
  /** @param {number} d @returns {Node} */
  function unary(d) { bump(d); if (isOp("-")) { p++; return { k: "un", op: "neg", a: unary(d + 1) }; } return postfix(d + 1); }
  /** @param {number} d @returns {Node} */
  function postfix(d) {
    bump(d);
    let a = primary(d + 1);
    for (;;) {
      if (isOp(".")) {
        p++;
        const t = toks[p];
        if (t.t !== "id") throw new ExprError("a name must follow the dot", t.at);
        if (FORBIDDEN.has(t.v)) throw new ExprError(`${t.v} is not a name an expression may use`, t.at);
        p++; a = { k: "member", obj: a, name: t.v };
      } else if (isOp("[")) {
        p++; const idx = or(d + 1); need("]"); a = { k: "index", obj: a, idx };
      } else return a;
    }
  }
  /** @param {number} d @returns {Node} */
  function primary(d) {
    bump(d);
    const t = toks[p];
    if (t.t === "num" || t.t === "str") { p++; return { k: "lit", v: t.v }; }
    if (t.t === "id") {
      p++;
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (t.v === "null") return { k: "lit", v: null };
      if (isOp("(")) {
        p++;
        const args = [];
        if (!isOp(")")) { for (;;) { args.push(or(d + 1)); if (isOp(",")) { p++; continue; } break; } }
        need(")");
        if (!Object.hasOwn(FUNCTIONS, t.v)) throw new ExprError(`${t.v} is not a function an expression may call`, t.at);
        return { k: "call", fn: t.v, args };
      }
      if (FORBIDDEN.has(t.v)) throw new ExprError(`${t.v} is not a name an expression may use`, t.at);
      return { k: "id", name: t.v };
    }
    if (isOp("(")) { p++; const e = or(d + 1); need(")"); return e; }
    if (isOp("[")) {
      p++;
      const items = [];
      if (!isOp("]")) { for (;;) { items.push(or(d + 1)); if (isOp(",")) { p++; continue; } break; } }
      need("]");
      return { k: "list", items };
    }
    throw new ExprError(t.t === "end" ? "the expression ends too soon" : `unexpected ${JSON.stringify(t.v)}`, t.at);
  }

  const tree = or(0);
  if (toks[p].t !== "end") throw new ExprError(`unexpected ${JSON.stringify(toks[p].v)}`, toks[p].at);
  return tree;
}

const str = (/** @type {any} */ v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
/** The pure functions an expression may call. */
export const FUNCTIONS = Object.freeze({
  len: (/** @type {any} */ v) => (Array.isArray(v) || typeof v === "string" ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0),
  lower: (/** @type {any} */ v) => str(v).toLowerCase(),
  upper: (/** @type {any} */ v) => str(v).toUpperCase(),
  trim: (/** @type {any} */ v) => str(v).trim(),
  startsWith: (/** @type {any} */ a, /** @type {any} */ b) => str(a).startsWith(str(b)),
  endsWith: (/** @type {any} */ a, /** @type {any} */ b) => str(a).endsWith(str(b)),
  coalesce: (/** @type {any[]} */ ...a) => a.find(v => v !== null && v !== undefined) ?? null,
  round: (/** @type {any} */ v) => Math.round(Number(v)),
  floor: (/** @type {any} */ v) => Math.floor(Number(v)),
  min: (/** @type {any[]} */ ...a) => Math.min(...a.map(Number)),
  max: (/** @type {any[]} */ ...a) => Math.max(...a.map(Number)),
  number: (/** @type {any} */ v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null),
  text: str,
  isnull: (/** @type {any} */ v) => v === null || v === undefined,
  days: (/** @type {any} */ n) => Number(n) * 86_400_000,
  hours: (/** @type {any} */ n) => Number(n) * 3_600_000,
  minutes: (/** @type {any} */ n) => Number(n) * 60_000,
});

/** Identifiers an expression reads at its root (the names a scope must supply). @param {Node} n @returns {Set<string>} */
export function roots(n, out = new Set()) {
  switch (n.k) {
    case "id": out.add(n.name); break;
    case "member": roots(n.obj, out); break;
    case "index": roots(n.obj, out); roots(n.idx, out); break;
    case "call": n.args.forEach(a => roots(a, out)); break;
    case "un": roots(n.a, out); break;
    case "bin": roots(n.a, out); roots(n.b, out); break;
    case "list": n.items.forEach(a => roots(a, out)); break;
    default: break;
  }
  return out;
}

/** Every `steps.<id>` an expression refers to. @param {Node} n @returns {Set<string>} */
export function stepRefs(n, out = new Set()) {
  if (n.k === "member" && n.obj.k === "id" && n.obj.name === "steps") out.add(n.name);
  switch (n.k) {
    case "member": stepRefs(n.obj, out); break;
    case "index": stepRefs(n.obj, out); stepRefs(n.idx, out); break;
    case "call": n.args.forEach(a => stepRefs(a, out)); break;
    case "un": stepRefs(n.a, out); break;
    case "bin": stepRefs(n.a, out); stepRefs(n.b, out); break;
    case "list": n.items.forEach(a => stepRefs(a, out)); break;
    default: break;
  }
  return out;
}

/**
 * Evaluate a parsed expression over a scope. Reads only own properties of plain objects and arrays; counts steps and refuses
 * a runaway. A missing name or field is null, never an exception, so a condition on an absent value is false rather than a crash.
 * @param {Node} node @param {Record<string, any>} scope
 */
export function evaluate(node, scope) {
  let steps = 0;
  const own = (/** @type {any} */ o, /** @type {string} */ k) => (o !== null && typeof o === "object" && Object.hasOwn(o, k) ? o[k] : null);
  const num = (/** @type {any} */ v) => (typeof v === "number" ? v : v === null || v === undefined ? NaN : Number(v));
  /** @param {Node} n @returns {any} */
  function go(n) {
    if (++steps > LIMITS.steps) throw new ExprError("the expression took too many steps");
    switch (n.k) {
      case "lit": return n.v;
      case "id": return own(scope, n.name);
      case "member": return own(go(n.obj), n.name);
      case "index": {
        const o = go(n.obj), i = go(n.idx);
        if (Array.isArray(o)) return typeof i === "number" ? (o[i] ?? null) : null;
        return typeof i === "string" ? own(o, i) : null;
      }
      case "list": return n.items.map(go);
      case "call": return /** @type {any} */ (FUNCTIONS)[n.fn](...n.args.map(go));
      case "un": { const a = go(n.a); return n.op === "not" ? !truthy(a) : -num(a); }
      case "bin": {
        if (n.op === "and") { const a = go(n.a); return truthy(a) ? go(n.b) : a; }
        if (n.op === "or") { const a = go(n.a); return truthy(a) ? a : go(n.b); }
        const a = go(n.a), b = go(n.b);
        switch (n.op) {
          case "==": return same(a, b);
          case "!=": return !same(a, b);
          case "<": return ordered(a, b, (x, y) => x < y);
          case "<=": return ordered(a, b, (x, y) => x <= y);
          case ">": return ordered(a, b, (x, y) => x > y);
          case ">=": return ordered(a, b, (x, y) => x >= y);
          case "in": return Array.isArray(b) ? b.some(x => same(x, a)) : typeof b === "string" && typeof a === "string" ? b.includes(a) : false;
          case "contains": return Array.isArray(a) ? a.some(x => same(x, b)) : typeof a === "string" && typeof b === "string" ? a.includes(b) : false;
          case "+": return typeof a === "string" || typeof b === "string" ? str(a) + str(b) : num(a) + num(b);
          case "-": return num(a) - num(b);
          case "*": return num(a) * num(b);
          case "/": return num(b) === 0 ? null : num(a) / num(b);
          case "%": return num(b) === 0 ? null : num(a) % num(b);
          default: throw new ExprError(`unknown operator ${n.op}`);
        }
      }
      default: throw new ExprError("unknown expression node");
    }
  }
  return go(node);
}

/** @param {any} v */
export const truthy = v => v !== null && v !== undefined && v !== false && v !== 0 && v !== "" && !(Array.isArray(v) && v.length === 0);
/** @param {any} a @param {any} b */
function same(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}
/** @param {any} a @param {any} b @param {(x: any, y: any) => boolean} f */
function ordered(a, b, f) {
  if (typeof a === "number" && typeof b === "number") return f(a, b);
  if (typeof a === "string" && typeof b === "string") return f(a, b);
  return false;
}

/** Parse and evaluate in one go. @param {string} src @param {Record<string, any>} scope */
export const run = (src, scope) => evaluate(parse(src), scope);
