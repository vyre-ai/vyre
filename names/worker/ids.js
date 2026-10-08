// @ts-check
// Identity names in the directory (team/0.3/DESIGN-wink.md sections 1 and 2). The name points at an IDENTITY, a permanent id with a
// signed, chained list of who can speak for it (names/worker/chain.js), never at a single key. A person is `alex.vyre.run`, a space is
// `harlow.vyre.run`: one namespace with the box names, so a name is taken once.
//
//   POST   /v1/ids/claim          {name, ops, sealed, rec}          claim a name for an identity: its genesis chain and a sealed record
//   GET    /v1/ids/resolve        ?name= or ?alias=                 the whole chain and the sealed record. Exact name only: no list, no search
//   POST   /v1/ids/append         {name, ops}                       new ops on the chain (add, remove, replace-code, recover), each verified
//   POST   /v1/ids/update         {name, sealed, rec}               an entry replaces the sealed record (the home moved)
//   POST   /v1/ids/alias          {name, domain}                    verify an own domain by a TXT at _vyre-id.<domain> signed by an entry
//   DELETE /v1/ids/alias          {name, domain, act}
//   POST   /v1/ids/release        {name, act}                       an entry that is not a newcomer gives the name up
//
// Nothing here needs a request signature: every write carries its own proof (a chain op is signed by an entry already on the list, a
// record or an act by an entry), so a relay or an operator can pass it along but cannot make one. The directory holds only public keys
// and an opaque sealed record encrypted under a key derived from the NAME, so it cannot read it. It verifies every update against the
// previous list, so an operator cannot forge an entry, and a client that kept the head it last saw (chain.js checkAnswer) notices a
// stale or forked answer. There is no recovery wait here: recovery is a chain op (the code, or two contacts), and the 24 hour newcomer
// rule inside the chain is what stops a takeover. Nothing here publishes a DNS record.

import { verdict, base32, dnsFor, same, sha256 } from "./index.js";
import * as C from "./chain.js";

export const RECORD_TAG = "vyre-id-record-v1";
export const ALIAS_TAG = "vyre-id-alias-v1";
export const ACT_TAG = "vyre-id-act-v1";
export const RESERVE_TAG = "vyre-id-reserve-v1";
export const KINDS = Object.freeze(["person", "space"]);
export const ID_LIMITS = Object.freeze({
  /** characters of the sealed record */
  sealed: 2048,
  /** own domains one identity may alias */
  aliases: 5,
  /** a reservation code lives this long */
  reserveMs: 24 * 3_600_000,
  /** how far a record's own time may be from the directory's */
  recordSkewMs: 5 * 60_000,
  /** a name released within this time of its claim is freed; later it is a tombstone for good */
  freeReleaseMs: 3_600_000,
  /** alias writes per name a day */
  aliasPerName: 20,
  /** chain ops added per name a day */
  appendPerName: 200,
  /** ops in one append */
  appendBatch: 20,
});

const enc = new TextEncoder();
const ALPHA32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** The only thing the directory keeps of a reservation code: a hash that names the name and the code (ignoring case, dashes and spaces). @param {string} name @param {string} code */
export async function reserveHash(name, code) { return sha256(`${RESERVE_TAG}\n${name}\n${String(code).toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^VYRE/, "")}`); }
const err = (status, code, message) => ({ status, code, message });
const unb64 = C.unb64;

export { recordMessage, aliasMessage, actMessage } from "./id-messages.js";
import { recordMessage, aliasMessage, actMessage } from "./id-messages.js";

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

/** The chain's owner lookup: a person's whole chain by id (the verifier checks it itself). @this {any} @param {string} id */
async function ownerOps(id) {
  const name = await this.store.get(`ii/${id}`);
  const rec = name ? await this.store.get(`id/${name}`) : null;
  return rec && rec.state !== "tombstone" ? rec.ops : null;
}

/**
 * Does this signature continue what the record's current signer made? The same signer (the same device through the owner's list for a space, the same entry for a person) that has been on its list since it
 * signed that record. A key put back after a removal has a newer `since`, and a `since` that cannot be read (not a finite number) is never "the same": the newcomer rule then applies (fail closed).
 * @param {any} cur the record's current signature (`by`, `via`, `ts`) or null @param {any} sig the new one, with its `since`
 */
export function continuesOwnRecord(cur, sig) {
  if (!cur) return false;
  const sameSigner = cur.via ? sig.via === cur.via : !sig.via && sig.by === cur.by;
  return sameSigner && Number.isFinite(sig.since) && sig.since <= cur.ts;
}

