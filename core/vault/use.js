// @ts-check
// core/vault/use.js: agents use Vault items by placeholder and never see a secret (the owner, 20 Oct: "the agent asks Vyre what's in store for this, the Vault sends back what's
// available to it ... the agent uses them in whatever format it wants, and then the Vault plugs in the keys").
//
//   vault.use.find       the items THIS caller may use: names, field names, plain values in full, and for a secret field only { name, secret: true } (no length, no last four, no hash).
//   placeholders     `{{vault:<Item>.<FIELD>}}` anywhere in a vault.request (url, query, headers, body). Names match canonically (case and punctuation do not matter). The values are put in
//                    here, on the server, and the answer comes back with every secret it used hidden ("[hidden: NORTHWIND_API_KEY]"), in its base64, URL-encoded and JSON forms too.
//   Used with        where an item's secrets may go: the hosts written on the item plus the hosts the person allowed. A host that is not on the list holds the request and asks the person once
//                    ("Use Northwind CRM with api.example.com?", vault.pending and vault.approve, or their own words through said.js); their yes puts the host on the list. Until then the
//                    secret goes nowhere. Never over plain http, never to a bare address, never to a private one (api-request.js checkTarget). Plain fields go anywhere.
//   scripts          an item marked "Allowed in scripts" (off by default) may be put into one program's environment by `vyre vault run --item <name> -- <cmd>` in an agent's session. The values
//                    travel sealed to a key the command line made for that one run (crypto.js sealFor), so no tool result carries them; the program's output is hidden the same way.
//
// Who may use an item (fail closed): the person on their own surface; a model that holds "Can use it, without seeing it" on the item (the kernel grant, access.js effectFor); the person's
// own assistant running a turn for the owner (the person's reach, per the own-account rule); or a thread the person tagged the item in (said.js). The vault is the owner's: a call made for
// any other person never gets here (member-gate.js), so an agent running for a member finds and uses nothing of the owner's or of another member's. An outward call (a send, a payment,
// a delete) still waits at the Gate exactly as vault.request does with a credential. Every use is an audit row on the item: who, for whom, which host or command, ok or refused. No value.

import net from "node:net";
import crypto from "node:crypto";
import { newPrefixedId } from "../../lib/id.js";
import { scrub } from "../../lib/scrub.js";
import { isPerson } from "../../lib/caller.js";
import { vaultFieldIsSecret } from "../../lib/secret-schema.js";
import { SPEC } from "../../lib/vault-kinds/kinds.js";
import { isAsker } from "./asker.js";
import { canon } from "../../lib/env-name.js";
import { sealFor } from "./crypto.js";
import { presence, quoted } from "./tools/presence.js";
import { checkTarget, classify, presetFor, parseFields, summarize, approvalHash, buildUrl, checkQuery } from "./api-request.js";

/** Per item: the hosts the person allowed, whether scripts may have it, which fields are plain. MACed (vault.js MACED): each one decides where a value may go. */
export const USE_MIGRATION = `CREATE TABLE vault_item_use (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, hosts TEXT NOT NULL DEFAULT '[]', scripts INTEGER NOT NULL DEFAULT 0, plain TEXT NOT NULL DEFAULT '[]', at INTEGER NOT NULL, by TEXT, mac TEXT
   );
   CREATE TABLE vault_use_requests (
     id TEXT PRIMARY KEY, item TEXT NOT NULL, item_id TEXT NOT NULL, host TEXT NOT NULL, agent TEXT NOT NULL, by TEXT, at INTEGER NOT NULL, UNIQUE (item_id, host)
   );`;
export const USE_MACED = ["id", "name", "hosts", "scripts", "plain"];

/** The `credential` a held placeholder request carries on its Gate card: never a vault item's name (an item name has no colon). */
export const CARD = "vault-placeholders";
const PURPOSE = "vault-run";
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const GATE_KINDS = { send: "send", spend: "spend", delete: "delete" };
const NOT_HERE = new Set(["api-credential", "ssh-key", "passkey"]);
const MAX_BODY = 1_000_000, MAX_RESPONSE = 2_000_000, MAX_RESULT = 256 * 1024, MAX_HOPS = 5;
const KEEP_HEADERS = ["content-type", "content-length", "etag", "last-modified", "retry-after", "x-request-id", "request-id", "ratelimit-remaining"];
/** Headers a request never sets: framing, forwarding and method overrides. Authentication is allowed here, because the value in it comes from a placeholder. */
const NEVER_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "expect", "x-forwarded-for", "x-forwarded-host", "forwarded",
  "x-http-method-override", "x-http-method", "x-method-override"]);
/** `{{vault:Item.FIELD}}`: the item is everything up to the last dot, the field a plain name. */
const PH = /\{\{\s*vault:([^{}\r\n]{1,160}?)\.([A-Za-z0-9_-]{1,64})\s*\}\}/g;

const isObj = (/** @type {any} */ v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const json = (/** @type {any} */ v, /** @type {any} */ d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };
const bad = (/** @type {string} */ msg, code = "bad_input") => Object.assign(new Error(msg), { code });
const printable = (/** @type {any} */ s, /** @type {number} */ n) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, n);

/** A name as the Vault compares it: upper case, every run of other characters one underscore. "Northwind CRM" and northwind-crm are both NORTHWIND_CRM. @param {unknown} s */
export { canon };

/** A host that is really an address. A secret goes to a named host only. @param {string} h */
const isAddress = h => net.isIP(h.replace(/^\[|\]$/g, "")) !== 0 || h.includes(":") || /^(0x[0-9a-f]+|\d+)$/i.test(h.split(".").pop() || "");

