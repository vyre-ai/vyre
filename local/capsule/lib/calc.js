// @ts-check
// calc: the Capsule answers "12 * 3.5" and "5 km in miles" itself, offline, as you type.
//
// It runs on every keystroke, so it is pure, small and has no dependencies. There is no eval and
// no Function: a recursive-descent parser reads a closed grammar, so nothing typed into the bar
// can run as code. The one rule that shapes everything else: a false positive is worse than a
// miss. `null` lets the query fall through to apps, files and the assistant, so anything that is
// not clearly math or a conversion (a word, a lone number, a version, a date, a phone number)
// returns null.
//
// Percent: `x%` is x/100, except as the right operand of + or -, where it is a share of the left
// side, the way Spotlight reads it: "200 + 10%" is 220, "50 - 20%" is 40. "15% of 80" is 12.
// `mod` is the JS remainder (sign follows the left side).
// Trig takes radians. `log` is base 10, `ln` is natural.
// Conversions need a target: "5 km in mi". A bare "5 km" returns null, because "5 m" could as
// easily be the start of a file name. No currency: it would need the network.
// Labels on conversions round to 4 significant digits (never dropping whole units); `copy`
// always carries 10.

/**
 * @typedef {{ kind: "calc", id: string, label: string, sub: string, value: number, copy: string }} CalcResult
 * @typedef {{ t: "num", v: number, raw: string } | { t: "id", v: string } | { t: "op", v: string }} Token
 * @typedef {{ dim: string, f: number, o: number, sym: string, name: string, plural?: string }} Unit
 */

const MAX_INPUT = 200;

// ---------------------------------------------------------------------------------------------
// Formatting

/** @param {string} int */
function group(int) {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A number as a person reads it. Null for anything not finite.
 * @param {number} x @param {number} sig @param {boolean} grouped
 */
function format(x, sig, grouped) {
  if (!Number.isFinite(x)) return null;
  let n = Number(x.toPrecision(sig));
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-6) {
    const [m, e] = n.toExponential(sig - 1).split("e");
    const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
    return `${mant}e${e.replace("+", "")}`;
  }
  const s = String(n);
  const neg = s.startsWith("-");
  const [int, frac] = (neg ? s.slice(1) : s).split(".");
  return (neg ? "-" : "") + (grouped ? group(int) : int) + (frac ? "." + frac : "");
}

/** Significant digits for a conversion label: 4, but never fewer than the whole units. */
function labelSig(x) {
  const abs = Math.abs(x);
  if (abs < 1000) return 4;
  return Math.min(15, Math.floor(Math.log10(abs)) + 1);
}

// ---------------------------------------------------------------------------------------------
// Arithmetic

/** sin(pi) is 1.2e-16 in floating point; a person expects 0. Only trig results are snapped. */
function snap(x) { return Math.abs(x) < 1e-12 ? 0 : x; }

const FUNCS = /** @type {Record<string, (x: number) => number>} */ ({
  sqrt: Math.sqrt, sin: (x) => snap(Math.sin(x)), cos: (x) => snap(Math.cos(x)), tan: (x) => snap(Math.tan(x)),
  log: Math.log10, ln: Math.log,
  abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
});
const CONSTS = /** @type {Record<string, number>} */ ({ pi: Math.PI, e: Math.E });
const WORD_OPS = new Set(["mod", "of", "x"]);
const NUM = /^(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/;

/**
 * @param {string} s lowercased, operators already normalized
 * @returns {Token[] | null}
 */
function tokenize(s) {
  /** @type {Token[]} */
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " ") { i++; continue; }
    if ((c >= "0" && c <= "9") || c === ".") {
      const m = NUM.exec(s.slice(i));
      if (!m) return null;
      out.push({ t: "num", v: Number(m[0].replace(/,/g, "")), raw: m[0] });
      i += m[0].length;
      continue;
    }
    if (c >= "a" && c <= "z") {
      let j = i;
      while (j < s.length && s[j] >= "a" && s[j] <= "z") j++;
      const w = s.slice(i, j);
      if (!(w in FUNCS) && !(w in CONSTS) && !WORD_OPS.has(w)) return null;
      out.push({ t: "id", v: w });
      i = j;
      continue;
    }
    if ("+-*/^()%".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    return null;
  }
  return out;
}

