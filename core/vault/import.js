// @ts-check
// vault/import: turn another password manager's export, or a .env file, into vault items.
//
// People leave a password manager only when leaving costs them nothing, so this reads the files
// they already have: .env, 1Password CSV, Bitwarden CSV and JSON, Chrome CSV and Safari CSV
// (ADR 0001, decision 10). vyred reads the file itself and hands the text here, so values never
// pass through Claude.
//
// Everything here is pure: text in, items out, no disk writes. Sealing and storing belong to
// the vault. Two rules follow from decision 4, where an item's name and description are
// listable and its field values are sealed:
//   - A name or description is built only from a title, a variable name, a host or a username,
//     never from a field value.
//   - `skipped` and `error` say what was dropped and why, in words a person can act on, and never
//     carry a value. JSON.parse's own message quotes the input, so it is not passed on.

import path from "node:path";

/** @typedef {"env"|"1password-csv"|"bitwarden-csv"|"bitwarden-json"|"chrome-csv"|"safari-csv"|"csv"} Format */
/**
 * @typedef {object} Item
 * @property {string} name
 * @property {"secret"|"login"|"note"|"card"} kind
 * @property {string} description
 * @property {Record<string,string>} fields
 * @property {string} [url]
 * @property {string[]} hosts
 * @property {string[]} [tags]
 */
/** @typedef {{ format: Format|null, items: Item[], skipped: string[], error?: string }} Result */

export const FORMATS = /** @type {const} */ (["env", "1password-csv", "bitwarden-csv", "bitwarden-json", "chrome-csv", "safari-csv", "csv"]);
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Parse an export into vault items.
 * @param {string} text
 * @param {{ format?: Format, filename?: string }} [opts]
 * @returns {Result}
 */
export function parse(text, { format, filename } = {}) {
  if (typeof text !== "string") return fail(format ?? null, "the file could not be read as text");
  if (format && !FORMATS.includes(format)) return fail(null, `unknown format "${String(format).slice(0, 40)}"; expected one of ${FORMATS.join(", ")}`);
  text = text.replace(/^﻿/, "");
  const fmt = format ?? detect(text, filename);
  if (!fmt) return fail(null, "could not tell what kind of export this is; pass a format (" + FORMATS.join(", ") + ")");
  try {
    if (fmt === "env") return parseEnv(text, filename);
    if (fmt === "bitwarden-json") return parseBitwardenJSON(text);
    return parseRows(text, fmt);
  } catch {
    // A parser bug must not surface a message built from the input.
    return fail(fmt, `the ${fmt} file could not be read`);
  }
}

/**
 * Split CSV text into rows of fields. Handles quoted fields holding commas, doubled quotes and
 * newlines, CRLF line ends and a UTF-8 BOM. Blank lines are dropped.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const end = () => { row.push(field); field = ""; };
  const endRow = () => {
    end();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { quoted = true; i++; continue; }
    if (c === ",") { end(); i++; continue; }
    if (c === "\r" && text[i + 1] === "\n") { endRow(); i += 2; continue; }
    if (c === "\n" || c === "\r") { endRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

/**
 * Split items into those to add and names already in the vault.
 * @param {Iterable<string>} existingNames
 * @param {Item[]} items
 * @returns {{ add: Item[], duplicate: string[] }}
 */
export function merge(existingNames, items) {
  const have = new Set(existingNames);
  /** @type {Item[]} */
  const add = [];
  /** @type {string[]} */
  const duplicate = [];
  for (const it of items) (have.has(it.name) ? duplicate.push(it.name) : add.push(it));
  return { add, duplicate };
}

// ---------------------------------------------------------------------------------------------
// Detection

