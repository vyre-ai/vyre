// @ts-check
// The space vault (ADR 0054). One random key per generation, wrapped to each member and to a server key.
// The server private key is sealed at rest. Its key-encryption key sits outside this directory, so a member's copy never has it.
// Agents and Flows open items with the server wrap while nobody is unlocked. Removing a member drops their wrap, then rotates the key.
// A failed rotation throws, retries, and leaves the member without a wrap. A crash keeps the last committed generation readable.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { scrub as conceal } from "../../lib/scrub.js";
import { hostAllowed, normalizeHostList } from "../../lib/vault-hosts.js";
import { writePrivate, readJson, rmQuiet } from "./files.js";
import { ensureKek, readKek } from "./sealed-key.js";
import { hkdf32, x25519Pair, sealTo, openSeal, aesWrap, aesUnwrap } from "./wrap.js";

const ITEM_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const refuse = (message, code) => Object.assign(new Error(message), { code });

const statePath = (/** @type {string} */ dir) => path.join(dir, "state.json");
const journalPath = (/** @type {string} */ dir) => path.join(dir, "journal.json");
const genDir = (/** @type {string} */ dir, /** @type {number} */ n) => path.join(dir, "gen", String(n));

/** @param {number} generation @param {string} id @param {string} name */
const itemAad = (generation, id, name) => `vyre:space-item:v1\n${generation}\n${id}\n${name}`;
/** @param {number} generation */
const wrapAad = generation => `vyre:space-vault:member:v1\n${generation}`;
/** @param {number} generation */
const serverAad = generation => `vyre:space-vault:server:v1\n${generation}`;

/** The key-encryption key for the server private key. It is outside the space directory a member would copy. @param {string} dir */
export function serverSealFile(dir) {
  const id = crypto.createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 16);
  return path.join(path.dirname(path.resolve(dir)), ".server-seal", `${id}.kek`);
}

/** @param {string} dir */
function generationOf(dir) {
  const s = readJson(statePath(dir));
  return s && Number.isInteger(s.generation) ? s.generation : 0;
}

/** @param {string} dir @param {number} n */
function readWraps(dir, n) {
  const g = readJson(path.join(genDir(dir, n), "wraps.json"));
  if (!g) throw refuse("This space vault generation is incomplete.", "corrupt");
  return g;
}

/** @param {string} dir @param {number} generation @param {string} priv */
function writeServer(dir, generation, priv) {
  const kek = ensureKek(serverSealFile(dir));
  try {
    const sealed = aesWrap(kek, Buffer.from(priv, "utf8"), serverAad(generation));
    writePrivate(path.join(genDir(dir, generation), "server.json"), JSON.stringify({ v: 1, sealed }) + "\n");
  } finally { kek.fill(0); }
}

/** @param {string} dir @param {number} n */
function serverPrivOf(dir, n) {
  const row = readJson(path.join(genDir(dir, n), "server.json"));
  if (!row) throw refuse("This space vault generation is incomplete.", "corrupt");
  if (typeof row.priv === "string" && !row.sealed) {
    writeServer(dir, n, row.priv);
    return row.priv;
  }
  if (!row.sealed) throw refuse("This space vault generation is incomplete.", "corrupt");
  const kek = readKek(serverSealFile(dir));
  if (!kek) throw refuse("The server key for this space vault is not on this device.", "not_found");
  try { return aesUnwrap(kek, row.sealed, serverAad(n)).toString("utf8"); }
  catch { throw refuse("The server key for this space vault is not on this device.", "not_found"); }
  finally { kek.fill(0); }
}

/** @param {string} dir @param {number} n */
function loadGen(dir, n) {
  return { wraps: readWraps(dir, n), serverPriv: serverPrivOf(dir, n) };
}

/** @param {string} dir @param {number} n */
function serverSvk(dir, n) {
  const g = loadGen(dir, n);
  return { svk: openSeal(g.serverPriv, g.wraps.server, wrapAad(n)), wraps: g.wraps, serverPriv: g.serverPriv };
}

