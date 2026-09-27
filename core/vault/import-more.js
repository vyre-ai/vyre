// @ts-check
// vault/import-more: the rest of the password managers people leave, read into vault items.
//
// LastPass CSV, Dashlane (the zip and each of its CSVs), Keeper CSV and JSON, NordPass CSV, Proton
// Pass (the unencrypted zip, its data.json and its CSV), Enpass JSON, KeePass 2 and KeePassXC XML,
// and KeePassXC CSV. Firefox and the Chromium browsers (Edge, Brave, Arc, Opera, Vivaldi) write a
// CSV import.js already reads. import.js detects and dispatches; this file holds the parsers.
//
// The rules of import.js hold here unchanged:
//   - A name or description is built only from a title, a host or a username, never a field value.
//   - `skipped` and `error` never carry a value. JSON.parse's own message is never passed on, and
//     the XML reader's errors are fixed words that quote nothing from the file.
// A record lands as the kind its contents fit: a login when it has a username or a password, an
// authenticator when its only secret is a TOTP seed, a card, address, identity or wifi when it has
// what that kind needs, and a note otherwise, so nothing a person stored is dropped on the floor.

import { item, Names, parseCSV, norm, slug, compact, originOf, str, short, fail, cell } from "./import.js";

/** @typedef {import("./import.js").Item} Item */
/** @typedef {import("./import.js").Result} Result */
/** @typedef {import("./import.js").Format} Format */

export const KDBX_ERROR = "this is a KeePass database (.kdbx), which is encrypted; export it as XML or CSV from KeePass or KeePassXC and import that";
const PROTON_ENCRYPTED = "this Proton Pass export is encrypted with PGP; export again from Proton Pass without encryption, as a zip or CSV";

/**
 * Parse a text export in one of the formats this file owns, or null for a format it does not.
 * @param {string} text @param {Format} fmt @returns {Result|null}
 */
export function parseMore(text, fmt) {
  switch (fmt) {
    case "lastpass-csv": return parseLastPass(text);
    case "dashlane-csv": return parseDashlaneCSV(text);
    case "keeper-csv": return parseKeeperCSV(text);
    case "keeper-json": return parseKeeperJSON(text);
    case "nordpass-csv": return parseNordPass(text);
    case "protonpass-csv": return parseProtonCSV(text);
    case "protonpass-json": return parseProtonJSON(text, "protonpass-json");
    case "enpass-json": return parseEnpass(text);
    case "keepass-xml": return parseKeePassXML(text);
    case "keepassxc-csv": return parseKeePassXCCSV(text);
    default: return null;
  }
}

/**
 * Read a Dashlane or Proton Pass zip from its entries. Without a format, null when the archive is
 * neither.
 * @param {Map<string, Buffer>} entries @param {Format} [fmt] @returns {Result|null}
 */
export function parseMoreZip(entries, fmt) {
  const names = [...entries.keys()];
  const proton = !fmt || fmt === "protonpass-zip";
  const dashlane = !fmt || fmt === "dashlane-zip";
  if (proton && names.some(n => /\.pgp$/i.test(n))) return fail("protonpass-zip", PROTON_ENCRYPTED);
  const data = names.find(n => base(n) === "data.json");
  if (proton && data) return parseProtonJSON(utf8(entries.get(data)) ?? "", "protonpass-zip");
  const tables = names.filter(n => DASHLANE_FILES.includes(base(n).toLowerCase()));
  if (dashlane && tables.length) {
    const out = new Out("dashlane-zip");
    for (const n of tables) {
      const file = printable(base(n));
      const text = utf8(entries.get(n));
      if (text === null) { out.skipped.push(`${file}: not UTF-8 text`); continue; }
      if (!dashlaneTable(out, text, file)) out.skipped.push(`${file}: not a Dashlane table read here`);
    }
    return out.result();
  }
  if (fmt === "dashlane-zip") return fail(fmt, "the zip archive holds none of Dashlane's CSV files (credentials.csv, securenotes.csv, payments.csv, ids.csv, personalInfo.csv)");
  if (fmt === "protonpass-zip") return fail(fmt, "the zip archive holds no Proton Pass data.json");
  return null;
}

/**
 * A CSV header (as normalized names) that belongs to one of these formats, most specific first.
 * @param {Set<string>} h @returns {Format|null}
 */
export function moreCSVFormat(h) {
  if (h.has("extra") && h.has("grouping")) return "lastpass-csv";
  if (h.has("httprealm") || h.has("formactionorigin") || (h.has("guid") && h.has("timepasswordchanged"))) return "firefox-csv";
  if (h.has("cardholdername") || h.has("additional urls") || (h.has("full name") && h.has("zipcode"))) return "nordpass-csv";
  if (h.has("vault") && h.has("type") && (h.has("createtime") || h.has("modifytime"))) return "protonpass-csv";
  if (h.has("group") && h.has("title") && h.has("password")) return "keepassxc-csv";
  if (h.has("otpsecret") || h.has("otpurl") || h.has("username2") || h.has("cc number") || h.has("account holder")
    || h.has("place of issue") || (h.has("item name") && h.has("zip"))) return "dashlane-csv";
  return null;
}

/** A parsed JSON export that belongs to one of these formats. @param {any} j @returns {Format|null} */
export function moreJSONFormat(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  if (Array.isArray(j.records)) return "keeper-json";
  if (j.vaults && typeof j.vaults === "object" && !Array.isArray(j.vaults)) return "protonpass-json";
  if (Array.isArray(j.items) && j.items.some((/** @type {any} */ it) => it && typeof it === "object" && typeof it.category === "string" && ("title" in it || Array.isArray(it.fields)))) return "enpass-json";
  return null;
}

/**
 * Keeper's CSV has no header row: Folder, Title, Login, Password, Website Address, Notes, Shared
 * Folder, then custom name and value pairs. It is guessed only once every known header has failed.
 * @param {string} text
 */
export function looksLikeKeeperCSV(text) {
  const cut = text.length > 8192;
  const rows = parseCSV(text.slice(0, 8192));
  if (cut) rows.pop();
  if (!rows.length) return false;
  if (keeperHeader(rows[0])) return true;
  const urlish = /^[a-z][a-z0-9+.-]*:\/\/\S*$|^[\w-]+(\.[\w-]+)+(\/\S*)?$/i;
  return rows.every(r => r.length >= 7 && (r[4].trim() === "" || urlish.test(r[4].trim()))) && rows.some(r => r[2].trim() || r[3]);
}
/** @param {string[]} r */
const keeperHeader = r => r.length >= 5 && norm(r[1] ?? "") === "title" && norm(r[3] ?? "") === "password";

