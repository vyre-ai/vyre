// @ts-nocheck (the app does not type-check this copy of kernel/flows/expr.js; the kernel does)
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
// ---- Times: reading a time in a zone, moving it by a signed amount, and printing it. No imports (the app keeps a byte-for-byte copy of this file); lib/time does the same sums for the rest of Vyre. ----
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** @param {any} v @returns {number | null} a time in milliseconds: a number, a number in a string, or a date text; null when it is none of those */
function toTime(v) {
  const ms = typeof v === "number" ? v : typeof v === "string" && v.trim() ? (/^-?\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) : Date.parse(v)) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : null;
}
/** @param {any} zone */
const zoneOf = zone => { const z = typeof zone === "string" && zone ? zone : "UTC"; try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return z; } catch { return "UTC"; } };
/** The wall clock in a zone at an instant. @param {number} ms @param {string} tz */
function wall(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(Math.floor(ms / 1000) * 1000)).map(x => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}
/** The zone's offset from UTC at an instant, in ms. @param {number} ms @param {string} tz */
const offsetAt = (ms, tz) => { const w = wall(ms, tz); return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000; };
/** The instant a wall clock shows in a zone. A time that happens twice (clocks go back) is the first; one the clocks skip (they go forward) is moved on by the gap. */
function instant(w, tz) {
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  const before = offsetAt(asUtc - 86_400_000, tz), after = offsetAt(asUtc + 86_400_000, tz);
  const fits = [before, after].map(o => asUtc - o).filter(t => offsetAt(t, tz) === asUtc - t);
  return fits.length ? Math.min(...fits) : asUtc - before;
}
/** Move a time by a signed amount of minutes, hours, days, weeks or months. Minutes and hours are exact; days, weeks and months keep the wall clock in the zone (a daylight saving change does not move "9:00 am"), and a month end stays inside the month (31 Jan plus 1 month is 28 or 29 Feb). @param {number} ms @param {number} amount @param {string} unit @param {string} tz @returns {number | null} */
function moved(ms, amount, unit, tz) {
  const u = String(unit).toLowerCase().replace(/s$/, "");
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) return null;
  if (u === "minute") return ms + amount * 60_000;
  if (u === "hour") return ms + amount * 3_600_000;
  const w = wall(ms, tz);
  if (u === "day" || u === "week") { const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + amount * (u === "week" ? 7 : 1))); return instant({ ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }, tz); }
  if (u === "month") {
    const idx = w.y * 12 + (w.mo - 1) + amount, y = Math.floor(idx / 12), mo = (idx % 12 + 12) % 12 + 1;
    return instant({ ...w, y, mo, d: Math.min(w.d, new Date(Date.UTC(y, mo, 0)).getUTCDate()) }, tz);
  }
  return null;
}
const two = (/** @type {number} */ n) => String(n).padStart(2, "0");
/**
 * A time printed in a zone, optionally after moving it. Named formats: date "14 Oct 2026", time "2:00 pm", datetime "14 Oct 2026, 2:00 pm", weekday "Wed 14 Oct", weekdaytime "Wed 14 Oct, 2:00 pm", iso "2026-10-14T14:00:00-07:00".
 * Something that is not a time comes back as its own text (a missing value as empty) so nothing is lost. An unknown zone reads as UTC and an unknown format as datetime.
 * @param {any} v @param {any} zone @param {any} format @param {any} [amount] @param {any} [unit]
 */
function show(v, zone, format, amount, unit) {
  if (v === null || v === undefined || v === "") return "";
  let ms = toTime(v);
  if (ms === null) return str(v);
  const tz = zoneOf(zone);
  if (amount !== undefined && amount !== null) { const m = moved(ms, Number(amount), unit, tz); if (m === null) return str(v); ms = m; }
  const w = wall(ms, tz), dow = DAYS[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()];
  const date = `${w.d} ${MONTHS[w.mo - 1]} ${w.y}`, short = `${dow} ${w.d} ${MONTHS[w.mo - 1]}`, time = `${w.h % 12 || 12}:${two(w.mi)} ${w.h < 12 ? "am" : "pm"}`;
  switch (format) {
    case "date": return date;
    case "time": return time;
    case "weekday": return short;
    case "weekdaytime": return `${short}, ${time}`;
    case "iso": { const o = Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000) / 60_000); return `${w.y}-${two(w.mo)}-${two(w.d)}T${two(w.h)}:${two(w.mi)}:${two(w.s)}${o === 0 ? "Z" : `${o < 0 ? "-" : "+"}${two(Math.floor(Math.abs(o) / 60))}:${two(Math.abs(o) % 60)}`}`; }
    default: return `${date}, ${time}`;
  }
}

/** The main item of a list field (an emails or phones field): the one marked primary, else the first. A text inside a record-like item is read from email, address, number, phone or value. Not a list: the value itself. @param {any} v */
function first(v) {
  const list = Array.isArray(v) ? v : [v];
  const x = list.find(e => e && typeof e === "object" && e.primary === true) ?? list[0];
  if (x && typeof x === "object") { for (const k of ["email", "address", "number", "phone", "value"]) if (typeof x[k] === "string") return x[k]; return null; }
  return x ?? null;
}

export const FUNCTIONS = Object.freeze({
  first,
  date: (/** @type {any} */ v, /** @type {any} */ zone) => show(v, zone, "weekday"),
  datetime: (/** @type {any} */ v, /** @type {any} */ zone) => show(v, zone, "weekdaytime"),
  addtime: (/** @type {any} */ v, /** @type {any} */ amount, /** @type {any} */ unit, /** @type {any} */ zone) => { const ms = toTime(v); return ms === null ? null : moved(ms, Number(amount), unit, zoneOf(zone)); },
  format: (/** @type {any} */ v, /** @type {any} */ format, /** @type {any} */ zone, /** @type {any} */ amount, /** @type {any} */ unit) => show(v, zone, format, amount, unit),
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
