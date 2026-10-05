// @ts-check
// The identity chain (team/0.3/DESIGN-wink.md section 2). An identity is a permanent id plus a signed, chained list of who can
// speak for it. The id never changes; the list does, and every change is one op signed by something already on the list, so the
// list is a chain nobody can forge, not the directory that stores it.
//
// A person's list holds device keys, one recovery-code key (the code and an optional PIN stretch into it) and optional recovery
// contacts. A space's list holds its owners, each one a person identity (`subject`) acting through one of that person's devices
// (`via`), checked against that person's own chain as it stood at the op's time.
//
//   genesis  seq 0, makes the id: the id is the kind prefix plus the hash of the genesis body, so nobody can claim another's id. It holds the
//            first device and, optionally, the recovery code's entry; both are founders and never count as newcomers.
//   add      one entry (device, code, contact; owner for a space)
//   remove   one entry by eid
//   replace-code   the recovery code is replaced; the new entry keeps the old one's age, so a replaced code is not "new"
//   recover  two recovery contacts approve a new device (no signer on the list is needed)
//
// The newcomer rule: for the first 24 hours an entry can sign but cannot remove older entries, touch a code or a contact, or (for a
// space) change owners. Any older entry can remove a newcomer at once. Time here is the op's own `ts`, which may not run backwards
// along the chain nor ahead of the verifier's clock by more than the skew.
//
// The web-key rule (lead ruling on reviewer-3's KP-1): an entry with `held: "web"` is a key a script on a web origin can reach (a WebCrypto key in a browser). It may sign its own genesis
// and nothing else about the list: no add, remove, replace-code or space-owner change, whatever its age. Who speaks for an identity changes only by a passkey entry (alg
// "webauthn-es256": a P-256 key and the rp it was made for) whose assertion carries user presence AND verification for each op, by a device key held by a phone or computer, or by the
// recovery code, which can add a device. A device entry may also carry `enclave`, the P-256 key a phone keeps in its Secure Enclave behind Face ID (NK-2): every list change it signs must carry `esig`, that
// key's ECDSA signature (exactly 64 bytes r||s, low s) over the same op message, or it is refused (`needs_enclave`). Face ID itself is the OS's key policy and is not visible here; enrolment should carry an App Attest assertion (`attest`)
// that its own verifier checks. `attest` is stored and never read in this file: nothing here may count on it. The directory Worker and every home run this same file, so all of them refuse.
//
// This file uses only WebCrypto, so the same code runs in the Worker, in Node and in a browser.

export const CHAIN_TAG = "vyre-chain-v1";
export const NEWCOMER_MS = 24 * 3_600_000;
export const SKEW_MS = 5 * 60_000;
export const MAX_OPS = 400;
export const MAX_ENTRIES = 40;
export const CONTACT_QUORUM = 2;
export const PERSON_KINDS = Object.freeze(["device", "code", "contact"]);
export const PREFIX = Object.freeze({ person: "per_", space: "spc_" });

const enc = new TextEncoder();
const EID = /^[a-z2-7]{26}$/;
const ID = /^(per|spc)_[a-z2-7]{26}$/;

/** @param {string} code @param {string} message */
export const chainError = (code, message) => Object.assign(new Error(message), { code, name: "ChainError" });

const hexOf = (/** @type {ArrayBuffer} */ b) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
/** @param {string|Uint8Array} s */
export const sha256hex = async s => hexOf(await crypto.subtle.digest("SHA-256", typeof s === "string" ? enc.encode(s) : /** @type {BufferSource} */ (s)));
export const b64u = (/** @type {Uint8Array} */ b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
export const unb64 = (/** @type {unknown} */ s) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try { return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0)); } catch { return null; }
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** 26 base32 characters of the SHA-256 of bytes. @param {Uint8Array} bytes */
export async function idOfBytes(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", /** @type {BufferSource} */ (bytes)));
  let out = "", bits = 0, value = 0;
  for (const byte of h) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.slice(0, 26);
}
/** The entry id of a public key: the same 26 characters a route id uses. @param {Uint8Array|string} pub */
export const eidOf = pub => idOfBytes(typeof pub === "string" ? /** @type {Uint8Array} */ (unb64(pub)) : pub);

/** Deterministic JSON: keys sorted, no undefined. @param {any} v @returns {string} */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

