// @ts-check
// relay: the transport and the pure checks behind a relayed pass (ADR 0001, decision 7).
//
// A relayed pass lets a holder use an owner's credential without ever receiving it. The holder's
// vyred signs a request envelope and posts it to the owner's relay listener; the owner checks the
// signature, the clock, the nonce and the destination, adds the value, sends the request and
// scrubs the value from what comes back. This file holds the parts of that path that need no
// pass database: encoding cards and tickets, signing and checking envelopes, the host allowlist,
// placeholder substitution, scrubbing, the outbound send and the listener itself. The vault
// module supplies pass lookup through the onRelay callback, so every check here stays testable
// on its own.
//
// Rules this file enforces, and why:
// - A placeholder in a URL is refused. A value in a URL lands in access logs and proxies.
// - Redirects are never followed. A redirect would carry the credential to a host nobody allowed.
// - Origins match exactly, scheme, host and port. A wildcard is a way to reach a host you control.
// - Responses are scrubbed of the value and of its base64 and URL-encoded forms, since servers
//   echo what they are sent.
// - Placeholders go in headers only, unless the item allows the body. A body is where a value
//   gets written somewhere the holder can read it back (a public gist, a paste), which a header
//   almost never is (ADR 0006, finding 5).
// - Upstream requests are https, except to loopback. A value in clear text on a network is a
//   value given to whoever is on the path.
// - Cards, tickets and envelopes (relay, sync and emergency) are signed over a domain tag, so a
//   signature made for one can never be replayed as another. Envelopes also name their audience, the owner's relay address,
//   so one signed for Dana's box cannot be spent at Alex's.

import crypto from "node:crypto";
import http from "node:http";
import { sign, verify, canonical } from "./crypto.js";
import { capValues } from "../link/transport.js";

const CARD_V1 = "vyre-card:v1:";
const CARD_PREFIX = "vyre-card:v2:";
const TICKET_V1 = "vyre-pass:v1:";
const TICKET_PREFIX = "vyre-pass:v2:";
const CARD_TAG = "vyre-card-v2";
const TICKET_TAG = "vyre-ticket-v1";
const ENVELOPE_TAG = "vyre-relay-v2";
const ENVELOPE_V = 2;
const CONCEALED = "<concealed by vyre>";
const SKEW_MS = 60_000;
const SEEN_TTL_MS = 120_000;

const isStr = v => typeof v === "string" && v.length > 0;
const b64url = s => Buffer.from(s, "utf8").toString("base64url");

function unwrap(str, prefix, what) {
  if (typeof str !== "string") throw new Error(`a ${what} must be a string`);
  const s = str.trim();
  if (!s.startsWith(prefix)) throw new Error(`not a ${what}: it should start with "${prefix}"`);
  const rest = s.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(rest)) throw new Error(`this ${what} is damaged: the part after "${prefix}" is not base64url`);
  let obj;
  try { obj = JSON.parse(Buffer.from(rest, "base64url").toString("utf8")); }
  catch { throw new Error(`this ${what} is damaged: its contents are not JSON`); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`this ${what} is damaged: its contents are not an object`);
  return obj;
}

/**
 * A card. v2 is signed by the identity sign key and carries the account and devices; v1 was
 * unsigned and is still read, but only so a person can pin it and verify it by hand.
 * @typedef {{ v: 1|2, name: string, sign: string, box: string, relay: string, login?: string, acct?: string,
 *   devices?: any[], sig?: string }} Card
 */

/** @param {any} c @param {1|2} v @returns {Card} */
function checkCard(c, v) {
  // relay may be empty: a Vyre with no relay listener can still receive sealed passes.
  for (const k of ["name", "sign", "box"]) if (!isStr(c?.[k])) throw new Error(`card is missing "${k}"`);
  if (typeof c.relay !== "string") throw new Error(`card is missing "relay"`);
  if (c.login !== undefined && typeof c.login !== "string") throw new Error(`card "login" must be text`);
  if (c.acct !== undefined && typeof c.acct !== "string") throw new Error(`card "acct" must be text`);
  if (v === 2 && (!Array.isArray(c.devices) || !c.devices.every(d => d && typeof d === "object" && !Array.isArray(d)))) throw new Error(`card "devices" must be a list`);
  // login, optional: the person's Tailscale login, so a pass can be bound to it as well as to the device key.
  /** @type {Card} */
  const out = { v, name: c.name, sign: c.sign, box: c.box, relay: c.relay, ...(c.login ? { login: c.login } : {}) };
  if (v === 2) Object.assign(out, c.acct ? { acct: c.acct } : {}, { devices: c.devices });
  return out;
}