/** @param {Buffer} svk @param {string} id @param {string} name @param {Buffer} value @param {number} generation */
function sealItem(svk, id, name, value, generation) {
  const key = hkdf32(svk, id, "vyre:space-item:v1");
  const box = aesWrap(key, value, itemAad(generation, id, name));
  key.fill(0);
  return { id, name, ...box };
}

/** @param {Buffer} svk @param {{ id: string, name: string, iv: string, ct: string, tag: string }} item @param {number} generation */
function openItem(svk, item, generation) {
  const key = hkdf32(svk, item.id, "vyre:space-item:v1");
  try { return aesUnwrap(key, item, itemAad(generation, item.id, item.name)); }
  finally { key.fill(0); }
}

/** @param {string} dir @param {number} n */
function itemFiles(dir, n) {
  const folder = path.join(genDir(dir, n), "items");
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(f => f.endsWith(".json")).map(f => path.join(folder, f));
}

/**
 * Make generation 1 with a server wrap and no members yet.
 * @param {string} dir
 */
export function create(dir) {
  if (generationOf(dir)) throw refuse("This space already has a vault.", "exists");
  const svk = crypto.randomBytes(32);
  const server = x25519Pair();
  const generation = 1;
  const base = genDir(dir, generation);
  fs.mkdirSync(path.join(base, "items"), { recursive: true, mode: 0o700 });
  writeServer(dir, generation, server.priv);
  writePrivate(path.join(base, "wraps.json"), JSON.stringify({ server: sealTo(server.pub, svk, wrapAad(generation)), members: {} }) + "\n");
  writePrivate(statePath(dir), JSON.stringify({ v: 1, generation }) + "\n");
  svk.fill(0);
  return { generation, serverPub: server.pub };
}

/** @param {string} dir */
export function status(dir) {
  const generation = generationOf(dir);
  const pending = needsYou(dir);
  const flag = pending ? { needsYou: pending } : {};
  if (!generation) return { exists: false, generation: 0, members: [], ...flag };
  const wraps = readWraps(dir, generation);
  return { exists: true, generation, members: Object.keys(wraps.members || {}), ...flag };
}

/**
 * Wrap the current key to a member. The server wrap opens the key; the member does not need to be unlocked.
 * @param {string} dir @param {string} personId @param {string} pubB64
 */