class Fail extends Error {}

/**
 * Recursive descent over the tokens. Each rule returns { v, pct } where pct marks a bare `n%`,
 * so + and - can read it as a share of the left side.
 * @param {Token[]} toks
 */
function parse(toks) {
  let p = 0;
  let ops = 0;
  const peek = () => toks[p];
  /** @param {string} v */
  const isOp = (v) => { const t = toks[p]; return !!t && (t.t === "op" || t.t === "id") && t.v === v; };
  /** @param {number} v */
  const ok = (v) => { if (!Number.isFinite(v)) throw new Fail(); return v; };

  /** @returns {{ v: number, pct: boolean }} */
  function expr() {
    let left = term();
    while (isOp("+") || isOp("-")) {
      const op = toks[p++].v;
      const right = term();
      ops++;
      const r = right.pct && !left.pct ? left.v * right.v : right.v;
      left = { v: ok(op === "+" ? left.v + r : left.v - r), pct: false };
    }
    return left;
  }

  function term() {
    let left = unary();
    for (;;) {
      if (isOp("*") || isOp("x")) { p++; ops++; left = { v: ok(left.v * unary().v), pct: false }; }
      else if (isOp("/")) {
        p++; ops++;
        const d = unary().v;
        if (d === 0) throw new Fail();
        left = { v: ok(left.v / d), pct: false };
      } else if (isOp("mod")) {
        p++; ops++;
        const d = unary().v;
        if (d === 0) throw new Fail();
        left = { v: ok(left.v % d), pct: false };
      } else if (isOp("of")) {
        if (!left.pct) throw new Fail();
        p++; ops++;
        left = { v: ok(left.v * unary().v), pct: false };
      } else return left;
    }
  }

  /** @returns {{ v: number, pct: boolean }} */
  function unary() {
    if (isOp("-")) { p++; const u = unary(); return { v: -u.v, pct: u.pct }; }
    return power();
  }

  function power() {
    const base = postfix();
    if (isOp("^")) {
      p++; ops++;
      return { v: ok(Math.pow(base.v, unary().v)), pct: false };
    }
    return base;
  }

  function postfix() {
    const v = primary();
    if (isOp("%")) { p++; return { v: v / 100, pct: true }; }
    return { v, pct: false };
  }

  /** @returns {number} */
  function primary() {
    const t = peek();
    if (!t) throw new Fail();
    if (t.t === "num") { p++; return t.v; }
    if (t.t === "id" && t.v in CONSTS) { p++; return CONSTS[t.v]; }
    if (t.t === "id" && t.v in FUNCS) {
      p++; ops++;
      const arg = isOp("(") ? primary() : power().v;
      return ok(FUNCS[t.v](arg));
    }
    if (isOp("(")) {
      p++;
      const v = expr().v;
      if (!isOp(")")) throw new Fail();
      p++;
      return v;
    }
    throw new Fail();
  }

  const result = expr();
  if (p !== toks.length) throw new Fail();
  return { v: result.v, ops };
}

/**
 * How the expression was read, for the sub line: "12 × 3.5", "-(2 + 3) × π", "sqrt(16)".
 * @param {Token[]} toks
 */
function describe(toks) {
  let out = "";
  /** @type {Token | null} */
  let prev = null;
  let prevUnary = false;
  for (const t of toks) {
    const unaryMinus = t.t === "op" && t.v === "-" && (!prev ||
      (prev.t === "op" && prev.v !== ")" && prev.v !== "%") ||
      (prev.t === "id" && (WORD_OPS.has(prev.v) || prev.v in FUNCS)));
    const s = t.t === "num" ? t.raw
      : t.t === "id" ? (t.v === "pi" ? "π" : t.v === "x" ? "×" : t.v)
      : t.v === "*" ? "×" : t.v === "/" ? "÷" : t.v;
    const glue = !prev
      || (t.t === "op" && (t.v === ")" || t.v === "%"))
      || (prev.t === "op" && prev.v === "(")
      || prevUnary
      || (t.t === "op" && t.v === "(" && prev.t === "id" && prev.v in FUNCS);
    out += (glue ? "" : " ") + s;
    prev = t;
    prevUnary = unaryMinus;
  }
  return out;
}