/** The signed part of a v2 card. */
const cardBody = c => ({ acct: c.acct, name: c.name, sign: c.sign, box: c.box, login: c.login, relay: c.relay, devices: c.devices || [] });

/**
 * A v2 card: `vyre-card:v2:` + base64url(canonical JSON), signed by the identity key it names.
 * Carries no secret.
 * @param {Omit<Card, "v" | "sig">} obj @param {string} privDer the identity's Ed25519 private key
 */
export function encodeCard(obj, privDer) {
  const body = cardBody(checkCard({ devices: [], ...obj }, 2));
  return CARD_PREFIX + b64url(canonical({ ...body, sig: sign(privDer, { tag: CARD_TAG, ...body }) }));
}

/**
 * Read a card back, v2 or v1. A v2 card whose signature does not verify against its own sign key
 * is refused. Throws a readable error on a wrong prefix or a malformed body.
 * @param {string} str @returns {Card}
 */
export function decodeCard(str) {
  const s = typeof str === "string" ? str.trim() : str;
  if (typeof s === "string" && s.startsWith(CARD_V1)) return checkCard(unwrap(s, CARD_V1, "Vyre card"), 1);
  const raw = unwrap(s, CARD_PREFIX, "Vyre card");
  const c = checkCard(raw, 2);
  if (!isStr(raw.sig) || !verify(c.sign, { tag: CARD_TAG, ...cardBody(c) }, raw.sig)) throw new Error("this Vyre card's signature does not match its key, so it was altered or forged");
  return { ...c, sig: raw.sig };
}

/**
 * A pass ticket, signed by the owner. `ownerCard` lets the holder pin the owner on first contact;
 * `holderSign` names the one Vyre the ticket is for.
 * @typedef {{ pass: string, owner: string, relay: string, ownerSign: string, ownerCard: string, holder: string,
 *   holderSign: string, items: string[], mode: "relayed"|"sealed", expires: number|null, sealed?: Record<string, any>,
 *   sig?: string }} Ticket
 */

/** @param {any} t @returns {Ticket} */
function checkTicket(t) {
  for (const k of ["pass", "owner", "ownerSign", "ownerCard", "holder", "holderSign"]) if (!isStr(t?.[k])) throw new Error(`pass ticket is missing "${k}"`);
  if (typeof t.relay !== "string" || (t.mode === "relayed" && !t.relay)) throw new Error(`pass ticket is missing "relay"`);
  if (!Array.isArray(t.items) || !t.items.length || !t.items.every(isStr)) throw new Error("pass ticket needs a non-empty list of item names");
  if (t.mode !== "relayed" && t.mode !== "sealed") throw new Error(`pass ticket mode must be "relayed" or "sealed"`);
  if (t.expires !== null && !(typeof t.expires === "number" && Number.isFinite(t.expires))) throw new Error("pass ticket expires must be a time in ms or null");
  /** @type {Ticket} */
  const out = { pass: t.pass, owner: t.owner, relay: t.relay, ownerSign: t.ownerSign, ownerCard: t.ownerCard, holder: t.holder, holderSign: t.holderSign, items: [...t.items], mode: t.mode, expires: t.expires };
  if (t.mode === "sealed") {
    if (!t.sealed || typeof t.sealed !== "object" || Array.isArray(t.sealed)) throw new Error("a sealed pass ticket must carry its sealed items");
    for (const item of t.items) if (!t.sealed[item] || typeof t.sealed[item] !== "object") throw new Error(`sealed pass ticket is missing item "${item}"`);
    out.sealed = t.sealed;
  } else if (t.sealed !== undefined) throw new Error("a relayed pass ticket carries no sealed items");
  return out;
}