/** The bytes a signer signs for an op: everything but the signature and the approvals. @param {any} op */
export function messageOf(op) {
  const { sig: _s, esig: _e, approvals: _a, ...body } = op;
  return enc.encode(`${CHAIN_TAG}\n${canonical(body)}`);
}
/**
 * The hash a next op names as `prev`. A WebAuthn assertion (a `sig` longer than an Ed25519 signature's 86 characters) is left out of it: an authenticator's ECDSA signature has a high-s twin that
 * anyone can make without the key, and an op hash that covered it would fork the head between whoever holds one form and whoever holds the other. The op body it signs is still covered (NE-1).
 */
export const hashOf = op => { if (op && typeof op.sig === "string" && op.sig.length > 100) { const { sig: _s, ...rest } = op; return sha256hex(canonical({ ...rest, sig: null })); } return sha256hex(canonical(op)); };

async function verifySig(pubText, message, sigText) {
  const pub = unb64(pubText), sig = unb64(sigText);
  if (!pub || !sig || pub.length !== 32 || sig.length !== 64) return false;
  try { return await crypto.subtle.verify({ name: "Ed25519" }, await crypto.subtle.importKey("raw", /** @type {BufferSource} */ (pub), { name: "Ed25519" }, false, ["verify"]), /** @type {BufferSource} */ (sig), /** @type {BufferSource} */ (message)); } catch { return false; }
}

/**
 * A WebAuthn assertion as a chain signature (a passkey with user verification signs each op). `sig` is base64url of the JSON { ad, cd, s }: the authenticator data, the client data
 * JSON, and the ES256 signature (DER, as the authenticator gives it), each base64url. The challenge the authenticator was given is SHA-256 of the op's message, so the assertion names
 * this one op; the rp id the entry names must hash to the authenticator data's rpIdHash, the origin must be that rp's own https origin, and the user must have been present AND verified.
 * @param {string} pubText a raw uncompressed P-256 point (65 bytes), base64url @param {string} rp @param {Uint8Array} message @param {string} sigText
 */
async function verifyWebAuthn(pubText, rp, message, sigText) {
  try {
    const pub = unb64(pubText), env = unb64(sigText);
    if (!pub || pub.length !== 65 || pub[0] !== 4 || !env || typeof rp !== "string" || !rp) return false;
    const j = JSON.parse(new TextDecoder().decode(env));
    const ad = unb64(j.ad), cd = unb64(j.cd), der = unb64(j.s);
    if (!ad || !cd || !der || ad.length < 37) return false;
    const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(rp)));
    for (let i = 0; i < 32; i++) if (ad[i] !== rpHash[i]) return false;
    if ((ad[32] & 0x05) !== 0x05) return false; // user present (0x01) and user verified (0x04), every op
    const client = JSON.parse(new TextDecoder().decode(cd));
    if (client.type !== "webauthn.get" || client.origin !== `https://${rp}` || client.crossOrigin === true) return false;
    const want = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", /** @type {BufferSource} */ (message))));
    if (client.challenge !== want) return false;
    const raw = derToRaw(der);
    if (!raw) return false;
    const signed = new Uint8Array(ad.length + 32);
    signed.set(ad, 0); signed.set(new Uint8Array(await crypto.subtle.digest("SHA-256", /** @type {BufferSource} */ (cd))), ad.length);
    const key = await crypto.subtle.importKey("raw", /** @type {BufferSource} */ (pub), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, /** @type {BufferSource} */ (raw), /** @type {BufferSource} */ (signed));
  } catch { return false; }
}
const P256_N_HALF = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n;
/** Is the s half (bytes 32 to 64) of a raw P-256 signature at most n/2? Rejects the high-s twin. @param {Uint8Array} raw */
function lowS(raw) { let v = 0n; for (let i = 32; i < 64; i++) v = (v << 8n) | BigInt(raw[i]); return v > 0n && v <= P256_N_HALF; }
/** An ECDSA signature in DER as the 64 bytes WebCrypto takes, or null. @param {Uint8Array} d */
function derToRaw(d) {
  if (d.length < 8 || d[0] !== 0x30 || d[1] !== d.length - 2 || d[2] !== 0x02) return null;
  let p = 3;
  const part = () => {
    const len = d[p++];
    let v = d.subarray(p, p + len);
    p += len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) return null;
    const out = new Uint8Array(32); out.set(v, 32 - v.length);
    return out;
  };
  const r = part();
  if (d[p++] !== 0x02) return null;
  const q = part();
  if (!r || !q || p !== d.length) return null;
  const raw = new Uint8Array(64); raw.set(r, 0); raw.set(q, 32);
  return raw;
}
/**
 * The second signature of NK-2: ECDSA P-256 (SHA-256) by the entry's Secure Enclave key over the same op message, 64 bytes r||s or DER, base64url. @param {Entry} e @param {Uint8Array} message @param {unknown} esig
 */
