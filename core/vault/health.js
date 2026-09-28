// @ts-check
// health: Watchtower. vyred opens each item, judges it, and hands back names and reason codes
// only: never a value, a length, a strength number or a hash of one (docs/adr/0006, section 6).
//
// Reasons:
//   weak           a login password (or a secret) whose estimated guess cost is under WEAK_BITS
//   reused         the same value in more than one item; items share an opaque group id ("g1")
//                  that is made fresh on every run, so it says nothing across runs
//   old            not changed for more than a year
//   rotate         marked for rotation (a sealed pass ended, or someone marked it)
//   2fa-available  a login for a site on the bundled list that has no TOTP seed here
//   unprotected    a personal kind still in the agents class (only when the vault has classes)
//   expired        its details say it ended (a PAT, a certificate, a licence)
//   expiring       it ends within EXPIRING_MS
//
// The breach check is separate and opt-in (vault.breach: "ask"), because it is a network call:
// the first five characters of each password's SHA-1 go to api.pwnedpasswords.com, with padding,
// and the matching is done here. It returns names only.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PERSONAL_KINDS, defaultField } from "./kinds.js";

export const WEAK_BITS = 50;
export const OLD_MS = 365 * 86400_000;
export const EXPIRING_MS = 14 * 86400_000;

/** The bundled list of domains that offer two-factor codes. */
export function twofaDomains() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "twofa.json");
  try { return new Set(JSON.parse(fs.readFileSync(file, "utf8")).domains.map(d => String(d).toLowerCase())); } catch { return new Set(); }
}

// A short list of what people actually pick. Enough to catch "Summer2024!" and "p@ssw0rd1";
// a generated password never trips it.
const COMMON = ["password", "passw0rd", "qwerty", "letmein", "welcome", "admin", "iloveyou", "monkey", "dragon", "sunshine",
  "football", "baseball", "princess", "master", "shadow", "trustno1", "abc123", "hello", "freedom", "whatever", "secret",
  "summer", "winter", "spring", "autumn", "login", "changeme", "default", "starwars", "superman", "batman", "michael",
  "charlie", "jennifer", "hunter", "ninja", "access", "pokemon", "computer", "internet", "company", "office", "test"];
const LEET = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };
const SEQ = "abcdefghijklmnopqrstuvwxyz0123456789 qwertyuiopasdfghjklzxcvbnm";

/**
 * A rough guess-cost estimate in bits: the character pool times the length, then cut for
 * repeats, runs, dates and common words. Deliberately pessimistic; it is used only to decide
 * weak or not, and the number never leaves vyred.
 * @param {string} pw
 */
export function estimateBits(pw) {
  const s = String(pw || "");
  if (!s) return 0;
  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/[0-9]/.test(s)) pool += 10;
  if (/[^A-Za-z0-9]/.test(s)) pool += 33;
  // Each character counts less when it repeats or continues a run (abc, 123, qwe).
  let effective = 0;
  const lower = s.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    const c = lower[i], prev = lower[i - 1];
    if (i > 0 && c === prev) { effective += 0.25; continue; }
    if (i > 0 && SEQ.includes(prev + c)) { effective += 0.35; continue; }
    effective += 1;
  }
  let bits = effective * Math.log2(Math.max(pool, 2));
  // A common word inside, after undoing leet, costs about a dictionary lookup (~12 bits) instead
  // of its letters.
  const plain = lower.replace(/[013457@$!]/g, ch => LEET[ch] || ch);
  for (const w of COMMON) {
    const at = plain.indexOf(w);
    if (at >= 0) { bits -= w.length * Math.log2(Math.max(pool, 2)) - 12; break; }
  }
  // A year or a date is a few bits, not 4 digits' worth.
  if (/(19|20)\d\d/.test(s)) bits -= 4 * Math.log2(Math.max(pool, 2)) - 7;
  return Math.max(0, Math.round(bits * 10) / 10);
}

/** "mail.google.co.uk" → "google.co.uk"; "api.github.com" → "github.com". Good enough for a list lookup. */
export function registrable(host) {
  const parts = String(host || "").toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const second = parts[parts.length - 2];
  const cc = parts[parts.length - 1].length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu"].includes(second);
  return parts.slice(cc ? -3 : -2).join(".");
}

function hostsOf(item) {
  const out = [];
  for (const u of [...(item.hosts || []), ...(item.url ? [item.url] : [])]) {
    try { out.push(new URL(String(u)).hostname); } catch {}
  }
  return out;
}

/**
 * Judge every item. `items` carry their opened fields; the result carries none of them.
 * @param {{ name: string, kind: string, fields: Record<string, string>, url?: string|null, hosts?: string[],
 *   updated: number, rotate?: any, class?: string|null, details?: { expires?: number } }[]} items
 * @param {{ now?: number, twofa?: Set<string>, classes?: boolean }} [opts]
 * @returns {{ items: { name: string, kind: string, reasons: string[], group?: string }[], counts: Record<string, number>, checked: number }}
 */