const DATE = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/;
const PHONE = [
  /^\+/, // international numbers; a leading + is never how arithmetic starts here
  /^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}$/,
  /^\d{3}[-.]\d{4}$/,
  /^\d{1,4}(?:-\d{2,4}){2,}$/,
];

/** @param {string} s @returns {CalcResult | null} */
function arithmetic(s) {
  if (DATE.test(s) || PHONE.some((r) => r.test(s))) return null;
  const toks = tokenize(s);
  if (!toks || !toks.length) return null;
  let out;
  try { out = parse(toks); } catch (e) { if (e instanceof Fail) return null; throw e; }
  if (out.ops === 0 || !Number.isFinite(out.v)) return null;
  const v = Object.is(out.v, -0) ? 0 : out.v;
  const label = format(v, 10, true);
  const copy = format(v, 10, false);
  if (label === null || copy === null) return null;
  return { kind: "calc", id: "calc:" + s, label, sub: describe(toks), value: Number(copy), copy };
}

// ---------------------------------------------------------------------------------------------
// Units

/** @type {Map<string, Unit>} */
const UNITS = new Map();

/**
 * @param {string} dim @param {number} f factor to the base unit @param {number} o offset to the base
 * @param {string} sym label symbol @param {string} name long plural name, for the sub line
 * @param {string[]} keys every spelling that means it (lowercase, no degree sign)
 * @param {string} [plural] label symbol when the value is not 1
 */
function unit(dim, f, o, sym, name, keys, plural) {
  const u = { dim, f, o, sym, name, plural };
  for (const k of keys) UNITS.set(k, u);
}

