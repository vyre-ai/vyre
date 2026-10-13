// @ts-check
// Design B (the sealed space list, rc.4): a server admits a device the person's identity chain lists, for a person who is already a member here, so a brand-new device that proved the identity is a full device
// on each of the person's servers without a typed code. This file is the pure check; core/relay/index.js asks it (admit0) and writes the device row.
//
//   The hello       "vyre-chain-hello-v1" over this server's box id, the identity, the entry, the time (2 minutes), a nonce and the channel's own key id, signed by the entry's chain key. The box id stops a replay at
//                   another server, the channel id carries it onto no other channel (it must equal the id of the key that completed this handshake), the window and a replay set stop a copy. A nonce is spent only by
//                   a hello that VERIFIED, so nobody can burn a victim's.
//   Members only    the identity must already have a role here (`roleOf`), matched by identity id. An identity with none is refused with the SAME words as a bad signature, so a probe cannot tell who is a member.
//   The chain       fetched and verified by this server (`fetchState`, kernel/identity/chain.js behind it), at each new connect and at most every 5 minutes. The highest seq and head seen per identity are kept: a
//                   lower seq, or the same seq with another head (a fork), is refused. When the chain cannot be fetched a device ALREADY admitted keeps working for an hour from the last good fetch; a new one is refused.
//   Limits          the chain's own: a newcomer (under 24 hours on the list) or a relay-held device is admitted but `limited`: it may use, send, approve and hold presence, and the acts only a full device may do are
//                   refused to it where they are made (core/relay, core/wink).

import { verifyWith, youngAt } from "../../kernel/identity/chain.js";

export const CHAIN_HELLO_TAG = "vyre-chain-hello-v1";
export const WINDOW_MS = 120_000;
export const REFRESH_MS = 300_000;
export const GRACE_MS = 3_600_000;
/** An entry the cached chain does not list makes the chain be read again, but not more often than this per identity: a new device just added works at once, and a stranger naming entries cannot make the server hammer the directory. */
export const UNKNOWN_ENTRY_REFRESH_MS = 10_000;
const NONCE_MAX = 4096;

/**
 * Is this chain entry LIMITED right now? A newcomer (under 24 hours on the list, or an age that is unknown), a held-web key, or a device added by signing in with GitHub that nobody has confirmed from a device already
 * trusted. Read from the current chain every time, never remembered: it stops when the 24 hours pass or a confirm lands. @param {any} entry @param {number} t
 */
export const limitedOf = (entry, t) => !Number.isFinite(Number(entry.since)) || youngAt({ founder: entry.founder === true, since: Number(entry.since) }, t) || entry.held === "web" || (entry.via === "github" && entry.confirmed !== true);

/** The relay's own key sits on the chain (held: "relay") so a person can sign in by GitHub. It is never a device: whoever holds the relay must not connect to a server as the owner. @param {any} entry */
const isRelayKey = entry => entry && entry.held === "relay";

/** The bytes the entry key signs. @param {string} box @param {{ identity: string, entry: string, ts: number | string, nonce: string, channel: string, pk?: string }} h `pk` is the sha256 (hex) of the presence public key the hello offers, or "-": the key is bound to the entry's signature. */
export const chainHelloMessage = (box, h) => Buffer.from(`${CHAIN_HELLO_TAG}\n${box}\n${h.identity}\n${h.entry}\n${h.ts}\n${h.nonce}\n${h.channel}\n${h.pk || "-"}`, "utf8");

/**
 * @param {{ boxId: () => Promise<string | null>, roleOf: (identity: string) => string | null | undefined | Promise<string | null | undefined>, fetchState: (identity: string, name?: string) => Promise<any>, now?: () => number }} o
 */