export function grant(dir, personId, pubB64) {
  const generation = generationOf(dir);
  if (!generation) throw refuse("This space has no vault yet. Create one first.", "not_found");
  const id = String(personId || "");
  if (!/^per_[a-z2-7]{10,}$/.test(id) && !/^per_test_[a-z0-9_-]{1,40}$/.test(id)) throw refuse("Name the member by their person id.", "bad_input");
  const pub = String(pubB64 || "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(pub) || Buffer.from(pub, "base64url").length !== 32) throw refuse("A member's vault key is a 32-byte public key.", "bad_input");
  const opened = serverSvk(dir, generation);
  // One key per member. A different key for someone who already has one is a swap: it goes through rotate, which drops the member and wraps a new key on purpose.
  const held = opened.wraps.members[id];
  if (held && held.pub !== pub) { opened.svk.fill(0); throw refuse("That member already has a vault key here. Rotate the space vault to replace it.", "exists"); }
  opened.wraps.members[id] = { pub, wrap: sealTo(pub, opened.svk, wrapAad(generation)) };
  writePrivate(path.join(genDir(dir, generation), "wraps.json"), JSON.stringify(opened.wraps) + "\n");
  opened.svk.fill(0);
  return { person: id, generation };
}

/**
 * Seal an item for the hosts it may be sent to. The value is not returned.
 * @param {string} dir @param {{ id: string, name: string, value: string, hosts?: string[] }} item
 */
export function put(dir, item) {
  const generation = generationOf(dir);
  if (!generation) throw refuse("This space has no vault yet. Create one first.", "not_found");
  const id = String(item.id || "");
  const name = String(item.name || "").slice(0, 80);
  if (!ITEM_RE.test(id) || !name) throw refuse("Give the item an id of letters, digits, dot, underscore or hyphen, and a name.", "bad_input");
  const hosts = normalizeHostList(item.hosts, refuse);
  const value = Buffer.from(String(item.value ?? ""), "utf8");
  if (!value.length) throw refuse("Give the item a value.", "bad_input");
  const opened = serverSvk(dir, generation);
  const sealed = { ...sealItem(opened.svk, id, name, value, generation), hosts };
  opened.svk.fill(0);
  value.fill(0);
  writePrivate(path.join(genDir(dir, generation), "items", `${id}.json`), JSON.stringify(sealed) + "\n");
  return { id, name, hosts, generation };
}

/** Names only. @param {string} dir */
export function list(dir) {
  const generation = generationOf(dir);
  if (!generation) return { items: [] };
  const items = itemFiles(dir, generation).map(f => {
    const row = readJson(f);
    return row ? { id: row.id, name: row.name, hosts: Array.isArray(row.hosts) ? row.hosts : [] } : null;
  }).filter(Boolean);
  return { items };
}

/**
 * @param {string} dir
 * @param {{ remove?: string[], crash?: (at: string) => void }} [opts]
 */
export function rotate(dir, opts = {}) {
  const crash = opts.crash || (() => {});
  const remove = new Set(opts.remove || []);
  const generation = generationOf(dir);
  if (!generation) throw refuse("This space has no vault yet. Create one first.", "not_found");
  const next = generation + 1;
  writePrivate(journalPath(dir), JSON.stringify({ phase: "copying", from: generation, next }) + "\n");
  crash("after-journal");
  const opened = serverSvk(dir, generation);
  const svk = crypto.randomBytes(32);
  const server = x25519Pair();
  /** @type {Record<string, { pub: string, wrap: any }>} */
  const members = {};
  for (const [id, row] of Object.entries(opened.wraps.members || {})) {
    if (remove.has(id)) continue;
    const pub = /** @type {any} */ (row).pub;
    members[id] = { pub, wrap: sealTo(pub, svk, wrapAad(next)) };
  }
  const base = genDir(dir, next);
  fs.mkdirSync(path.join(base, "items"), { recursive: true, mode: 0o700 });
  for (const f of itemFiles(dir, generation)) {
    const row = readJson(f);
    if (!row) continue;
    const plain = openItem(opened.svk, row, generation);
    const sealed = { ...sealItem(svk, row.id, row.name, plain, next), hosts: Array.isArray(row.hosts) ? row.hosts : [] };
    plain.fill(0);
    writePrivate(path.join(base, "items", `${row.id}.json`), JSON.stringify(sealed) + "\n");
  }
  writeServer(dir, next, server.priv);
  writePrivate(path.join(base, "wraps.json"), JSON.stringify({ server: sealTo(server.pub, svk, wrapAad(next)), members }) + "\n");
  opened.svk.fill(0);
  svk.fill(0);
  writePrivate(journalPath(dir), JSON.stringify({ phase: "committing", from: generation, next }) + "\n");
  crash("before-commit");
  writePrivate(statePath(dir), JSON.stringify({ v: 1, generation: next }) + "\n");
  crash("after-commit");
  rmQuiet(genDir(dir, generation));
  rmQuiet(journalPath(dir));
  return { generation: next, removed: [...remove] };
}

/** Drop one member when a space vault exists. A home with none is unchanged. @param {string} dir @param {string} personId */
export function rotateIfPresent(dir, personId) {
  if (!generationOf(dir)) return { rotated: false };
  return { rotated: true, ...rotate(dir, { remove: [String(personId || "")] }) };
}

const NEEDS_TITLE = "A space vault key did not rotate when a member left. Vyre will try again.";
const needsPath = (/** @type {string} */ dir) => path.join(dir, "needs-you.json");
/** @type {Map<string, NodeJS.Timeout>} */
const retryTimers = new Map();

/** @param {string} dir */
export function needsYou(dir) {
  const row = readJson(needsPath(dir));
  if (!row || typeof row.title !== "string" || !row.title) return null;
  return { title: row.title, person: String(row.person || ""), at: Number(row.at) || 0 };
}

/** @param {string} dir @param {string} personId @param {string} message */
function flagNeeds(dir, personId, message) {
  writePrivate(needsPath(dir), JSON.stringify({
    v: 1, person: String(personId || ""), at: Date.now(), title: NEEDS_TITLE, error: String(message || "").slice(0, 200),
  }) + "\n");
}

/** @param {string} dir */
function clearNeeds(dir) {
  const t = retryTimers.get(dir);
  if (t) clearTimeout(t);
  retryTimers.delete(dir);
  rmQuiet(needsPath(dir));
}

/** @param {string} dir @param {string} personId */
function scheduleRetry(dir, personId) {
  if (retryTimers.has(dir)) return;
  const given = Number(process.env.VYRE_SPACE_VAULT_RETRY_MS);
  const ms = Number.isFinite(given) && given >= 0 ? given : 30_000;
  const t = setTimeout(() => {
    retryTimers.delete(dir);
    try { rotateOnRemove(dir, personId); } catch { /* the flag stays until a later retry */ }
  }, ms);
  if (typeof t.unref === "function") t.unref();
  retryTimers.set(dir, t);
}

/** Stop queued retries. Tests call this so a timer cannot write after the home is gone. */
export function cancelRetries() {
  for (const t of retryTimers.values()) clearTimeout(t);
  retryTimers.clear();
}

/**
 * Delete one member's wrap on the current generation, before rotation. Their access is gone even when rotation does not finish.
 * @param {string} dir @param {string} personId
 */
export function dropMember(dir, personId) {
  const generation = generationOf(dir);
  if (!generation) return { dropped: false };
  let wraps;
  try { wraps = readWraps(dir, generation); } catch { return { dropped: false }; }
  const id = String(personId || "");
  if (!wraps.members || !wraps.members[id]) return { dropped: false };
  delete wraps.members[id];
  writePrivate(path.join(genDir(dir, generation), "wraps.json"), JSON.stringify(wraps) + "\n");
  return { dropped: true };
}

/**
 * Drop the member's wrap, then rotate. A failure throws, stays flagged for Needs you, and is retried.
 * The member's wrap is already gone, so they cannot open items while the retry is waiting.
 * @param {string} dir @param {string} personId
 */
export function rotateOnRemove(dir, personId) {
  const dropped = dropMember(dir, personId);
  try {
    resume(dir);
    const r = rotateIfPresent(dir, personId);
    clearNeeds(dir);
    return { ...r, needsYou: false, dropped: dropped.dropped };
  } catch (e) {
    flagNeeds(dir, personId, /** @type {any} */ (e).message);
    scheduleRetry(dir, personId);
    throw refuse("That member's vault access was removed. The space vault key did not finish rotating. Vyre will try again.", "rotation_failed");
  }
}

/** Retry every flagged space vault under a root. @param {string} root */
export function pumpRetries(root) {
  if (!root || !fs.existsSync(root)) return { retried: 0, waiting: 0 };
  let retried = 0, waiting = 0;
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (!needsYou(dir)) continue;
    const person = needsYou(dir);
    retried++;
    try {
      const r = rotateOnRemove(dir, person ? person.person : "");
      if (r.needsYou) waiting++;
    } catch (e) {
      if (/** @type {any} */ (e).code !== "rotation_failed") throw e;
      waiting++;
    }
  }
  return { retried, waiting };
}

