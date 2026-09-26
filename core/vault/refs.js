// @ts-check
// refs: `vault://item/field` references, the templates that hold them, and dotenv files.
//
// These are how a config file points at a secret without holding it: `vyre vault read`,
// `inject` and `run --env-file` all start from a reference. A template marks one as
// `{{ vault://item/field }}` (spaces inside the braces are optional) and `\{{` is a literal
// `{{`, so a template can still contain other templating languages. Nothing here opens a value;
// the tools do that, after presence, for exactly the refs found here.

const REF = /^vault:\/\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/([A-Za-z0-9_.-]{1,64}))?$/;

/**
 * `vault://item/field` to `{ name, field }`; the field is optional (the kind's default).
 * @param {string} ref @returns {{ ref: string, name: string, field?: string }}
 */
export function parseRef(ref) {
  const m = REF.exec(String(ref).trim());
  if (!m) throw new Error(`${JSON.stringify(String(ref).slice(0, 80))} is not a vault reference like vault://item/field`);
  return { ref: `vault://${m[1]}${m[2] ? "/" + m[2] : ""}`, name: m[1], ...(m[2] ? { field: m[2] } : {}) };
}

export const isRef = s => REF.test(String(s).trim());

/**
 * Split a template into literal text and references. `\{{` is an escaped `{{`; an unclosed or
 * malformed `{{ vault://` is an error rather than text, so a typo never ships a half-rendered file.
 * @param {string} text
 * @returns {({ text: string } | { ref: string, name: string, field?: string })[]}
 */
export function parseTemplate(text) {
  const s = String(text);
  /** @type {any[]} */
  const parts = [];
  let lit = "", i = 0;
  while (i < s.length) {
    if (s.startsWith("\\{{", i)) { lit += "{{"; i += 3; continue; }
    if (s.startsWith("{{", i)) {
      const end = s.indexOf("}}", i + 2);
      const inner = end < 0 ? null : s.slice(i + 2, end).trim();
      if (inner !== null && inner.startsWith("vault://")) {
        if (lit) { parts.push({ text: lit }); lit = ""; }
        parts.push(parseRef(inner));
        i = end + 2;
        continue;
      }
      if (inner === null && /^\{\{\s*vault:\/\//.test(s.slice(i))) throw new Error("a {{ vault://... reference is not closed with }}");
    }
    lit += s[i++];
  }
  if (lit) parts.push({ text: lit });
  return parts;
}

/** The distinct refs in a template, in order of first use. */
export function templateRefs(text) {
  const seen = new Set();
  return parseTemplate(text).filter(p => "ref" in p && !seen.has(p.ref) && seen.add(p.ref)).map(p => /** @type {any} */ (p).ref);
}

/**
 * Fill a template's references from `values` (ref to value).
 * @param {string} text @param {Record<string, string>} values
 */
export function render(text, values) {
  return parseTemplate(text).map(p => ("ref" in p ? (p.ref in values ? values[p.ref] : (() => { throw new Error(`no value for ${p.ref}`); })()) : p.text)).join("");
}

/**
 * A dotenv file: `KEY=value`, `export KEY=value`, single or double quotes, `#` comments. A
 * value that is exactly `vault://...` is a reference, and `{{ vault://... }}` inside a value is
 * rendered like a template. Returns each variable with the refs it needs.
 * @param {string} text
 * @returns {{ key: string, value: string, refs: string[] }[]}
 */
export function parseEnvFile(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (const [n, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) throw new Error(`line ${n + 1} of the env file is not KEY=value`);
    let v = m[2];
    if (/^"/.test(v)) {
      const close = v.lastIndexOf('"');
      if (close < 1) throw new Error(`line ${n + 1}: unclosed double quote`);
      v = v.slice(1, close).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (/^'/.test(v)) {
      const close = v.lastIndexOf("'");
      if (close < 1) throw new Error(`line ${n + 1}: unclosed single quote`);
      v = v.slice(1, close);
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
    }
    if (isRef(v)) out.push({ key: m[1], value: `{{ ${v.trim()} }}`, refs: [parseRef(v).ref] });
    else out.push({ key: m[1], value: v, refs: templateRefs(v) });
  }
  return out;
}