async function verifyEsig(e, message, esig) {
  try {
    const pt = unb64(e.enclave), sg = unb64(esig);
    if (!pt || !sg) return false;
    // One signature, one encoding: exactly 64 bytes r||s with s in the low half. A DER form or a high-s twin of the same signature would be a second valid op with another hash, forking the chain
    // head between whoever holds one and whoever holds the other (reviewer-3 NE-1), so neither is accepted.
    if (sg.length !== 64 || !lowS(sg)) return false;
    const raw = sg;
    const key = await crypto.subtle.importKey("raw", /** @type {BufferSource} */ (pt), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, /** @type {BufferSource} */ (raw), /** @type {BufferSource} */ (message));
  } catch { return false; }
}
/** Does `sig` over `message` check out for this entry's key, whatever kind of key it is? @param {Entry} e @param {Uint8Array} message @param {string} sig */
const verifyEntry = (e, message, sig) => (e.alg === "webauthn-es256" ? verifyWebAuthn(/** @type {string} */ (e.pub), String(e.rp || ""), message, sig) : verifySig(/** @type {string} */ (e.pub), message, sig));

/**
 * @typedef {{ eid: string, kind: "device"|"code"|"contact"|"owner", pub?: string, subject?: string, label?: string, since: number, addedBy: string|null, founder?: boolean, alg?: "webauthn-es256", rp?: string, held?: "web", enclave?: string, attest?: string }} Entry
 * @typedef {{ id: string, kind: "person"|"space", seq: number, head: string, ts: number, entries: Entry[] }} State
 * @typedef {{ ownerOps?: (id: string) => Promise<any[]|null>, live?: boolean, liveFrom?: number, seenAt?: (seq: number) => number|undefined, now?: number, skewMs?: number }} Ctx
 * `ownerOps(id)` gives a person's whole chain (the verifier checks it itself). `live` says every op here is being ACCEPTED now, so its device must be on the owner's
 * current list; `liveFrom` is the same for ops from that sequence on (a client that pinned a head treats what is newer than its pin as live).
 * An entry's age never comes from a time its adder wrote: an op accepted live must be made now (its time is within the skew of the acceptor's clock), and a
 * verifier that learned an op later passes `seenAt(seq)`, the first time IT saw it, and the age starts there if that is later than the op's own time.
 */