/** A KeePass 1 or 2 database file: 0x9AA2D903, then 0xB54BFB65/66/67, little-endian. @param {Uint8Array} b */
export function isKdbx(b) {
  return b.length >= 8 && b[0] === 0x03 && b[1] === 0xd9 && b[2] === 0xa2 && b[3] === 0x9a
    && b[5] === 0xfb && b[6] === 0x4b && b[7] === 0xb5 && (b[4] === 0x65 || b[4] === 0x66 || b[4] === 0x67);
}

// ---------------------------------------------------------------------------------------------
// Records into items

/**
 * @typedef {object} Common
 * @property {string} label where a record is, for a reason line: a row or item number and its title
 * @property {string} title
 * @property {string} [url]
 * @property {string[]} [urls]
 * @property {string[]} [tags]
 */

class Out {
  /** @param {Format} fmt */
  constructor(fmt) {
    this.fmt = fmt;
    this.names = new Names();
    /** @type {Item[]} */
    this.items = [];
    /** @type {string[]} */
    this.skipped = [];
  }
  /** @returns {Result} */
  result() { return { format: this.fmt, items: this.items, skipped: this.skipped }; }
  /** @param {string} label @param {string} why */
  skip(label, why) { this.skipped.push(`${label}: ${why}`); return null; }
  /**
   * @param {Common & { kind: Item["kind"], fields: Record<string,string>, username?: string, description?: string }} o
   * @returns {Item}
   */
  push(o) {
    const urls = (o.urls ?? []).map(u => u.trim()).filter(Boolean);
    const url = (o.url ?? "").trim() || urls[0] || "";
    const tags = [...new Set((o.tags ?? []).map(t => t.trim()).filter(Boolean))];
    const it = item(this.names, { title: o.title, kind: o.kind, fields: o.fields, url: url || undefined, username: o.username, tags, fmt: this.fmt, description: o.description });
    const hosts = [...new Set([url, ...urls].map(originOf).filter(Boolean))];
    if (hosts.length) it.hosts = hosts;
    this.items.push(it);
    return it;
  }
}

/** Custom fields as `field-<name>`, a repeated name numbered. Empty values are dropped. */
class Extra {
  constructor() { /** @type {Record<string,string>} */ this.f = {}; }
  /** @param {string} label @param {unknown} value */
  add(label, value) {
    const v = typeof value === "number" ? String(value) : value;
    if (typeof v !== "string" || v === "") return;
    const b = `field-${slug(label) || "field"}`;
    let k = b;
    for (let n = 2; Object.hasOwn(this.f, k); n++) k = `${b}-${n}`;
    this.f[k] = v;
  }
}

/**
 * A record holding a login, a TOTP seed or a note, by what it has.
 * @param {Out} out
 * @param {Common & { username?: string, password?: string, totp?: string, notes?: string, account?: string, extra?: Record<string,string> }} r
 */
function secretRecord(out, r) {
  const extra = r.extra ?? {};
  const { label, title, url, urls, tags } = r;
  if (r.password || r.username) {
    return out.push({ label, title, url, urls, tags, kind: "login", username: r.username,
      fields: compact({ username: r.username ?? "", password: r.password ?? "", totp: r.totp ?? "", notes: r.notes ?? "", ...extra }) });
  }
  if (r.totp) {
    return out.push({ label, title, url, urls, tags, kind: "authenticator", username: r.account,
      fields: compact({ totp: r.totp, account: r.account ?? "", notes: r.notes ?? "", ...extra }) });
  }
  return noteRecord(out, { label, title, url, urls, tags, notes: r.notes, fields: extra });
}

/**
 * A note. With no text of its own, its fields become the text, one "name: value" a line.
 * @param {Out} out @param {Common & { notes?: string, fields?: Record<string,string> }} r
 */
function noteRecord(out, r) {
  const fields = compact(r.fields ?? {});
  const notes = r.notes ?? "";
  const text = notes || lines(fields);
  if (!text.trim()) return out.skip(r.label, "nothing to import");
  return out.push({ ...r, kind: "note", fields: notes ? compact({ text, ...fields }) : { text } });
}

/** @param {Record<string,string>} f */
const lines = f => Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");

/**
 * @param {Out} out
 * @param {Common & { holder?: string, number?: string, expiry?: string, cvv?: string, pin?: string, notes?: string, brand?: string, extra?: Record<string,string> }} r
 */
function cardRecord(out, r) {
  const number = (r.number ?? "").replace(/[\s-]+/g, "");
  const rest = compact({ holder: (r.holder ?? "").trim(), expiry: expiry(r.expiry ?? ""), cvv: (r.cvv ?? "").trim(), pin: (r.pin ?? "").trim(), ...(r.extra ?? {}) });
  if (!number) return noteRecord(out, { ...r, fields: rest });
  const brand = (r.brand ?? "").trim();
  return out.push({ ...r, kind: "card", fields: compact({ number, ...rest, notes: r.notes ?? "" }),
    description: brand ? `${r.title || "card"} (${short(brand)})` : undefined });
}

/**
 * @param {Out} out
 * @param {Common & { address: Record<string,string>, notes?: string, extra?: Record<string,string> }} r
 */
function addressRecord(out, r) {
  const a = compact(Object.fromEntries(Object.entries(r.address).map(([k, v]) => [k, (v ?? "").trim()])));
  const fields = compact({ ...a, notes: r.notes ?? "", ...(r.extra ?? {}) });
  if (!(a.line1 || a.city || a.postal || a.country)) return noteRecord(out, { ...r, notes: r.notes, fields: compact({ ...a, ...(r.extra ?? {}) }) });
  return out.push({ ...r, kind: "address", fields });
}

/**
 * @param {Out} out
 * @param {Common & { identity: Record<string,string>, notes?: string, extra?: Record<string,string> }} r
 */