/** @param {string} text @param {string} [filename] @returns {Format|null} */
function detect(text, filename) {
  const base = filename ? path.basename(filename) : "";
  if (/^\.env/i.test(base) || /\.env$/i.test(base)) return "env";
  const head = text.trimStart();
  if (head.startsWith("{")) {
    try {
      const j = JSON.parse(text);
      if (j && Array.isArray(j.items)) return "bitwarden-json";
      if (j && j.encrypted === true) return "bitwarden-json";
    } catch { /* not JSON */ }
    return null;
  }
  const firstLine = head.split(/\r?\n/, 1)[0] ?? "";
  if (/,/.test(firstLine)) {
    const rows = parseCSV(head.slice(0, 4096));
    const f = rows.length ? csvFormat(rows[0]) : null;
    if (f) return f;
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (lines.length && ENV_LINE.test(lines[0]) && lines.filter(l => ENV_LINE.test(l)).length * 2 >= lines.length) return "env";
  return null;
}

const ENV_LINE = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=/;

/** @param {string} h */
const norm = h => h.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/** @param {string[]} header @returns {Format|null} */
function csvFormat(header) {
  const h = new Set(header.map(norm));
  if (h.has("login password") || h.has("login uri") || h.has("login username")) return "bitwarden-csv";
  if (h.has("title") && (h.has("website") || h.has("archived") || h.has("favorite")) && h.has("password")) return "1password-csv";
  if (h.has("title") && h.has("url") && h.has("otpauth") && h.has("password")) return "safari-csv";
  if (h.has("name") && h.has("url") && h.has("password") && !h.has("title")) return "chrome-csv";
  const cols = columns(header);
  if (cols.password >= 0 || (cols.title >= 0 && (cols.username >= 0 || cols.url >= 0 || cols.notes >= 0))) return "csv";
  return null;
}

// ---------------------------------------------------------------------------------------------
// .env

/** @param {string} text @param {string} [filename] @returns {Result} */
function parseEnv(text, filename) {
  const description = `from ${filename ? path.basename(filename) : ".env"}`;
  /** @type {Map<string, Item>} */
  const found = new Map();
  /** @type {string[]} */
  const skipped = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^\s*(?:export\s+)?([^\s=#]+)\s*=\s*(.*)$/.exec(line);
    if (!m) { skipped.push(`line ${n + 1}: not NAME=value`); continue; }
    const name = m[1];
    let rest = m[2];
    let value;
    if (rest.startsWith('"')) {
      // Double quotes: escapes, and the value may run across lines until the closing quote.
      let out = "";
      let i = 1;
      let closed = false;
      let j = n;
      for (;;) {
        for (; i < rest.length; i++) {
          const c = rest[i];
          if (c === "\\" && i + 1 < rest.length) {
            const e = rest[++i];
            out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === '"' ? '"' : e === "\\" ? "\\" : "\\" + e;
          } else if (c === '"') { closed = true; break; }
          else out += c;
        }
        if (closed || j + 1 >= lines.length) break;
        out += "\n";
        rest = lines[++j];
        i = 0;
      }
      if (!closed) { skipped.push(`${safeName(name)}: no closing double quote`); continue; }
      n = j;
      value = out;
    } else if (rest.startsWith("'")) {
      const close = rest.indexOf("'", 1);
      if (close < 0) { skipped.push(`${safeName(name)}: no closing single quote`); continue; }
      value = rest.slice(1, close);
    } else {
      value = rest.replace(/\s+#.*$/, "").trim();
      if (value.startsWith("#")) value = "";
    }
    if (!NAME.test(name)) { skipped.push(`${safeName(name)}: not a usable item name`); continue; }
    if (value === "") { skipped.push(`${name}: empty value`); continue; }
    if (found.has(name)) { skipped.push(`${name}: set more than once, the last one is kept`); found.delete(name); }
    found.set(name, { name, kind: "secret", description, fields: { value }, hosts: [] });
  }
  return { format: "env", items: [...found.values()], skipped };
}

/** A variable name is safe to report, but only a bounded, printable one. @param {string} s */
const safeName = s => s.replace(/[^\x21-\x7e]/g, "?").slice(0, 64);

// ---------------------------------------------------------------------------------------------
// CSV exports

const ALIASES = {
  title: ["title", "name"],
  username: ["username", "login username", "user name", "email", "login", "user"],
  password: ["password", "login password"],
  url: ["url", "website", "login uri", "urls", "web site"],
  notes: ["notes", "note", "comments"],
  totp: ["otpauth", "totp", "login totp", "one time password"],
  tags: ["tags", "folder"],
  type: ["type"],
  fields: ["fields"],
};

/** @param {string[]} header @returns {Record<keyof typeof ALIASES, number>} */
function columns(header) {
  const h = header.map(norm);
  /** @type {any} */
  const out = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    out[key] = -1;
    for (const nm of names) { const i = h.indexOf(nm); if (i >= 0) { out[key] = i; break; } }
  }
  return out;
}

/** @param {string} text @param {Format} fmt @returns {Result} */
function parseRows(text, fmt) {
  const rows = parseCSV(text);
  if (!rows.length) return fail(fmt, "the file is empty");
  const cols = columns(rows[0]);
  if (cols.password < 0 && cols.title < 0 && cols.username < 0) return fail(fmt, "the header row has no title, username or password column");
  const names = new Names();
  /** @type {Item[]} */
  const items = [];
  /** @type {string[]} */
  const skipped = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (/** @type {keyof typeof ALIASES} */ k) => (cols[k] >= 0 ? (row[cols[k]] ?? "") : "").trim();
    const title = get("title");
    const label = title ? `row ${r + 1} (${short(title)})` : `row ${r + 1}`;
    const type = get("type").toLowerCase();
    const tags = get("tags").split(/[;,]/).map(s => s.trim()).filter(Boolean);
    const notes = cell(row, cols.notes);
    const url = firstURL(get("url"));
    const username = get("username");

    if (fmt === "bitwarden-csv" && type && type !== "login") {
      if (type === "note") {
        if (!notes) { skipped.push(`${label}: empty note`); continue; }
        items.push(item(names, { title, kind: "note", fields: { text: notes }, tags, fmt }));
      } else if (type === "card") {
        items.push(item(names, { title, kind: "card", fields: compact({ notes, ...custom(get("fields")) }), tags, fmt }));
      } else skipped.push(`${label}: ${short(type)} items are not imported`);
      continue;
    }

    const fields = compact({
      username,
      password: cell(row, cols.password),
      totp: get("totp"),
      notes,
      ...(fmt === "bitwarden-csv" ? custom(cell(row, cols.fields)) : {}),
    });
    if (!Object.keys(fields).length) { skipped.push(`${label}: nothing to import`); continue; }
    const kind = fields.password || fields.username || fields.totp || url ? "login" : "note";
    if (kind === "note") {
      items.push(item(names, { title, kind, fields: { text: notes }, tags, fmt }));
      continue;
    }
    items.push(item(names, { title, kind, fields, url, username, tags, fmt }));
  }
  return { format: fmt, items, skipped };
}

/** Keep a cell exactly as written except for line ends. @param {string[]} row @param {number} i */
const cell = (row, i) => (i >= 0 ? (row[i] ?? "").replace(/\r\n/g, "\n") : "");

/** Bitwarden's "fields" column: one "name: value" per line. @param {string} s */
function custom(s) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const line of s.split(/\r?\n/)) {
    const i = line.indexOf(": ");
    if (i <= 0) continue;
    const k = slug(line.slice(0, i));
    const v = line.slice(i + 2);
    if (k && v) out[`field-${k}`] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Bitwarden JSON

/** @param {string} text @returns {Result} */
function parseBitwardenJSON(text) {
  let j;
  try { j = JSON.parse(text); } catch { return fail("bitwarden-json", "the file is not valid JSON"); }
  if (j && j.encrypted === true) return fail("bitwarden-json", "this Bitwarden export is encrypted; export again as unencrypted JSON");
  if (!j || !Array.isArray(j.items)) return fail("bitwarden-json", "the JSON has no items list");
  /** @type {Map<string,string>} */
  const folders = new Map();
  for (const f of Array.isArray(j.folders) ? j.folders : []) if (f && f.id && typeof f.name === "string") folders.set(f.id, f.name);
  const names = new Names();
  /** @type {Item[]} */
  const items = [];
  /** @type {string[]} */
  const skipped = [];
  j.items.forEach((/** @type {any} */ it, /** @type {number} */ idx) => {
    if (!it || typeof it !== "object") { skipped.push(`item ${idx + 1}: not an object`); return; }
    const title = str(it.name).trim();
    const label = title ? `item ${idx + 1} (${short(title)})` : `item ${idx + 1}`;
    const tags = it.folderId && folders.has(it.folderId) ? [folders.get(it.folderId) ?? ""] : [];
    const notes = str(it.notes);
    /** @type {Record<string,string>} */
    const extra = {};
    for (const f of Array.isArray(it.fields) ? it.fields : []) {
      const k = slug(str(f?.name));
      const v = str(f?.value);
      if (k && v) extra[`field-${k}`] = v;
    }
    if (it.type === 1 || it.login) {
      const login = it.login ?? {};
      const uris = Array.isArray(login.uris) ? login.uris.map((/** @type {any} */ u) => str(u?.uri).trim()).filter(Boolean) : [];
      const url = uris[0] ?? "";
      const username = str(login.username).trim();
      const fields = compact({ username, password: str(login.password), totp: str(login.totp).trim(), notes, ...extra });
      if (!Object.keys(fields).length && !url) { skipped.push(`${label}: nothing to import`); return; }
      items.push(item(names, { title, kind: "login", fields, url, username, tags, fmt: "bitwarden-json" }));
    } else if (it.type === 2 || it.secureNote) {
      if (!notes && !Object.keys(extra).length) { skipped.push(`${label}: empty note`); return; }
      items.push(item(names, { title, kind: "note", fields: compact({ text: notes, ...extra }), tags, fmt: "bitwarden-json" }));
    } else if (it.type === 3 || it.card) {
      const c = it.card ?? {};
      const mm = str(c.expMonth).trim();
      const yy = str(c.expYear).trim();
      const expiry = mm && yy ? `${mm.padStart(2, "0")}/${yy.slice(-2).padStart(2, "0")}` : "";
      const fields = compact({ holder: str(c.cardholderName).trim(), number: str(c.number).replace(/\s+/g, ""), expiry, cvv: str(c.code).trim(), notes, ...extra });
      if (!Object.keys(fields).length) { skipped.push(`${label}: empty card`); return; }
      const brand = str(c.brand).trim();
      items.push(item(names, { title, kind: "card", fields, tags, fmt: "bitwarden-json", description: brand ? `${title || "card"} (${short(brand)})` : undefined }));
    } else if (it.type === 4 || it.identity) {
      skipped.push(`${label}: identity items are not imported`);
    } else {
      skipped.push(`${label}: unknown item type`);
    }
  });
  return { format: "bitwarden-json", items, skipped };
}

// ---------------------------------------------------------------------------------------------
// Items and names

const LABELS = {
  "1password-csv": "1Password", "bitwarden-csv": "Bitwarden", "bitwarden-json": "Bitwarden",
  "chrome-csv": "Chrome", "safari-csv": "Safari", csv: "CSV", env: ".env",
};

/**
 * @param {Names} names
 * @param {{ title: string, kind: Item["kind"], fields: Record<string,string>, url?: string, username?: string, tags?: string[], fmt: Format, description?: string }} o
 * @returns {Item}
 */
function item(names, o) {
  const host = o.url ? hostOf(o.url) : "";
  const origin = o.url ? originOf(o.url) : "";
  const base = slug(o.title) || slug(host) || slug(o.username ?? "") || o.kind;
  const name = names.take(base, o.username ?? "");
  /** @type {Item} */
  const out = {
    name,
    kind: o.kind,
    description: o.description ?? (o.title ? o.title.slice(0, 200) : `${o.kind} from ${LABELS[o.fmt]}`),
    fields: o.fields,
    hosts: origin ? [origin] : [],
  };
  if (o.url) out.url = o.url;
  if (o.tags && o.tags.length) out.tags = o.tags;
  return out;
}

class Names {
  constructor() { /** @type {Set<string>} */ this.used = new Set(); }
  /** @param {string} base @param {string} username */
  take(base, username) {
    base = fit(base, 0);
    if (!this.used.has(base)) return this.add(base);
    const u = slug(username);
    if (u) {
      const withUser = fit(base, u.length + 1) + "-" + u;
      if (NAME.test(withUser) && !this.used.has(withUser)) return this.add(withUser);
    }
    for (let n = 2; ; n++) {
      const s = String(n);
      const c = fit(base, s.length + 1) + "-" + s;
      if (!this.used.has(c)) return this.add(c);
    }
  }
  /** @param {string} n */
  add(n) { this.used.add(n); return n; }
}

/** Trim a name so a suffix of `room` characters still fits in 128. @param {string} s @param {number} room */
const fit = (s, room) => s.slice(0, Math.max(1, 128 - room)).replace(/[-._]+$/, "") || "item";

/** Lowercase, runs of anything else to "-", trimmed. @param {string} s */
function slug(s) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128).replace(/-+$/, "");
}

/** @param {string} s */
function firstURL(s) {
  return (s.split(/[\n,]/).map(x => x.trim()).find(Boolean) ?? "");
}

/** @param {string} u */
function parseURL(u) {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch { return null; }
}
/** @param {string} u */
const originOf = u => parseURL(u)?.origin ?? "";
/** @param {string} u */
const hostOf = u => parseURL(u)?.hostname ?? "";

/** Drop empty fields. @param {Record<string,string>} f */
function compact(f) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const [k, v] of Object.entries(f)) if (typeof v === "string" && v !== "") out[k] = v;
  return out;
}

/** @param {unknown} v */
const str = v => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
/** A title for a reason line: bounded and on one line. @param {string} s */
const short = s => s.replace(/\s+/g, " ").slice(0, 60);

/** @param {Format|null} format @param {string} error @returns {Result} */
function fail(format, error) { return { format, items: [], skipped: [], error }; }
