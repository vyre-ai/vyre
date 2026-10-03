// @ts-check
// Identity names in the directory (team/0.3/DESIGN-spaces-first.md sections 1 and 1b). A person is a key with a name
// (`alex.vyre.run`), and a space is a key with a name (`harlow.vyre.run`): one namespace with the box names, so a name is
// taken once. The caller is the identity KEY, authenticated by the same signed headers a box route uses (the route id is the
// first 26 base32 characters of the key's hash, which is also a person's id after `per_`), so no new auth scheme.
//
//   POST   /v1/ids/claim          {name, kind, record, recordSig}   claim a name for this key (kind person or space)
//   GET    /v1/ids/resolve        ?name= or ?alias=                 the sealed record and the pinned key; no signature needed
//   POST   /v1/ids/update         {name, record, recordSig}         the holder replaces the sealed record (the home moved)
//   POST   /v1/ids/alias          {name, domain}                    verify an own domain by a signed TXT at _vyre-id.<domain>
//   DELETE /v1/ids/alias          {name, domain}
//   POST   /v1/ids/rotate         {name, record, recordSig, rotateSig}  the holder moves the name to a new key, which signs too
//   POST   /v1/ids/release        {name}
//   POST   /v1/ids/recover        {name, code, next, record, recordSig} a 72-hour pending rebind to the caller's key
//   POST   /v1/ids/recover/cancel {name}                            the current key cancels it
//   GET    /v1/ids/mine                                              the name this key holds
//
// What the directory stores is the signed claim and an opaque sealed record. The sealed record is encrypted under a key
// derived from the NAME (core/names/ids.js), so the directory cannot read it, a visitor who does not know the name learns
// nothing, and there is no public DNS control record under vyre.run (reviewer-2 R2-21). A client verifies the record's
// signature against the key it pinned (an invite, a pairing) before it trusts anything inside.
// Nothing here publishes a DNS record.

import { verdict, routeId, base32, codeHash } from "./index.js";

export const RECORD_TAG = "vyre-id-record-v1";
export const ALIAS_TAG = "vyre-id-alias-v1";
export const ROTATE_TAG = "vyre-id-rotate-v1";
export const KINDS = Object.freeze(["person", "space"]);
export const ID_LIMITS = Object.freeze({
  /** characters of the sealed record */
  sealed: 2048,
  /** own domains one identity may alias */
  aliases: 5,
  /** how far a record's own time may be from the directory's */
  recordSkewMs: 5 * 60_000,
  /** a rebind waits this long so a live holder can cancel it */
  recoverMs: 72 * 3_600_000,
  /** a name released within this time of its claim is freed; later it is a tombstone for good */
  freeReleaseMs: 3_600_000,
  /** alias writes per key a day */
  aliasPerKey: 20,
});

const enc = new TextEncoder();
const err = (status, code, message) => ({ status, code, message });
const unb64 = s => { if (!/^[A-Za-z0-9_-]*$/.test(String(s))) return null; try { return Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), c => c.charCodeAt(0)); } catch { return null; } };
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

/** The bytes a key signs to claim or replace its record. @param {{ name: string, kind: string, pub: string, ts: number|string, sealedHash: string }} m */
export const recordMessage = m => enc.encode(`${RECORD_TAG}\n${m.name}\n${m.kind}\n${m.pub}\n${m.ts}\n${m.sealedHash}`);
/** What an own domain's TXT carries, signed by the identity key. */
export const aliasMessage = m => enc.encode(`${ALIAS_TAG}\n${m.name}\n${m.domain}\n${m.keyId}`);
export const rotateMessage = m => enc.encode(`${ROTATE_TAG}\n${m.name}\n${m.from}\n${m.to}`);

async function verifySig(pubBytes, message, sigBytes) {
  if (!pubBytes || !sigBytes || pubBytes.length !== 32 || sigBytes.length !== 64) return false;
  try { return await crypto.subtle.verify({ name: "Ed25519" }, await crypto.subtle.importKey("raw", pubBytes, { name: "Ed25519" }, false, ["verify"]), sigBytes, message); } catch { return false; }
}