/** The mixin: methods the Directory gains. `this` is the Directory. */
export const idOps = {
  /** @this {any} */
  async idLoad(name) { return (await this.store.get(`id/${name}`)) || null; },
  /** @this {any} */
  async idSave(rec) { await this.store.put(`id/${rec.name}`, rec); },
  /** The identity record a name resolves to, or null; a tombstone resolves to nothing. @this {any} */
  async idLiveRecord(name) {
    const rec = await this.idLoad(name);
    return rec && rec.state !== "tombstone" ? rec : null;
  },
  /** @this {any} */
  idCtx() { return { now: this.now(), ownerOps: ownerOps.bind(this) }; },
  /** For ops, records and acts being ACCEPTED now: a space's owner device must be on the owner's current list. @this {any} */
  idLive() { return { ...this.idCtx(), live: true }; },
  /** The entry ids that may sign a request for a route: kept so the box-side "is this name mine" check still works. @param {C.State} state */
  eidsOf(state) { return state.entries.filter(e => e.kind === "device" || e.kind === "code").map(e => e.eid); },

  /** Check an entry's signature over a sealed record. @this {any} */
  async idCheckRecord(rec, state, r, sealed) {
    if (!r || typeof r !== "object" || typeof r.sig !== "string") throw err(400, "bad_record", "send the signed record");
    if (typeof sealed !== "string" || sealed.length < 1 || sealed.length > ID_LIMITS.sealed || !/^[A-Za-z0-9_-]+$/.test(sealed)) throw err(400, "bad_record", "the sealed record is missing or too large");
    if (!Number.isFinite(Number(r.ts)) || Math.abs(this.now() - Number(r.ts)) > ID_LIMITS.recordSkewMs) throw err(400, "stale", "the record's time is off; check the clock");
    let key;
    try { key = await C.signerKey(state, String(r.by), r.via ? String(r.via) : undefined, Number(r.ts), this.idLive(), { seq: r.vseq, head: r.vhead }); } catch (e) { throw err(403, "bad_signature", String(/** @type {any} */ (e).message)); }
    const sealedHash = await C.sha256hex(sealed);
    if (!await C.verifyWith(key.pub, recordMessage({ name: rec.name, id: state.id, by: String(r.by), via: r.via ? String(r.via) : undefined, ts: r.ts, sealedHash, vseq: r.vseq, vhead: r.vhead }), r.sig, key.signing)) throw err(403, "bad_signature", "the record's signature does not check out");
    const out = { by: String(r.by), via: r.via ? String(r.via) : undefined, ...(r.vseq !== undefined ? { vseq: r.vseq, vhead: r.vhead } : {}), ts: Number(r.ts), sig: r.sig };
    // Not stored: whether the signing device was a newcomer, for the caller's rule (a record update by a young device).
    Object.defineProperty(out, "young", { value: key.young === true, enumerable: false });
    // When the signing key was last put on its list: a key that was removed and put back starts again from now (a removal resets its age).
    let since = NaN;
    try {
      if (state.kind === "space") {
        // the signing device is on the OWNER's list: its age is that entry's, on the owner's chain as it stands now
        const ops = await ownerOps.call(this, String(r.by));
        const owner = ops ? await C.verifyChain(ops, { ...this.idCtx(), now: this.now() + C.SKEW_MS }) : null;
        const dev = owner && r.via ? owner.entries.find((/** @type {any} */ e) => e.eid === String(r.via)) : null;
        if (dev) since = Number(dev.since);
      } else {
        const e = state.entries.find((/** @type {any} */ x) => x.eid === String(r.by));
        if (e) since = Number(e.since);
      }
    } catch { since = NaN; }
    Object.defineProperty(out, "since", { value: since, enumerable: false });
    return out;
  },

  /** Check a signed act (alias clear, release) by an entry; `fresh` forbids a newcomer. @this {any} */
  async idCheckAct(rec, act, action, domain, { fresh = false } = {}) {
    if (!act || typeof act !== "object" || typeof act.sig !== "string") throw err(400, "bad_act", "sign the request with an entry on the list");
    if (!Number.isFinite(Number(act.ts)) || Math.abs(this.now() - Number(act.ts)) > ID_LIMITS.recordSkewMs) throw err(400, "stale", "the request's time is off; check the clock");
    const state = await C.verifyChain(rec.ops, { ...this.idCtx(), now: this.now() + C.SKEW_MS });
    let key;
    try { key = await C.signerKey(state, String(act.by), act.via ? String(act.via) : undefined, this.now(), this.idLive()); } catch (e) { throw err(403, "not_yours", "that name is not held by this entry"); }
    if (!await C.verifyWith(key.pub, actMessage({ action, name: rec.name, domain, ts: act.ts }), act.sig, key.signing)) throw err(403, "bad_signature", "the signature does not check out");
    if (fresh && key.young) throw err(403, "newcomer", "a sign-in under 24 hours old cannot do that");
    return state;
  },

  /**
   * Claim a name for a SPACE, signed by an owner identity that already exists (the chain's own owner lookup checks it). A person's first name is never claimed here: it comes
   * from a reservation made on the web and finalized with the code (op_idFinalize), so no identity is created any other way.
   * @this {any}
   */
  async op_idClaim(b, _a, ip) {
    return this.idClaimCore(b, ip, null);
  },

  /**
   * A reservation: the name is held for this person for 24 hours and a code is returned, once. Only a hash of it is kept (so the Worker cannot read it back), it is good for one finalize, and
   * reserving the same name again replaces the hash, so the older code stops working. Nothing here needs a key or a server: the web page only reserves.
   * @this {any}
   */
  async op_idReserve(b, _a, ip) {
    const v = verdict(b.name);
    if (v.status === "invalid") throw err(400, "invalid", v.why || "not a name");
    if (v.status === "reserved") throw err(403, "reserved", "that name is reserved");
    if (await this.load(v.name) || await this.idLoad(v.name)) throw err(409, "taken", "someone else has that name");
    await this.count("rsvip", ip, Number(this.env.RESERVES_PER_IP_PER_DAY) || 20, "too many names reserved from this address today");
    await this.count("rsv", "all", Number(this.env.GLOBAL_CLAIMS_PER_DAY) || 500, "the directory is busy today; try again tomorrow");
    const raw = Array.from(crypto.getRandomValues(new Uint8Array(20)), x => ALPHA32[x & 31]).join("");   // 20 characters of 5 bits: 100 bits
    const code = "VYRE-" + raw.match(/.{4}/g).join("-");
    const expires = this.now() + ID_LIMITS.reserveMs;
    await this.store.put(`rsv/${v.name}`, { hash: await reserveHash(v.name, code), exp: expires });
    return { name: v.name, code, expires };
  },

  /** A live reservation of a name, or null; an expired one is dropped. @this {any} @param {string} name */
  async idReservation(name) {
    const r = await this.store.get(`rsv/${name}`);
    if (!r) return null;
    if (this.now() >= r.exp) { await this.store.delete(`rsv/${name}`); return null; }
    return r;
  },

  /**
   * A person's first name: the genesis chain the app made with its own key, plus the reservation code. The code is checked before anything else is learned, burns when the claim goes through,
   * and one answer covers every way it can be wrong.
   * @this {any}
   */
  async op_idFinalize(b, _a, ip) {
    const v = verdict(b.name);
    if (v.status === "invalid") throw err(400, "invalid", v.why || "not a name");
    const bad = () => err(403, "bad_code", "that reservation code is not valid; it may have expired, been used, or been replaced");
    const r = v.status === "reserved" ? null : await this.idReservation(v.name);
    if (!r || typeof b.code !== "string" || !same(await reserveHash(v.name, b.code), r.hash)) throw bad();
    const out = await this.idClaimCore(b, ip, "person");
    await this.store.delete(`rsv/${v.name}`);
    return out;
  },

  /** @this {any} @param {any} b @param {string} ip @param {"person"|null} viaCode a person's genesis is accepted only with the code */
  async idClaimCore(b, ip, viaCode) {
    const v = verdict(b.name);
    if (v.status === "invalid") throw err(400, "invalid", v.why || "not a name");
    if (v.status === "reserved") throw err(403, "reserved", "that name is reserved");
    const ops = Array.isArray(b.ops) ? b.ops : [];
    if (!ops.length || ops.length > ID_LIMITS.appendBatch) throw err(400, "bad_chain", "send the identity's chain from its genesis");
    let state;
    try { state = await C.verifyChain(ops, this.idLive()); } catch (e) { throw err(400, String(/** @type {any} */ (e).code || "bad_chain"), String(/** @type {any} */ (e).message)); }
    // A person is created one way only; a space one way only.
    if (viaCode ? state.kind !== "person" : state.kind !== "space") throw err(403, viaCode ? "not_a_person" : "reserve_first", viaCode ? "a reservation is for a person's first name" : "a first name is reserved at vyre.run/setup, then finished in the app");
    const held = await this.store.get(`ii/${state.id}`);
    if (held) {
      if (held === v.name) return { name: v.name, kind: state.kind, id: state.id, mine: true };
      throw err(409, "one_per_identity", `this identity already holds ${held}`);
    }
    const rec0 = { name: v.name };
    const sig = await this.idCheckRecord(rec0, state, b.rec, b.sealed);
    // One namespace: a name used by a box, or by any identity, is taken. Another person's live reservation holds it too.
    if (await this.load(v.name) || await this.idLoad(v.name) || (!viaCode && await this.idReservation(v.name))) throw err(409, "taken", "someone else has that name");
    await this.count("ip", ip, Number(this.env.CLAIMS_PER_IP_PER_DAY) || 5, "too many names claimed from this address today");
    const max = Number(this.env.GLOBAL_CLAIMS_PER_DAY) || 500;
    await this.count("all", "all", max, "the directory is busy today; try again tomorrow");
    const rec = { v: 2, name: v.name, kind: state.kind, id: state.id, ops, eids: this.eidsOf(state), sealed: b.sealed, rec: sig, state: "live", claimedAt: this.now(), aliases: [], notices: [], log: [] };
    await this.idSave(rec);
    await this.store.put(`ii/${state.id}`, v.name);
    return { name: v.name, kind: state.kind, id: state.id, mine: true };
  },

  /** Exact name only. A missing, released and invalid name answer alike, so a probe learns only what a holder published. @this {any} */
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
    if (!rec) throw err(404, "not_found", "no such name");
    return { name: rec.name, kind: rec.kind, id: rec.id, ops: rec.ops, sealed: rec.sealed, rec: rec.rec, aliases: rec.aliases };
  },

  /** New ops on a name's chain, each verified against the list before it. @this {any} */
  async op_idAppend(b, _a, ip) {
    const v = verdict(b.name);
    const rec = v.status === "invalid" ? null : await this.idLiveRecord(v.name);
    if (!rec) throw err(404, "not_found", "no such name");
    const add = Array.isArray(b.ops) ? b.ops : [];
    if (!add.length || add.length > ID_LIMITS.appendBatch) throw err(400, "bad_chain", `send between 1 and ${ID_LIMITS.appendBatch} ops`);
    await this.count("iap", rec.name, ID_LIMITS.appendPerName, "too many changes to that identity today");
    const live = this.idLive();
    let state = await C.verifyChain(rec.ops, { ...this.idCtx(), now: this.now() + C.SKEW_MS });
    const before = state.seq;
    for (const op of add) {
      if (op && op.seq <= state.seq) {
        // The caller is resending what the directory has: fine if it is the same op, a fork if not.
        if (await C.hashOf(rec.ops[op.seq]) === await C.hashOf(op)) continue;
        throw err(409, "fork", "that op is not the one the list already has at that place");
      }
      try { state = await C.applyOp(state, op, live); } catch (e) { throw err(/** @type {any} */ (e).code === "newcomer" ? 403 : 400, String(/** @type {any} */ (e).code || "bad_op"), String(/** @type {any} */ (e).message)); }
    }
    if (state.seq === before) return { name: rec.name, id: rec.id, seq: state.seq, head: state.head };
    if (state.seq > C.MAX_OPS) throw err(409, "too_long", "that chain is as long as a chain may be");
    rec.ops = [...rec.ops, ...add.filter((/** @type {any} */ o) => o.seq > before)];
    rec.eids = this.eidsOf(state);
    this.note(rec, "chain", { from: before, to: state.seq });
    await this.idSave(rec);
    return { name: rec.name, id: rec.id, seq: state.seq, head: state.head };
  },

  /** An entry replaces the sealed record (the space's home moved, a new relay). @this {any} */
  async op_idUpdate(b) {
    const v = verdict(b.name);
    const rec = v.status === "invalid" ? null : await this.idLiveRecord(v.name);
    if (!rec) throw err(404, "not_found", "no such name");
    const state = await C.verifyChain(rec.ops, { ...this.idCtx(), now: this.now() + C.SKEW_MS });
    const sig = await this.idCheckRecord(rec, state, b.rec, b.sealed);
    // A space's record says where its home is (route, home, root key), sealed, so what changed cannot be told here: a device under 24 hours old (a stolen one, added with a recovery code) must not
    // repoint a space. It may continue what it itself signed (the same device as the record's current signer), so a phone that made the space this morning can finish setting it up.
    // The same for a person's record (where their home or box is). Continuing means the same signer: the same device through the owner's list for a space, the same entry for a person.
    // ...and only while it has been on its list since it signed that record: a key that was removed and put back is a newcomer again, so an old compromised key cannot come back and repoint.
    const same = continuesOwnRecord(rec.rec, sig);
    if (sig.young && !same) throw err(403, "newcomer", rec.kind === "space" ? "a sign-in under 24 hours old cannot change where a space lives" : "a sign-in under 24 hours old cannot change where your name points");
    if (rec.rec && sig.ts <= rec.rec.ts) throw err(400, "stale", "the record must be newer than the one it replaces and match the clock");
    Object.assign(rec, { sealed: b.sealed, rec: sig });
    await this.idSave(rec);
    return { name: rec.name, ts: sig.ts };
  },

  /** An own domain as an alias: its owner puts a TXT at _vyre-id.<domain> signed by an entry of the identity. @this {any} */
  async op_idAlias(b, _a, _ip) {
    const v = verdict(b.name);
    const rec = v.status === "invalid" ? null : await this.idLiveRecord(v.name);
    if (!rec) throw err(404, "not_found", "no such name");
    const domain = aliasDomain(b.domain);
    if (!domain) throw err(400, "bad_domain", "that is not a domain the directory can alias");
    await this.count("alias", rec.name, ID_LIMITS.aliasPerName, "too many alias attempts today");
    const taken = await this.store.get(`ia/${domain}`);
    if (taken && taken !== rec.name) throw err(409, "taken", "another name already has that domain");
    if (rec.aliases.includes(domain)) return { name: rec.name, domain, aliases: rec.aliases };
    if (rec.aliases.length >= ID_LIMITS.aliases) throw err(409, "too_many", `at most ${ID_LIMITS.aliases} domains`);
    let txt;
    try { txt = await txtOf(this.env, `_vyre-id.${domain}`); } catch { throw err(502, "dns_unavailable", "could not read the domain's DNS; try again"); }
    const state = await C.verifyChain(rec.ops, { ...this.idCtx(), now: this.now() + C.SKEW_MS });
    let proven = false;
    for (const line of txt) {
      const m = /^vyre-id=2;name=([a-z0-9-]+);id=((?:per|spc)_[a-z2-7]{26});by=([a-z2-7_]{26,30});via=([a-z2-7]{26}|-);sig=([A-Za-z0-9_-]+)$/.exec(line.trim());
      if (!m || m[1] !== rec.name || m[2] !== rec.id) continue;
      try {
        const key = await C.signerKey(state, m[3], m[4] === "-" ? undefined : m[4], this.now(), this.idLive());
        if (await C.verifyWith(key.pub, aliasMessage({ name: rec.name, domain, id: rec.id }), m[5], key.signing)) { proven = true; break; }
      } catch { /* not an entry */ }
    }
    if (!proven) throw err(403, "not_proven", `put the TXT record at _vyre-id.${domain} that your device shows, then try again`);
    rec.aliases = [...rec.aliases, domain];
    await this.idSave(rec);
    await this.store.put(`ia/${domain}`, rec.name);
    return { name: rec.name, domain, aliases: rec.aliases };
  },

  /** @this {any} */
  async op_idAliasClear(b) {
    const v = verdict(b.name);
    const rec = v.status === "invalid" ? null : await this.idLiveRecord(v.name);
    if (!rec) throw err(404, "not_found", "no such name");
    const domain = aliasDomain(b.domain);
    if (!domain || !rec.aliases.includes(domain)) throw err(404, "not_found", "that domain is not an alias of this name");
    await this.idCheckAct(rec, b.act, "alias-clear", domain);
    rec.aliases = rec.aliases.filter((/** @type {string} */ d) => d !== domain);
    await this.idSave(rec);
    await this.store.delete(`ia/${domain}`);
    return { name: rec.name, aliases: rec.aliases };
  },


  // ---- certificates for a Space's names, by DNS-01 only (PT-1) ----
  // The relay in front of a Space's edge passes TLS through and must never be able to get a certificate, so the proof of control is a DNS record, which the relay cannot write. The Space
  // signs the request with an entry of its own list (an act, like releasing a name); only then does the directory put the TXT at _acme-challenge.<space>.<zone> (the one label covers the name and its
  // wildcard) and, once, a CAA record that names the one ACME account the Space's Caddy uses, so no other account can be issued a certificate for the name. HTTP-01 and TLS-ALPN-01 are never offered.

  /** The Space whose name this is, with the signed act checked. @this {any} @param {any} b @param {string} action @param {string} subject */
  async idAcmeSpace(b, action, subject) {
    const v = verdict(b.name);
    const rec = v.status === "invalid" ? null : await this.idLiveRecord(v.name);
    if (!rec) throw err(404, "not_found", "no such name");
    if (rec.kind !== "space") throw err(403, "not_a_space", "certificates are issued for a Space's names");
    await this.idCheckAct(rec, b.act, action, subject, { fresh: true });
    return rec;
  },

  /** Put one ACME DNS-01 challenge value for the Space's name. @this {any} */
  async op_idAcme(b) {
    const token = String(b.token || "");
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) throw err(400, "bad_token", "not an ACME challenge value");
    const rec = await this.idAcmeSpace(b, "acme", token);
    await this.count("acme", rec.name, 10, "too many challenges today");
    const fqdn = `_acme-challenge.${rec.name}.${dnsFor(this.env).zone}`;
    await dnsFor(this.env).addTxt(fqdn, token, 4);
    return { fqdn };
  },

  /** Take the challenge values away again. @this {any} */
  async op_idAcmeClear(b) {
    const rec = await this.idAcmeSpace(b, "acme-clear", "-");
    const fqdn = `_acme-challenge.${rec.name}.${dnsFor(this.env).zone}`;
    await dnsFor(this.env).clear(fqdn, "TXT");
    return { fqdn };
  },

  /** Pin issuance for the Space's name to one ACME account (its accounturi). Replaces the pin. @this {any} */
  async op_idCaa(b) {
    const uri = String(b.accounturi || "");
    if (!/^https:\/\/[a-z0-9.-]{1,100}\/[A-Za-z0-9._\/-]{1,120}$/.test(uri)) throw err(400, "bad_account", "not an ACME account URI");
    const rec = await this.idAcmeSpace(b, "caa", uri);
    await this.count("caa", rec.name, 5, "too many changes today");
    const dns = dnsFor(this.env);
    const fqdn = `${rec.name}.${dns.zone}`;
    await dns.setCaa(fqdn, `letsencrypt.org; accounturi=${uri}`);
    return { fqdn, pinned: uri };
  },

  /** Give the name up. Only an entry that is not a newcomer can; used for any time, the name is a tombstone for good. @this {any} */
  async op_idRelease(b) {
    const v = verdict(b.name);
    const rec = v.status === "invalid" ? null : await this.idLiveRecord(v.name);
    if (!rec) throw err(404, "not_found", "no such name");
    await this.idCheckAct(rec, b.act, "release", undefined, { fresh: true });
    for (const d of rec.aliases) await this.store.delete(`ia/${d}`);
    if (this.now() - rec.claimedAt <= ID_LIMITS.freeReleaseMs) {
      await this.store.delete(`id/${rec.name}`);
      await this.store.delete(`ii/${rec.id}`);
      return { name: rec.name, tombstone: false };
    }
    Object.assign(rec, { state: "tombstone", aliases: [], sealed: "", rec: null });
    this.note(rec, "released", {});
    await this.idSave(rec);
    return { name: rec.name, tombstone: true };
  },
};

export const ID_ROUTES = Object.freeze({
  "POST /v1/ids/claim": "idClaim", "POST /v1/ids/reserve": "idReserve", "POST /v1/ids/finalize": "idFinalize", "GET /v1/ids/resolve": "idResolve", "POST /v1/ids/append": "idAppend", "POST /v1/ids/update": "idUpdate",
  "POST /v1/ids/alias": "idAlias", "DELETE /v1/ids/alias": "idAliasClear", "POST /v1/ids/release": "idRelease",
  "POST /v1/ids/acme": "idAcme", "DELETE /v1/ids/acme": "idAcmeClear", "POST /v1/ids/caa": "idCaa",
});
/** The routes that carry their own proof and so take no request signature. */
export const SELF_PROVEN = Object.freeze(new Set(["idClaim", "idReserve", "idFinalize", "idResolve", "idAppend", "idUpdate", "idAlias", "idAliasClear", "idRelease", "idAcme", "idAcmeClear", "idCaa"]));