/**
 * A signed pass ticket: `vyre-pass:v2:` + base64url(canonical JSON). The owner signs
 * canonical({ tag: "vyre-ticket-v1", ...ticket }).
 * @param {Omit<Ticket, "sig">} obj @param {string} privDer the owner's Ed25519 private key
 */
export function encodeTicket(obj, privDer) {
  const t = checkTicket(obj);
  return TICKET_PREFIX + b64url(canonical({ ...t, sig: sign(privDer, { tag: TICKET_TAG, ...t }) }));
}

/**
 * Read a ticket back and check it is whole: signed by `ownerSign`, and carrying a card for that
 * same key. Whether that key is the one this Vyre pinned for the owner is the caller's check.
 * An old unsigned ticket is refused with a message that says what to do.
 * @param {string} str @returns {Ticket}
 */
export function decodeTicket(str) {
  const s = typeof str === "string" ? str.trim() : str;
  if (typeof s === "string" && s.startsWith(TICKET_V1)) {
    let owner = "the owner";
    try { owner = String(unwrap(s, TICKET_V1, "pass ticket").owner || owner); } catch {}
    throw new Error(`this pass ticket is from an older Vyre and is not signed, so nothing proves ${owner} made it · ask them to update Vyre and create the pass again`);
  }
  const raw = unwrap(s, TICKET_PREFIX, "pass ticket");
  const t = checkTicket(raw);
  if (!isStr(raw.sig) || !verify(t.ownerSign, { tag: TICKET_TAG, ...t }, raw.sig)) throw new Error("this pass ticket's signature does not match its owner's key, so it was altered or forged");
  let card;
  try { card = decodeCard(t.ownerCard); } catch (e) { throw new Error(`this pass ticket carries a bad owner card: ${/** @type {Error} */ (e).message}`); }
  if (card.v !== 2 || card.sign !== t.ownerSign) throw new Error("this pass ticket's owner card is for a different key than the one that signed it");
  return { ...t, sig: raw.sig };
}

/**
 * @typedef {{ method?: string, url: string, headers?: Record<string, string>, body?: string }} RelayRequest
 * @typedef {{ v: 2, aud: string, pass: string, item: string, request: RelayRequest, ts: number, nonce: string, sig: string }} Envelope
 */

/** What an envelope's signature covers: the tag, the version, the audience and the request. */
const envelopeBody = e => ({ tag: ENVELOPE_TAG, v: e.v, aud: e.aud, pass: e.pass, item: e.item, request: e.request, ts: e.ts, nonce: e.nonce });

/**
 * Sign a relay request with the holder's device key, for one owner's relay (`aud`).
 * @param {{ pass: string, item: string, request: RelayRequest, privDer: string, aud: string, now?: number }} a
 * @returns {Envelope}
 */
export function envelope({ pass, item, request, privDer, aud, now = Date.now() }) {
  /** @type {Omit<Envelope, "sig">} */
  const e = { v: ENVELOPE_V, aud: String(aud), pass, item, request, ts: now, nonce: crypto.randomBytes(16).toString("base64url") };
  return { ...e, sig: sign(privDer, envelopeBody(e)) };
}

/**
 * Nonces for replay refusal, kept in vyre.db so a restart does not reopen the window. `claim`
 * is one INSERT, so two requests racing with one nonce cannot both pass.
 * @param {import("node:sqlite").DatabaseSync} db a database with the vault_relay_nonces table
 */
export function dbNonces(db) {
  const ins = db.prepare("INSERT OR IGNORE INTO vault_relay_nonces (nonce, ts) VALUES (?, ?)");
  const del = db.prepare("DELETE FROM vault_relay_nonces WHERE ts < ?");
  return {
    /** @param {number} now */
    prune: now => { del.run(now - SEEN_TTL_MS); },
    /** @param {string} nonce @param {number} ts */
    claim: (nonce, ts) => Number(ins.run(nonce, ts).changes) === 1,
  };
}