export function createChainAdmit(o) {
  const clock = o.now || Date.now;
  /** @type {Map<string, { state: any, at: number }>} the last good chain per identity and when it was fetched */
  const cache = new Map();
  /** @type {Map<string, { seq: number, head: string }>} the highest chain seen per identity */
  const highest = new Map();
  /** @type {Set<string>} identity/entry pairs this server has admitted */
  const admitted = new Set();
  /** @type {Map<string, number>} spent nonces to the time they may be forgotten */
  const nonces = new Map();

  /** The chain for an identity: from the cache while it is fresh, else fetched, checked against the highest seen, and kept. Answers { state, stale } or { why }. @param {string} identity @param {boolean} known this device was admitted before @param {string} [name] the Vyre name the hello claims, for an identity this server has never seen */
  async function chainOf(identity, known, name, force = false) {
    const t = clock(), have = cache.get(identity);
    if (have && t - have.at <= REFRESH_MS && !(force && t - have.at >= UNKNOWN_ENTRY_REFRESH_MS)) return { state: have.state, stale: false, fetched: false };
    /** @type {any} */ let state = null;
    try { state = await o.fetchState(identity, name); } catch { state = null; }
    if (!state || !Array.isArray(state.entries)) {
      // cannot be checked: a device already admitted keeps working for the grace from the last good fetch; a new one is refused
      if (have && known && t - have.at <= GRACE_MS) return { state: have.state, stale: true, fetched: false };
      return { why: "cannot_check" };
    }
    const top = highest.get(identity);
    if (top) {
      if (state.seq < top.seq) return { why: "chain_older" };
      if (state.seq === top.seq && state.head !== top.head) return { why: "chain_fork" };
    }
    highest.set(identity, { seq: state.seq, head: state.head });
    cache.set(identity, { state, at: t });
    return { state, stale: false, fetched: true };
  }

  return {
    /**
     * Check one chain hello. Answers { ok: true, identity, entry, pub, role, limited, seq, head, stale } or { ok: false, why }.
     * @param {any} h the hello @param {string} channelId the id of the key that completed this handshake
     */
    async check(h, channelId) {
      const t = clock();
      const str = (/** @type {any} */ v, /** @type {RegExp} */ re) => typeof v === "string" && re.test(v);
      if (!h || typeof h !== "object" || Array.isArray(h) || !str(h.identity, /^per_[a-z2-7]{26}$/) || !str(h.entry, /^[a-z2-7]{26}$/) || !str(h.nonce, /^[A-Za-z0-9_-]{16,64}$/) || !str(h.channel, /^[a-z2-7]{16}$/) || !Number.isFinite(Number(h.ts)) || typeof h.sig !== "string" || (h.name !== undefined && !str(h.name, /^[a-z0-9.-]{3,253}$/)) || (h.pk !== undefined && !str(h.pk, /^[a-f0-9]{64}$/))) return { ok: false, why: "bad_input" };
      if (h.channel !== channelId) return { ok: false, why: "wrong_channel" };
      if (Math.abs(t - Number(h.ts)) > WINDOW_MS) return { ok: false, why: "stale" };
      for (const [n, exp] of nonces) { if (exp > t) break; nonces.delete(n); }
      if (nonces.has(h.nonce)) return { ok: false, why: "replayed" };
      // the client hears only `bad_proof` for all three of these (so a probe cannot tell a member from a stranger); `detail` is for this server's own log
      const refuse = (/** @type {string} */ detail) => ({ ok: false, why: "bad_proof", detail });
      // members only, by identity id; the same words as a bad signature when there is none
      const role = await o.roleOf(h.identity);
      if (!role) return refuse("no_role: this identity is neither the owner nor a member here");
      const box = await o.boxId().catch(() => null);
      if (!box) return { ok: false, why: "cannot_check" };
      const known = admitted.has(`${h.identity}/${h.entry}`);
      let c = await chainOf(h.identity, known, h.name);
      if ("why" in c) return { ok: false, why: c.why };
      const find = (/** @type {any} */ st) => (st.entries || []).find((/** @type {any} */ e) => e && e.eid === h.entry && e.kind === "device" && typeof e.pub === "string");
      let entry = find(c.state);
      // a device the person has just added is not in the chain this server cached: read it again now (at most every 10 seconds), then decide
      if (!entry && !c.fetched) { const again = await chainOf(h.identity, known, h.name, true); if (!("why" in again)) { c = again; entry = find(c.state); } }
      if (!entry) return refuse("no_entry: the chain lists no device with that entry id");
      if (isRelayKey(entry)) return refuse("relay_key: the relay's own key is never a device");
      let good = false;
      try { good = await verifyWith(entry.pub, chainHelloMessage(box, h), h.sig, entry); } catch { good = false; }
      if (!good) return refuse(`bad_signature: the entry key did not sign this box, identity, entry, time, nonce, channel and presence key (this server's box id starts ${String(box).slice(0, 6)}, ${String(box).length} characters; channel ${h.channel})`);
      if (nonces.has(h.nonce)) return { ok: false, why: "replayed" };
      nonces.set(h.nonce, t + 2 * WINDOW_MS);
      while (nonces.size > NONCE_MAX) nonces.delete(/** @type {string} */ (nonces.keys().next().value));
      admitted.add(`${h.identity}/${h.entry}`);
      return { ok: true, identity: h.identity, entry: entry.eid, pub: entry.pub, role: String(role), limited: limitedOf(entry, t), pk: h.pk || "-", seq: c.state.seq, head: c.state.head, stale: c.stale };
    },

    /**
     * Where a chain-admitted device stands NOW, read from the chain (fetched again at most every 5 minutes): "ok" (still listed, with `limited` recomputed from the current entry), "gone" (taken off the list, or the
     * relay's own key), or "unknown" (the chain cannot be read and the 1 hour grace is over: the caller refuses). @param {string} identity @param {string} entry
     * @returns {Promise<{ state: "ok" | "gone" | "unknown", limited: boolean }>}
     */
    async status(identity, entry) {
      // a row exists for this device, so it was admitted before (maybe by an earlier run of this server): the grace applies
      const c = await chainOf(identity, true);
      if ("why" in c) return { state: "unknown", limited: true };
      const e = (c.state.entries || []).find((/** @type {any} */ x) => x && x.eid === entry && x.kind === "device");
      if (!e || isRelayKey(e)) return { state: "gone", limited: true };
      return { state: "ok", limited: limitedOf(e, clock()) };
    },
    /** @param {string} identity @param {string} entry @returns {Promise<"ok" | "gone" | "unknown">} */
    async stillListed(identity, entry) { return (await this.status(identity, entry)).state; },
  };
}

/**
 * A ceiling on chain hellos, applied BEFORE any chain is fetched or signature checked, so a stranger hammering the door cannot make this server hammer the directory. The relay passes the box only the device's key, not an
 * address, so the ceilings are per channel key and box-wide. @param {{ now?: () => number, perKey?: number, total?: number, windowMs?: number }} [o]
 * @returns {(key: string) => boolean} true when this hello may go on
 */
export function createRateGate(o = {}) {
  const clock = o.now || Date.now, perKey = o.perKey ?? 10, total = o.total ?? 120, windowMs = o.windowMs ?? 60_000;
  /** @type {Map<string, number[]>} */ const by = new Map();
  /** @type {number[]} */ let all = [];
  return key => {
    const t = clock();
    all = all.filter(x => t - x < windowMs);
    const mine = (by.get(key) || []).filter(x => t - x < windowMs);
    if (all.length >= total || mine.length >= perKey) { by.set(key, mine); return false; }
    all.push(t); by.set(key, [...mine, t]);
    if (by.size > 2000) by.delete(/** @type {string} */ (by.keys().next().value));
    return true;
  };
}
