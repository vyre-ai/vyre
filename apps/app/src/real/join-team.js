// @ts-check
// Join a team from a device that has a Vyre name and NO server of its own (the employee's phone or Mac): this app does what a person's own box does for an invite (core/spaces/index.js kernelCard and
// spaces.invites.accept), because there is no box to do it. Everything is the same wire: the space's record in the names directory says where its home is (relay, route, box); this device opens a throwaway
// invitee channel to it (relay/client/client.js `invitee: true`), opens the peer stream with a hello signed by its identity key (core/daemon/peer-door.js checks it), reads the join card with `kernel.call`
// (grants.invites.get, with the home proving it holds the space), and accepts with its own presence proof over exactly that card (grants.invites.accept). The accept carries `bind`, which enrols this
// device's presence key on that server inside the same call (kernel/remote/server.js joinKey). Afterwards the same channel with the hello `invite: "member"` reaches the space as a member.
//
// Every outside thing is handed in (deps), so Node tests it against a real server and the app gives it its WebCrypto/secure-store pieces (src/real/join-team.ts).
import * as C from "../../../../kernel/identity/chain.js";
import { recordMessage } from "../../../../names/worker/id-messages.js";
import { sha256 } from "@noble/hashes/sha256";
import { canonical, payloadHash, b64url } from "../../modules/vyre-signer/presence-proof.js";
import { openRecord } from "../identity/seal.js";

const enc = new TextEncoder();
const refuse = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const hex = (/** @type {Uint8Array} */ u) => Array.from(u, b => b.toString(16).padStart(2, "0")).join("");
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vyre\.run$/;
const TOKEN_RE = /^(inv_[0-9a-f]{32})\.([A-Za-z0-9_-]+)$/;

/** @typedef {{ id: string, name: string, eid: string, sign: (m: Uint8Array) => Promise<Uint8Array> | Uint8Array }} Who */

/** The fingerprint of a space as its inviter saw it: its permanent id and its root key (32 hex characters). @param {string} chainId @param {string} rootPublic */
export const spaceFingerprint = (chainId, rootPublic) => hex(sha256(enc.encode(`vyre-space-fingerprint-v1\n${chainId}\n${rootPublic}`))).slice(0, 32);
const attestMessage = (/** @type {string} */ space, /** @type {string} */ nonce) => `vyre-space-attest-v1\n${space}\n${nonce}`;
/** What an invitee's listed device signs to put a presence key on a server it has never touched (kernel/seal/wire.js joinBytes). */
const joinBytes = (/** @type {string} */ invite, /** @type {string} */ space, /** @type {string} */ person, /** @type {string} */ keyId, /** @type {string} */ spki) => enc.encode(`vyre-presence-join-v1\n${invite}\n${space}\n${person}\n${keyId}\n${b64url(sha256(enc.encode(spki)))}`);

/** A join link: https, `<label>.vyre.run`, /join/<token>, nothing else (lib/spaces/invites.js parseJoinLink; own-domain aliases need a box and are refused here). @param {string} link */
export function parseInviteLink(link) {
  let u;
  try { u = new URL(String(link).trim()); } catch { throw refuse("bad_input", "That is not a link."); }
  if (u.protocol !== "https:") throw refuse("bad_input", "A join link must start with https.");
  if (u.username || u.password || u.port || u.search || u.hash) throw refuse("bad_input", "That is not a join link.");
  const host = u.hostname.toLowerCase();
  if (!NAME_RE.test(host)) throw refuse("bad_input", "That address is not a Vyre space.");
  const m = /^\/join\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(u.pathname);
  const t = m && TOKEN_RE.exec(m[1]);
  if (!m || !t) throw refuse("bad_input", "That is not a join link.");
  /** @type {any} */ let carried = null;
  try { carried = JSON.parse(new TextDecoder().decode(/** @type {Uint8Array} */ (C.unb64(t[2])))); } catch { carried = null; }
  const pin = carried && carried.chain && typeof carried.chain.id === "string" && Number.isInteger(carried.chain.seq) && typeof carried.chain.head === "string" ? { id: carried.chain.id, seq: carried.chain.seq, head: carried.chain.head } : null;
  if (!pin) throw refuse("unpinned", "This invite does not say which version of the space it was made for. Ask for a new one.");
  return { host, name: host.replace(/\.vyre\.run$/, ""), token: m[1], invite: t[1], pin, rk: carried && typeof carried.rk === "string" ? carried.rk : null };
}