function identityRecord(out, r) {
  const d = compact(Object.fromEntries(Object.entries(r.identity).map(([k, v]) => [k, (v ?? "").trim()])));
  if (!(d.name || d.number || d.birthdate)) return noteRecord(out, { ...r, fields: compact({ ...d, ...(r.extra ?? {}) }) });
  return out.push({ ...r, kind: "identity", fields: compact({ ...d, notes: r.notes ?? "", ...(r.extra ?? {}) }) });
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/**
 * A card expiry as MM/YY from "03/2029", "3/29", "2029-03", "March,2029" and the like; anything
 * else is kept as written.
 * @param {string} s
 */
export function expiry(s) {
  s = s.trim();
  if (!s) return "";
  /** @param {string|number} m @param {string} y */
  const mmyy = (m, y) => (Number(m) >= 1 && Number(m) <= 12 ? `${String(Number(m)).padStart(2, "0")}/${y.slice(-2)}` : s);
  let m;
  if ((m = /^(\d{1,2})\s*[/.-]\s*(\d{2}|\d{4})$/.exec(s))) return mmyy(m[1], m[2]);
  if ((m = /^(\d{4})\s*[/.-]\s*(\d{1,2})(?:[/.-]\d{1,2})?$/.exec(s))) return mmyy(m[2], m[1]);
  if ((m = /^([A-Za-z]{3,})[\s,]+(\d{2}|\d{4})$/.exec(s))) {
    const i = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (i >= 0) return mmyy(i + 1, m[2]);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// CSV helpers

/** @param {string} text */
function table(text) {
  const rows = parseCSV(text);
  const h = (rows[0] ?? []).map(norm);
  /** @param {...string} names */
  const idx = (...names) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };
  return { rows, h, idx };
}
/** A cell trimmed. @param {string[]} row @param {number} i */
const at = (row, i) => cell(row, i).trim();
/** @param {string} prefix @param {number} n @param {string} title */
const where = (prefix, n, title) => (title ? `${prefix} ${n} (${short(title)})` : `${prefix} ${n}`);
/** @param {string} n */
const base = n => n.split("/").pop() ?? "";
/** @param {string} s */
const printable = s => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 80);
/** @param {Buffer|undefined} b */
function utf8(b) {
  if (!b) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return null; }
}
/** @param {unknown} v @returns {any[]} */
const arr = v => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------------------------------------
// LastPass CSV: url,username,password,totp,extra,name,grouping,fav. A url of "http://sn" is a secure
// note, its text in `extra`; a note starting "NoteType:Credit Card" or "NoteType:Address" holds
// "Key:Value" lines.

/** @param {string} text @returns {Result} */
function parseLastPass(text) {
  const F = "lastpass-csv";
  const { rows, idx } = table(text);
  if (!rows.length) return fail(F, "the file is empty");
  const c = { url: idx("url"), username: idx("username"), password: idx("password"), totp: idx("totp"), extra: idx("extra"), name: idx("name"), grouping: idx("grouping") };
  if (c.url < 0 || c.extra < 0 || c.name < 0) return fail(F, "the header row is not LastPass's (url, username, password, totp, extra, name, grouping)");
  const out = new Out(F);
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const title = at(row, c.name);
    const label = where("row", r + 1, title);
    const grouping = at(row, c.grouping).replace(/\\/g, "/");
    const tags = grouping && grouping !== "(none)" ? [grouping] : [];
    const url = at(row, c.url);
    const extra = cell(row, c.extra);
    if (url === "http://sn") { lastPassNote(out, { label, title, tags, extra }); continue; }
    secretRecord(out, { label, title, url: url === "http://" ? "" : url, tags,
      username: at(row, c.username), password: cell(row, c.password), totp: at(row, c.totp), notes: extra });
  }
  return out.result();
}

/** @param {Out} out @param {{ label: string, title: string, tags: string[], extra: string }} r */
function lastPassNote(out, r) {
  const type = /^NoteType:(.*)$/.exec(r.extra.split(/\r?\n/, 1)[0] ?? "")?.[1]?.trim().toLowerCase() ?? "";
  if (type !== "credit card" && type !== "address") return noteRecord(out, { ...r, notes: r.extra });
  const kv = keyValues(r.extra);
  const take = (/** @type {string[]} */ ...keys) => {
    for (const k of keys) { const v = kv.get(k); if (v !== undefined) { kv.delete(k); return v.trim(); } }
    return "";
  };
  take("notetype"); take("language");
  const notes = kv.get("notes") ?? ""; kv.delete("notes");
  if (type === "credit card") {
    const holder = take("name on card"), brand = take("type"), number = take("number"), cvv = take("security code"), exp = take("expiration date");
    const extra = new Extra();
    for (const [k, v] of kv) if (v.trim() && v.trim() !== ",") extra.add(k, v.trim());
    return cardRecord(out, { ...r, holder, brand, number, cvv, expiry: exp, notes, extra: extra.f });
  }
  const name = [take("first name"), take("middle name"), take("last name")].filter(Boolean).join(" ");
  const address = {
    name, company: take("company"), line1: take("address 1"),
    line2: [take("address 2"), take("address 3")].filter(Boolean).join(", "),
    city: take("city / town", "city"), region: take("state"), postal: take("zip / postal code", "zip"), country: take("country"),
    phone: phone(take("phone")), email: take("email address", "email"),
  };
  const extra = new Extra();
  for (const [k, v] of kv) extra.add(k, /phone|fax/.test(k) ? phone(v.trim()) : v.trim());
  return addressRecord(out, { ...r, address, notes, extra: extra.f });
}

/**
 * LastPass's "Key:Value" note body, keys lowercased. A line without a colon continues the value
 * before it; "Notes" takes everything after it.
 * @param {string} text
 */
function keyValues(text) {
  /** @type {Map<string,string>} */
  const kv = new Map();
  const ls = text.replace(/\r\n/g, "\n").split("\n");
  let last = "";
  for (let i = 0; i < ls.length; i++) {
    const c = ls[i].indexOf(":");
    if (c <= 0) { if (last) kv.set(last, `${kv.get(last)}\n${ls[i]}`); continue; }
    const k = ls[i].slice(0, c).trim().toLowerCase();
    if (k === "notes") { kv.set(k, [ls[i].slice(c + 1), ...ls.slice(i + 1)].join("\n")); break; }
    kv.set(k, ls[i].slice(c + 1));
    last = k;
  }
  return kv;
}