/** A hostname the directory will accept as an alias: letters, digits, dashes, at least two labels, no IP, nothing under vyre.run. @param {unknown} raw */
export function aliasDomain(raw) {
  const d = String(raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (d.length < 4 || d.length > 253) return null;
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return null;
  if (d === "vyre.run" || d.endsWith(".vyre.run") || d.includes("xn--")) return null;
  return d;
}

/** The TXT strings at a name, over DNS-over-HTTPS unless the environment gives a resolver. @param {any} env @param {string} name @returns {Promise<string[]>} */
async function txtOf(env, name) {
  if (typeof env.RESOLVE_TXT === "function") return (await env.RESOLVE_TXT(name)).map(String);
  const f = env.DOH_FETCH || globalThis.fetch.bind(globalThis);
  const res = await f(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: "application/dns-json" } });
  const j = await res.json();
  return (j.Answer || []).filter(a => a.type === 16).map(a => String(a.data).replace(/^"|"$/g, "").replace(/" "/g, ""));
}

/** @param {any} b the posted record @param {string} kind */
function shapeOf(b, name, kind) {
  const r = b.record;
  if (!r || typeof r !== "object" || Array.isArray(r)) throw err(400, "bad_record", "send the signed record");
  if (r.name !== name || r.kind !== kind) throw err(400, "bad_record", "the record is for another name or kind");
  if (typeof r.pub !== "string" || !unb64(r.pub) || unb64(r.pub)?.length !== 32) throw err(400, "bad_record", "the record's key is not an Ed25519 key");
  if (typeof r.sealed !== "string" || r.sealed.length < 1 || r.sealed.length > ID_LIMITS.sealed || !/^[A-Za-z0-9_-]+$/.test(r.sealed)) throw err(400, "bad_record", "the sealed record is missing or too large");
  if (!Number.isFinite(Number(r.ts))) throw err(400, "bad_record", "the record has no time");
  if (typeof b.recordSig !== "string") throw err(400, "bad_record", "the record is not signed");
  return r;
}