/** Does one entry's own shape hold? @param {any} e @param {"person"|"space"} kind */
async function shapeOfEntry(e, kind) {
  if (!e || typeof e !== "object" || Array.isArray(e)) throw chainError("bad_entry", "an entry is an object");
  if (kind === "space") {
    if (e.kind !== "owner" || !/^per_[a-z2-7]{26}$/.test(String(e.subject)) || e.eid !== e.subject) throw chainError("bad_entry", "a space's list holds owners: person identities");
    return { eid: e.subject, kind: "owner", subject: e.subject, label: cleanLabel(e.label) };
  }
  if (!PERSON_KINDS.includes(e.kind)) throw chainError("bad_entry", "an entry is a device, a recovery code or a recovery contact");
  const pub = unb64(e.pub);
  // A passkey (alg webauthn-es256) is a P-256 point and the rp it was made for; every other entry is an Ed25519 key. `held: "web"` says a script on a web origin can reach the key (a WebCrypto
  // key kept by the browser): such a key has no say over who speaks for the identity (KP-1). Both are part of the signed entry, so neither can change after the fact.
  const passkey = e.alg === "webauthn-es256";
  if (e.alg !== undefined && !passkey) throw chainError("bad_entry", "an entry's key type is not known");
  if (e.held !== undefined && e.held !== "web") throw chainError("bad_entry", "an entry is held on the web or says nothing");
  if (passkey ? (!pub || pub.length !== 65 || pub[0] !== 4 || typeof e.rp !== "string" || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(e.rp) || e.held !== undefined || e.kind !== "device") : (!pub || pub.length !== 32 || e.rp !== undefined)) throw chainError("bad_entry", passkey ? "a passkey entry is a device with a P-256 key and the rp it was made for" : "an entry's key is not an Ed25519 key");
  if (e.eid !== await idOfBytes(/** @type {Uint8Array} */ (pub))) throw chainError("bad_entry", "an entry's id is not its key's hash");
  // `enclave` (NK-2): the raw uncompressed P-256 point of a key the phone keeps in its Secure Enclave behind Face ID. It is part of the signed entry, so it is immutable once on the list. Any list
  // change this entry signs must also carry `esig` from that key. `attest` is the opaque App Attest assertion the verifier of enrolment checks (it is not read here: this file cannot see the OS's policy).
  if (e.enclave !== undefined) {
    const pt = unb64(e.enclave);
    if (passkey || e.kind !== "device" || !pt || pt.length !== 65 || pt[0] !== 4) throw chainError("bad_entry", "an enclave key is a raw uncompressed P-256 point on a device entry");
  }
  if (e.attest !== undefined && (typeof e.attest !== "string" || e.attest.length > 8192)) throw chainError("bad_entry", "an attestation is a string");
  return { eid: e.eid, kind: e.kind, pub: e.pub, label: cleanLabel(e.label), ...(passkey ? { alg: "webauthn-es256", rp: e.rp } : {}), ...(e.held === "web" ? { held: "web" } : {}), ...(e.enclave !== undefined ? { enclave: e.enclave } : {}), ...(e.attest !== undefined ? { attest: e.attest } : {}) };
}
const cleanLabel = (/** @type {unknown} */ l) => (typeof l === "string" ? l.replace(/[\u0000-\u001f]/g, " ").slice(0, 60) : undefined) || undefined;

/** The founder entries (a person's first device, and the recovery code made with it) are never newcomers: nothing older exists to protect from them. */
export const youngAt = (/** @type {Entry} */ e, /** @type {number} */ ts) => !e.founder && ts - e.since < NEWCOMER_MS;
const find = (/** @type {State} */ s, /** @type {string} */ eid) => s.entries.find(e => e.eid === eid);

/** The id a genesis body makes. @param {any} body */
export const idOfGenesis = async body => `${PREFIX[body.kind]}${await idOfBytes(enc.encode(`${CHAIN_TAG}\n${canonical(strip(body))}`))}`;
const strip = (/** @type {any} */ op) => { const { sig: _s, id: _i, approvals: _a, via: _v, ...rest } = op; return rest; };

/**
 * Check one op against the state before it and return the state after. `state` is null for a genesis.
 * @param {State|null} state @param {any} op @param {Ctx} ctx
 * @returns {Promise<State>}
 */