/**
 * The space's record from the names directory, verified from its genesis against the pin the link carries (the link's own version of the list), with the sealed record opened.
 * @param {{ fetch: typeof fetch, base: string, now?: () => number }} d @param {string} label @param {{ id: string, seq: number, head: string }} pin
 */
export async function resolveSpace(d, label, pin) {
  const now = d.now ?? Date.now;
  const root = d.base.replace(/\/+$/, "");
  const get = async (/** @type {string} */ name) => {
    let res;
    try { res = await d.fetch(`${root}/v1/ids/resolve?name=${encodeURIComponent(name)}`, { headers: { accept: "application/json" } }); } catch { throw refuse("unreachable", "Cannot reach the names directory right now."); }
    /** @type {any} */ let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !json || json.error || !json.data) throw refuse("not_found", "That space could not be verified. Ask for a new invite.");
    return json.data;
  };
  const r = await get(label);
  /** @type {Map<string, any[]|null>} */ const owned = new Map();
  const ownerOps = async (/** @type {string} */ id) => {
    const e = (Array.isArray(r.ops) ? r.ops : []).map((/** @type {any} */ o) => o && o.entry).filter(Boolean).find((/** @type {any} */ x) => x.subject === id && x.label);
    if (!e) return null;
    if (!owned.has(id)) { try { const q = await get(String(e.label)); owned.set(id, q.id === id && q.kind === "person" ? q.ops : null); } catch { owned.set(id, null); } }
    return owned.get(id) || null;
  };
  if (!r || r.name !== label || r.kind !== "space" || !Array.isArray(r.ops)) throw refuse("wrong_space", "That space could not be verified. Ask for a new invite.");
  /** @type {any} */ let state;
  try { state = await C.verifyChain(r.ops, { now: now() + C.SKEW_MS, ownerOps, liveFrom: pin.seq + 1 }); } catch { throw refuse("wrong_space", "That space could not be verified. Ask for a new invite."); }
  if (state.id !== r.id) throw refuse("wrong_space", "That space could not be verified. Ask for a new invite.");
  const seen = await C.checkAnswer(pin, r.ops);
  if (!seen.ok) throw refuse("forged", "This invite could not be verified. Ask for a new one.");
  const rec = r.rec;
  if (!r.sealed || !rec) throw refuse("wrong_space", "That space could not be verified. Ask for a new invite.");
  try {
    const at = await C.stateAt(r.ops, rec.ts, { now: now() + C.SKEW_MS, ownerOps });
    const key = at && await C.signerKey(at, rec.by, rec.via, rec.ts, { ownerOps, now: now() + C.SKEW_MS }, { seq: rec.vseq, head: rec.vhead });
    const good = key && await C.verifyWith(key.pub, recordMessage({ name: label, id: state.id, by: rec.by, via: rec.via, ts: rec.ts, sealedHash: await C.sha256hex(r.sealed), vseq: rec.vseq, vhead: rec.vhead }), rec.sig, key.signing);
    if (!good) throw new Error("bad signature");
  } catch { throw refuse("wrong_space", "That space's record does not check out. Ask for a new invite."); }
  const payload = await openRecord(label, r.sealed);
  if (!payload) throw refuse("wrong_space", "That space's record could not be opened.");
  return { id: state.id, payload };
}

/** Wait for a promise at most `ms`. @template T @param {Promise<T>} p @param {number} ms @param {() => Error} onTimeout @returns {Promise<T>} */
const within = (p, ms, onTimeout) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(onTimeout()), ms); p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); }); });

/**
 * @typedef {{
 *   who: Who,
 *   fetch: typeof fetch, base: string, now?: () => number,
 *   connect: (o: any) => any, openServerPeer: (conn: any, o?: any) => Promise<any>,
 *   crypto: any,
 *   signPresence?: (req: { op: string, space: string, fields: any, payload_hash: string, prompt?: string, person: string }) => Promise<any>,
 *   presenceKey?: () => Promise<{ key_id: string, spki: string, signer: string, attestation?: any } | null | undefined>,
 *   words?: string[],
 *   store?: { get(key: string): Promise<any> | any, put(key: string, value: any): Promise<void> | void, delete?(key: string): Promise<void> | void },
 * }} Deps
 * @typedef {Deps} JoinDeps
 */

