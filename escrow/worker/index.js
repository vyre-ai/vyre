// @ts-check
// The GitHub sign-in escrow, its own Worker and domain (escrow.vyre.run), apart from the relay so that the relay's "holds nothing" claim stays true.
// It holds, per linked person: the sealed vault Secret Key plus a home hint (route and pinned box key of the server with the vault), and a per-link Ed25519 key that is
// the relay entry on the person's identity chain. It never sees the master password or the recovery code, and the vault stays shut without the master password.
//
//   POST /v1/escrow/create   relay only (MAC): {ghid, identity, name, ts} -> makes a NEW key pair for this link (replacing any), answers its public key and a one-use put token
//   POST /v1/escrow/put      device, with the put token: {token, bundle:{sk, home}} -> seals and stores it (also how a vault reset refreshes the Secret Key)
//   POST /v1/escrow/release  relay only (MAC): {ghid, device:{eid,pub,agree}, ts} -> adds the device to the chain as via "github" with the relay key and answers the bundle sealed to the device's agreement key
//   POST /v1/escrow/delete   relay only (MAC): {ghid, identity, ts} -> purges the bundle and the key
//   POST /v1/escrow/token    relay only (MAC): {ghid, identity, ts} -> a fresh one-use put token (the Secret Key changed)
// Every relay call carries a one-use nonce `n` inside the MAC'd body, so a captured call cannot be replayed within the time window.
//
// At rest: AES-256-GCM under a key-encryption key that is a Worker secret (ESCROW_KEK_<kid>, ESCROW_KEK_CURRENT names the kid), the AAD binds the numeric GitHub id, the identity id and the kid.
// Nothing here logs a body, and errors carry no secret. To rotate: add ESCROW_KEK_<new> and set ESCROW_KEK_CURRENT; new records use it. A rewrap op is NOT built yet, so the old ESCROW_KEK_<kid> must stay set until it is: removing it orphans every bundle sealed under it.

import * as C from "../../kernel/identity/chain.js";
import { mac } from "./mac.js";
export { mac };

export const LIMITS = Object.freeze({ skewMs: 2 * 60_000, tokenMs: 10 * 60_000, releasePerGhidHour: 5, releasePerIdentityHour: 10, failuresBeforeLock: 5, lockMs: 3_600_000, bundle: 2048, home: 512 });
const enc = new TextEncoder(), dec = new TextDecoder();
const json = (/** @type {number} */ status, /** @type {any} */ body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const now = (/** @type {any} */ env) => (typeof env.NOW === "function" ? env.NOW() : Date.now());
const same = (/** @type {string} */ a, /** @type {string} */ b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const b64 = C.b64u, unb64 = (/** @type {string} */ s) => /** @type {Uint8Array} */ (C.unb64(s));

const kekOf = async (/** @type {any} */ env, /** @type {string} */ kid) => {
  const raw = env[`ESCROW_KEK_${kid}`];
  const bytes = typeof raw === "string" ? C.unb64(raw) : null;
  if (!bytes || bytes.length !== 32) throw new Error("no key for that kid");
  return crypto.subtle.importKey("raw", /** @type {BufferSource} */ (bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
};
const aad = (/** @type {number} */ ghid, /** @type {string} */ identity, /** @type {string} */ kid) => enc.encode(`vyre-gh-escrow-v1|${ghid}|${identity}|${kid}`);
async function seal(/** @type {any} */ env, /** @type {number} */ ghid, /** @type {string} */ identity, /** @type {Uint8Array} */ plain) {
  const kid = String(env.ESCROW_KEK_CURRENT || "");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(ghid, identity, kid) }, await kekOf(env, kid), /** @type {BufferSource} */ (plain)));
  return { kid, iv: b64(iv), ct: b64(ct) };
}
async function open(/** @type {any} */ env, /** @type {number} */ ghid, /** @type {string} */ identity, /** @type {any} */ s) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: /** @type {BufferSource} */ (unb64(s.iv)), additionalData: aad(ghid, identity, s.kid) }, await kekOf(env, s.kid), /** @type {BufferSource} */ (unb64(s.ct))));
}
/** Seal to a device's agreement point (raw P-256): an ephemeral ECDH, HKDF, AES-GCM. Only that device's private agreement key opens it. @param {string} agree @param {Uint8Array} plain */
export async function sealTo(agree, plain) {
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const peer = await crypto.subtle.importKey("raw", /** @type {BufferSource} */ (unb64(agree)), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, eph.privateKey, 256);
  const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("vyre-gh-escrow-release-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, /** @type {BufferSource} */ (plain)));
  return { v: 1, eph: b64(new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey))), iv: b64(iv), ct: b64(ct) };
}