export async function applyOp(state, op, ctx = {}) {
  const now = ctx.now ?? Date.now(), skew = ctx.skewMs ?? SKEW_MS;
  if (!op || typeof op !== "object" || op.v !== 1) throw chainError("bad_op", "not an op");
  if (!Number.isFinite(op.ts) || op.ts > now + skew) throw chainError("bad_time", "an op's time is ahead of the clock");
  // Accepted now, so made now: the adder cannot pick an old time and so cannot hand a new entry a past age.
  if (ctx.live && op.ts < now - skew) throw chainError("bad_time", "an op accepted now must be made now");
  /** The time an age is counted from: the op's own, or the first time this verifier saw it if that is later. */
  const eff = ctx.seenAt && Number.isInteger(op.seq) ? Math.max(op.ts, ctx.seenAt(op.seq) ?? 0) : op.ts;
  const msg = messageOf(op);

  if (op.type === "genesis") {
    if (state) throw chainError("bad_op", "a chain has one genesis");
    if (op.seq !== 0 || op.prev !== null || !["person", "space"].includes(op.kind)) throw chainError("bad_op", "a genesis is seq 0 with no prev");
    if (typeof op.nonce !== "string" || op.nonce.length < 8 || op.nonce.length > 64) throw chainError("bad_op", "a genesis carries a nonce");
    const entry = await shapeOfEntry(op.entry, op.kind);
    if (op.id !== await idOfGenesis(op)) throw chainError("bad_id", "the id is not the hash of the genesis");
    if (op.kind === "person") {
      if (entry.kind !== "device" || op.by !== entry.eid || !await verifyEntry(/** @type {Entry} */ (entry), msg, op.sig)) throw chainError("bad_signature", "the first device signs its own genesis");
    } else await verifyOwnerSig(op, entry.eid, /** @type {Entry} */ ({ ...entry, since: eff, addedBy: null }), msg, eff, ctx);
    /** @type {Entry[]} */
    const entries = [{ ...entry, since: eff, addedBy: null, founder: true }];
    if (op.code !== undefined) {
      const code = await shapeOfEntry(op.code, op.kind);
      if (op.kind !== "person" || code.kind !== "code") throw chainError("bad_entry", "a genesis may carry a recovery code entry for a person");
      entries.push({ ...code, since: eff, addedBy: null, founder: true });
    }
    return { id: op.id, kind: op.kind, seq: 0, head: await hashOf(op), ts: op.ts, entries };
  }

  if (!state) throw chainError("bad_op", "a chain starts with its genesis");
  if (op.id !== state.id || op.seq !== state.seq + 1 || op.prev !== state.head) throw chainError("bad_chain", "the op does not follow the chain's head");
  if (op.ts < state.ts) throw chainError("bad_time", "an op's time runs backwards");
  const isSpace = state.kind === "space";
  /** @type {Entry[]} */
  let entries = state.entries.map(e => ({ ...e }));
  const next = { ...state, entries };

  // Who signs, and are they young?
  /** @type {Entry|undefined} */
  let signer;
  let young = false;
  if (op.type === "recover") {
    if (isSpace) throw chainError("bad_op", "a space has no recovery contacts");
  } else {
    signer = find(state, String(op.by));
    if (!signer) throw chainError("not_on_list", "the signer is not on the list");
    if (isSpace) {
      young = await verifyOwnerSig(op, signer.eid, signer, msg, eff, ctx);
    } else {
      if (signer.kind === "contact") throw chainError("not_allowed", "a recovery contact only approves a recovery");
      if (!await verifyEntry(signer, msg, op.sig)) throw chainError("bad_signature", "the signature does not check out");
      // A key a web origin can reach has no authority over who speaks for the identity: not to add, remove or replace anything. A passkey signs each op with user verification, the recovery
      // code can add a device, and a phone or computer key joins the list that way (KP-1).
      if (signer.held === "web") throw chainError("web_key", "a key kept by a web page cannot change who speaks for this identity; use your passkey or your recovery code");
      // A phone's Ed25519 identity seed is a software key; its Secure Enclave key stands behind Face ID. A list change signed by an entry that has an enclave key must carry that key's signature too,
      // so reading the seed alone changes nothing about who speaks for the identity (NK-2). An entry with neither `held` nor `enclave` (a Mac or a server key) still signs alone.
      if (signer.enclave && !await verifyEsig(signer, msg, op.esig)) throw chainError("needs_enclave", "a change to who speaks for this identity from a phone also needs its Face ID signature");
      young = youngAt(signer, eff);
      // The recovery code is a way BACK IN, not a way to take over: it can only add a device. That device is a newcomer, and the owner's own devices stay and can remove it.
      if (signer.kind === "code" && !(op.type === "add" && op.entry && op.entry.kind === "device")) throw chainError("code_limited", "the recovery code can only add a device; sign in with a device to change the list");
    }
  }

  const sensitive = (/** @type {Entry} */ e) => e.kind === "code" || e.kind === "contact";
  switch (op.type) {
    case "add": {
      const e = await shapeOfEntry(op.entry, state.kind);
      if (find(state, e.eid)) throw chainError("exists", "that entry is already on the list");
      if (isSpace ? young : (sensitive(/** @type {Entry} */ (e)) && young)) throw chainError("newcomer", "a sign-in under 24 hours old cannot change the owners, the recovery code or the contacts");
      if (e.kind === "code" && state.entries.some(x => x.kind === "code")) throw chainError("has_code", "there is a recovery code already; replace it");
      entries.push({ ...e, since: eff, addedBy: signer ? signer.eid : null });
      break;
    }
    case "remove": {
      const target = find(state, String(op.target));
      if (!target) throw chainError("not_on_list", "that entry is not on the list");
      const self = signer && target.eid === signer.eid;
      if (young && !self) {
        if (isSpace || sensitive(target) || target.since <= /** @type {Entry} */ (signer).since) throw chainError("newcomer", "a sign-in under 24 hours old can remove only newer sign-ins");
      }
      entries = entries.filter(e => e.eid !== target.eid);
      if (isSpace ? !entries.length : !entries.some(e => e.kind === "device" || e.kind === "code")) throw chainError("last_entry", "that would leave nobody who can sign");
      break;
    }
    case "replace-code": {
      if (isSpace) throw chainError("bad_op", "a space has no recovery code");
      if (young) throw chainError("newcomer", "a sign-in under 24 hours old cannot change the recovery code");
      const e = await shapeOfEntry(op.entry, "person");
      if (e.kind !== "code") throw chainError("bad_entry", "replace-code carries a code entry");
      if (find(state, e.eid)) throw chainError("exists", "that is the code it already has");
      const old = state.entries.find(x => x.kind === "code");
      entries = entries.filter(x => x.kind !== "code");
      entries.push({ ...e, since: old ? old.since : eff, addedBy: /** @type {Entry} */ (signer).eid });
      break;
    }
    case "recover": {
      const e = await shapeOfEntry(op.entry, "person");
      if (e.kind !== "device") throw chainError("bad_entry", "a recovery adds a device");
      if (find(state, e.eid)) throw chainError("exists", "that device is already on the list");
      const seen = new Set();
      for (const a of Array.isArray(op.approvals) ? op.approvals : []) {
        const c = a && find(state, String(a.eid));
        if (!c || c.kind !== "contact" || seen.has(c.eid) || youngAt(c, eff)) continue;
        if (await verifyEntry(c, msg, a.sig)) seen.add(c.eid);
      }
      if (seen.size < CONTACT_QUORUM) throw chainError("no_quorum", `a recovery needs ${CONTACT_QUORUM} recovery contacts to approve`);
      entries.push({ ...e, since: eff, addedBy: null });
      break;
    }
    default: throw chainError("bad_op", "unknown op type");
  }
  if (entries.length > MAX_ENTRIES) throw chainError("too_many", `at most ${MAX_ENTRIES} entries`);
  return { ...next, entries, seq: op.seq, head: await hashOf(op), ts: op.ts };
}