/** The https host names an item's own hosts name (its origins). @param {any} row */
function writtenHosts(row) {
  const out = [];
  for (const o of json(row.hosts, [])) { try { const u = new URL(String(o)); if (u.protocol === "https:" && (!u.port || u.port === "443")) out.push(u.hostname.toLowerCase()); } catch { /* not an origin */ } }
  return out;
}

/** Each placeholder in a string: the text, the item and the field as written. In a url they may be percent-encoded (a URL parser encodes braces in a path and a space anywhere). @param {string} s @param {boolean} [inUrl] */
function refsIn(s, inUrl = false) {
  const text = inUrl ? decodeUrlRefs(s).text : s;
  return [...text.matchAll(PH)].map(m => ({ item: m[1].trim(), field: m[2] }));
}

/** A url with its percent-encoded placeholders written plainly, and the map back to the raw text each came from, so the raw text is what gets replaced. @param {string} s */
function decodeUrlRefs(s) {
  /** @type {{ raw: string, plain: string }[]} */ const spans = [];
  const text = s.replace(/(?:\{\{|%7B%7B)((?:(?!\}\}|%7D%7D).){1,400})(?:\}\}|%7D%7D)/gi, (raw, inner) => {
    let plain;
    try { plain = `{{${decodeURIComponent(String(inner).replace(/\+/g, " "))}}}`; } catch { plain = raw; }
    spans.push({ raw, plain });
    return plain;
  });
  return { text, spans };
}

/** Put values into a url: each placeholder's raw text becomes its value, URL-encoded. @param {string} s @param {(item: string, field: string) => string} value */
function fillUrl(s, value) {
  return s.replace(/(?:\{\{|%7B%7B)((?:(?!\}\}|%7D%7D).){1,400})(?:\}\}|%7D%7D)/gi, raw => {
    const { text } = decodeUrlRefs(raw);
    PH.lastIndex = 0;
    const m = PH.exec(text);
    PH.lastIndex = 0;
    return m && m[0] === text ? encodeURIComponent(value(m[1].trim(), m[2])) : raw;
  });
}

/** Put values into text, each through `enc`. @param {string} s @param {(item: string, field: string) => string} value @param {(v: string) => string} enc */
const fillText = (s, value, enc) => s.replace(PH, (_m, item, field) => enc(value(String(item).trim(), field)));

/** A body as the text that goes out, before any value is put in: text as given, an object as JSON, or as a form when the caller said so. @param {any} body @param {string} [ctype] */
function encodeBody(body, ctype) {
  if (typeof body === "string") return body;
  if (/x-www-form-urlencoded/i.test(ctype || "") && isObj(body)) {
    const p = new URLSearchParams();
    const add = (/** @type {string} */ k, /** @type {any} */ v) => { if (Array.isArray(v)) v.forEach((x, i) => add(`${k}[${i}]`, x)); else if (isObj(v)) for (const [kk, vv] of Object.entries(v)) add(`${k}[${kk}]`, vv); else if (v !== undefined && v !== null) p.append(k, String(v)); };
    for (const [k, v] of Object.entries(body)) add(k, v);
    // the form encoder writes braces as %7B and %7D; put the placeholders back so they are found
    return p.toString().replace(/%7B%7Bvault%3A([^%]*(?:%(?!7D)[0-9A-F]{2}[^%]*)*)%7D%7D/gi, (_m, inner) => { try { return `{{vault:${decodeURIComponent(inner.replace(/\+/g, " "))}}}`; } catch { return _m; } });
  }
  return JSON.stringify(body);
}

/** How a value is written into a body of this type, so it cannot break the body out of its shape. @param {string} ctype @returns {(v: string) => string} */
const bodyEnc = ctype => (/json/i.test(ctype) ? v => JSON.stringify(v).slice(1, -1) : /x-www-form-urlencoded/i.test(ctype) ? v => encodeURIComponent(v) : v => v);

/**
 * Hide each secret, and its encoded forms, behind its own label. Longest first, so a value inside a longer one is not cut in half.
 * @param {string} text @param {{ value: string, label: string }[]} secrets
 */
export function hide(text, secrets) {
  let out = String(text ?? "");
  for (const s of [...secrets].sort((a, b) => b.value.length - a.value.length)) out = scrub(out, [s.value], { marker: `[hidden: ${s.label}]`, wide: true });
  return out;
}
/** @param {any} v @param {{ value: string, label: string }[]} secrets @returns {any} */
const hideAll = (v, secrets) => {
  if (typeof v === "string") return hide(v, secrets);
  if (Array.isArray(v)) return v.map(x => hideAll(x, secrets));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [hide(k, secrets), hideAll(x, secrets)]));
  return v;
};

export class VaultUse {
  /**
   * @param {import("./vault.js").Vault} vault @param {any} api the vault.request engine (request.js ApiRequests): its transport, lookup, Gate sender and seal
   * @param {any} said @param {(type: string, payload: any) => void} emit
   */
  constructor(vault, api, said, emit = () => {}) { this.v = /** @type {any} */ (vault); this.api = api; this.said = said; this.emit = emit; this.db = this.v.db; }

  // ---- the item's own rules ----

  /** Its rules, read only from a row that passes its MAC: a tampered or missing row is the default (no extra host, no scripts, no plain field). @param {any} row */
  rules(row) {
    const none = { hosts: /** @type {string[]} */ ([]), scripts: false, plain: /** @type {string[]} */ ([]) };
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_item_use WHERE id = ?").get(String(row.id)));
    if (!r || r.name !== row.name || !this.v.rowOk("vault_item_use", r)) return none;
    return { hosts: json(r.hosts, []).map(String), scripts: r.scripts === 1, plain: json(r.plain, []).map(String) };
  }