/** The Worker's front: every call but `put` comes from the relay and carries a MAC and a time. */
export default {
  /** @param {Request} request @param {any} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json(200, { ok: true });
    if (request.method !== "POST" || !url.pathname.startsWith("/v1/escrow/")) return json(404, { error: "no such call" });
    if (!env.ESCROW || !env.ESCROW_RELAY_SECRET || !env.ESCROW_KEK_CURRENT) return json(503, { error: "not set up" });
    const text = await request.text();
    if (text.length > 8192) return json(413, { error: "too big" });
    /** @type {any} */ let b;
    try { b = JSON.parse(text); } catch { return json(400, { error: "bad request" }); }
    if (!b || typeof b !== "object") return json(400, { error: "bad request" });
    const op = url.pathname.slice("/v1/escrow/".length);
    if (!["create", "put", "release", "delete", "token"].includes(op)) return json(404, { error: "no such call" });
    if (op !== "put") {
      const { m, ...rest } = b;
      if (!Number.isFinite(rest.ts) || Math.abs(rest.ts - now(env)) > LIMITS.skewMs || typeof m !== "string" || typeof rest.n !== "string" || rest.n.length < 16 || rest.n.length > 64 || !same(m, await mac(env.ESCROW_RELAY_SECRET, op, rest))) return json(401, { error: "not the relay" });
      b = rest;
    }
    const res = await env.ESCROW.get(env.ESCROW.idFromName("escrow")).fetch("https://escrow/op", { method: "POST", body: JSON.stringify({ op, b, now: now(env), ip: request.headers.get("cf-connecting-ip") || "unknown" }) });
    return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  },
};

/** One object holds every record, so a link is claimed from both sides at once and counts cannot race. */
export class Escrow {
  /** @param {any} ctx @param {any} env */
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  /** @param {Request} request */
  async fetch(request) {
    const { op, b, now: t } = /** @type {any} */ (await request.json());
    try {
      await this.prune(t);
      // A relay call is spent by its nonce; a replay inside the time window finds it gone.
      if (op !== "put") {
        if (await this.ctx.storage.get(`r/${b.n}`)) return json(401, { error: "not the relay" });
        await this.ctx.storage.put(`r/${b.n}`, t + 2 * LIMITS.skewMs + 1000);
      }
      if (op === "create") return await this.create(b, t);
      if (op === "put") return await this.put(b, t);
      if (op === "release") return await this.release(b, t);
      if (op === "token") return await this.token(b, t);
      return await this.del(b);
    } catch (e) {
      // An error says what failed, never a key, a body or the secret.
      return json(500, { error: "the escrow could not do that" });
    }
  }

  /** Drop what has run out: spent relay nonces, put tokens' nonces and the hour counters older than two hours. */
  async prune(/** @type {number} */ t) {
    const dead = [];
    for (const prefix of ["r/", "n/"]) for (const [k, v] of await this.ctx.storage.list({ prefix })) if (typeof v === "number" && v < t) dead.push(k);
    for (const prefix of ["rg/", "ri/"]) for (const k of (await this.ctx.storage.list({ prefix })).keys()) if (Number(k.split("/")[2]) < t - 2 * 3_600_000) dead.push(k);
    for (let i = 0; i < dead.length; i += 100) await this.ctx.storage.delete(dead.slice(i, i + 100));
  }