/**
 * The owner's chain state at a position the op names, after checking that the position is real (its hash is the one named). A device's
 * standing comes from where it sits in the chain, never from a time the signer claims, so a removed key cannot be backdated into validity.
 * @param {Ctx} ctx @param {string} subject @param {unknown} seq @param {unknown} head
 * @returns {Promise<{ at: State, ops: any[] }>}
 */
async function ownerAt(ctx, subject, seq, head) {
  const ops = ctx.ownerOps ? await ctx.ownerOps(subject) : null;
  if (!ops) throw chainError("unknown_owner", "the owner's own identity cannot be found");
  if (!Number.isInteger(seq) || /** @type {number} */ (seq) < 0 || /** @type {number} */ (seq) >= ops.length || typeof head !== "string") throw chainError("bad_via", "a space op names the position of the owner's list it relied on");
  if (await hashOf(ops[/** @type {number} */ (seq)]) !== head) throw chainError("bad_via", "that is not the owner's list at that position");
  const now = (ctx.now ?? Date.now()) + (ctx.skewMs ?? SKEW_MS);
  return { at: await verifyChain(ops.slice(0, /** @type {number} */ (seq) + 1), { now }), ops };
}

/** The device must also be on the owner's CURRENT list (acceptance time): removing a device ends its signing at once. @param {Ctx} ctx @param {any[]} ops @param {Entry} dev */
async function stillOnList(ctx, ops, dev) {
  const now = (ctx.now ?? Date.now()) + (ctx.skewMs ?? SKEW_MS);
  const head = await verifyChain(ops, { now });
  const cur = find(head, dev.eid);
  if (!cur || cur.pub !== dev.pub) throw chainError("removed", "that device has been removed from the owner's list");
}