/**
 * Check an envelope against the pass's holder key and this relay's own address. Returns null
 * when valid, otherwise a short reason. A valid nonce is recorded in `seen`: a Map (nonce -> ts)
 * or a dbNonces store. Entries older than 120 s are dropped, which is safe because a timestamp
 * that old already fails the 60 s window.
 * @param {any} env
 * @param {{ holderKey: string, audience: string, now?: number,
 *   seen: Map<string, number> | { prune(now: number): void, claim(nonce: string, ts: number): boolean } }} o
 * @returns {string|null}
 */
export function checkEnvelope(env, { holderKey, audience, now = Date.now(), seen }) {
  if (seen instanceof Map) { for (const [nonce, ts] of seen) if (now - ts > SEEN_TTL_MS) seen.delete(nonce); }
  else seen.prune(now);
  if (!env || typeof env !== "object" || !isStr(env.pass) || !isStr(env.item) || !isStr(env.nonce) || !isStr(env.sig)
    || typeof env.ts !== "number" || !env.request || typeof env.request !== "object" || !isStr(env.request.url)) return "malformed envelope";
  if (env.v !== ENVELOPE_V) return "this request comes from an older Vyre; update it";
  if (!isStr(env.aud) || env.aud !== audience) return "this request was signed for another relay";
  if (!verify(holderKey, envelopeBody(env), env.sig)) return "bad signature";
  if (Math.abs(now - env.ts) > SKEW_MS) return "timestamp outside 60 s window";
  if (seen instanceof Map) {
    if (seen.has(env.nonce)) return "replayed nonce";
    seen.set(env.nonce, env.ts);
  } else if (!seen.claim(env.nonce, env.ts)) return "replayed nonce";
  return null;
}

const SYNC_TAG = "vyre-sync-v1";
const syncBody = e => ({ tag: SYNC_TAG, v: e.v, aud: e.aud, from: e.from, vault: e.vault, op: e.op, body: e.body, ts: e.ts, nonce: e.nonce });

/**
 * A shared-vault sync request, signed by a member's device key for one home (`aud`). The same
 * guards as a relay envelope: a domain tag, the audience, a timestamp and a nonce.
 * @param {{ vault: string, op: string, body: any, from: string, privDer: string, aud: string, now?: number }} a
 */
export function syncEnvelope({ vault, op, body, from, privDer, aud, now = Date.now() }) {
  const e = { v: 1, aud: String(aud), from, vault, op, body, ts: now, nonce: crypto.randomBytes(16).toString("base64url") };
  return { ...e, sig: sign(privDer, syncBody(e)) };
}

/**
 * Check a sync envelope. `key` is the sender's sign key, which the caller has already found in
 * the vault's manifest. Returns null when valid, or a short reason.
 * @param {any} env @param {{ audience: string, now?: number, seen: { prune(now: number): void, claim(nonce: string, ts: number): boolean } }} o
 */
export function checkSync(env, { audience, now = Date.now(), seen }) {
  seen.prune(now);
  if (!env || typeof env !== "object" || env.v !== 1 || !isStr(env.from) || !isStr(env.vault) || !isStr(env.op) || !isStr(env.nonce)
    || !isStr(env.sig) || typeof env.ts !== "number") return "malformed sync request";
  if (env.aud !== audience) return "this request was signed for another home";
  if (!verify(env.from, syncBody(env), env.sig)) return "bad signature";
  if (Math.abs(now - env.ts) > SKEW_MS) return "timestamp outside 60 s window";
  if (!seen.claim(env.nonce, env.ts)) return "replayed nonce";
  return null;
}

const EMERGENCY_TAG = "vyre:emergency:v1";
/** What an emergency envelope's signature covers. The shape of a sync envelope, under its own tag. */
const emergencyBody = e => ({ tag: EMERGENCY_TAG, v: e.v, aud: e.aud, from: e.from, op: e.op, ts: e.ts, nonce: e.nonce });