export function judge(items, { now = Date.now(), twofa = twofaDomains(), classes = false } = {}) {
  // Reuse: group by an HMAC under a key made for this run only, so nothing stable leaves.
  const runKey = crypto.randomBytes(32);
  const tag = v => crypto.createHmac("sha256", runKey).update(String(v)).digest("hex");
  const byTag = new Map();
  for (const it of items) {
    for (const v of secretsOf(it)) {
      const t = tag(v);
      if (!byTag.has(t)) byTag.set(t, new Set());
      byTag.get(t).add(it.name);
    }
  }
  const groupOf = new Map();
  let g = 0;
  for (const names of byTag.values()) {
    if (names.size < 2) continue;
    const id = "g" + (++g);
    for (const n of names) if (!groupOf.has(n)) groupOf.set(n, id);
  }

  const counts = { weak: 0, reused: 0, old: 0, rotate: 0, "2fa-available": 0, unprotected: 0, expired: 0, expiring: 0 };
  const out = [];
  for (const it of items) {
    const reasons = [];
    const pw = it.kind === "login" ? it.fields.password : it.kind === "secret" ? it.fields.value : undefined;
    if (typeof pw === "string" && pw && estimateBits(pw) < WEAK_BITS) reasons.push("weak");
    if (groupOf.has(it.name)) reasons.push("reused");
    if (now - Number(it.updated || now) > OLD_MS) reasons.push("old");
    if (it.rotate) reasons.push("rotate");
    if (it.kind === "login" && !it.fields.totp && hostsOf(it).some(h => twofa.has(registrable(h)) || twofa.has(h))) reasons.push("2fa-available");
    if (classes && it.class === "agents" && (PERSONAL_KINDS.includes(it.kind) || it.fields.totp)) reasons.push("unprotected");
    const ends = it.details && Number(it.details.expires);
    if (ends && ends <= now) reasons.push("expired");
    else if (ends && ends - now <= EXPIRING_MS) reasons.push("expiring");
    for (const r of reasons) counts[r] += 1;
    if (reasons.length) out.push({ name: it.name, kind: it.kind, reasons, ...(groupOf.has(it.name) ? { group: /** @type {string} */ (groupOf.get(it.name)) } : {}) });
  }
  return { items: out, counts, checked: items.length };
}

/** The values reuse is judged on: passwords, single-value secrets and tokens, not usernames or notes. */
function secretsOf(it) {
  const f = it.fields || {};
  if (it.kind === "login") return f.password ? [f.password] : [];
  if (it.kind === "secret" || it.kind === "api-key") return f.value ? [f.value] : [];
  if (it.kind === "env-set") return Object.values(f).filter(v => typeof v === "string" && v.length >= 8);
  // A typed credential is judged on the value it hands over (a PAT's token, a cloud secret key).
  if (["pat", "oauth", "cloud", "db-url", "wifi", "license"].includes(it.kind)) {
    const k = defaultField(it.kind, Object.keys(f));
    return k && typeof f[k] === "string" && f[k].length >= 8 ? [f[k]] : [];
  }
  return [];
}

export const BREACH_URL = "https://api.pwnedpasswords.com/range/";

/**
 * Check passwords against known breaches with k-anonymity: only the first five hex characters
 * of each SHA-1 leave, with Add-Padding so the reply size says nothing either.
 * @param {{ name: string, password: string }[]} entries
 * @param {{ fetch: typeof globalThis.fetch }} deps
 * @returns {Promise<{ breached: string[], checked: number, requests: number }>}
 */
export async function breachCheck(entries, { fetch }) {
  const byPrefix = new Map();
  for (const e of entries) {
    if (!e.password) continue;
    const h = crypto.createHash("sha1").update(e.password, "utf8").digest("hex").toUpperCase();
    const p = h.slice(0, 5);
    if (!byPrefix.has(p)) byPrefix.set(p, []);
    byPrefix.get(p).push({ name: e.name, suffix: h.slice(5) });
  }
  const breached = new Set();
  for (const [prefix, list] of byPrefix) {
    let res;
    try { res = await fetch(BREACH_URL + prefix, { headers: { "Add-Padding": "true", "user-agent": "vyre-vault" } }); }
    catch { throw new Error("api.pwnedpasswords.com did not answer; nothing was checked after that"); }
    if (!res.ok) throw new Error(`api.pwnedpasswords.com answered ${res.status}`);
    const hits = new Set();
    for (const line of String(await res.text()).split("\n")) {
      const [suffix, count] = line.trim().split(":");
      // Padding rows have a count of 0.
      if (suffix && Number(count) > 0) hits.add(suffix.toUpperCase());
    }
    for (const e of list) if (hits.has(e.suffix)) breached.add(e.name);
  }
  return { breached: [...breached].sort(), checked: entries.filter(e => e.password).length, requests: byPrefix.size };
}