const FT = 0.3048, IN = 0.0254, MI = 1609.344, YD = 0.9144, LB = 0.45359237, GAL = 3.785411784;
// length (m)
unit("length", 1, 0, "m", "meters", ["m", "meter", "meters", "metre", "metres"]);
unit("length", 1000, 0, "km", "kilometers", ["km", "kms", "kilometer", "kilometers", "kilometre", "kilometres"]);
unit("length", 0.01, 0, "cm", "centimeters", ["cm", "centimeter", "centimeters", "centimetre", "centimetres"]);
unit("length", 0.001, 0, "mm", "millimeters", ["mm", "millimeter", "millimeters", "millimetre", "millimetres"]);
unit("length", MI, 0, "mi", "miles", ["mi", "mile", "miles"]);
unit("length", YD, 0, "yd", "yards", ["yd", "yds", "yard", "yards"]);
unit("length", FT, 0, "ft", "feet", ["ft", "foot", "feet", "'"]);
unit("length", IN, 0, "in", "inches", ["in", "inch", "inches", "\""]);
unit("length", 1852, 0, "nmi", "nautical miles", ["nmi", "nautical mile", "nautical miles"]);
// mass (kg)
unit("mass", 1, 0, "kg", "kilograms", ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"]);
unit("mass", 0.001, 0, "g", "grams", ["g", "gram", "grams", "gramme", "grammes"]);
unit("mass", 1e-6, 0, "mg", "milligrams", ["mg", "milligram", "milligrams"]);
unit("mass", LB, 0, "lb", "pounds", ["lb", "lbs", "pound", "pounds"]);
unit("mass", LB / 16, 0, "oz", "ounces", ["oz", "ounce", "ounces"]);
unit("mass", LB * 14, 0, "st", "stone", ["st", "stone", "stones"]);
unit("mass", 1000, 0, "t", "tonnes", ["t", "tonne", "tonnes", "metric ton", "metric tons"]);
unit("mass", LB * 2000, 0, "ton", "short tons", ["ton", "tons", "short ton", "short tons"], "tons");
// volume (L)
unit("volume", 1, 0, "L", "liters", ["l", "liter", "liters", "litre", "litres"]);
unit("volume", 0.001, 0, "mL", "milliliters", ["ml", "milliliter", "milliliters", "millilitre", "millilitres"]);
unit("volume", 1000, 0, "m³", "cubic meters", ["m3", "cu m", "cubic meter", "cubic meters", "cubic metre", "cubic metres"]);
unit("volume", GAL, 0, "gal", "gallons", ["gal", "gals", "gallon", "gallons"]);
unit("volume", GAL / 4, 0, "qt", "quarts", ["qt", "qts", "quart", "quarts"]);
unit("volume", GAL / 8, 0, "pt", "pints", ["pt", "pts", "pint", "pints"]);
unit("volume", GAL / 16, 0, "cup", "cups", ["cup", "cups"], "cups");
unit("volume", GAL / 128, 0, "fl oz", "fluid ounces", ["fl oz", "floz", "fluid ounce", "fluid ounces"]);
unit("volume", GAL / 256, 0, "tbsp", "tablespoons", ["tbsp", "tbs", "tablespoon", "tablespoons"]);
unit("volume", GAL / 768, 0, "tsp", "teaspoons", ["tsp", "teaspoon", "teaspoons"]);
// temperature (K), with offsets
unit("temperature", 1, 273.15, "°C", "Celsius", ["c", "celsius", "centigrade", "degc"]);
unit("temperature", 5 / 9, 273.15 - 32 * 5 / 9, "°F", "Fahrenheit", ["f", "fahrenheit", "degf"]);
unit("temperature", 1, 0, "K", "kelvin", ["k", "kelvin", "kelvins"]);
// time (s)
unit("time", 0.001, 0, "ms", "milliseconds", ["ms", "millisecond", "milliseconds"]);
unit("time", 1, 0, "s", "seconds", ["s", "sec", "secs", "second", "seconds"]);
unit("time", 60, 0, "min", "minutes", ["min", "mins", "minute", "minutes"]);
unit("time", 3600, 0, "h", "hours", ["h", "hr", "hrs", "hour", "hours"]);
unit("time", 86400, 0, "d", "days", ["d", "day", "days"]);
unit("time", 604800, 0, "wk", "weeks", ["wk", "wks", "week", "weeks"]);
unit("time", 31557600 / 12, 0, "mo", "months", ["mo", "month", "months"]);
unit("time", 31557600, 0, "yr", "years", ["yr", "yrs", "year", "years"]);
// data (byte); "b" is a byte, bits are spelled out
unit("data", 1 / 8, 0, "bit", "bits", ["bit", "bits"], "bits");
unit("data", 1, 0, "B", "bytes", ["b", "byte", "bytes"]);
const DEC = [["kB", "kilobytes", "kb", "kilobyte"], ["MB", "megabytes", "mb", "megabyte"], ["GB", "gigabytes", "gb", "gigabyte"], ["TB", "terabytes", "tb", "terabyte"], ["PB", "petabytes", "pb", "petabyte"]];
DEC.forEach(([sym, name, k, long], i) => unit("data", 1000 ** (i + 1), 0, sym, name, [k, long, long + "s"]));
const BIN = [["KiB", "kibibytes", "kib", "kibibyte"], ["MiB", "mebibytes", "mib", "mebibyte"], ["GiB", "gibibytes", "gib", "gibibyte"], ["TiB", "tebibytes", "tib", "tebibyte"]];
BIN.forEach(([sym, name, k, long], i) => unit("data", 1024 ** (i + 1), 0, sym, name, [k, long, long + "s"]));
// speed (m/s)
unit("speed", 1, 0, "m/s", "meters per second", ["m/s", "mps", "meters per second", "metres per second"]);
unit("speed", 1000 / 3600, 0, "km/h", "kilometers per hour", ["km/h", "kmh", "kph", "kmph", "km/hr", "kilometers per hour", "kilometres per hour"]);
unit("speed", MI / 3600, 0, "mph", "miles per hour", ["mph", "mi/h", "miles per hour"]);
unit("speed", 1852 / 3600, 0, "kn", "knots", ["kn", "kt", "kts", "knot", "knots"]);
unit("speed", FT, 0, "ft/s", "feet per second", ["ft/s", "fps", "feet per second"]);
// area (m²)
unit("area", 1, 0, "m²", "square meters", ["m2", "sq m", "sqm", "sq meter", "sq meters", "sq metre", "sq metres"]);
unit("area", 1e6, 0, "km²", "square kilometers", ["km2", "sq km", "sq kilometer", "sq kilometers", "sq kilometre", "sq kilometres"]);
unit("area", 1e-4, 0, "cm²", "square centimeters", ["cm2", "sq cm", "sq centimeter", "sq centimeters"]);
unit("area", FT * FT, 0, "ft²", "square feet", ["ft2", "sq ft", "sqft", "sq foot", "sq feet"]);
unit("area", IN * IN, 0, "in²", "square inches", ["in2", "sq in", "sq inch", "sq inches"]);
unit("area", YD * YD, 0, "yd²", "square yards", ["yd2", "sq yd", "sq yard", "sq yards"]);
unit("area", MI * MI, 0, "mi²", "square miles", ["mi2", "sq mi", "sq mile", "sq miles"]);
unit("area", 4046.8564224, 0, "acre", "acres", ["acre", "acres", "ac"], "acres");
unit("area", 10000, 0, "ha", "hectares", ["ha", "hectare", "hectares"]);

/** @param {string} s @returns {Unit | undefined} */
function lookupUnit(s) {
  const k = s.replace(/°/g, "").replace(/²/g, "2").replace(/³/g, "3")
    .replace(/\b(?:degrees?|deg)\s+/g, "deg").replace(/\bsquare\s+/g, "sq ").replace(/\bsq\.\s*/g, "sq ")
    .replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").trim();
  return UNITS.get(k) || UNITS.get(k.replace(/^deg/, "")) || UNITS.get(k.replace(/ /g, ""));
}

const QTY = /^(-?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))\s*(.+)$/;
const CONNECTORS = new Set(["in", "to", "as", "=", "into"]);