  /** Change an item's rules (the person's own act, or their yes to a host). @param {any} row @param {{ hosts?: string[], scripts?: boolean, plain?: string[] }} next @param {string} by */
  async setRules(row, next, by) {
    await this.v.key();
    const cur = this.rules(row);
    const hosts = [...new Set((next.hosts ?? cur.hosts).map(h => String(h).toLowerCase()))].slice(0, 50);
    const plain = [...new Set(next.plain ?? cur.plain)].slice(0, 100);
    const scripts = next.scripts ?? cur.scripts;
    this.db.prepare(`INSERT INTO vault_item_use (id, name, hosts, scripts, plain, at, by) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, hosts=excluded.hosts, scripts=excluded.scripts, plain=excluded.plain, at=excluded.at, by=excluded.by`)
      .run(String(row.id), String(row.name), JSON.stringify(hosts), scripts ? 1 : 0, JSON.stringify(plain), Date.now(), String(by));
    this.v.sign("vault_item_use", String(row.id));
    return { hosts, scripts, plain };
  }

  /** Where this item's secrets may go: the hosts written on it and the ones the person allowed. @param {any} row */
  usedWith(row) { return [...new Set([...writtenHosts(row), ...this.rules(row).hosts])]; }

  /** A field is plain when the person marked it so, or when it is a label of a known kind (a login's username). Anything else is secret. @param {any} row @param {string} field @param {{ plain: string[] }} rules */
  plain(row, field, rules) {
    if (rules.plain.includes(field)) return true;
    const spec = SPEC[row.kind];
    return Boolean(spec && !NOT_HERE.has(row.kind) && (spec.fields || []).includes(field) && !vaultFieldIsSecret(row.kind, field));
  }

  // ---- who may use what ----