/** LastPass writes a phone as {"num":..,"ext":..,"cc3l":..}. @param {string} v */
function phone(v) {
  if (!v.startsWith("{")) return v;
  try {
    const j = JSON.parse(v);
    return [str(j?.num), str(j?.ext) ? `ext ${str(j.ext)}` : ""].filter(Boolean).join(" ");
  } catch { return v; }
}

// ---------------------------------------------------------------------------------------------
// Dashlane: credentials.csv, securenotes.csv, payments.csv, ids.csv and personalInfo.csv, in a
// zip or one at a time. Each is told apart by its header.

const DASHLANE_FILES = ["credentials.csv", "securenotes.csv", "payments.csv", "ids.csv", "personalinfo.csv"];

/** @param {string} text @returns {Result} */
function parseDashlaneCSV(text) {
  const out = new Out("dashlane-csv");
  if (!parseCSV(text).length) return fail("dashlane-csv", "the file is empty");
  if (!dashlaneTable(out, text, "")) return fail("dashlane-csv", "the header row is not one of Dashlane's (credentials, secure notes, payments, IDs, personal info)");
  return out.result();
}

/**
 * Read one Dashlane table into `out`; false when the header is none of Dashlane's.
 * @param {Out} out @param {string} text @param {string} file
 */
function dashlaneTable(out, text, file) {
  const { rows, h, idx } = table(text);
  if (!rows.length) return true;
  const has = (/** @type {string} */ n) => h.includes(n);
  const pre = file ? `${file} row` : "row";
  const each = (/** @type {(row: string[], label: string, get: (...n: string[]) => string, raw: (...n: string[]) => string) => void} */ fn) => {
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const get = (/** @type {string[]} */ ...n) => at(row, idx(...n));
      const raw = (/** @type {string[]} */ ...n) => cell(row, idx(...n));
      fn(row, where(pre, r + 1, get("title") || get("account name") || get("item name")), get, raw);
    }
  };
  if (has("otpsecret") || has("otpurl") || has("username2") || (has("password") && has("title"))) {
    each((row, label, get, raw) => {
      const extra = new Extra();
      extra.add("username2", get("username2"));
      extra.add("username3", get("username3"));
      secretRecord(out, { label, title: get("title"), url: get("url"), tags: [get("category")], username: get("username"),
        password: raw("password"), totp: get("otpsecret", "otpurl"), notes: raw("note"), extra: extra.f });
    });
    return true;
  }
  if (has("cc number") || has("account holder")) {
    each((row, label, get, raw) => {
      const title = get("account name");
      const mm = get("expiration month"), yy = get("expiration year");
      const extra = new Extra();
      for (const k of ["issuing bank", "country", "routing number", "account number", "bic", "iban"]) extra.add(k, get(k));
      if (get("cc number")) {
        cardRecord(out, { label, title, holder: get("account holder"), number: get("cc number"), cvv: get("code"),
          expiry: mm && yy ? `${mm}/${yy}` : "", notes: raw("note"), extra: extra.f });
      } else {
        noteRecord(out, { label, title, notes: raw("note"), fields: compact({ holder: get("account holder"), ...extra.f }) });
      }
    });
    return true;
  }
  if (has("place of issue") || (has("issue date") && has("number"))) {
    each((row, label, get, raw) => {
      const type = get("type");
      const title = type ? type.replace(/[_-]+/g, " ") : "id";
      const extra = new Extra();
      extra.add("state", get("state"));
      identityRecord(out, { label: `${label} (${short(title)})`, title,
        identity: { name: get("name"), number: get("number"), issued: get("issue date"), expiry: get("expiration date"), country: get("place of issue"), type },
        notes: raw("note"), extra: extra.f });
    });
    return true;
  }
  if (has("item name") || has("first name") || has("zip")) {
    each((row, label, get) => {
      const type = get("type").toLowerCase();
      if (type && type !== "address") { out.skip(label, `personal info of type ${short(type)} is not imported`); return; }
      addressRecord(out, { label, title: get("item name") || get("title"),
        address: { name: get("address recipient"), line1: get("address"),
          line2: [get("address building"), get("address apartment"), get("address floor")].filter(Boolean).join(", "),
          city: get("city"), region: get("state"), postal: get("zip"), country: get("country"), phone: get("phone number") } });
    });
    return true;
  }
  if (has("title") && has("note")) {
    each((row, label, get, raw) => { noteRecord(out, { label, title: get("title"), tags: [get("category")], notes: raw("note") }); });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Keeper CSV (no header row) and Keeper JSON

/** @param {string} text @returns {Result} */
function parseKeeperCSV(text) {
  const out = new Out("keeper-csv");
  const rows = parseCSV(text);
  if (!rows.length) return fail("keeper-csv", "the file is empty");
  rows.forEach((row, i) => {
    if (i === 0 && keeperHeader(row)) return;
    const title = at(row, 1);
    const label = where("row", i + 1, title);
    const extra = new Extra();
    let totp = "";
    for (let k = 7; k + 1 < row.length; k += 2) {
      const name = row[k].trim();
      const value = cell(row, k + 1);
      if (!value) continue;
      if (!totp && (/^TFC:/i.test(name) || /^\$?oneTimeCode/i.test(name) || /^otpauth:\/\//i.test(value.trim()))) totp = value.trim();
      else extra.add(name || "field", value);
    }
    secretRecord(out, { label, title, url: at(row, 4), tags: [at(row, 0), at(row, 6)], username: at(row, 2), password: cell(row, 3),
      totp, notes: cell(row, 5), extra: extra.f });
  });
  return out.result();
}

/** @param {string} text @returns {Result} */
function parseKeeperJSON(text) {
  const F = "keeper-json";
  let j;
  try { j = JSON.parse(text); } catch { return fail(F, "the file is not valid JSON"); }
  if (!j || !Array.isArray(j.records)) return fail(F, "the JSON has no records list");
  const out = new Out(F);
  j.records.forEach((/** @type {any} */ rec, /** @type {number} */ i) => {
    if (!rec || typeof rec !== "object") { out.skip(`record ${i + 1}`, "not an object"); return; }
    const title = str(rec.title).trim();
    const label = where("record", i + 1, title);
    const type = str(rec.$type);
    const tags = arr(rec.folders).map(f => [str(f?.shared_folder), str(f?.folder)].filter(Boolean).join("/"));
    const extra = new Extra();
    let totp = "", notes = str(rec.notes), holder = "", pin = "", name = "";
    /** @type {Record<string,string>} */
    let card = {};
    /** @type {Record<string,string>} */
    let addr = {};
    for (const [key, v0] of [...pairs(rec.custom_fields), ...pairs(rec.fields)]) {
      const v = Array.isArray(v0) ? (v0.every(x => typeof x === "string") ? v0.join("\n") : v0[0]) : v0;
      const m = /^\$([A-Za-z]+)(?::([^:]*))?(?:::\d+)?$/.exec(key);
      const ktype = m ? m[1] : "";
      const klabel = m ? (m[2] ?? "") : key.replace(/::\d+$/, "");
      if (ktype === "oneTimeCode" || /^TFC:/i.test(key)) { if (!totp) totp = str(v).trim(); continue; }
      if (ktype === "paymentCard" && v && typeof v === "object") {
        card = { number: str(v.cardNumber), expiry: str(v.cardExpirationDate), cvv: str(v.cardSecurityCode) };
        continue;
      }
      if (ktype === "address" && v && typeof v === "object") {
        addr = { line1: str(v.street1), line2: str(v.street2), city: str(v.city), region: str(v.state), postal: str(v.zip), country: str(v.country) };
        continue;
      }
      if (ktype === "name" && v && typeof v === "object") { name = [str(v.first), str(v.middle), str(v.last)].filter(Boolean).join(" "); continue; }
      if (ktype === "pinCode") { pin = str(v); continue; }
      if (/cardholder/i.test(klabel || ktype)) { holder = str(v); continue; }
      if (ktype === "note" && !notes) { notes = str(v); continue; }
      if (typeof v === "string" || typeof v === "number") { extra.add(klabel || ktype || "field", v); continue; }
      if (v && typeof v === "object") out.skip(label, `field ${short(klabel || ktype || "field")} is not imported`);
    }
    if (type === "bankCard" || card.number) {
      cardRecord(out, { label, title, tags, holder, pin, notes, ...card, extra: extra.f });
    } else if (type === "address" || Object.values(addr).some(Boolean)) {
      addressRecord(out, { label, title, tags, address: { name, ...addr }, notes, extra: extra.f });
    } else {
      if (name) extra.add("name", name);
      secretRecord(out, { label, title, tags, url: str(rec.login_url), username: str(rec.login).trim(), password: str(rec.password), totp, notes, extra: extra.f });
    }
  });
  return out.result();
}

/** Keeper custom fields: an object of name to value, or a list of { name|label|type, value }. @param {unknown} x @returns {[string, any][]} */
function pairs(x) {
  if (Array.isArray(x)) return x.filter(f => f && typeof f === "object").map(f => [str(f.name) || str(f.label) || str(f.type), f.value]);
  if (x && typeof x === "object") return Object.entries(x);
  return [];
}

// ---------------------------------------------------------------------------------------------
// NordPass CSV

/** @param {string} text @returns {Result} */
function parseNordPass(text) {
  const F = "nordpass-csv";
  const { rows, idx } = table(text);
  if (!rows.length) return fail(F, "the file is empty");
  if (idx("name") < 0 || idx("type") < 0) return fail(F, "the header row is not NordPass's (name, url, username, password, ..., type)");
  const out = new Out(F);
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (/** @type {string[]} */ ...n) => at(row, idx(...n));
    const raw = (/** @type {string[]} */ ...n) => cell(row, idx(...n));
    const title = get("name");
    const label = where("row", r + 1, title);
    const type = get("type").toLowerCase().replace(/[\s-]+/g, "_");
    const tags = [get("folder")];
    if (type === "folder") continue;
    const extra = new Extra();
    const custom = raw("custom fields");
    if (custom.trim()) {
      try {
        for (const f of arr(JSON.parse(custom))) extra.add(str(f?.label) || str(f?.type) || "field", str(f?.value));
      } catch { out.skip(label, "its custom fields could not be read"); }
    }
    if (type === "credit_card") {
      cardRecord(out, { label, title, tags, holder: get("cardholdername"), number: get("cardnumber"), cvv: get("cvc"), pin: get("pin"),
        expiry: get("expirydate"), notes: raw("note"), extra: { ...compact({ "field-zip": get("zipcode") }), ...extra.f } });
    } else if (type === "identity") {
      addressRecord(out, { label, title, tags, notes: raw("note"), extra: extra.f,
        address: { name: get("full name"), line1: get("address1"), line2: get("address2"), city: get("city"), region: get("state"),
          postal: get("zipcode"), country: get("country"), phone: get("phone number"), email: get("email") } });
    } else if (type === "note") {
      noteRecord(out, { label, title, tags, notes: raw("note"), fields: extra.f });
    } else {
      const urls = [get("url"), ...get("additional urls").split(/[\s,]+/)].filter(Boolean);
      secretRecord(out, { label, title, tags, urls, username: get("username") || get("email"), password: raw("password"), totp: get("totp"), notes: raw("note"), extra: extra.f });
    }
  }
  return out.result();
}

// ---------------------------------------------------------------------------------------------
// Proton Pass: data.json (alone or in the zip) and the CSV

/** @param {string} text @param {Format} F @returns {Result} */
function parseProtonJSON(text, F) {
  if (text.trimStart().startsWith("-----BEGIN PGP")) return fail(F, PROTON_ENCRYPTED);
  let j;
  try { j = JSON.parse(text); } catch { return fail(F, "the Proton Pass data is not valid JSON"); }
  if (j && j.encrypted === true) return fail(F, PROTON_ENCRYPTED);
  if (!j || !j.vaults || typeof j.vaults !== "object") return fail(F, "the Proton Pass data has no vaults");
  const out = new Out(F);
  let n = 0;
  for (const v of Object.values(j.vaults)) {
    const tags = [str(v?.name).trim()];
    for (const it of arr(v?.items)) {
      n++;
      const d = it?.data && typeof it.data === "object" ? it.data : {};
      const md = d.metadata && typeof d.metadata === "object" ? d.metadata : {};
      const title = str(md.name).trim();
      const label = where("item", n, title);
      if (it?.state === 2) { out.skip(label, "in the trash"); continue; }
      const type = str(d.type);
      const c = d.content && typeof d.content === "object" ? d.content : {};
      const notes = str(md.note);
      const extra = new Extra();
      let totp = "";
      for (const f of arr(d.extraFields)) {
        const val = str(f?.data?.content);
        if (str(f?.type) === "totp" && !totp) totp = val.trim();
        else extra.add(str(f?.fieldName) || "field", val);
      }
      if (type === "login") {
        const user = str(c.itemUsername).trim() || str(c.username).trim();
        const email = str(c.itemEmail).trim();
        if (user && email) extra.add("email", email);
        secretRecord(out, { label, title, tags, urls: arr(c.urls).map(str), username: user || email, password: str(c.password),
          totp: str(c.totpUri).trim() || totp, notes, extra: extra.f });
      } else if (type === "note") {
        noteRecord(out, { label, title, tags, notes, fields: extra.f });
      } else if (type === "creditCard") {
        cardRecord(out, { label, title, tags, holder: str(c.cardholderName), number: str(c.number), cvv: str(c.verificationNumber),
          pin: str(c.pin), expiry: str(c.expirationDate), notes, extra: extra.f });
      } else if (type === "identity") {
        const used = new Set(["fullName", "organization", "streetAddress", "floor", "city", "stateOrProvince", "zipOrPostalCode", "countryOrRegion", "phoneNumber", "email"]);
        for (const [k, val] of Object.entries(c)) if (!used.has(k) && typeof val === "string") extra.add(k, val);
        for (const sec of arr(c.extraSections)) for (const f of arr(sec?.sectionFields)) extra.add(str(f?.fieldName) || "field", str(f?.data?.content));
        addressRecord(out, { label, title, tags, notes, extra: extra.f, address: {
          name: str(c.fullName), company: str(c.organization), line1: str(c.streetAddress), line2: str(c.floor), city: str(c.city),
          region: str(c.stateOrProvince), postal: str(c.zipOrPostalCode), country: str(c.countryOrRegion), phone: str(c.phoneNumber), email: str(c.email) } });
      } else if (type === "wifi") {
        const ssid = str(c.ssid).trim(), password = str(c.password);
        if (ssid || password) out.push({ label, title, tags, kind: "wifi", fields: compact({ ssid, password, notes, ...extra.f }) });
        else noteRecord(out, { label, title, tags, notes, fields: extra.f });
      } else if (type === "alias") {
        out.skip(label, "alias items hold no secret and are not imported");
      } else if (notes || Object.keys(extra.f).length) {
        noteRecord(out, { label, title, tags, notes, fields: extra.f });
      } else out.skip(label, `${short(type || "unknown")} items are not imported`);
    }
  }
  return out.result();
}

/** @param {string} text @returns {Result} */
function parseProtonCSV(text) {
  const F = "protonpass-csv";
  const { rows, idx } = table(text);
  if (!rows.length) return fail(F, "the file is empty");
  if (idx("type") < 0 || idx("name") < 0) return fail(F, "the header row is not Proton Pass's (type, name, url, email, username, password, note, totp, vault)");
  const out = new Out(F);
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (/** @type {string[]} */ ...n) => at(row, idx(...n));
    const title = get("name");
    const label = where("row", r + 1, title);
    const type = get("type").toLowerCase();
    const tags = [get("vault")];
    const notes = cell(row, idx("note"));
    if (type === "alias") { out.skip(label, "alias items hold no secret and are not imported"); continue; }
    if (type === "note") { noteRecord(out, { label, title, tags, notes }); continue; }
    const user = get("username"), email = get("email");
    const extra = new Extra();
    if (user && email) extra.add("email", email);
    secretRecord(out, { label, title, tags, urls: get("url").split(/[\s,]+/), username: user || email, password: cell(row, idx("password")),
      totp: get("totp"), notes, extra: extra.f });
  }
  return out.result();
}

// ---------------------------------------------------------------------------------------------
// Enpass JSON: { folders, items: [{ title, category, note, fields: [{ label, type, value }] }] }

const ADDRESS_LABELS = /** @type {[RegExp, string][]} */ ([
  [/^(street|address)( ?1| line ?1)?$/i, "line1"], [/^(street|address) ?(2|line ?2)$/i, "line2"], [/^(city|town)$/i, "city"],
  [/^(state|province|region)$/i, "region"], [/^(zip|postal|post code|postcode|zip code|postal code)$/i, "postal"],
  [/^country$/i, "country"], [/^company|organi[sz]ation$/i, "company"],
]);

/** @param {string} text @returns {Result} */
function parseEnpass(text) {
  const F = "enpass-json";
  let j;
  try { j = JSON.parse(text); } catch { return fail(F, "the file is not valid JSON"); }
  if (!j || !Array.isArray(j.items)) return fail(F, "the JSON has no items list");
  /** @type {Map<string, any>} */
  const folders = new Map(arr(j.folders).filter(f => f && typeof f.uuid === "string").map(f => [f.uuid, f]));
  /** @param {string} id */
  const folderPath = id => {
    const out = [];
    for (let f = folders.get(id), n = 0; f && n < 32; f = folders.get(str(f.parent_uuid)), n++) out.unshift(str(f.title).trim());
    return out.filter(Boolean).join("/");
  };
  const out = new Out(F);
  j.items.forEach((/** @type {any} */ it, /** @type {number} */ i) => {
    if (!it || typeof it !== "object") { out.skip(`item ${i + 1}`, "not an object"); return; }
    const title = str(it.title).trim();
    const label = where("item", i + 1, title);
    if (it.trashed === 1 || it.trashed === true) { out.skip(label, "in the trash"); return; }
    const cat = str(it.category).toLowerCase();
    const notes = str(it.note);
    const tags = arr(it.folders).map(id => folderPath(str(id)));
    const extra = new Extra();
    let username = "", email = "", password = "", totp = "";
    /** @type {string[]} */
    const urls = [];
    /** @type {Record<string,string>} */
    const cc = {};
    /** @type {Record<string,string>} */
    const addr = {};
    let first = "", last = "", fullName = "", phoneNo = "";
    for (const f of arr(it.fields)) {
      if (!f || f.deleted === 1 || f.deleted === true) continue;
      const t = str(f.type), v = str(f.value), lab = str(f.label).trim();
      if (!v || t === "section") continue;
      if (t === "username" && !username) { username = v.trim(); continue; }
      if (t === "email" && !email) { email = v.trim(); continue; }
      if (t === "password" && !password) { password = v; continue; }
      if (t === "url") { urls.push(v.trim()); continue; }
      if (t === "totp" && !totp) { totp = v.trim(); continue; }
      const ccKey = { ccName: "holder", ccNumber: "number", ccCvc: "cvv", ccExpiry: "expiry", ccPin: "pin", ccType: "brand" }[t];
      if (ccKey && !cc[ccKey]) { cc[ccKey] = v; continue; }
      if (cat === "identity") {
        const a = ADDRESS_LABELS.find(([re]) => re.test(lab));
        if (a && !addr[a[1]]) { addr[a[1]] = v; continue; }
        if (/^first ?name$/i.test(lab)) { first = v.trim(); continue; }
        if (/^last ?name|surname$/i.test(lab)) { last = v.trim(); continue; }
        if (/^(full )?name$/i.test(lab)) { fullName = v.trim(); continue; }
        if (t === "phone" && !phoneNo) { phoneNo = v.trim(); continue; }
      }
      extra.add(lab || t || "field", v);
    }
    if (username && email) extra.add("email", email);
    if (cat === "creditcard" || cc.number) {
      cardRecord(out, { label, title, tags, ...cc, notes, extra: extra.f });
    } else if (cat === "identity" && Object.keys(addr).length) {
      addressRecord(out, { label, title, tags, notes, extra: extra.f,
        address: { name: fullName || [first, last].filter(Boolean).join(" "), ...addr, phone: phoneNo, email: username ? "" : email } });
    } else if (cat === "note") {
      noteRecord(out, { label, title, tags, notes, fields: compact({ ...extra.f, ...(password ? { "field-password": password } : {}) }) });
    } else {
      if (cat === "identity") { extra.add("name", fullName || [first, last].filter(Boolean).join(" ")); extra.add("phone", phoneNo); }
      secretRecord(out, { label, title, tags, urls, username: username || email, password, totp, notes, extra: extra.f });
    }
  });
  return out.result();
}

// ---------------------------------------------------------------------------------------------
// KeePass 2 and KeePassXC XML, and KeePassXC CSV

/** @typedef {{ name: string, attrs: Record<string,string>, children: El[], text: string }} El */

const XML_NAME = /[A-Za-z_:][A-Za-z0-9_:.-]*/y;
const XML_ENTITIES = new Map([["lt", "<"], ["gt", ">"], ["amp", "&"], ["quot", '"'], ["apos", "'"]]);

/**
 * A small XML reader for exports: elements, attributes, text, CDATA, comments, processing
 * instructions, the five predefined entities and numeric character references. A DOCTYPE (and
 * so any entity declaration or external entity) is refused. Errors are fixed words; none quotes
 * the input.
 * @param {string} src
 * @param {{ maxDepth?: number, maxNodes?: number }} [opts]
 * @returns {El} the root element
 */
export function readXML(src, { maxDepth = 256, maxNodes = 2_000_000 } = {}) {
  src = src.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  /** @type {El} */
  const doc = { name: "", attrs: {}, children: [], text: "" };
  const stack = [doc];
  let i = 0, nodes = 0, rooted = false;
  /** @param {string} s */
  const text = s => {
    const top = stack[stack.length - 1];
    if (top === doc) { if (/\S/.test(s)) throw xmlError("text outside the root element"); return; }
    top.text += s;
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { text(decodeXML(src.slice(i))); break; }
    if (lt > i) text(decodeXML(src.slice(i, lt)));
    if (src.startsWith("<!--", lt)) {
      const e = src.indexOf("-->", lt + 4);
      if (e < 0) throw xmlError("a comment is not closed");
      i = e + 3; continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const e = src.indexOf("]]>", lt + 9);
      if (e < 0) throw xmlError("a CDATA section is not closed");
      if (stack.length === 1) throw xmlError("text outside the root element");
      text(src.slice(lt + 9, e));
      i = e + 3; continue;
    }
    if (src.startsWith("<!", lt)) throw xmlError(/^<!DOCTYPE/i.test(src.slice(lt, lt + 9)) ? "a DOCTYPE is refused" : "a markup declaration is refused");
    if (src.startsWith("<?", lt)) {
      const e = src.indexOf("?>", lt + 2);
      if (e < 0) throw xmlError("a processing instruction is not closed");
      i = e + 2; continue;
    }
    if (src[lt + 1] === "/") {
      const e = src.indexOf(">", lt);
      if (e < 0) throw xmlError("a closing tag is not closed");
      const top = stack.pop();
      if (!top || top === doc || top.name !== src.slice(lt + 2, e).trim()) throw xmlError("a closing tag does not match its element");
      i = e + 1; continue;
    }
    XML_NAME.lastIndex = lt + 1;
    const m = XML_NAME.exec(src);
    if (!m) throw xmlError("a tag has no name");
    /** @type {El} */
    const el = { name: m[0], attrs: {}, children: [], text: "" };
    let j = lt + 1 + m[0].length;
    let closed = false;
    for (;;) {
      while (j < src.length && /\s/.test(src[j])) j++;
      if (j >= src.length) throw xmlError("a tag is not closed");
      if (src[j] === ">") { j++; break; }
      if (src[j] === "/" && src[j + 1] === ">") { j += 2; closed = true; break; }
      XML_NAME.lastIndex = j;
      const a = XML_NAME.exec(src);
      if (!a) throw xmlError("an attribute has no name");
      j += a[0].length;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] !== "=") throw xmlError("an attribute has no value");
      j++;
      while (j < src.length && /\s/.test(src[j])) j++;
      const q = src[j];
      if (q !== '"' && q !== "'") throw xmlError("an attribute value is not quoted");
      const e = src.indexOf(q, j + 1);
      if (e < 0) throw xmlError("an attribute value is not closed");
      const raw = src.slice(j + 1, e);
      if (raw.includes("<")) throw xmlError("an attribute value holds a <");
      if (Object.hasOwn(el.attrs, a[0])) throw xmlError("an attribute appears twice");
      el.attrs[a[0]] = decodeXML(raw);
      j = e + 1;
    }
    if (++nodes > maxNodes) throw xmlError("the file has too many elements");
    const parent = stack[stack.length - 1];
    if (parent === doc) {
      if (rooted) throw xmlError("there is more than one root element");
      rooted = true;
    }
    parent.children.push(el);
    if (!closed) {
      stack.push(el);
      if (stack.length > maxDepth + 1) throw xmlError("elements nest too deep");
    }
    i = j;
  }
  if (stack.length !== 1) throw xmlError("an element is not closed");
  if (!rooted) throw xmlError("there is no root element");
  return doc.children[0];
}