/** Rows for the Needs you list. Titles only. @param {string} root */
export function attention(root) {
  if (!root || !fs.existsSync(root)) return { items: [] };
  /** @type {{ space: string, title: string, person: string, at: number }[]} */
  const items = [];
  for (const name of fs.readdirSync(root)) {
    const row = needsYou(path.join(root, name));
    if (!row) continue;
    items.push({ space: name, title: row.title, person: row.person, at: row.at });
  }
  return { items };
}

/** Finish a rotation that crashed, or discard a copy that never committed. @param {string} dir */
export function resume(dir) {
  const j = readJson(journalPath(dir));
  if (!j) return { resumed: false };
  const generation = generationOf(dir);
  if (j.phase === "copying" || (j.phase === "committing" && generation !== j.next)) {
    rmQuiet(genDir(dir, j.next));
    rmQuiet(journalPath(dir));
    return { resumed: true, generation, discarded: j.next };
  }
  if (generation === j.next) {
    rmQuiet(genDir(dir, j.from));
    rmQuiet(journalPath(dir));
    return { resumed: true, generation, cleaned: j.from };
  }
  return { resumed: false, generation };
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * The address must be https, on a saved host, with no userinfo and no other port.
 * @param {string} raw @param {string[]} hosts
 */
function assertDestination(raw, hosts) {
  let u;
  try { u = new URL(String(raw || "")); } catch { throw refuse("That address is not one this vault can call.", "bad_input"); }
  if (u.protocol !== "https:") throw refuse("A space vault item is only sent to https.", "host_refused");
  if (u.username || u.password) throw refuse("That address must not carry a user or password.", "host_refused");
  if (u.port && u.port !== "443") throw refuse("A space vault item is only sent on the https port.", "host_refused");
  if (!hostAllowed(u.hostname, hosts)) throw refuse(`${u.hostname} is not a host this item was saved for.`, "host_refused");
  return u;
}

/** @param {any} res */
function locationOf(res) {
  const h = res && res.headers;
  if (!h) return "";
  if (typeof h.get === "function") return String(h.get("location") || "");
  const key = Object.keys(h).find(k => k.toLowerCase() === "location");
  return key ? String(h[key] || "") : "";
}

/**
 * Open an item with the server wrap and place the value on the outbound request. The returned result never contains the value.
 * A redirect is followed only when the next host is one this item was saved for.
 * @param {string} dir
 * @param {{ id: string, request: { url?: string, method?: string, headers?: Record<string, string>, body?: string }, transport: (req: any) => Promise<{ status?: number, body?: any, headers?: any }> }} o
 */
export async function lend(dir, o) {
  const generation = generationOf(dir);
  if (!generation) throw refuse("This space has no vault yet. Create one first.", "not_found");
  const id = String(o.id || "");
  const row = readJson(path.join(genDir(dir, generation), "items", `${id}.json`));
  if (!row) throw refuse("That space vault item is not here.", "not_found");
  const hosts = Array.isArray(row.hosts) ? row.hosts.map(String) : [];
  if (!hosts.length) throw refuse("Save it again with the hosts it may be sent to.", "host_refused");
  const asked = (o.request || {}).url;
  assertDestination(asked, hosts);
  const opened = serverSvk(dir, generation);
  const secretBuf = openItem(opened.svk, row, generation);
  opened.svk.fill(0);
  const secret = secretBuf.toString("utf8");
  secretBuf.fill(0);
  let req = inject(o.request || {}, secret);
  let hops = 0;
  for (;;) {
    assertDestination(req.url, hosts);
    const res = await o.transport(req);
    const status = Number(res && res.status) || 0;
    const loc = locationOf(res);
    if (REDIRECT.has(status) && loc) {
      if (++hops > 3) throw refuse("That host redirected too many times.", "host_refused");
      const next = new URL(loc, req.url);
      assertDestination(next.href, hosts);
      const keep = status === 307 || status === 308;
      /** @type {Record<string, string>} */
      const headers = { ...(req.headers || {}) };
      if (!keep) { delete headers["content-type"]; delete headers["Content-Type"]; }
      req = inject({ url: next.href, method: keep ? req.method : (req.method === "HEAD" ? "HEAD" : "GET"), headers, body: keep ? req.body : undefined }, secret);
      continue;
    }
    return { ok: status >= 200 && status < 300, status, body: scrub(res && res.body, secret) };
  }
}

/** @param {{ url?: string, method?: string, headers?: Record<string, string>, body?: string }} request @param {string} secret */
function inject(request, secret) {
  const headers = { ...(request.headers || {}) };
  const existing = Object.keys(headers).find(k => k.toLowerCase() === "authorization");
  if (existing) headers[existing] = String(headers[existing]).split("{{secret}}").join(secret);
  else headers.authorization = `Bearer ${secret}`;
  let body = request.body;
  if (typeof body === "string" && body.includes("{{secret}}")) body = body.split("{{secret}}").join(secret);
  return { url: request.url, method: request.method || "GET", headers, body };
}

/** @param {any} body @param {string} secret */
function scrub(body, secret) {
  if (secret.length < 8) return body;
  const text = typeof body === "string" ? body : JSON.stringify(body === undefined ? null : body);
  if (!text.includes(secret)) return body;
  const cleaned = conceal(text, [secret], { marker: "[redacted]", min: 8 });
  if (typeof body === "string") return cleaned;
  try { return JSON.parse(cleaned); } catch { return { redacted: true }; }
}

/**
 * The external MCP door for one space vault: tools/call of vault_space_request. The result text is the response, never the value.
 * @param {string} dir
 * @param {any} rpc
 * @param {(req: any) => Promise<{ status?: number, body?: any }>} transport
 */
export async function externalMcp(dir, rpc, transport) {
  const id = rpc && rpc.id !== undefined ? rpc.id : null;
  if (!rpc || rpc.method !== "tools/call" || !rpc.params || rpc.params.name !== "vault_space_request") {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "unknown tool" } };
  }
  const args = rpc.params.arguments || {};
  const result = await lend(dir, { id: args.id, request: { url: args.url, method: args.method, headers: args.headers, body: args.body }, transport });
  const text = JSON.stringify({ ok: result.ok, status: result.status, body: result.body });
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } };
}