/**
 * The invitee's signed hello for the home's door: this identity key over the box, the space and the invite, bound to the channel's own key id (core/spaces/index.js inviteeHello).
 * @param {Deps} d @param {{ box: string }} channel @param {string} space @param {string} invite @param {string} channelKey
 */
async function helloFor(d, channel, space, invite, channelKey) {
  const ts = (d.now ?? Date.now)();
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const sig = b64url(await d.who.sign(enc.encode(`vyre-invitee-hello-v2\n${channel.box}\n${space}\n${invite}\n${d.who.id}\n${d.who.eid}\n${ts}\n${nonce}\n${channelKey}`)));
  return { space, invite, channel: channelKey, identity: d.who.id, ...(d.who.name ? { name: `${String(d.who.name).replace(/\.vyre\.run$/, "")}.vyre.run` } : {}), entry: d.who.eid, ts, nonce, sig };
}

/**
 * A kernel call session to a space's home as an invitee (invite id) or as a member (invite "member"): a throwaway channel key, the signed hello in the stream head, and `call(name, args)`.
 * @param {Deps} d @param {{ relay: string, route: string, box: string }} channel @param {string} space @param {string} invite
 */
export async function homeSession(d, channel, space, invite) {
  const provider = d.crypto;
  const kp = await provider.generateKeyPair();
  const ks = { get: async () => kp, set: async () => {} };
  const conn = d.connect({ relay: channel.relay, route: channel.route, box: channel.box, name: "a device", crypto: provider, keyStore: ks, invitee: true });
  /** @type {any} */ let peer;
  try {
    await within(conn.ready(), 10_000, () => refuse("unreachable", "That server is not the one this space names, or it cannot be reached."));
    const channelKey = conn.reply && conn.reply.invitee;
    if (typeof channelKey !== "string") throw refuse("unreachable", "That server did not admit this device as an invitee.");
    const hello = await helloFor(d, channel, space, invite, channelKey);
    peer = await d.openServerPeer(conn, { invitee: hello });
  } catch (e) { try { conn.close(); } catch { /* closed */ } throw e; }
  let n = 0;
  return {
    /** One wire call (kernel/remote/wire.js): the answer's result, or an Error with the home's code. @param {string} call @param {any[]} args */
    async call(call, args) {
      const id = `rq_${(d.now ?? Date.now)().toString(36)}_${(++n).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const reply = await peer.call("kernel.call", { v: 1, space, id, ts: (d.now ?? Date.now)(), call, args });
      if (!reply || reply.v !== 1 || reply.id !== id || typeof reply.ok !== "boolean") throw refuse("unavailable", "The home's answer was not understood.");
      if (!reply.ok) throw refuse(String(reply.error && reply.error.code || "unavailable").slice(0, 40), String(reply.error && reply.error.message || "refused").slice(0, 300));
      return reply.result;
    },
    close() { try { peer.close(); } catch { /* closed */ } try { conn.close(); } catch { /* closed */ } },
  };
}

const fingerprintWords = (/** @type {string[] | undefined} */ words, /** @type {string} */ fp) => {
  if (!words || words.length < 2048 || !fp) return null;
  const bits = BigInt("0x" + fp.slice(0, 11));
  return [3, 2, 1, 0].map(k => words[Number((bits >> BigInt(11 * k)) & 2047n)]).join(" ");
};

/**
 * Read a join link: the space's verified record, the home's proof that it holds the space, and the join card. Returns what the person is shown and the way to accept (or let go).
 * @param {Deps} d @param {string} link
 */
export async function openInvite(d, link) {
  const p = parseInviteLink(link);
  const { id: chainId, payload } = await resolveSpace(d, p.name, p.pin);
  // The fingerprint is of the space's permanent chain id and its root key; the home's kernel knows the space by the id the owner-signed record carries.
  const rk = spaceFingerprint(chainId, String(payload.rootPublic || ""));
  const spaceId = String(payload.id || "");
  if (!/^spc_[a-z2-7]{12,26}$/.test(spaceId)) throw refuse("wrong_space", "That space's record could not be opened.");
  if (p.rk && rk !== p.rk) throw refuse("forged", "This invite could not be verified. Ask for a new one.");
  const route = payload.route;
  if (!route || typeof route.route !== "string") throw refuse("unreachable", `This space lives on ${payload.ownerName || payload.owner_name ? `${payload.ownerName || payload.owner_name}'s` : "its owner's"} computer and cannot be reached from here. Ask them to move it to their server.`);
  const channel = { relay: String(route.relay || ""), route: route.route, box: String(route.box || "") };
  const home = await homeSession(d, channel, spaceId, p.invite);
  try {
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    /** @type {any} */ let got;
    try { got = await home.call("grants.invites.get", [p.invite, { attest: nonce }]); }
    catch (e) {
      const c = String(/** @type {any} */ (e).code || "");
      // the home's door refusing this person (an invite made for someone else, spent, or not admitted) is not an outage
      if (/^(denied|not_a_member|forbidden|not_allowed|not_found)$/.test(c)) throw refuse("not_for_you", "This invite cannot be used.");
      throw e;
    }
    const { attest, ...card } = got && typeof got === "object" ? got : /** @type {any} */ ({});
    // a server that cannot prove it holds the space (a signature over a fresh nonce with the key the owner-signed record names) is refused before anything is shown or accepted
    let proven = false;
    try { proven = Boolean(payload.rootPublic) && Boolean(attest) && attest.pub === payload.rootPublic && typeof attest.sig === "string" && await C.verifyWith(String(attest.pub), enc.encode(attestMessage(spaceId, nonce)), attest.sig); } catch { proven = false; }
    if (!proven) throw refuse("server_not_proven", "This server could not prove that it holds this space, so Vyre will not join it. Ask the person who invited you.");
    const view = { ...card, space: `${p.name}.vyre.run`, label: payload.label || p.name, fingerprint: rk, fingerprint_words: fingerprintWords(d.words, rk) };
    return {
      card: view, spaceId, channel, invite: p.invite,
      /** The person's yes: their presence key signs exactly this card, this device's identity key vouches for that key on this server, and the home makes the membership. */
      async accept() {
        if (typeof d.signPresence !== "function") throw refuse("no_signer", "This device cannot give the yes yet.");
        const seen = { role: card.role, scope: card.scope ?? null, expires: card.expires ?? null, invitee: card.invitee ?? null };
        const fields = { invite: card.id ?? p.invite, hash: b64url(sha256(enc.encode(canonical(seen)))), person: d.who.id };
        const req = { op: "grant.accept", space: spaceId, fields, payload_hash: payloadHash("grant.accept", spaceId, fields), person: d.who.id, prompt: `Join ${view.label}` };
        const proof = await d.signPresence(req);
        if (!proof || typeof proof !== "object") throw refuse("no_proof", "The yes was not given.");
        const pk = typeof d.presenceKey === "function" ? await d.presenceKey() : null;
        const bind = pk && typeof pk.key_id === "string" && typeof pk.spki === "string" && typeof pk.signer === "string"
          ? { key_id: pk.key_id, spki: pk.spki, signer: pk.signer, sig: b64url(await d.who.sign(joinBytes(p.invite, spaceId, d.who.id, pk.key_id, pk.spki))), ...(pk.attestation && typeof pk.attestation === "object" ? { attestation: pk.attestation } : {}) }
          : undefined;
        const got2 = await home.call("grants.invites.accept", [p.invite, { seen, proof, ...(bind ? { bind } : {}) }]);
        const membership = got2 && got2.membership ? got2.membership : got2;
        // the person is a member now: keep where the home is, so this device reaches the space with a member stream (no invite)
        if (d.store) await d.store.put(`member-of/${spaceId}`, { channel, name: `${p.name}.vyre.run`, role: membership && membership.role ? String(membership.role) : null, at: (d.now ?? Date.now)() });
        return { joined: true, space: spaceId, membership };
      },
      close: () => home.close(),
    };
  } catch (e) { home.close(); throw e; }
}

/**
 * A call to a space this device joined, as a member: the member row kept at the accept, a channel with the hello `invite: "member"`, and the home's kernel answering for membership.
 * @param {Deps} d @param {string} spaceId @param {string} call @param {any[]} [args]
 */
export async function callTeam(d, spaceId, call, args = []) {
  const row = d.store ? await d.store.get(`member-of/${spaceId}`) : null;
  if (!row || !row.channel) throw refuse("not_a_member", "This device has not joined that space.");
  const home = await homeSession(d, row.channel, spaceId, "member");
  try { return await home.call(call, args); } finally { home.close(); }
}