/** @param {string} why */
const xmlError = why => new Error(`xml: ${why}`);

/** @param {string} s */
function decodeXML(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&([^;&\s<]{1,10});|&/g, (_all, ref) => {
    if (ref === undefined) throw xmlError("a bare & is not escaped");
    const named = XML_ENTITIES.get(ref);
    if (named !== undefined) return named;
    let cp = NaN;
    if (/^#x[0-9a-fA-F]{1,6}$/.test(ref)) cp = parseInt(ref.slice(2), 16);
    else if (/^#[0-9]{1,7}$/.test(ref)) cp = parseInt(ref.slice(1), 10);
    else throw xmlError("an unknown entity is used");
    const ok = cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
    if (!ok) throw xmlError("a character reference is out of range");
    return String.fromCodePoint(cp);
  });
}

/** @param {El|undefined} el @param {string} name */
const kid = (el, name) => el?.children.find(c => c.name === name);
/** @param {El|undefined} el @param {string} name */
const kids = (el, name) => (el ? el.children.filter(c => c.name === name) : []);
/** @param {El|undefined} el */
const txt = el => el?.text ?? "";

/** @param {string} text @returns {Result} */
function parseKeePassXML(text) {
  const F = "keepass-xml";
  /** @type {El} */
  let root;
  try { root = readXML(text); } catch (e) {
    const m = e instanceof Error && e.message.startsWith("xml: ") ? e.message.slice(5) : "it is not well-formed";
    return fail(F, `the KeePass XML could not be read (${m})`);
  }
  if (root.name !== "KeePassFile") return fail(F, "the XML is not a KeePass export (it has no KeePassFile element)");
  const top = kid(root, "Root");
  if (!top) return fail(F, "the KeePass XML has no Root element");
  const bin = txt(kid(kid(root, "Meta"), "RecycleBinUUID")).trim();
  const out = new Out(F);
  let n = 0;
  /** @param {El} g @param {string[]} trail @param {number} depth */
  const walk = (g, trail, depth) => {
    const name = txt(kid(g, "Name")).trim();
    const uuid = txt(kid(g, "UUID")).trim();
    if (depth > 0 && ((bin && !/^A+=*$/.test(bin) && uuid === bin) || name === "Recycle Bin")) {
      out.skipped.push(`group ${short(name || "Recycle Bin")}: the recycle bin is not imported`);
      return;
    }
    // The top group is the database itself; its name is not a folder.
    const here = depth === 0 ? [] : [...trail, name || "group"];
    for (const e of kids(g, "Entry")) keepassEntry(out, e, ++n, here);
    for (const c of kids(g, "Group")) walk(c, here, depth + 1);
  };
  for (const g of kids(top, "Group")) walk(g, [], 0);
  return out.result();
}

/** @param {Out} out @param {El} e @param {number} n @param {string[]} trail */
function keepassEntry(out, e, n, trail) {
  /** @type {Map<string,string>} */
  const s = new Map();
  /** @type {string[]} */
  const sealed = [];
  for (const st of kids(e, "String")) {
    const k = txt(kid(st, "Key"));
    const v = kid(st, "Value");
    if (!k) continue;
    if (v?.attrs.Protected === "True") { sealed.push(k); continue; }
    s.set(k, txt(v));
  }
  const title = (s.get("Title") ?? "").trim();
  const label = where("entry", n, title);
  for (const k of sealed) out.skip(label, `field ${short(printable(k))} is encrypted in the file and not imported`);
  for (const b of kids(e, "Binary")) out.skip(label, `attachment ${short(printable(txt(kid(b, "Key"))))} not imported`);
  const take = (/** @type {string} */ k) => { const v = s.get(k) ?? ""; s.delete(k); return v; };
  take("Title");
  const username = take("UserName").trim();
  const password = take("Password");
  const url = take("URL").trim();
  const notes = take("Notes");
  let totp = take("otp").trim() || take("TOTP Seed").trim();
  const b32 = take("TimeOtp-Secret-Base32").replace(/\s+/g, "");
  const period = take("TimeOtp-Period").trim(), digits = take("TimeOtp-Length").trim(), algo = take("TimeOtp-Algorithm").trim();
  if (!totp && b32) {
    if (period || digits || algo) {
      const q = new URLSearchParams({ secret: b32 });
      if (period) q.set("period", period);
      if (digits) q.set("digits", digits);
      if (algo) q.set("algorithm", algo.replace(/^HMAC-?/i, "").replace(/-/g, "").toUpperCase());
      totp = `otpauth://totp/${encodeURIComponent(title || username || "keepass")}?${q}`;
    } else totp = b32;
  }
  const extra = new Extra();
  for (const [k, v] of s) extra.add(k, v);
  const tags = [trail.join("/"), ...txt(kid(e, "Tags")).split(/[;,]/)];
  secretRecord(out, { label, title, url, tags, username, password, totp, account: username, notes, extra: extra.f });
}

/** @param {string} text @returns {Result} */
function parseKeePassXCCSV(text) {
  const F = "keepassxc-csv";
  const { rows, idx } = table(text);
  if (!rows.length) return fail(F, "the file is empty");
  const c = { group: idx("group"), title: idx("title"), username: idx("username", "user name"), password: idx("password"), url: idx("url"), notes: idx("notes"), totp: idx("totp") };
  if (c.title < 0 || c.password < 0) return fail(F, "the header row is not KeePassXC's (Group, Title, Username, Password, URL, Notes, TOTP)");
  const out = new Out(F);
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const title = at(row, c.title);
    const segs = at(row, c.group).split("/").map(x => x.trim()).filter(Boolean);
    const group = segs.slice(1).join("/");
    if (segs[1] === "Recycle Bin") { out.skip(where("row", r + 1, title), "in the recycle bin"); continue; }
    const username = at(row, c.username);
    secretRecord(out, { label: where("row", r + 1, title), title, url: at(row, c.url), tags: [group], username,
      password: cell(row, c.password), totp: at(row, c.totp), account: username, notes: cell(row, c.notes) });
  }
  return out.result();
}