/**
 * An emergency-access request from a contact to an owner's relay (`aud`), signed by the
 * contact's device key. `op` is "request" or "status". The same guards as a sync envelope: a
 * domain tag of its own, the audience, a timestamp and a nonce.
 * @param {{ op: string, from: string, privDer: string, aud: string, now?: number }} a
 */
export function emergencyEnvelope({ op, from, privDer, aud, now = Date.now() }) {
  const e = { v: 1, aud: String(aud), from, op, ts: now, nonce: crypto.randomBytes(16).toString("base64url") };
  return { ...e, sig: sign(privDer, emergencyBody(e)) };
}

/**
 * Check an emergency envelope. `env.from` is the sender's sign key, which the caller has already
 * matched to a pinned person. The signature is checked before the audience, so a stranger who
 * knows a contact's public key learns nothing from the reason. Null when valid, or a short reason.
 * @param {any} env @param {{ audience: string, now?: number, seen: { prune(now: number): void, claim(nonce: string, ts: number): boolean } }} o
 */
export function checkEmergency(env, { audience, now = Date.now(), seen }) {
  seen.prune(now);
  if (!env || typeof env !== "object" || env.v !== 1 || !isStr(env.from) || !isStr(env.op) || !isStr(env.nonce)
    || !isStr(env.sig) || typeof env.ts !== "number" || !isStr(env.aud)) return "malformed emergency request";
  if (!verify(env.from, emergencyBody(env), env.sig)) return "bad signature";
  if (env.aud !== audience) return "this request was signed for another relay";
  if (Math.abs(now - env.ts) > SKEW_MS) return "timestamp outside 60 s window";
  if (!seen.claim(env.nonce, env.ts)) return "replayed nonce";
  return null;
}

/** 127.0.0.0/8, ::1 and localhost. */
export function isLoopback(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** https, or http to loopback only. A relayed value never crosses a network in clear text. */
export function secureTarget(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u.hostname));
}

/**
 * A pass's optional method and path allowlists. Paths match by prefix on the URL's normalised
 * path, so `/v1/../gists` is judged as `/gists`. Returns null when allowed, or the reason.
 * @param {RelayRequest} request @param {{ methods?: string[]|null, paths?: string[]|null }} rules
 */
export function requestAllowed(request, { methods, paths } = {}) {
  const m = String(request.method || "GET").toUpperCase();
  if (methods && methods.length && !methods.includes(m)) return `this pass allows only ${methods.join(", ")}`;
  if (paths && paths.length) {
    let p;
    try { p = new URL(request.url).pathname; } catch { return "request url is not a valid URL"; }
    if (!paths.some(x => p.startsWith(x))) return `this pass allows only paths under ${paths.join(", ")}`;
  }
  return null;
}

/**
 * True only when `url` is http or https and its origin equals one of `hosts` exactly (scheme,
 * host and port). No wildcards. Each host is an origin string like "https://api.example.com".
 * @param {string} url @param {string[]} hosts
 */
export function allowedOrigin(url, hosts) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  for (const h of hosts || []) {
    try { if (new URL(h).origin === u.origin) return true; } catch {}
  }
  return false;
}

/** The app capability a tailnet grant carries to let a peer use relayed vault items (ADR 0014, part 7). */
export const VAULT_CAP = "vyre.run/cap/vault";

/**
 * Whether the tailnet policy, as `whois` reported it for a peer, grants that peer `item` in
 * `mode`. A grant entry is `{ items: ["northwind-*", "harlow-portal"], mode: "relayed"|"sealed"|"any" }`;
 * an item pattern is an exact name or a trailing-* prefix, nothing else, and an entry without a
 * mode or items grants nothing. The answer only ever narrows: the pass is still what gives access.
 * @param {{ caps?: Record<string, any[]> } | null | undefined} who @param {string} item @param {string} mode
 */
export function grantCovers(who, item, mode) {
  return capValues(who, VAULT_CAP).some(g => g && typeof g === "object" && (g.mode === "any" || g.mode === mode)
    && Array.isArray(g.items) && g.items.some(p => typeof p === "string" && p !== ""
      && (p.endsWith("*") ? String(item).startsWith(p.slice(0, -1)) : p === item)));
}