/** The mixin: methods the Directory gains. `this` is the Directory. */
export const idOps = {
  /** @this {any} */
  async idLoad(name) {
    let rec = await this.store.get(`id/${name}`);
    if (!rec) return null;
    if (rec.pending && rec.pending.eta <= this.now()) rec = await this.idLand(rec);
    return rec;
  },
  /** @this {any} */
  async idSave(rec) { await this.store.put(`id/${rec.name}`, rec); },
  /** @this {any} */
  async idLand(rec) {
    const p = rec.pending;
    rec.pending = null;
    await this.store.delete(`ip/${p.route}`);
    if (await this.store.get(`ir/${p.route}`)) { this.note(rec, "recovery-void", { reason: "key already holds a name" }); await this.idSave(rec); return rec; }
    if (rec.route && await this.store.get(`ir/${rec.route}`) === rec.name) await this.store.delete(`ir/${rec.route}`);
    await this.store.put(`ir/${p.route}`, rec.name);
    Object.assign(rec, { route: p.route, pub: p.pub, sealed: p.sealed, recordSig: p.recordSig, ts: p.ts, codeHash: p.next });
    this.note(rec, "recovered", {});
    await this.idSave(rec);
    return rec;
  },
  /** The identity record a name resolves to, or null; a tombstone resolves to nothing. @this {any} */
  async idLiveRecord(name) {
    const rec = await this.idLoad(name);
    return rec && rec.state !== "tombstone" ? rec : null;
  },
  /** @this {any} */
  async idOwned(b, a) {
    const v = verdict(b.name);
    const rec = v.status === "invalid" ? null : await this.idLoad(v.name);
    if (!rec || rec.route !== a.route || rec.state === "tombstone") throw err(403, "not_yours", "that name is not held by this key");
    return rec;
  },

  /** @this {any} */
  async op_idClaim(b, a, ip) {
    const v = verdict(b.name);
    if (v.status === "invalid") throw err(400, "invalid", v.why || "not a name");
    if (v.status === "reserved") throw err(403, "reserved", "that name is reserved");
    const kind = String(b.kind);
    if (!KINDS.includes(kind)) throw err(400, "bad_kind", "a name is for a person or a space");
    const held = await this.store.get(`ir/${a.route}`);
    if (held) {
      if (held === v.name) return { name: v.name, mine: true, code: null };
      throw err(409, "one_per_key", `this key already holds ${held}`);
    }
    const r = shapeOf(b, v.name, kind);
    const pub = unb64(r.pub);
    if (await routeId(pub) !== a.route) throw err(403, "wrong_key", "the record's key is not the key that signed the request");
    if (Math.abs(this.now() - Number(r.ts)) > ID_LIMITS.recordSkewMs) throw err(400, "stale", "the record's time is off; check the clock");
    const sealedHash = await sha256(r.sealed);
    if (!await verifySig(pub, recordMessage({ name: v.name, kind, pub: r.pub, ts: r.ts, sealedHash }), unb64(b.recordSig))) throw err(403, "bad_signature", "the record's signature does not check out");
    // One namespace: a name used by a box, or by any identity, is taken.
    if (await this.load(v.name) || await this.idLoad(v.name)) throw err(409, "taken", "someone else has that name");
    await this.count("ip", ip, 5, "too many names claimed from this address today");
    const max = Number(this.env.GLOBAL_CLAIMS_PER_DAY) || 500;
    await this.count("all", "all", max, "the directory is busy today; try again tomorrow");
    const raw = new Uint8Array(16);
    crypto.getRandomValues(raw);
    const code = base32(raw).slice(0, 26).replace(/(.{4})(?=.)/g, "$1-");
    const rec = { v: 1, name: v.name, kind, route: a.route, pub: r.pub, sealed: r.sealed, recordSig: b.recordSig, ts: Number(r.ts), state: "live", claimedAt: this.now(),
      aliases: [], codeHash: await codeHash(v.name, code), pending: null, notices: [], log: [] };
    await this.idSave(rec);
    await this.store.put(`ir/${a.route}`, v.name);
    return { name: v.name, kind, mine: true, code };
  },

  /** @this {any} */
  async op_idResolve(_b, _a, _ip, q) {
    let name = null;
    if (q.alias) {
      const d = aliasDomain(q.alias);
      name = d ? await this.store.get(`ia/${d}`) : null;
    } else {
      const v = verdict(q.name);
      name = v.status === "invalid" ? null : v.name;
    }
    const rec = name ? await this.idLiveRecord(name) : null;
    // A missing, released and invalid name answer the same, so a probe learns only what a holder published.
    if (!rec) throw err(404, "not_found", "no such name");
    return { name: rec.name, kind: rec.kind, pub: rec.pub, keyId: rec.route, sealed: rec.sealed, recordSig: rec.recordSig, ts: rec.ts, aliases: rec.aliases };
  },

  /** @this {any} */
  async op_idMine(_b, a) {
    const name = await this.store.get(`ir/${a.route}`);
    const rec = name ? await this.idLoad(name) : null;
    if (!rec) return { name: null };
    return { name: rec.name, kind: rec.kind, state: rec.state, aliases: rec.aliases, pending: rec.pending ? { eta: rec.pending.eta } : null, notices: rec.notices };
  },

  /** The holder replaces the sealed record (the space's home moved, a new relay). @this {any} */
  async op_idUpdate(b, a) {
    const rec = await this.idOwned(b, a);
    const r = shapeOf(b, rec.name, rec.kind);
    if (r.pub !== rec.pub) throw err(400, "wrong_key", "an update keeps the key; rotate to change it");
    if (Math.abs(this.now() - Number(r.ts)) > ID_LIMITS.recordSkewMs || Number(r.ts) <= rec.ts) throw err(400, "stale", "the record must be newer than the one it replaces and match the clock");
    const sealedHash = await sha256(r.sealed);
    if (!await verifySig(unb64(rec.pub), recordMessage({ name: rec.name, kind: rec.kind, pub: r.pub, ts: r.ts, sealedHash }), unb64(b.recordSig))) throw err(403, "bad_signature", "the record's signature does not check out");
    Object.assign(rec, { sealed: r.sealed, recordSig: b.recordSig, ts: Number(r.ts) });
    await this.idSave(rec);
    return { name: rec.name, ts: rec.ts };
  },

  /** An own domain as an alias: its owner puts a TXT at _vyre-id.<domain> signed by the identity key. @this {any} */
  async op_idAlias(b, a, _ip) {
    const rec = await this.idOwned(b, a);
    const domain = aliasDomain(b.domain);
    if (!domain) throw err(400, "bad_domain", "that is not a domain the directory can alias");
    await this.count("alias", a.route, ID_LIMITS.aliasPerKey, "too many alias attempts today");
    const taken = await this.store.get(`ia/${domain}`);
    if (taken && taken !== rec.name) throw err(409, "taken", "another name already has that domain");
    if (rec.aliases.includes(domain)) return { name: rec.name, domain, aliases: rec.aliases };
    if (rec.aliases.length >= ID_LIMITS.aliases) throw err(409, "too_many", `at most ${ID_LIMITS.aliases} domains`);
    let txt;
    try { txt = await txtOf(this.env, `_vyre-id.${domain}`); } catch { throw err(502, "dns_unavailable", "could not read the domain's DNS; try again"); }
    let proven = false;
    for (const line of txt) {
      const m = /^vyre-id=1;name=([a-z0-9-]+);key=([a-z2-7]{26});sig=([A-Za-z0-9_-]+)$/.exec(line.trim());
      if (!m || m[1] !== rec.name || m[2] !== rec.route) continue;
      if (await verifySig(unb64(rec.pub), aliasMessage({ name: rec.name, domain, keyId: rec.route }), unb64(m[3]))) { proven = true; break; }
    }
    if (!proven) throw err(403, "not_proven", `put the TXT record at _vyre-id.${domain} that your device shows, then try again`);
    rec.aliases = [...rec.aliases, domain];
    await this.idSave(rec);
    await this.store.put(`ia/${domain}`, rec.name);
    return { name: rec.name, domain, aliases: rec.aliases };
  },

  /** @this {any} */
  async op_idAliasClear(b, a) {
    const rec = await this.idOwned(b, a);
    const domain = aliasDomain(b.domain);
    if (!domain || !rec.aliases.includes(domain)) throw err(404, "not_found", "that domain is not an alias of this name");
    rec.aliases = rec.aliases.filter(d => d !== domain);
    await this.idSave(rec);
    await this.store.delete(`ia/${domain}`);
    return { name: rec.name, aliases: rec.aliases };
  },

  /** The holder moves the name to a new key. Both keys sign: the old one by authenticating, the new one over the move. @this {any} */
  async op_idRotate(b, a) {
    const rec = await this.idOwned(b, a);
    const r = shapeOf(b, rec.name, rec.kind);
    const next = unb64(r.pub);
    const nextRoute = await routeId(/** @type {Uint8Array} */ (next));
    if (nextRoute === rec.route) throw err(400, "same_key", "that is the key it already has");
    if (await this.store.get(`ir/${nextRoute}`)) throw err(409, "one_per_key", "the new key already holds a name");
    if (Math.abs(this.now() - Number(r.ts)) > ID_LIMITS.recordSkewMs) throw err(400, "stale", "the record's time is off; check the clock");
    const sealedHash = await sha256(r.sealed);
    if (!await verifySig(next, recordMessage({ name: rec.name, kind: rec.kind, pub: r.pub, ts: r.ts, sealedHash }), unb64(b.recordSig))) throw err(403, "bad_signature", "the new record's signature does not check out");
    if (!await verifySig(next, rotateMessage({ name: rec.name, from: rec.route, to: nextRoute }), unb64(b.rotateSig))) throw err(403, "bad_signature", "the new key did not sign the move");
    await this.store.delete(`ir/${rec.route}`);
    await this.store.put(`ir/${nextRoute}`, rec.name);
    Object.assign(rec, { route: nextRoute, pub: r.pub, sealed: r.sealed, recordSig: b.recordSig, ts: Number(r.ts) });
    this.note(rec, "rotated", { to: nextRoute.slice(0, 8) });
    await this.idSave(rec);
    return { name: rec.name, keyId: nextRoute };
  },

  /** @this {any} */
  async op_idRelease(b, a) {
    const rec = await this.idOwned(b, a);
    await this.store.delete(`ir/${a.route}`);
    for (const d of rec.aliases) await this.store.delete(`ia/${d}`);
    if (this.now() - rec.claimedAt <= ID_LIMITS.freeReleaseMs) { await this.store.delete(`id/${rec.name}`); return { name: rec.name, tombstone: false }; }
    // Used: the name can never be anyone else's. Only the recovery code moves it.
    Object.assign(rec, { state: "tombstone", route: null, aliases: [], sealed: "", pending: null });
    this.note(rec, "released", {});
    await this.idSave(rec);
    return { name: rec.name, tombstone: true };
  },

  /** A new key asks to take a name over with the recovery code; it waits 72 hours and the current key can cancel. @this {any} */
  async op_idRecover(b, a, ip) {
    const v = verdict(b.name);
    await this.count("rip", ip, 20, "too many recovery attempts from this address today");
    await this.count("rname", v.name, 5, "too many recovery attempts for that name today");
    const refused = () => err(403, "refused", "that name and code do not match");
    if (v.status === "invalid" || !/^[0-9a-f]{64}$/.test(String(b.next || ""))) throw refused();
    const rec = await this.idLoad(v.name);
    const ok = rec && String(rec.codeHash) === await codeHash(v.name, String(b.code || ""));
    if (rec) { rec.log = [...(rec.log || []), { at: this.now(), ok: Boolean(ok), route: a.route.slice(0, 8) }].slice(-50); await this.idSave(rec); }
    if (!ok) throw refused();
    if (rec.route === a.route) throw err(409, "already_yours", "this key already holds that name");
    if (await this.store.get(`ir/${a.route}`)) throw err(409, "one_per_key", "this key already holds a name");
    if (rec.pending) {
      if (rec.pending.route === a.route) return { name: rec.name, pendingUntil: rec.pending.eta };
      throw err(409, "pending", "another recovery of that name is already waiting");
    }
    const r = shapeOf(b, rec.name, rec.kind);
    const pub = unb64(r.pub);
    if (await routeId(pub) !== a.route) throw err(403, "wrong_key", "the record's key is not the key that signed the request");
    const sealedHash = await sha256(r.sealed);
    if (!await verifySig(pub, recordMessage({ name: rec.name, kind: rec.kind, pub: r.pub, ts: r.ts, sealedHash }), unb64(b.recordSig))) throw err(403, "bad_signature", "the record's signature does not check out");
    rec.pending = { route: a.route, at: this.now(), eta: this.now() + ID_LIMITS.recoverMs, next: b.next, pub: r.pub, sealed: r.sealed, recordSig: b.recordSig, ts: Number(r.ts) };
    await this.store.put(`ip/${a.route}`, rec.name);
    this.note(rec, "recovery-pending", { eta: rec.pending.eta, by: a.route.slice(0, 8) });
    await this.idSave(rec);
    return { name: rec.name, pendingUntil: rec.pending.eta };
  },

  /** @this {any} */
  async op_idRecoverCancel(b, a) {
    const rec = await this.idOwned(b, a);
    if (!rec.pending) return { name: rec.name, cancelled: false };
    await this.store.delete(`ip/${rec.pending.route}`);
    rec.pending = null;
    this.note(rec, "recovery-cancelled", {});
    await this.idSave(rec);
    return { name: rec.name, cancelled: true };
  },
};

export const ID_ROUTES = Object.freeze({
  "POST /v1/ids/claim": "idClaim", "GET /v1/ids/resolve": "idResolve", "GET /v1/ids/mine": "idMine", "POST /v1/ids/update": "idUpdate",
  "POST /v1/ids/alias": "idAlias", "DELETE /v1/ids/alias": "idAliasClear", "POST /v1/ids/rotate": "idRotate", "POST /v1/ids/release": "idRelease",
  "POST /v1/ids/recover": "idRecover", "POST /v1/ids/recover/cancel": "idRecoverCancel",
});