/**
 * A space op is signed by one of its owners' devices (never by a recovery code). The device must be on the owner's list at the position the
 * op names, and, when the op is being accepted now (`ctx.live`, or `liveFrom`), on the owner's current list. Says whether the device was young.
 * @param {any} op @param {string} subject @param {Entry} owner @param {Uint8Array} msg @param {number} ts @param {Ctx} ctx @returns {Promise<boolean>}
 */
async function verifyOwnerSig(op, subject, owner, msg, ts, ctx) {
  if (op.by !== subject || typeof op.via !== "string" || !EID.test(op.via)) throw chainError("bad_signature", "a space op names its owner and the device that signed");
  const { at, ops } = await ownerAt(ctx, subject, op.via_seq, op.via_head);
  const dev = find(at, op.via);
  if (!dev || dev.kind !== "device") throw chainError("not_on_list", "that device is not on the owner's list");
  if (dev.held === "web") throw chainError("web_key", "a key kept by a web page cannot change who owns a space; use your passkey");
  if (dev.enclave && !await verifyEsig(dev, msg, op.esig)) throw chainError("needs_enclave", "a change to who owns a space from a phone also needs its Face ID signature");
  if (!await verifyEntry(dev, msg, op.sig)) throw chainError("bad_signature", "the signature does not check out");
  if (ctx.live || (ctx.liveFrom !== undefined && op.seq >= ctx.liveFrom)) await stillOnList(ctx, ops, dev);
  return youngAt(dev, ts);
}

/**
 * The public key that signs for `by` (and `via`, for a space owner's device), and whether it was young. For anything that is not an op: a
 * sealed record, an alias proof, a release. For a space, `pos` is the position of the owner's list the signer named; with `ctx.live` the
 * device must also be on that list now. A recovery code is never young-exempt: it counts as a newcomer here.
 * @param {State} state @param {string} by @param {string|undefined} via @param {number} ts @param {Ctx} ctx @param {{ seq?: number, head?: string }} [pos]
 * @returns {Promise<{ pub: string, young: boolean, entry: Entry }>}
 */
export async function signerKey(state, by, via, ts, ctx = {}, pos = {}) {
  const e = find(state, String(by));
  if (!e) throw chainError("not_on_list", "the signer is not on the list");
  if (state.kind === "space") {
    let { seq, head } = pos;
    if (seq === undefined && ctx.live) { const all = ctx.ownerOps ? await ctx.ownerOps(e.eid) : null; if (!all) throw chainError("unknown_owner", "the owner's own identity cannot be found"); ({ via_seq: seq, via_head: head } = await viaOf(all)); }
    const { at, ops } = await ownerAt(ctx, e.eid, seq, head);
    const dev = typeof via === "string" ? find(at, via) : undefined;
    if (!dev || dev.kind !== "device") throw chainError("not_on_list", "that device is not on the owner's list");
    if (ctx.live) await stillOnList(ctx, ops, dev);
    return { pub: /** @type {string} */ (dev.pub), young: youngAt(dev, ts), entry: e, signing: dev };
  }
  if (e.kind === "contact") throw chainError("not_allowed", "a recovery contact only approves a recovery");
  return { pub: /** @type {string} */ (e.pub), young: e.kind === "code" || youngAt(e, ts), entry: e, signing: e };
}

/** The position of a person's chain a space op relies on: its head. @param {any[]} ownerOps */
export async function viaOf(ownerOps) { return { via_seq: ownerOps.length - 1, via_head: await hashOf(ownerOps[ownerOps.length - 1]) }; }

/** Does `sig` over `message` check out under the key `signerKey` names? Pass the entry that signed (`signing` in signerKey's answer) so a passkey's assertion is checked as one. @param {string} pub @param {Uint8Array} message @param {string} sig @param {Entry} [entry] */
export const verifyWith = (pub, message, sig, entry) => (entry && entry.alg === "webauthn-es256" ? verifyWebAuthn(/** @type {string} */ (entry.pub), String(entry.rp || ""), message, sig) : verifySig(pub, message, sig));

/** Verify a whole chain from its genesis and return its state. @param {any[]} ops @param {Ctx} [ctx] */
export async function verifyChain(ops, ctx = {}) {
  if (!Array.isArray(ops) || !ops.length) throw chainError("bad_chain", "an empty chain");
  if (ops.length > MAX_OPS) throw chainError("too_long", `a chain is at most ${MAX_OPS} ops`);
  /** @type {State|null} */
  let s = null;
  for (const op of ops) s = await applyOp(s, op, ctx);
  return /** @type {State} */ (s);
}