const PLACEHOLDER =/\{\{\s*vault(?:\.([A-Za-z0-9_-]+))?\s*\}\}/g;
const HAS_PLACEHOLDER = /\{\{\s*vault(?:\.[A-Za-z0-9_-]+)?\s*\}\}/;

/**
 * Put an item's field values into a request's header values, and into the body only when the
 * item allows it (`body: true`). `{{vault}}` means the default field, `{{vault.<field>}}` a named
 * one. A placeholder in the URL or a header name is refused, and so is an unknown field. Returns
 * a new request and the values used, for scrubbing.
 * @param {RelayRequest} request @param {Record<string, string>} fields @param {string} defaultField
 * @param {{ body?: boolean }} [o]
 * @returns {{ request: RelayRequest, values: string[] }}
 */
export function substitute(request, fields, defaultField, { body = false } = {}) {
  if (!request || typeof request.url !== "string") throw new Error("request needs a url");
  if (HAS_PLACEHOLDER.test(request.url)) throw new Error("a vault placeholder cannot go in the url: a value there ends up in access logs. Put it in a header or the body");
  const values = new Set();
  const fill = s => String(s).replace(PLACEHOLDER, (_, field) => {
    const name = field || defaultField;
    const v = fields?.[name];
    if (typeof v !== "string") throw new Error(`this item has no field "${name}"`);
    values.add(v);
    return v;
  });
  /** @type {RelayRequest} */
  const out = { ...request };
  if (request.headers) {
    out.headers = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (HAS_PLACEHOLDER.test(k)) throw new Error("a vault placeholder cannot go in a header name");
      out.headers[k] = fill(v);
    }
  }
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body !== "string") throw new Error("request body must be a string");
    if (!body && HAS_PLACEHOLDER.test(request.body)) throw new Error("this item's value may go in headers only; its owner can allow the body with relay.body");
    out.body = body ? fill(request.body) : request.body;
  }
  return { request: out, values: [...values] };
}

/**
 * Replace every occurrence of each value, and of its base64, base64url and URL-encoded forms,
 * with a marker. Values shorter than 4 characters are skipped: scrubbing them would shred text.
 * @param {string} text @param {string[]} values
 */
export function scrub(text, values) {
  let out = String(text ?? "");
  const forms = new Set();
  for (const v of values || []) {
    if (typeof v !== "string" || v.length < 4) continue;
    const b = Buffer.from(v, "utf8");
    for (const f of [v, b.toString("base64"), b.toString("base64").replace(/=+$/, ""), b.toString("base64url"), encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, "+")]) {
      if (f.length >= 4) forms.add(f);
    }
  }
  // Longest first, so a form that contains another is replaced whole.
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join(CONCEALED);
  return out;
}

/**
 * Send a request the way a relay must: redirects off, a timeout, and a cap on the response size.
 * @param {RelayRequest} request
 * @param {{ timeoutMs?: number, maxBytes?: number }} [o]
 * @returns {Promise<{ status: number, headers: { "content-type"?: string, location?: string }, body: string }>}
 */
export async function send(request, { timeoutMs = 30000, maxBytes = 5_000_000 } = {}) {
  let u;
  try { u = new URL(request.url); } catch { throw new Error("request url is not a valid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("request url must be http or https");
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  try {
    const res = await fetch(u, { method: (request.method || "GET").toUpperCase(), headers: request.headers, body: request.body ?? undefined, redirect: "manual", signal: ctl.signal });
    /** @type {{ "content-type"?: string, location?: string }} */
    const headers = {};
    const ct = res.headers.get("content-type"); if (ct) headers["content-type"] = ct;
    const loc = res.headers.get("location"); if (loc) headers.location = loc;
    let body = "", size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          ctl.abort();
          await reader.cancel().catch(() => {});
          throw new Error(`response is larger than ${maxBytes} bytes`);
        }
        body += dec.decode(value, { stream: true });
      }
      body += dec.decode();
    }
    return { status: res.status, headers, body };
  } catch (e) {
    if (timedOut) throw new Error(`no response within ${timeoutMs} ms`);
    throw e;
  } finally { clearTimeout(timer); }
}

