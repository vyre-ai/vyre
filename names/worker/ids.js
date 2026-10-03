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

import { verdict, base32 } from "./index.js";
import * as C from "./chain.js";

export const RECORD_TAG = "vyre-id-record-v1";
export const ALIAS_TAG = "vyre-id-alias-v1";
export const ACT_TAG = "vyre-id-act-v1";
export const KINDS = Object.freeze(["person", "space"]);
export const ID_LIMITS = Object.freeze({
  /** characters of the sealed record */
  sealed: 2048,
  /** own domains one identity may alias */
  aliases: 5,
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
const err = (status, code, message) => ({ status, code, message });
const unb64 = C.unb64;

/** The bytes an entry signs over a sealed record. @param {{ name: string, id: string, by: string, via?: string, ts: number|string, sealedHash: string }} m */
export const recordMessage = m => enc.encode(`${RECORD_TAG}\n${m.name}\n${m.id}\n${m.by}\n${m.via || "-"}\n${m.ts}\n${m.sealedHash}`);
/** What an own domain's TXT carries, signed by an entry. */
export const aliasMessage = m => enc.encode(`${ALIAS_TAG}\n${m.name}\n${m.domain}\n${m.id}`);
/** A signed act that is not a chain op: clearing an alias, releasing a name. @param {{ action: string, name: string, domain?: string, ts: number|string }} m */
export const actMessage = m => enc.encode(`${ACT_TAG}\n${m.action}\n${m.name}\n${m.domain || "-"}\n${m.ts}`);

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

/** The directory's view of an identity as the chain's resolver: the state of a person as it stood at a time. @this {any} @param {string} id @param {number} ts */
async function resolveOwner(id, ts) {
  const name = await this.store.get(`ii/${id}`);
  const rec = name ? await this.store.get(`id/${name}`) : null;
  if (!rec || rec.state === "tombstone") return null;
  try { return await C.stateAt(rec.ops, ts, { now: this.now() + C.SKEW_MS }); } catch { return null; }
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
  idCtx() { return { now: this.now(), resolve: resolveOwner.bind(this) }; },
  /** The entry ids that may sign a request for a route: kept so the box-side "is this name mine" check still works. @param {C.State} state */
  eidsOf(state) { return state.entries.filter(e => e.kind === "device" || e.kind === "code").map(e => e.eid); },

  /** Check an entry's signature over a sealed record. @this {any} */
  async idCheckRecord(rec, state, r, sealed) {
    if (!r || typeof r !== "object" || typeof r.sig !== "string") throw err(400, "bad_record", "send the signed record");
    if (typeof sealed !== "string" || sealed.length < 1 || sealed.length > ID_LIMITS.sealed || !/^[A-Za-z0-9_-]+$/.test(sealed)) throw err(400, "bad_record", "the sealed record is missing or too large");
    if (!Number.isFinite(Number(r.ts)) || Math.abs(this.now() - Number(r.ts)) > ID_LIMITS.recordSkewMs) throw err(400, "stale", "the record's time is off; check the clock");
    let key;
    try { key = await C.signerKey(state, String(r.by), r.via ? String(r.via) : undefined, Number(r.ts), this.idCtx()); } catch (e) { throw err(403, "bad_signature", String(/** @type {any} */ (e).message)); }
    const sealedHash = await C.sha256hex(sealed);
    if (!await C.verifyWith(key.pub, recordMessage({ name: rec.name, id: state.id, by: String(r.by), via: r.via ? String(r.via) : undefined, ts: r.ts, sealedHash }), r.sig)) throw err(403, "bad_signature", "the record's signature does not check out");
    return { by: String(r.by), via: r.via ? String(r.via) : undefined, ts: Number(r.ts), sig: r.sig };
  },

  /** Check a signed act (alias clear, release) by an entry; `fresh` forbids a newcomer. @this {any} */
  async idCheckAct(rec, act, action, domain, { fresh = false } = {}) {
    if (!act || typeof act !== "object" || typeof act.sig !== "string") throw err(400, "bad_act", "sign the request with an entry on the list");
    if (!Number.isFinite(Number(act.ts)) || Math.abs(this.now() - Number(act.ts)) > ID_LIMITS.recordSkewMs) throw err(400, "stale", "the request's time is off; check the clock");
    const state = await C.verifyChain(rec.ops, { ...this.idCtx(), now: this.now() + C.SKEW_MS });
    let key;
    try { key = await C.signerKey(state, String(act.by), act.via ? String(act.via) : undefined, this.now(), this.idCtx()); } catch (e) { throw err(403, "not_yours", "that name is not held by this entry"); }
    if (!await C.verifyWith(key.pub, actMessage({ action, name: rec.name, domain, ts: act.ts }), act.sig)) throw err(403, "bad_signature", "the signature does not check out");
    if (fresh && key.young) throw err(403, "newcomer", "a sign-in under 24 hours old cannot do that");
    return state;
  },

  /** @this {any} */
  async op_idClaim(b, _a, ip) {
    const v = verdict(b.name);
    if (v.status === "invalid") throw err(400, "invalid", v.why || "not a name");
    if (v.status === "reserved") throw err(403, "reserved", "that name is reserved");
    const ops = Array.isArray(b.ops) ? b.ops : [];
    if (!ops.length || ops.length > ID_LIMITS.appendBatch) throw err(400, "bad_chain", "send the identity's chain from its genesis");
    let state;
    try { state = await C.verifyChain(ops, this.idCtx()); } catch (e) { throw err(400, String(/** @type {any} */ (e).code || "bad_chain"), String(/** @type {any} */ (e).message)); }
    const held = await this.store.get(`ii/${state.id}`);
    if (held) {
      if (held === v.name) return { name: v.name, kind: state.kind, id: state.id, mine: true };
      throw err(409, "one_per_identity", `this identity already holds ${held}`);
    }
    const rec0 = { name: v.name };
    const sig = await this.idCheckRecord(rec0, state, b.rec, b.sealed);
    // One namespace: a name used by a box, or by any identity, is taken.
    if (await this.load(v.name) || await this.idLoad(v.name)) throw err(409, "taken", "someone else has that name");
    await this.count("ip", ip, 5, "too many names claimed from this address today");
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
    const ctx = this.idCtx();
    let state = await C.verifyChain(rec.ops, { ...ctx, now: this.now() + C.SKEW_MS });
    const before = state.seq;
    for (const op of add) {
      if (op && op.seq <= state.seq) {
        // The caller is resending what the directory has: fine if it is the same op, a fork if not.
        if (await C.hashOf(rec.ops[op.seq]) === await C.hashOf(op)) continue;
        throw err(409, "fork", "that op is not the one the list already has at that place");
      }
      try { state = await C.applyOp(state, op, ctx); } catch (e) { throw err(/** @type {any} */ (e).code === "newcomer" ? 403 : 400, String(/** @type {any} */ (e).code || "bad_op"), String(/** @type {any} */ (e).message)); }
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
        const key = await C.signerKey(state, m[3], m[4] === "-" ? undefined : m[4], this.now(), this.idCtx());
        if (await C.verifyWith(key.pub, aliasMessage({ name: rec.name, domain, id: rec.id }), m[5])) { proven = true; break; }
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
  "POST /v1/ids/claim": "idClaim", "GET /v1/ids/resolve": "idResolve", "POST /v1/ids/append": "idAppend", "POST /v1/ids/update": "idUpdate",
  "POST /v1/ids/alias": "idAlias", "DELETE /v1/ids/alias": "idAliasClear", "POST /v1/ids/release": "idRelease",
});
/** The routes that carry their own proof and so take no request signature. */
export const SELF_PROVEN = Object.freeze(new Set(["idClaim", "idResolve", "idAppend", "idUpdate", "idAlias", "idAliasClear", "idRelease"]));