/**
 * Open an item with a member's own key. Tools do not call this; tests prove a removed member's wrap no longer works.
 * @param {string} dir @param {string} personId @param {string} privB64 @param {string} itemId
 */
export function openAsMember(dir, personId, privB64, itemId) {
  const generation = generationOf(dir);
  const wraps = readWraps(dir, generation);
  const row = wraps.members && wraps.members[personId];
  if (!row) throw refuse("That member has no wrap on this generation.", "not_found");
  const svk = openSeal(privB64, row.wrap, wrapAad(generation));
  const item = readJson(path.join(genDir(dir, generation), "items", `${itemId}.json`));
  if (!item) throw refuse("That space vault item is not here.", "not_found");
  try { return openItem(svk, item, generation).toString("utf8"); }
  finally { svk.fill(0); }
}

/**
 * What a member's computer may hold: their wraps and the item names. No server private key and no seal key.
 * @param {string} dir
 */
export function memberBundle(dir) {
  const generation = generationOf(dir);
  if (!generation) return { generation: 0, members: {}, items: [] };
  const wraps = readWraps(dir, generation);
  /** @type {Record<string, { pub: string, wrap: any }>} */
  const members = {};
  for (const [id, row] of Object.entries(wraps.members || {})) {
    const pub = /** @type {any} */ (row).pub;
    members[id] = { pub, wrap: /** @type {any} */ (row).wrap };
  }
  return { generation, members, items: list(dir).items };
}