const MAX_BODY = 6 * 1024 * 1024;

/** Refuse `identity: "tailscale"` on a bind other than loopback, in words a person can act on. */
export function checkBind(host, identity) {
  if (identity === "tailscale" && !isLoopback(host)) {
    throw new Error(`vault.relay.identity "tailscale" needs vault.relay.host to be 127.0.0.1: on ${host} anyone who reaches the port can forge the Tailscale login header · bind to loopback and publish it with tailscale serve`);
  }
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large", "request body is over 6 MB");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "bad_input", "request body is not JSON"); }
}

/**
 * Start the relay listener. `POST /v1/relay`, and `/v1/sync` and `/v1/emergency` when their
 * handlers are given; everything else is 404.
 * `login` is the Tailscale-User-Login header that `tailscale serve` adds to what it proxies. It
 * means something only when the listener is reachable through serve alone, so it is passed on
 * only with `identity: "tailscale"`, and that is refused on a bind other than loopback: anyone
 * who can reach a public bind can write the header themselves.
 * @param {{ host?: string, port?: number, identity?: string|null, onRelay: (env: any, meta: { remoteAddress?: string, login?: string|null }) => Promise<{ status: number, body: any }>,
 *   onSync?: ((env: any, meta: any) => Promise<{ status: number, body: any }>) | null, onEmergency?: ((env: any, meta: any) => Promise<{ status: number, body: any }>) | null }} o
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function serve({ host = "127.0.0.1", port = 0, identity = null, onRelay, onSync = null, onEmergency = null }) {
  checkBind(host, identity);
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url || "/", "http://relay").pathname;
      // /v1/sync: shared vaults, answered only by a home that has them (share.js, shared.js).
      // /v1/emergency: a contact asking for, or collecting, emergency access (emergency.js).
      const handler = path === "/v1/relay" ? onRelay : path === "/v1/sync" && onSync ? onSync
        : path === "/v1/emergency" && onEmergency ? onEmergency : null;
      if (req.method !== "POST" || !handler) return reply(res, 404, { error: { code: "not_found", message: `${req.method} ${path}` } });
      const env = await readJson(req);
      const login = identity === "tailscale" ? req.headers["tailscale-user-login"] : null;
      const out = await handler(env, { remoteAddress: req.socket.remoteAddress, login: typeof login === "string" && login ? login : null });
      reply(res, out?.status || 200, out?.body ?? {});
    } catch (e) {
      if (e instanceof HttpError) return reply(res, e.status, { error: { code: e.code, message: e.message } });
      // Never the message: it can carry a path, a host or worse, and the caller is someone else.
      if (!res.headersSent) reply(res, 500, { error: { code: "internal", message: "the relay failed; its owner can see why in vyre vault audit" } });
      else res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(undefined)); });
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  const h = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return {
    url: `http://${h}:${addr.port}`,
    close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); }),
  };
}

/**
 * Post an envelope to an owner's relay listener. Returns the parsed `{data}` or `{error}`, or an
 * `unreachable` error when the owner's box does not answer.
 * @param {string} relayUrl @param {Envelope} env @param {{ timeoutMs?: number }} [o]
 * @returns {Promise<any>}
 */
export async function callRelay(relayUrl, env, { timeoutMs = 45000, route = "/v1/relay" } = {}) {
  let res;
  const target = new URL(route, relayUrl);
  try {
    res = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env), redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const why = e?.name === "TimeoutError" ? `no answer within ${timeoutMs} ms` : (e?.cause?.code || e?.message || "connection failed");
    return { error: { code: "unreachable", message: `the owner's Vyre at ${target.origin} did not answer (${why})` } };
  }
  let text;
  try { text = await res.text(); } catch (e) { return { error: { code: "unreachable", message: `the owner's Vyre stopped mid-reply (${e?.message})` } }; }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && ("data" in parsed || "error" in parsed)) return parsed;
  } catch {}
  return { error: { code: "bad_response", message: `the owner's Vyre answered ${res.status} with something that is not a relay reply` } };
}