  /** The person this call is for, from the kernel's chain, else the thread's asker; null when neither says. @param {any} meta */
  async personOf(meta) {
    const K = this.v.access && this.v.access.K;
    try { if (K && typeof K.chain === "function") { const c = await K.chain(meta); const p = (c && Array.isArray(c.hops) ? c.hops : []).find((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person"); if (p) return String(p.actor.id); } } catch { /* fall through */ }
    try { if (this.said && this.said.askerOf && meta.thread) return (await this.said.askerOf(String(meta.thread))) || null; } catch { /* none */ }
    return null;
  }

  /** The person's own assistant running a turn for the owner: the person's reach (agentKind comes from the registry, the chain from the kernel; every person hop must be the owner). @param {any} meta */
  async ownRun(meta) {
    if (meta.agentKind !== "assistant") return false;
    const K = this.v.access && this.v.access.K;
    if (!K || !K.owner || typeof K.chain !== "function") return false;
    try {
      const c = await K.chain(meta);
      const ps = (c && Array.isArray(c.hops) ? c.hops : []).filter((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person").map((/** @type {any} */ h) => String(h.actor.id));
      return ps.length > 0 && ps.every(p => p === String(K.owner));
    } catch { return false; }
  }

  /** The name a model call is judged as, or null for a person. @param {any} meta */
  agentOf(meta) { const c = String(meta.caller || ""); return isAsker(c) ? (this.v.access && this.v.access.modelName ? this.v.access.modelName(meta, c) : "assistant") : null; }

  /**
   * How this caller may use items, as one function: (row) => may it. Decided once per call. A module never uses placeholders (it holds a grant and vault.release).
   * @param {any} meta @returns {Promise<{ mode: "person" | "own" | "grant", may: (row: any) => Promise<boolean> }>}
   */
  async judge(meta) {
    const caller = String(meta.caller || "");
    if (!isAsker(caller)) {
      if (!isPerson(caller)) throw bad("placeholders are for agents and the person; a module uses an item through its grant (vault.release)", "denied");
      return { mode: "person", may: async () => true };
    }
    if (await this.ownRun(meta)) return { mode: "own", may: async () => true };
    const who = /** @type {string} */ (this.agentOf(meta));
    const access = this.v.access;
    return { mode: "grant", may: async row => {
      if (meta.thread && this.said && (await this.said.match({ kind: "use", to: [row.name], hosts: json(row.hosts, []) }, { thread: String(meta.thread) }).catch(() => null))) return true;
      if (!access || !access.K || typeof access.effectFor !== "function") return false;
      return (await access.effectFor(who, row.name, "vault.read", undefined, meta.thread)) !== "deny";
    } };
  }

  /** The items a caller may use, rows that pass their MAC. @param {{ may: (row: any) => Promise<boolean> }} j */
  async usable(j) {
    const out = [];
    for (const it of this.v.list().items) {
      if (it.kind === "ssh-key" || it.kind === "passkey") continue;
      const row = this.v.row(it.name);
      if (row && (await j.may(row))) out.push(row);
    }
    return out;
  }

  // ---- vault.use.find ----

  /** @param {{ q?: string, limit?: number }} input @param {any} meta */
  async find(input, meta) {
    await this.v.key();
    const j = await this.judge(meta);
    const q = String(input.q || "").trim().toLowerCase(), cq = canon(q);
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
    const items = [];
    for (const row of await this.usable(j)) {
      const fields = json(row.fields, []).map(String);
      const app = String(json(row.details, {}).provider || writtenHosts(row)[0] || "");
      const words = [row.name, row.description, app, ...fields].map(x => String(x || ""));
      if (q && !words.some(w => w.toLowerCase().includes(q) || (cq && canon(w).includes(cq)))) continue;
      if (row.kind === "api-credential") {
        let hosts = [];
        try { hosts = (await this.v.apiCredential(row.name)).config.hosts; } catch { hosts = []; }
        items.push({ name: row.name, kind: row.kind, ...(row.description ? { description: String(row.description).slice(0, 200) } : {}), used_with: hosts, fields: [], how: `vault.request with credential "${row.name}"` });
      } else {
        const rules = this.rules(row);
        let open = null;
        const plainNames = fields.filter(f => this.plain(row, f, rules));
        if (plainNames.length) { try { open = await this.v.fields(row); } catch { open = null; } }
        items.push({ name: row.name, kind: row.kind, ...(row.description ? { description: String(row.description).slice(0, 200) } : {}), ...(app ? { app } : {}), used_with: this.usedWith(row), scripts: rules.scripts,
          fields: fields.map(f => (plainNames.includes(f) ? { name: f, ...(open && typeof open[f] === "string" ? { plain: open[f] } : { plain: null, note: "locked" }) } : { name: f, secret: true })),
          placeholder: `{{vault:${row.name}.${canon(fields.find(f => !plainNames.includes(f)) || fields[0] || "FIELD")}}}` });
      }
      if (items.length >= limit) break;
    }
    return { items, ...(items.length > 1 ? { note: "Several items match: pick the one that fits, or ask the person which to use." } : {}),
      ...(items.length ? {} : { note: "Nothing you may use matches. The person shares an item with Can use it, without seeing it, or tags it with # in the chat." }) };
  }

  // ---- placeholders ----

  /**
   * Every placeholder in a request, resolved: the item (one row, usable by this caller), the field, its value and whether it is secret. Refuses the whole request on any unknown or
   * ungranted one, naming it; an item this caller may not use answers exactly as one that does not exist.
   * @param {{ item: string, field: string }[]} refs @param {{ may: (row: any) => Promise<boolean> }} j
   */
  async resolve(refs, j) {
    /** @type {Map<string, any>} */ const rows = new Map();
    /** @type {Map<string, { row: any, field: string, value: string, secret: boolean }>} */ const out = new Map();
    const all = this.v.list().items;
    for (const r of refs) {
      const key = `${canon(r.item)}.${canon(r.field)}`;
      if (out.has(key)) continue;
      const shown = `{{vault:${printable(r.item, 80)}.${printable(r.field, 64)}}}`;
      let row = rows.get(canon(r.item));
      if (!row) {
        const hits = all.filter((/** @type {any} */ x) => canon(x.name) === canon(r.item));
        if (hits.length > 1) throw bad(`${shown}: ${hits.length} items are called ${canon(r.item)}; ask the person to rename one`, "ambiguous");
        row = hits.length ? this.v.row(hits[0].name) : null;
        if (!row || NOT_HERE.has(row.kind) || !(await j.may(row))) throw bad(`${shown}: there is no item called ${printable(r.item, 80)} that you may use. vault.use.find lists the ones you can; the person shares one with Can use it, without seeing it.`, "not_found");
        rows.set(canon(r.item), row);
      }
      const names = json(row.fields, []).map(String);
      const field = names.find(f => canon(f) === canon(r.field));
      if (!field) throw bad(`${shown}: ${row.name} has no field ${printable(r.field, 64)}; its fields are ${names.map(canon).join(", ") || "none"}`, "not_found");
      const f = await this.v.fields(row);
      const value = f[field];
      if (typeof value !== "string" || !value) throw bad(`${shown}: ${row.name} has nothing in ${canon(field)}`, "not_found");
      const secret = !this.plain(row, field, this.rules(row));
      // A value this short cannot be told apart from ordinary text in the answer, so it could not be hidden there: it is not sent.
      if (secret && value.length < 4) throw bad(`${shown}: the value is too short to hide in the answer, so it is not sent`, "denied");
      out.set(key, { row, field, value, secret });
    }
    return out;
  }

  /**
   * The request with the values put in, checked, classified and hashed: everything a decision needs. Nothing is sent.
   * @param {any} input { method, url, query?, headers?, body? } @param {any} meta @param {{ may: (row: any) => Promise<boolean>, mode: string }} j
   */
  async plan(input, meta, j) {
    const method = String(input.method || "").toUpperCase();
    if (!METHODS.includes(method)) throw bad(`method must be one of ${METHODS.join(", ")}`);
    if (typeof input.url !== "string") throw bad("a request names its url");
    const templUrl = buildUrl(input.url, input.query);
    /** @type {Record<string, string>} */ const templHeaders = {};
    if (input.headers !== undefined && input.headers !== null) {
      if (!isObj(input.headers) || Object.keys(input.headers).length > 20) throw bad("headers is an object of at most 20 strings");
      for (const [k, v] of Object.entries(input.headers)) {
        const n = k.toLowerCase();
        if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(n)) throw bad(`"${printable(k, 40)}" is not a header name`);
        if (NEVER_HEADERS.has(n) || n.startsWith("proxy-") || n.startsWith("sec-")) throw bad(`${n} is set by the connection, never by a request`);
        if (typeof v !== "string" || v.length > 8000 || /[\r\n\0]/.test(v)) throw bad(`header ${n} must be a single-line string`);
        templHeaders[n] = v;
      }
    }
    let templBody;
    if (input.body !== undefined && input.body !== null && input.body !== "") {
      if (method === "GET" || method === "HEAD") throw bad("a GET or HEAD carries no body");
      templBody = encodeBody(input.body, templHeaders["content-type"]);
      if (Buffer.byteLength(templBody) > MAX_BODY) throw bad("body is larger than 1 MB");
    }
    const ctype = templHeaders["content-type"] || (templBody !== undefined ? (/^\s*[[{]/.test(templBody) ? "application/json" : "application/x-www-form-urlencoded") : "");
    const refs = [...refsIn(templUrl, true), ...Object.values(templHeaders).flatMap(v => refsIn(v)), ...(templBody !== undefined ? refsIn(templBody) : [])];
    if (!refs.length) throw bad("name a credential, or write an item's field as {{vault:Item.FIELD}} in the url, headers or body (vault.use.find lists what you may use)");
    const used = await this.resolve(refs, j);
    const value = (/** @type {string} */ item, /** @type {string} */ field) => /** @type {any} */ (used.get(`${canon(item)}.${canon(field)}`)).value;
    const filledUrl = fillUrl(templUrl, value);
    /** @type {Record<string, string>} */ const headers = {};
    for (const [k, v] of Object.entries(templHeaders)) {
      const filled = fillText(v, value, x => x);
      if (/[\r\n\0]/.test(filled)) throw bad(`a value put into header ${k} has a line break, which a header cannot carry`);
      headers[k] = filled;
    }
    const body = templBody !== undefined ? fillText(templBody, value, bodyEnc(ctype)) : undefined;
    const secrets = [...used.values()].filter(u => u.secret).map(u => ({ value: u.value, label: canon(u.field), row: u.row }));
    let parsed;
    try { parsed = new URL(filledUrl); } catch { throw bad("url is not a valid address"); }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:") throw bad(secrets.length ? "a secret is never sent over plain http: use https" : "Vyre sends these requests over https only");
    if (isAddress(host)) throw bad("a request goes to a named host, never to a bare address");
    const card = `${CARD}:${j.mode}:${j.mode === "grant" ? this.agentOf(meta) || "" : ""}`;
    const hash = approvalHash({ credential: card, method, url: templUrl, headers: templHeaders, body: templBody });
    const shown = new URL(templUrl);
    const cls = classify(method, shown.pathname + shown.search, []);
    const preset = presetFor(method, shown.pathname + shown.search);
    const fields = cls.kind === "read" ? { recipients: [] } : parseFields(preset, { body: templBody, contentType: ctype });
    const names = [...new Set([...used.values()].map(u => u.row.name))];
    return { method, host, filledUrl, headers: { ...(body !== undefined && !headers["content-type"] ? { "content-type": ctype } : {}), ...headers }, body, templUrl, templHeaders, templBody, secrets, used, names, card, hash,
      kind: cls.kind, parsed: fields, to: fields.recipients.length ? fields.recipients : [host],
      summary: cls.kind === "read" ? "" : summarize({ kind: cls.kind, method, url: templUrl, actingAs: names.join(", "), parsed: fields }) };
  }

  /** Who did it, for the audit line. @param {any} meta */
  whoOf(meta) { const a = this.agentOf(meta); return a ? `agent:${a}` : String(meta.caller || "?"); }

  /** One audit row per item used: who, for whom, where, ok or not. Never a value. @param {string[]} names @param {any} meta @param {boolean} ok @param {string} why @param {string} where @param {string | null} person */
  note(names, meta, ok, why, where, person) {
    for (const n of names) this.v.audit("use", n, this.whoOf(meta), ok, `${printable(why, 140)}${person ? ` for ${printable(person, 64)}` : ""}`, { origin: printable(where, 120), surface: meta.surface || null });
  }

  /**
   * vault.request with placeholders. A read runs once its hosts are on the items' Used with; a host that is not asks the person first; an outward call waits at the Gate as any other.
   * @param {any} input @param {any} meta
   */
  async request(input, meta) {
    const j = await this.judge(meta);
    await this.v.key();
    const person = await this.personOf(meta);
    let plan;
    try { plan = await this.plan(input, meta, j); }
    catch (e) {
      // which item a refusal names is in its words; the audit row says only that a placeholder request was refused
      this.v.audit("use", null, this.whoOf(meta), false, `refused: ${printable(/** @type {Error} */ (e).message.replace(/\{\{[^}]*\}\}/g, "{{...}}"), 120)}`);
      throw e;
    }
    // Used with: every item whose secret goes along must have this host on its list.
    const ask = [];
    for (const row of new Map(plan.secrets.map(s => [s.row.id, s.row])).values()) {
      if (this.usedWith(row).includes(plan.host)) continue;
      // The person's own words named this item and this host (said.js "use" with the host): that is their yes.
      const said = meta.thread && this.said ? (await this.said.match({ kind: "use", to: [row.name], hosts: [plan.host] }, { thread: String(meta.thread) }).catch(() => null))
        || (await this.said.match({ kind: "use", to: [row.name], hosts: [`https://${plan.host}`] }, { thread: String(meta.thread) }).catch(() => null)) : null;
      if (said) { await this.setRules(row, { hosts: [...this.rules(row).hosts, plan.host] }, `said:${said.id}`); continue; }
      ask.push(row);
    }
    if (ask.length) {
      const ids = ask.map(row => this.hold(row, plan.host, meta));
      this.note(ask.map(r => r.name), meta, false, `held: ${plan.host} is not on its Used with yet`, plan.host, person);
      const what = ask.map(r => r.name).join(" and ");
      return { held: ids.join(","), kind: "host", message: `Waiting for the person to allow ${what} with ${plan.host}. Nothing was sent. When they approve it in Vyre, send the same request again.` };
    }
    if (plan.kind === "read") return { ...(await this.execute(plan, meta, person)), kind: "read" };
    // Asking is approving: what the person's own words covered runs now.
    const said = this.said ? await this.said.match({ kind: plan.kind, channel: `api:${plan.names[0]}`, via: `api:${plan.names[0]}`, to: plan.to, ...(plan.kind === "spend" ? { amount: plan.parsed.amount, payee: plan.parsed.payee, currency: plan.parsed.currency } : {}) },
      { thread: meta.thread }).catch(() => null) : null;
    if (said) return { ...(await this.execute(plan, meta, person, `said:${said.id}`)), kind: plan.kind, said: said.id };
    const call = this.api && this.api.deps && this.api.deps.call;
    if (!call) throw bad("the Gate is not running, so an outward call cannot be held", "failed");
    await this.api.offer();
    const agent = meta.agent || (/^mcp:agent:(.+)$/.exec(String(meta.caller)) || [])[1] || undefined;
    const r = await call("gate.request", {
      kind: /** @type {any} */ (GATE_KINDS)[plan.kind] || "send", via: "vault-api", to: plan.to, why: `vault.request with ${plan.names.join(", ")}`,
      ...(meta.thread ? { thread: meta.thread } : {}), ...(agent ? { agent } : {}),
      content: this.api.sealed({ credential: plan.card, method: plan.method, url: plan.templUrl, summary: plan.summary, hash: plan.hash, kind: plan.kind,
        request: { headers: plan.templHeaders, ...(plan.templBody !== undefined ? { body: plan.templBody } : {}) }, parsed: plan.parsed }),
    });
    if (r.error) throw bad(r.error.message || "the Gate did not take it", r.error.code || "failed");
    if (r.data.state === "sent") return { ...(isObj(r.data.result) ? r.data.result : {}), kind: plan.kind };
    this.note(plan.names, meta, true, `${plan.method} held at the Gate ${r.data.id}`, plan.host, person);
    return { held: r.data.id, kind: plan.kind, summary: plan.summary, message: r.data.message };
  }

  /**
   * The Gate approved a held placeholder request (request.js send hands it here after checking the vault's seal): run exactly it. Rebuilt from the Gate's own record, it must hash to what the
   * person saw, every item must still be usable as it was judged then (a named agent's grant is asked again), and every host must be on Used with now; nothing is held a second time.
   * @param {any} c the sealed card @param {any} held its request @param {any} it the Gate's item @param {string} caller
   */
  async send(c, held, it, caller) {
    const m = /^vault-placeholders:(person|own|grant):(.*)$/.exec(String(c.credential));
    if (!m) throw bad("the approved content is not a held placeholder request", "denied");
    const [, mode, agent] = m;
    const meta = { caller: mode === "grant" ? `mcp:agent:${agent}` : "module:gate", agent: agent || undefined, thread: it.thread || undefined, surface: "gate" };
    const access = this.v.access;
    /** @type {{ mode: string, may: (row: any) => Promise<boolean> }} */
    const j = { mode, may: async row => {
      if (mode !== "grant") return true;   // the owner approved this exact request with their own items: their own act
      return Boolean(access && access.K && typeof access.effectFor === "function" && (await access.effectFor(agent, row.name, "vault.read", undefined, it.thread)) !== "deny");
    } };
    const plan = await this.plan({ method: c.method, url: c.url, headers: held.headers, body: held.body }, { caller: meta.caller, agent: meta.agent, agentKind: undefined }, j);
    // the card names who it was for; the plan's own card text is rebuilt from that, so the hash covers it
    plan.card = String(c.credential);
    plan.hash = approvalHash({ credential: plan.card, method: plan.method, url: plan.templUrl, headers: plan.templHeaders, body: plan.templBody });
    if (plan.hash !== c.hash) throw bad("the request was changed after it was held, so it is not sent; ask again", "denied");
    if (plan.kind !== c.kind) throw bad(`this request is now a ${plan.kind}, not a ${c.kind}; ask again`, "denied");
    for (const s of plan.secrets) if (!this.usedWith(s.row).includes(plan.host)) throw bad(`${s.row.name} is not used with ${plan.host}; ask again`, "denied");
    return this.execute(plan, meta, it.by ? String(it.by) : null, `released:${printable(it.id, 60)} by ${printable(caller, 40)}`);
  }

  /** A new host for an item, waiting for the person. One request per item and host. @param {any} row @param {string} host @param {any} meta */
  hold(row, host, meta) {
    const old = /** @type {any} */ (this.db.prepare("SELECT id FROM vault_use_requests WHERE item_id = ? AND host = ?").get(String(row.id), host));
    if (old) return String(old.id);
    const id = newPrefixedId("vu");
    this.db.prepare("INSERT INTO vault_use_requests (id, item, item_id, host, agent, by, at) VALUES (?,?,?,?,?,?,?)").run(id, String(row.name), String(row.id), host, this.agentOf(meta) || "you", String(meta.caller || ""), Date.now());
    this.emit("vault.use-asked", { item: String(row.name), host });
    return id;
  }

  /** What waits for the person, for vault.pending (useHosts). Names and hosts only. */
  pending() {
    return /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_use_requests ORDER BY at").all()).map(r => ({ id: r.id, item: r.item, host: r.host, agent: r.agent, by: r.by, at: r.at }));
  }

  /** One waiting request, or null. @param {string} id */
  one(id) { return /** @type {any} */ (this.db.prepare("SELECT * FROM vault_use_requests WHERE id = ?").get(String(id))) || null; }

  /** The person's yes (vault.approve with a vu_ id): the host goes on the item's Used with. @param {string} id @param {string} caller */
  async approve(id, caller) {
    const r = this.one(id);
    if (!r) throw bad(`nothing pending with id ${printable(id, 40)}`, "not_found");
    const row = this.v.row(r.item);
    this.db.prepare("DELETE FROM vault_use_requests WHERE id = ?").run(r.id);
    if (!row || String(row.id) !== String(r.item_id)) throw bad(`${r.item} was changed or removed since it was asked; ask again`, "not_found");
    await this.setRules(row, { hosts: [...this.rules(row).hosts, r.host] }, caller);
    this.v.audit("use-allowed", row.name, caller, true, `with ${printable(r.host, 120)}`, { origin: r.host });
    this.emit("vault.use-allowed", { item: row.name, host: r.host });
    return { approved: { item: row.name, host: r.host } };
  }

  /** The person's no. @param {string} id @param {string} caller */
  decline(id, caller) {
    const r = this.one(id);
    if (!r) return { declined: false };
    this.db.prepare("DELETE FROM vault_use_requests WHERE id = ?").run(r.id);
    this.v.audit("use", r.item, caller, false, `declined: not with ${printable(r.host, 120)}`, { origin: r.host });
    this.emit("vault.use-allowed", { item: r.item, host: r.host, declined: true });
    return { declined: true };
  }

  // ---- sending ----

  /**
   * Make the call: to the checked, pinned address; a redirect only for a read and only on the same host, each hop checked again; the answer with every secret hidden.
   * @param {any} plan @param {any} meta @param {string | null} person @param {string} [why]
   */
  async execute(plan, meta, person, why = "") {
    const lookup = this.api && this.api.deps ? this.api.deps.lookup : undefined;
    const transport = this.api.transport;
    try {
      let t = await checkTarget(plan.filledUrl, [plan.host], { lookup });
      checkQuery(t.url);
      let hops = 0, reply;
      for (;;) {
        reply = await transport({ url: t.url, address: t.addresses[0], method: plan.method, headers: { accept: "application/json", ...plan.headers }, ...(plan.body !== undefined ? { body: plan.body } : {}), timeoutMs: 30_000, maxBytes: MAX_RESPONSE });
        if (reply.status >= 300 && reply.status < 400 && reply.headers.location) {
          if (plan.method !== "GET" && plan.method !== "HEAD") throw bad("the API answered a redirect to a write, which is refused; call the address it names directly", "redirect");
          let next;
          try { next = new URL(reply.headers.location, t.url); } catch { throw bad("the API answered a redirect to an address that is not one", "redirect"); }
          if (next.hostname.toLowerCase() !== plan.host) throw bad(`the API redirected to another host (${printable(next.hostname, 80)}); a secret never follows one`, "redirect");
          if (++hops > MAX_HOPS) throw bad("the API redirected more than five times", "redirect");
          t = await checkTarget(next.toString(), [plan.host], { lookup });
          continue;
        }
        break;
      }
      this.note(plan.names, meta, reply.status < 500, `${plan.method} ${reply.status}${why ? ` ${why}` : ""}`, plan.host, person);
      return this.shape(reply, plan.secrets);
    } catch (e) {
      const msg = hide(String(/** @type {Error} */ (e)?.message || e), plan.secrets);
      this.note(plan.names, meta, false, `${plan.method} failed${why ? ` ${why}` : ""}`, plan.host, person);
      throw Object.assign(new Error(msg), { code: /** @type {any} */ (e)?.code || "failed" });
    }
  }

  /** The answer as the caller sees it: kept headers, the body as JSON or text, every secret hidden in every form, cut to a model's size. @param {any} reply @param {{ value: string, label: string }[]} secrets */
  shape(reply, secrets) {
    const type = String(reply.headers["content-type"] || "");
    /** @type {Record<string, string>} */ const heads = {};
    for (const k of KEEP_HEADERS) if (reply.headers[k] !== undefined) heads[k] = hide(String(reply.headers[k]), secrets);
    const buf = Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body || "");
    const textual = /json|text|xml|javascript|x-www-form-urlencoded|csv|yaml|html/i.test(type) || (!type && !buf.includes(0));
    /** @type {any} */ let body = "";
    if (buf.length && !textual) {
      if (secrets.some(s => buf.includes(s.value) || buf.includes(Buffer.from(s.value).toString("base64")))) throw bad("the answer carries a secret in a file, so it is withheld", "withheld");
      body = { binary: true, bytes: buf.length, type: type || null };
    } else if (buf.length) {
      const text = buf.toString("utf8");
      body = hide(text, secrets);
      if (/json/i.test(type)) { try { body = hideAll(JSON.parse(text), secrets); } catch { /* keep the hidden text */ } }
    }
    let out = { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: heads, body, ...(reply.truncated ? { truncated: true } : {}) };
    const s = JSON.stringify(out);
    if (s.length > MAX_RESULT) out = { ...out, body: (typeof out.body === "string" ? out.body : JSON.stringify(out.body)).slice(0, MAX_RESULT - 4096) + ` [cut: the response was ${s.length} characters]`, truncated: true };
    return out;
  }

  // ---- scripts ----

  /**
   * Values for `vyre vault run --item` in an agent's session: each item must be one the agent may use AND marked Allowed in scripts. The env names are the fields' canonical names. The answer
   * is sealed to the key the command line made for this run, so the values are in no tool result.
   * @param {{ items: string[], key: string, command?: string }} input @param {any} meta
   */
  async env(input, meta) {
    const caller = String(meta.caller || "");
    if (!isAsker(caller)) throw bad("vyre vault run with --item is for an agent's session; on your own computer, vyre vault run names the items itself", "denied");
    if (/^(?:mcp|harness)$/.test(caller)) throw bad("vyre vault run --item runs in a session Vyre started for an agent or a chat; a plain session has none to judge", "denied");
    const items = Array.isArray(input.items) ? input.items.map(String) : [];
    if (!items.length || items.length > 10) throw bad("name one to ten items with --item");
    let key;
    try { key = crypto.createPublicKey({ key: Buffer.from(String(input.key || ""), "base64"), format: "der", type: "spki" }); } catch { key = null; }
    if (!key || key.asymmetricKeyType !== "x25519") throw bad("the run's key is not one this Vyre can seal to; run the command through vyre vault run");
    await this.v.key();
    const j = await this.judge(meta);
    const person = await this.personOf(meta);
    const command = printable(String(input.command || "a command").split("/").pop(), 80);
    /** @type {Record<string, string>} */ const env = {};
    const hidden = [];
    for (const name of items) {
      const hits = this.v.list().items.filter((/** @type {any} */ x) => canon(x.name) === canon(name));
      const row = hits.length === 1 ? this.v.row(hits[0].name) : null;
      if (!row || NOT_HERE.has(row.kind) || !(await j.may(row))) { this.v.audit("use", null, this.whoOf(meta), false, `refused: an item for ${command} that this caller may not use`); throw bad(`there is no item called ${printable(name, 80)} that you may use (vault.use.find lists them)`, "not_found"); }
      if (!this.rules(row).scripts) { this.note([row.name], meta, false, `refused: not allowed in scripts (${command})`, `command ${command}`, person); throw bad(`${row.name} is not allowed in scripts. The person can turn on Allowed in scripts for it in the Vault; until then use it through vault.request with {{vault:${row.name}.FIELD}}.`, "denied"); }
      const f = await this.v.fields(row);
      const rules = this.rules(row);
      for (const [k, v] of Object.entries(f)) {
        const c = canon(k), n = /^[0-9]/.test(c) ? `_${c}` : c;
        if (!c || typeof v !== "string") continue;
        if (Object.hasOwn(env, n) && env[n] !== v) throw bad(`two items give ${n}; run them one at a time`);
        env[n] = v;
        if (!this.plain(row, k, rules)) hidden.push(n);
      }
      this.note([row.name], meta, true, `run ${command}`, `command ${command}`, person);
    }
    return { box: sealFor(String(input.key), { env, hidden }, PURPOSE, PURPOSE), names: Object.keys(env) };
  }
}

/** What `vyre vault run --item` opens the sealed answer with (core/cli/session.js). */
export const RUN_PURPOSE = PURPOSE;

/**
 * @param {{ vault: import("./vault.js").Vault, api: any, said: any, tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void, emit?: (type: string, payload: any) => void }} o
 */
export function register({ vault, api, said, tool, emit }) {
  const use = new VaultUse(vault, api, said, emit);
  // vault.request without a credential is a placeholder request; a held one comes back here from the Gate (request.js).
  api.placeholders = (/** @type {any} */ input, /** @type {any} */ meta) => use.request(input, meta);
  api.placeholderSend = (/** @type {any} */ c, /** @type {any} */ held, /** @type {any} */ it, /** @type {string} */ caller) => use.send(c, held, it, caller);
  const str = { type: "string" };
  const obj = (/** @type {any} */ properties, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });

  tool("vault.use.find", ["cli", "local", "deck", "capsule", "mcp", "harness"], "Vault items you may use: names, field names, plain values. Secret fields show only their name; use them as {{vault:Item.FIELD}} in vault.request.",
    obj({ q: { type: "string", description: "words to match the item, its app or a field name" }, limit: { type: "integer" } }), (input, meta) => use.find(input || {}, meta));

  tool("vault.use.env", ["mcp", "harness"], "For vyre vault run --item in an agent's session: the items' fields for one program, sealed to the run's key. Only items Allowed in scripts.",
    obj({ items: { type: "array", items: str }, key: str, command: str }, ["items", "key"]), (input, meta) => use.env(input, meta));

  tool("vault.use.set", ["cli", "local", "deck", "capsule"], "Your rules for an item: Allowed in scripts, plain fields, the hosts it is used with; or decline a host an agent asked for.",
    obj({ name: str, scripts: { type: "boolean" }, plain: { type: "array", items: str }, hosts: { type: "array", items: str }, decline: str }, ["name"]),
    async (input, { caller }) => {
      if (input.decline !== undefined) return use.decline(String(input.decline), String(caller));
      const row = vault.row(String(input.name || ""));
      if (!row || NOT_HERE.has(row.kind)) throw bad(`no item named ${printable(input.name, 80)} that takes these rules`, "not_found");
      const names = json(row.fields, []).map(String);
      const plain = input.plain === undefined ? undefined : (Array.isArray(input.plain) ? input.plain : []).map(String).map(p => { const f = names.find(n => canon(n) === canon(p)); if (!f) throw bad(`${row.name} has no field ${printable(p, 64)}`); return f; });
      const hosts = input.hosts === undefined ? undefined : (Array.isArray(input.hosts) ? input.hosts : []).map(h => { const s = String(h).toLowerCase(); if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s) || isAddress(s)) throw bad(`${printable(h, 80)} is not a host name`); return s; });
      const out = await use.setRules(row, { ...(input.scripts !== undefined ? { scripts: input.scripts === true } : {}), ...(plain ? { plain } : {}), ...(hosts ? { hosts } : {}) }, String(caller));
      vault.audit("use-rules", row.name, String(caller), true, `scripts ${out.scripts ? "on" : "off"}; ${out.plain.length} plain; ${out.hosts.length} hosts`);
      return { name: row.name, ...out };
    },
    // Loosening needs the person present: a script can read the value, a plain field is shown to agents, a host receives the secret. Tightening never does.
    presence("Change who can use a vault item", input => {
      const parts = [];
      if (input.scripts === true) parts.push("let scripts read it");
      if (Array.isArray(input.plain) && input.plain.length) parts.push(`show ${input.plain.slice(0, 6).map(String).join(", ")} to agents`);
      if (Array.isArray(input.hosts) && input.hosts.length) parts.push(`send its secrets to ${input.hosts.slice(0, 6).map(String).join(", ")}`);
      return parts.length ? `For ${quoted(input.name)}: ${parts.join("; ")}` : `Change the rules for ${quoted(input.name)}`;
    }, { skip: (/** @type {any} */ { input }) => !(input && (input.scripts === true || (Array.isArray(input.plain) && input.plain.length) || (Array.isArray(input.hosts) && input.hosts.length))) }));

  return use;
}
