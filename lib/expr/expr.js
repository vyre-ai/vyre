// @ts-check
// The Expression language: one small, safe language for rules, stage conditions, computed fields
// and filters. Parsed and evaluated here; never handed to eval. Limits on length, depth and nodes.
//
//   stage < "Drafting" or engagement_signed == true
//   len(client.name) > 0 and fee >= 0
//
// Values: strings, numbers, true, false, null. Names are dot paths into the record. Operators:
// or, and, not, ==, !=, <, <=, >, >=, in, +, -, *, /, parentheses. Functions: len, lower, upper, empty, round,
// days_since (whole days from a date or datetime to now, null when there is none; computed fields only: `ctx.now` is the caller's clock).

import { LanguageError } from "./errors.js";

const LIMITS = { maxLength: 2000, maxDepth: 24, maxNodes: 400 };
const FUNCS = new Set(["len", "lower", "upper", "empty", "days_since", "round"]);

/** @typedef {{ t: string, v?: any, i: number }} Tok */
/** @typedef {{ n: "lit", v: any } | { n: "path", p: string[] } | { n: "un", op: string, a: Node } | { n: "bin", op: string, a: Node, b: Node } | { n: "call", f: string, a: Node[] } | { n: "list", v: Node[] }} Node */

/** @param {string} s @returns {Tok[]} */
function lex(s) {
  /** @type {Tok[]} */ const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++; const raw = s.slice(i, j); if (!/^\d+(\.\d+)?$/.test(raw)) throw new LanguageError("expr_syntax", `Bad number ${raw}`); out.push({ t: "num", v: Number(raw), i }); i = j; continue; }
    if (c === '"' || c === "'") { let j = i + 1; let v = ""; while (j < s.length && s[j] !== c) { if (s[j] === "\\") { j++; } v += s[j]; j++; } if (j >= s.length) throw new LanguageError("expr_syntax", "A string in the expression is never closed"); out.push({ t: "str", v, i }); i = j + 1; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++; out.push({ t: "id", v: s.slice(i, j), i }); i = j; continue; }
    const two = s.slice(i, i + 2);
    if (["==", "!=", "<=", ">="].includes(two)) { out.push({ t: "op", v: two, i }); i += 2; continue; }
    if ("<>+-*/(),.[]".includes(c)) { out.push({ t: "op", v: c, i }); i++; continue; }
    throw new LanguageError("expr_syntax", `Unexpected character ${JSON.stringify(c)} in the expression`);
  }
  return out;
}

/**
 * Parse an expression string into a tree. Throws LanguageError.
 * @param {string} src
 * @returns {Node}
 */
export function parseExpr(src) {
  if (typeof src !== "string" || !src.trim()) throw new LanguageError("expr_syntax", "An expression cannot be empty");
  if (src.length > LIMITS.maxLength) throw new LanguageError("expr_limit", `An expression is limited to ${LIMITS.maxLength} characters`);
  const toks = lex(src);
  let p = 0, depth = 0, nodes = 0;
  const peek = () => toks[p];
  const isOp = (/** @type {string} */ v) => peek()?.t === "op" && peek().v === v;
  const isKw = (/** @type {string} */ v) => peek()?.t === "id" && peek().v === v;
  const bump = () => { if (++nodes > LIMITS.maxNodes) throw new LanguageError("expr_limit", "The expression is too large"); };
  /** @returns {any} */ function orE() { /** @type {any} */ let a = andE(); while (isKw("or")) { p++; bump(); a = { n: "bin", op: "or", a, b: andE() }; } return a; }
  /** @returns {any} */ function andE() { /** @type {any} */ let a = notE(); while (isKw("and")) { p++; bump(); a = { n: "bin", op: "and", a, b: notE() }; } return a; }
  /** @returns {any} */ function notE() { if (isKw("not")) { p++; bump(); return { n: "un", op: "not", a: notE() }; } return cmp(); }
  /** @returns {any} */ function cmp() {
    /** @type {any} */ let a = add();
    for (;;) {
      const t = peek();
      if (t?.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) { p++; bump(); a = { n: "bin", op: t.v, a, b: add() }; }
      else if (isKw("in")) { p++; bump(); a = { n: "bin", op: "in", a, b: add() }; }
      else return a;
    }
  }
  /** @returns {any} */ function add() { /** @type {any} */ let a = mul(); while (isOp("+") || isOp("-")) { const op = toks[p++].v; bump(); a = { n: "bin", op, a, b: mul() }; } return a; }
  /** @returns {any} */ function mul() { /** @type {any} */ let a = atom(); while (isOp("*") || isOp("/")) { const op = toks[p++].v; bump(); a = { n: "bin", op, a, b: atom() }; } return a; }
  /** @returns {any} */ function atom() {
    const t = toks[p++]; bump();
    if (!t) throw new LanguageError("expr_syntax", "The expression ends too early");
    if (++depth > LIMITS.maxDepth) throw new LanguageError("expr_limit", "The expression is nested too deeply");
    try {
      if (t.t === "num" || t.t === "str") return { n: "lit", v: t.v };
      if (t.t === "op" && t.v === "-") return { n: "un", op: "neg", a: atom() };
      if (t.t === "op" && t.v === "(") { /** @type {any} */ const e = orE(); if (!isOp(")")) throw new LanguageError("expr_syntax", 'Expected ")" in the expression'); p++; return e; }
      if (t.t === "op" && t.v === "[") { /** @type {Node[]} */ const items = []; while (!isOp("]")) { items.push(orE()); if (isOp(",")) p++; else break; } if (!isOp("]")) throw new LanguageError("expr_syntax", 'Expected "]" in the expression'); p++; return { n: "list", v: items }; }
      if (t.t === "id") {
        if (t.v === "true") return { n: "lit", v: true };
        if (t.v === "false") return { n: "lit", v: false };
        if (t.v === "null") return { n: "lit", v: null };
        if (["and", "or", "not", "in"].includes(t.v)) throw new LanguageError("expr_syntax", `Unexpected "${t.v}" in the expression`);
        if (isOp("(")) {
          if (!FUNCS.has(t.v)) throw new LanguageError("expr_syntax", `Unknown function ${t.v}; the language has ${[...FUNCS].join(", ")}`);
          p++; /** @type {Node[]} */ const args = []; while (!isOp(")")) { args.push(orE()); if (isOp(",")) p++; else break; }
          if (!isOp(")")) throw new LanguageError("expr_syntax", 'Expected ")" after the arguments'); p++;
          return { n: "call", f: t.v, a: args };
        }
        const path = [t.v];
        while (isOp(".")) { p++; const m = toks[p++]; if (!m || m.t !== "id") throw new LanguageError("expr_syntax", "Expected a name after the dot"); path.push(m.v); }
        if (path.some((s) => s === "__proto__" || s === "constructor" || s === "prototype")) throw new LanguageError("expr_syntax", "That name is not allowed");
        return { n: "path", p: path };
      }
      throw new LanguageError("expr_syntax", `Unexpected ${JSON.stringify(t.v ?? t.t)} in the expression`);
    } finally { depth--; }
  }
  const tree = orE();
  if (p < toks.length) throw new LanguageError("expr_syntax", `Unexpected ${JSON.stringify(toks[p].v)} in the expression`);
  return tree;
}

