// @ts-check
// scrub: take known secret values out of text. The ONE implementation (consolidation inventory item 2); every module that holds a value it must not show calls this and none writes its own.
//
// A value is replaced wherever it appears and in the forms it is commonly seen in: base64 (padded and not), base64url, URL-encoded (with %20 and with +), and, since a PEM key or a value with a quote
// is escaped inside JSON, its JSON-escaped text. `wide` adds the forms a build log or a copied value takes (lower and upper case, letters-and-digits only, hex, lower-case URL escapes). A value shorter
// than `min` characters is left alone: scrubbing it would shred ordinary text. lib/ is importable by every module, so a module no longer copies this to avoid importing another module's file.
//
// What is NOT here: recognising a credential by its SHAPE when nothing knows the value (lib/credential-shapes.js).

/** What replaces a known value unless the caller names its own marker. */
export const CONCEALED = "<concealed by vyre>";

/** Lowercase, compatibility-normalised (full-width digits to ASCII), letters and digits only. @param {string} s */
export const compact = s => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The texts one value can appear as.
 * @param {string} value @param {{ wide?: boolean, min?: number }} [o] @returns {string[]}
 */
export function valueForms(value, { wide = false, min = 4 } = {}) {
  const buf = Buffer.from(value, "utf8");
  const b64 = buf.toString("base64");
  const uri = encodeURIComponent(value);
  const forms = new Set([value, b64, b64.replace(/=+$/, ""), buf.toString("base64url"), uri, uri.replace(/%20/g, "+"), JSON.stringify(value).slice(1, -1)]);
  if (wide) for (const f of [value.toLowerCase(), value.toUpperCase(), compact(value), buf.toString("hex"), buf.toString("hex").toUpperCase(), uri.toLowerCase()]) forms.add(f);
  return [...forms].filter(f => f.length >= min);
}

/**
 * Replace every occurrence of each value, and of its common forms, with a marker. Longest forms first, so a value inside a longer form is not cut in half.
 * @param {unknown} text @param {Iterable<unknown>} [values] @param {{ marker?: string, min?: number, wide?: boolean }} [o]
 */
export function scrub(text, values, { marker = CONCEALED, min = 4, wide = false } = {}) {
  let out = String(text ?? "");
  const forms = new Set();
  for (const v of values || []) {
    if (typeof v !== "string" || v.length < min) continue;
    for (const f of valueForms(v, { wide, min })) forms.add(f);
  }
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join(marker);
  return out;
}

/**
 * Scrub every string inside a JSON-able value, keys included. It walks the value rather than scrubbing its JSON text, so a value with a newline or a quote (a PEM key) still matches; an Error keeps
 * its name and loses the value from its message.
 * @template T @param {T} v @param {Iterable<unknown>} [values] @param {{ marker?: string, min?: number, wide?: boolean }} [o] @returns {T}
 */
export function scrubAll(v, values, o) {
  const list = [...(values || [])];
  /** @param {any} x @returns {any} */
  const walk = x => {
    if (typeof x === "string") return scrub(x, list, o);
    if (Array.isArray(x)) return x.map(walk);
    if (x instanceof Error) return Object.assign(new Error(scrub(x.message, list, o)), { name: x.name });
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, val]) => [scrub(k, list, o), walk(val)]));
    return x;
  };
  return walk(v);
}