  async create(/** @type {any} */ b, /** @type {number} */ t) {
    const ghid = b.ghid, identity = b.identity;
    if (!Number.isSafeInteger(ghid) || ghid <= 0 || !C.ID_RE.test(String(identity)) || typeof b.name !== "string") return json(400, { error: "bad request" });
    // A new key pair on every link, and the old bundle goes with the old key.
    const kp = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]));
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const pubText = b64(pub);
    const old = /** @type {any} */ (await this.ctx.storage.get(`g/${ghid}`));
    const other = /** @type {any} */ (await this.ctx.storage.get(`i/${identity}`));
    if ((old && old.identity !== identity) || (other && other !== ghid)) return json(409, { error: "linked elsewhere" });
    await this.ctx.storage.put({ [`g/${ghid}`]: { ghid, identity, name: b.name, eid: await C.eidOf(pub), pub: pubText, key: await seal(this.env, ghid, identity, priv), bundle: null, at: t, fails: 0, lockUntil: 0 }, [`i/${identity}`]: ghid });
    priv.fill(0);
    const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
    const token = { ghid, identity, exp: t + LIMITS.tokenMs, nonce };
    await this.ctx.storage.put(`n/${nonce}`, token.exp);
    return json(200, { pub: pubText, eid: await C.eidOf(pub), token: { ...token, m: await mac(this.env.ESCROW_RELAY_SECRET, "put", token) } });
  }

  async put(/** @type {any} */ b, /** @type {number} */ t) {
    const k = b.token;
    if (!k || !Number.isSafeInteger(k.ghid) || typeof k.m !== "string" || typeof k.nonce !== "string") return json(401, { error: "no" });
    const { m, ...rest } = k;
    if (!same(m, await mac(this.env.ESCROW_RELAY_SECRET, "put", rest)) || rest.exp < t) return json(401, { error: "no" });
    const exp = await this.ctx.storage.get(`n/${rest.nonce}`);
    if (!exp) return json(401, { error: "no" });
    await this.ctx.storage.delete(`n/${rest.nonce}`);
    const rec = /** @type {any} */ (await this.ctx.storage.get(`g/${rest.ghid}`));
    if (!rec || rec.identity !== rest.identity) return json(404, { error: "no" });
    const bundle = b.bundle;
    if (!bundle || typeof bundle.sk !== "string" || bundle.sk.length < 8 || bundle.sk.length > 200) return json(400, { error: "bad bundle" });
    if (bundle.home !== null && bundle.home !== undefined && (typeof bundle.home !== "string" || enc.encode(bundle.home).length > LIMITS.home)) return json(400, { error: "bad bundle" });
    const plain = enc.encode(JSON.stringify({ v: 1, sk: bundle.sk, home: bundle.home ?? null }));
    await this.ctx.storage.put(`g/${rest.ghid}`, { ...rec, bundle: await seal(this.env, rec.ghid, rec.identity, plain), updated: t });
    return json(200, { ok: true });
  }

  async release(/** @type {any} */ b, /** @type {number} */ t) {
    const same_answer = () => json(404, { error: "nothing to release" });
    const rec = /** @type {any} */ (await this.ctx.storage.get(`g/${b.ghid}`));
    const d = b.device;
    if (!rec || !d || !C.EID_RE.test(String(d.eid)) || typeof d.pub !== "string" || typeof d.agree !== "string") return same_answer();
    if (t < rec.lockUntil) return json(429, { error: "wait before trying GitHub again" });
    const hour = t - (t % 3_600_000);
    const bump = async (/** @type {string} */ k, /** @type {number} */ limit) => { const n = ((await this.ctx.storage.get(k)) || 0) + 1; await this.ctx.storage.put(k, n); return n <= limit; };
    if (!(await bump(`rg/${rec.ghid}/${hour}`, LIMITS.releasePerGhidHour)) || !(await bump(`ri/${rec.identity}/${hour}`, LIMITS.releasePerIdentityHour))) return json(429, { error: "wait before trying GitHub again" });
    // Written back from a FRESH read, changing only the counters: a put (a vault reset) or a delete that landed while this call waited on the directory is never overwritten.
    const touch = async (/** @type {(r: any) => any} */ change) => {
      const cur = /** @type {any} */ (await this.ctx.storage.get(`g/${rec.ghid}`));
      if (!cur || cur.identity !== rec.identity) return null;
      await this.ctx.storage.put(`g/${rec.ghid}`, { ...cur, ...change(cur) });
      return cur;
    };
    const fail = async (/** @type {number} */ status, /** @type {string} */ say) => {
      await touch(cur => { const fails = cur.fails + 1; return { fails: fails >= LIMITS.failuresBeforeLock ? 0 : fails, lockUntil: fails >= LIMITS.failuresBeforeLock ? t + LIMITS.lockMs : cur.lockUntil }; });
      return json(status, { error: say });
    };
    if (!rec.bundle) return fail(409, "no escrowed key yet");
    // The chain at the directory, verified here. The relay's own entry must be on the list now.
    const f = typeof this.env.NAMES_FETCH === "function" ? this.env.NAMES_FETCH : globalThis.fetch.bind(globalThis);
    const origin = String(this.env.NAMES_ORIGIN || "https://names.vyre.run").replace(/\/+$/, "");
    let state;
    try {
      const r = await f(`${origin}/v1/ids/resolve?name=${encodeURIComponent(rec.name)}`, { headers: { accept: "application/json" } });
      const j = /** @type {any} */ (await r.json());
      if (!r.ok || !j.data || j.data.id !== rec.identity) return fail(409, "the directory does not hold that identity");
      state = await C.verifyChain(j.data.ops, { now: t });
    } catch { return json(503, { error: "the names directory did not answer" }); }
    if (!state.entries.some(e => e.eid === rec.eid && e.held === "relay")) return fail(409, "the relay's key is not on that identity's list");
    const priv = await open(this.env, rec.ghid, rec.identity, rec.key);
    const key = await crypto.subtle.importKey("pkcs8", /** @type {BufferSource} */ (priv), "Ed25519", false, ["sign"]);
    priv.fill(0);
    const entry = { eid: String(d.eid), kind: "device", pub: d.pub, via: "github", agree: d.agree };
    let op;
    try { op = await C.makeOp(state, { type: "add", entry }, { by: rec.eid, ts: t, sign: async m => new Uint8Array(await crypto.subtle.sign("Ed25519", key, /** @type {BufferSource} */ (m))) }); await C.applyOp(state, op, { now: t, live: true }); }
    catch (e) { return fail(409, /** @type {any} */ (e).code === "relay_rate" ? "too many devices were added today" : "the identity's list does not allow that"); }
    const ap = await f(`${origin}/v1/ids/append`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: rec.name, ops: [op] }) });
    if (!ap.ok) return fail(409, "the directory did not take the new device");
    // The bundle is read again now, after the directory: a reset that refreshed the Secret Key meanwhile is the one released, and a link that was deleted releases nothing.
    const cur = await touch(() => ({ fails: 0, lastRelease: t }));
    if (!cur || !cur.bundle) return same_answer();
    const plain = await open(this.env, cur.ghid, cur.identity, cur.bundle);
    const sealed = await sealTo(d.agree, plain);
    plain.fill(0);
    return json(200, { sealed, lastRelease: t, deviceEid: entry.eid });
  }

  /** A fresh put token for a person already linked, for when a vault reset makes a new Secret Key (the relay asks for it after a device-signed request). */
  async token(/** @type {any} */ b, /** @type {number} */ t) {
    const rec = /** @type {any} */ (await this.ctx.storage.get(`g/${b.ghid}`));
    if (!rec || rec.identity !== b.identity) return json(404, { error: "nothing linked" });
    const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
    const token = { ghid: rec.ghid, identity: rec.identity, exp: t + LIMITS.tokenMs, nonce };
    await this.ctx.storage.put(`n/${nonce}`, token.exp);
    return json(200, { token: { ...token, m: await mac(this.env.ESCROW_RELAY_SECRET, "put", token) } });
  }

  async del(/** @type {any} */ b) {
    const rec = /** @type {any} */ (await this.ctx.storage.get(`g/${b.ghid}`));
    if (rec && rec.identity === b.identity) await this.ctx.storage.delete([`g/${b.ghid}`, `i/${rec.identity}`]);
    return json(200, { ok: true });
  }
}