/** Names an expression reads (the first segment of every path). @param {Node} n @returns {Set<string>} */
export function exprNames(n, acc = new Set()) {
  if (n.n === "path") acc.add(n.p[0]);
  else if (n.n === "un") exprNames(n.a, acc);
  else if (n.n === "bin") { exprNames(n.a, acc); exprNames(n.b, acc); }
  else if (n.n === "call") n.a.forEach((x) => exprNames(x, acc));
  else if (n.n === "list") n.v.forEach((x) => exprNames(x, acc));
  return acc;
}

/**
 * Evaluate. `ctx.values` is the record's fields; `ctx.stageOrder` maps a stage field name to its
 * ordered stage names so that stage < "Drafting" compares by position.
 * @param {Node} n
 * @param {{ values: Record<string, any>, stageOrder?: Record<string, string[]>, now?: number }} ctx
 * @returns {any}
 */
export function evalExpr(n, ctx) {
  switch (n.n) {
    case "lit": return n.v;
    case "list": return n.v.map((x) => evalExpr(x, ctx));
    case "path": { let v = ctx.values; for (const k of n.p) { if (v == null || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(v, k)) return null; v = v[k]; } return v; }
    case "un": { const a = evalExpr(n.a, ctx); return n.op === "not" ? !truthy(a) : -Number(a); }
    case "call": {
      const a = n.a.map((x) => evalExpr(x, ctx));
      if (n.f === "len") return a[0] == null ? 0 : (typeof a[0] === "string" || Array.isArray(a[0]) ? a[0].length : 0);
      if (n.f === "lower") return String(a[0] ?? "").toLowerCase();
      if (n.f === "upper") return String(a[0] ?? "").toUpperCase();
      if (n.f === "round") return a[0] == null || Number.isNaN(Number(a[0])) ? null : Math.round(Number(a[0]) * 10 ** Number(a[1] ?? 0)) / 10 ** Number(a[1] ?? 0);
      if (n.f === "days_since") { const t = typeof a[0] === "number" ? a[0] : Date.parse(String(a[0] ?? "")); return !Number.isFinite(t) || ctx.now === undefined ? null : Math.floor((ctx.now - t) / 86_400_000); }
      return a[0] == null || a[0] === "" || (Array.isArray(a[0]) && a[0].length === 0);
    }
    case "bin": {
      if (n.op === "and") return truthy(evalExpr(n.a, ctx)) && truthy(evalExpr(n.b, ctx));
      if (n.op === "or") return truthy(evalExpr(n.a, ctx)) || truthy(evalExpr(n.b, ctx));
      const a = evalExpr(n.a, ctx), b = evalExpr(n.b, ctx);
      if (n.op === "in") return Array.isArray(b) ? b.includes(a) : typeof b === "string" && typeof a === "string" ? b.includes(a) : false;
      if (n.op === "+") return typeof a === "string" || typeof b === "string" ? String(a ?? "") + String(b ?? "") : Number(a) + Number(b);
      if (n.op === "-") return Number(a) - Number(b);
      if (n.op === "*") return Number(a) * Number(b);
      if (n.op === "/") return Number(b) === 0 ? null : Number(a) / Number(b);
      if (n.op === "==") return a === b;
      if (n.op === "!=") return a !== b;
      let x = a, y = b;
      if (n.a.n === "path" && n.a.p.length === 1 && ctx.stageOrder?.[n.a.p[0]] && typeof b === "string") { const order = ctx.stageOrder[n.a.p[0]]; x = order.indexOf(a); y = order.indexOf(b); if (x < 0 || y < 0) return false; }
      else if (a == null || b == null) return false;
      return n.op === "<" ? x < y : n.op === "<=" ? x <= y : n.op === ">" ? x > y : x >= y;
    }
  }
}
const truthy = (/** @type {any} */ v) => v !== false && v != null && v !== 0 && v !== "";