/** @param {string} s @returns {CalcResult | null} */
function conversion(s) {
  const words = s.replace(/=/g, " = ").split(" ").filter(Boolean);
  for (let i = 1; i < words.length - 1; i++) {
    if (!CONNECTORS.has(words[i])) continue;
    const q = QTY.exec(words.slice(0, i).join(" "));
    if (!q) continue;
    const from = lookupUnit(q[2]);
    const to = lookupUnit(words.slice(i + 1).join(" "));
    if (!from || !to || from.dim !== to.dim) continue;
    const n = Number(q[1].replace(/,/g, ""));
    const base = n * from.f + from.o;
    if (from.dim === "temperature" && base < 0) return null;
    const v = (base - to.o) / to.f;
    if (!Number.isFinite(v)) return null;
    const out = Object.is(v, -0) || Math.abs(v) < 1e-12 ? 0 : v;
    const num = format(out, labelSig(out), true);
    const copy = format(out, 10, false);
    if (num === null || copy === null) return null;
    const sym = to.plural && Number(copy) !== 1 ? to.plural : to.sym;
    return {
      kind: "calc", id: "calc:" + s, label: `${num} ${sym}`,
      sub: `${format(n, 10, true)} ${from.plural && n !== 1 ? from.plural : from.sym} in ${to.name}`, value: Number(copy), copy,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------

/**
 * What the Capsule should show for this text, if it is math or a conversion.
 * @param {string} text
 * @returns {CalcResult | null}
 */
export function evaluate(text) {
  if (typeof text !== "string" || text.length > MAX_INPUT) return null;
  const s = text.toLowerCase()
    .replace(/[×✕]/g, "*").replace(/÷/g, "/").replace(/[\u2212\u2013]/g, "-").replace(/\*\*/g, "^").replace(/π/g, "pi")
    .replace(/\s+/g, " ").trim().replace(/\s*=$/, "");
  if (!s || !/[0-9]|pi|\be\b/.test(s)) return null;
  if (/[a-z]/.test(s) && / (?:in|to|as|into) |=/.test(s)) {
    const c = conversion(s);
    if (c) return c;
  }
  return arithmetic(s);
}