/** The state as it stood at a time: the ops with ts at or before it (a chain's ts never runs backwards). @param {any[]} ops @param {number} ts @param {Ctx} [ctx] */
export async function stateAt(ops, ts, ctx = {}) {
  const upto = ops.filter(o => o.ts <= ts);
  return upto.length ? verifyChain(upto, ctx) : null;
}

/** Build and sign the genesis. `sign(bytes)` is the first entry's key (a person), or an owner's device (a space, with `via`). @param {{ kind: "person"|"space", entry: any, code?: any, viaPos?: { via_seq: number, via_head: string }, nonce: string, ts: number, via?: string, sign: (m: Uint8Array) => Promise<Uint8Array>|Uint8Array }} o */
export async function makeGenesis({ kind, entry, code, nonce, ts, via, viaPos, sign }) {
  const op = { v: 1, type: "genesis", kind, seq: 0, prev: null, ts, nonce, entry, ...(code ? { code } : {}), by: entry.eid, ...(via ? { via } : {}), ...(viaPos || {}) };
  /** @type {any} */ (op).id = await idOfGenesis(op);
  /** @type {any} */ (op).sig = b64u(await sign(messageOf(op)));
  return op;
}

/** Build and sign the next op on a state. `body` is {type, entry|target, ...}; contacts' approvals come in `approvals` already signed. @param {State} state @param {any} body @param {{ by?: string, via?: string, viaPos?: { via_seq: number, via_head: string }, ts: number, sign?: (m: Uint8Array) => Promise<Uint8Array>|Uint8Array }} o */
export async function makeOp(state, body, { by, via, viaPos, ts, sign, esign }) {
  const op = { v: 1, id: state.id, seq: state.seq + 1, prev: state.head, ts, ...body, ...(by ? { by } : {}), ...(via ? { via } : {}), ...(viaPos || {}) };
  if (sign) /** @type {any} */ (op).sig = b64u(await sign(messageOf(op)));
  // the Secure Enclave key's own signature over the same message (NK-2): `esign` returns 64 bytes r||s or DER
  if (esign) /** @type {any} */ (op).esig = b64u(await esign(messageOf(op)));
  return op;
}

/** What a recovery contact signs to approve (the op without any signatures yet). @param {any} op */
export const approvalMessage = op => messageOf(op);

/** Entries that need to alert the person's devices: adds, removes and recoveries after a sequence number. @param {any[]} ops @param {number} afterSeq */
export function alertsSince(ops, afterSeq) {
  return ops.filter(o => o.seq > afterSeq && o.type !== "genesis").map(o => ({ seq: o.seq, ts: o.ts, type: o.type, by: o.by || null, entry: o.entry ? { eid: o.entry.eid, kind: o.entry.kind, label: o.entry.label || null } : null, target: o.target || null }));
}

/**
 * Compare what a name's directory answered with what this client already holds: an answer must contain the held chain as its prefix.
 * A shorter answer is stale (a replay or an old cache); a different op at the same place is a fork (an operator or a thief rewriting).
 * @param {{ id: string, seq: number, head: string }|null|undefined} pin @param {any[]} ops
 * @returns {Promise<{ ok: true, fresh: boolean }|{ ok: false, code: "stale"|"fork"|"other_id", why: string }>}
 */
export async function checkAnswer(pin, ops) {
  if (!pin) return { ok: true, fresh: true };
  if (!ops.length || ops[0].id !== pin.id) return { ok: false, code: "other_id", why: "the name now points at a different identity than the one you trusted" };
  if (ops.length - 1 < pin.seq) return { ok: false, code: "stale", why: "the directory answered with an older list than you have seen" };
  if (await hashOf(ops[pin.seq]) !== pin.head) return { ok: false, code: "fork", why: "the directory's list does not continue the one you trusted" };
  return { ok: true, fresh: ops.length - 1 > pin.seq };
}

/** The pin to keep after a verified chain. @param {State} s */
export const pinOf = s => ({ id: s.id, seq: s.seq, head: s.head });

export { ID as ID_RE, EID as EID_RE };
