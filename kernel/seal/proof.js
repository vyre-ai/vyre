// kernel/seal/proof.js: the sealing process checks a presence proof itself (invariant 4): a signature by an enrolled, biometric-gated key of the
// one person in the chain, over exactly this payload, fresh, used once. The process trusts the kernel only for who is in the chain.
import crypto from "node:crypto";
import fs from "node:fs";
import { proofBytes, payloadHash, sha256b64, bindBytes, joinBytes } from "./wire.js";
import { bindAttestation, assertProof, assertProofDry } from "./appattest.js";
import { strengthOf, strengthRefusal, methodOf, UNATTESTED_SIGNERS, isUnattestedEnclave } from "./strength.js";
// The identity chain verifier lives in kernel/identity (windows authors it, its hash is pinned there): the root of trust for devices.
import { verifyChain, checkAnswer, pinOf, verifyWith, verifyWebAuthn, youngAt } from "../identity/chain.js";

/** A passkey's relying party: the site name it was made for. */
const RP = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
export const SIGNERS = new Set(["secure_enclave", "tpm", "windows_hello", "strongbox", "webauthn_platform"]);
/** A software key, for the automated walk on a development-kind build only (ruling 4, 5 Oct): the process takes it only when started with `allowSoftware`, which main sets only for a development build, and every use is named method "software". */
export const SOFTWARE = "software";
/** Why a presence key's signer class (and a passkey's site) is not one to take, or null. */
const signerProblem = (/** @type {string} */ signer, /** @type {any} */ rp) => (!SIGNERS.has(signer) && signer !== SOFTWARE ? "bad_signer" : signer === "webauthn_platform" && !RP.test(String(rp || "")) ? "bad_rp" : null);
export const MAX_PROOF_LIFE_MS = 120_000;
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
export const UNBOUND_GRACE_MS = 24 * 3_600_000;
export const NEWCOMER_MS = 24 * 3_600_000;

export class Presence {
  /** @param {() => number} [now] @param {{ verifiers?: Record<string, (att: any, spki: Buffer) => string | null>, allowUnattested?: boolean }} [o] a verifier checks a platform attestation (App Attest, Android key attestation, a TPM quote, WebAuthn) and returns the signer class it proves, or null */
  constructor(now = Date.now, { verifiers = {}, allowUnattested = false, allowSoftware = false, appattest = null, file = null, custody = null } = {}) {
    this.keys = new Map(); this.joined = new Map(); this.used = new Map(); this.tokens = new Map(); this.now = now; this.since = now(); this.verifiers = verifiers; this.allowUnattested = allowUnattested; this.allowSoftware = allowSoftware; this.appattest = appattest;
    this.file = file; /** @type {WeakSet<object>} proofs a passkey made that preverify checked */ this.waOk = new WeakSet(); this.pins = new Map(); this.barred = new Set(); this.ever = new Set(); this.v = 0; this.recovery = false; this.custody = custody;
    // Enrolled keys, and the persons who ever enrolled one, live in the sealing folder (public keys only), MACed under a key derived from the master and
    // anchored by a sealed marker (a version counter and the persons) in the encrypted store. A file that is missing while the anchor exists, fails its
    // MAC, is older than the anchor or cannot be read puts the whole process in recovery: no key is known and no enrolment is accepted (R-7).
    if (file && custody) this.load();
  }
  load() {
    const anchor = (() => { try { return this.custody.anchorRead(); } catch { return "bad"; } })();
    if (!fs.existsSync(this.file)) { if (anchor) this.fail(anchor); return; }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (raw.mac !== this.custody.mac(raw.body) || anchor === "bad") return this.fail(anchor);
      const j = JSON.parse(raw.body);
      if (!anchor || anchor.v !== j.v || j.v < 1) return this.fail(anchor);
      for (const [id, k] of Object.entries(j.keys)) this.keys.set(id, { person: k.person, signer: k.signer, attested: k.attested, spki: k.spki, device: k.device, since: k.since ?? 0, founder: k.founder ?? true, ...(k.aa ? { aa: k.aa } : {}), ...(k.rp ? { rp: k.rp } : {}), key: crypto.createPublicKey({ key: Buffer.from(k.spki, "base64"), format: "der", type: "spki" }) });
      for (const p of j.ever) this.ever.add(p);
      for (const [p, x] of Object.entries(j.pins || {})) this.pins.set(p, x);
      for (const d of j.barred || []) this.barred.add(d);
      this.v = j.v;
    } catch { this.fail(anchor); }
  }
  fail(anchor) { this.recovery = true; this.keys.clear(); if (anchor && anchor !== "bad") for (const p of anchor.ever) this.ever.add(p); if (anchor && anchor !== "bad") { for (const [p, x] of Object.entries(anchor.pins || {})) this.pins.set(p, x); for (const d of anchor.barred || []) this.barred.add(d); } }
  save() {
    if (!this.file) return;
    this.v++;
    const keys = Object.fromEntries([...this.keys].map(([id, k]) => [id, { person: k.person, signer: k.signer, attested: k.attested, spki: k.spki, device: k.device, since: k.since, founder: k.founder, ...(k.aa ? { aa: k.aa } : {}), ...(k.rp ? { rp: k.rp } : {}) }]));
    const pins = Object.fromEntries(this.pins), barred = [...this.barred];
    const body = JSON.stringify({ v: this.v, keys, ever: [...this.ever], pins, barred });
    // The anchor goes first: a crash between the two leaves the file one version behind, which reads as recovery (fail closed), never as a reset.
    this.custody.anchorWrite({ v: this.v, ever: [...this.ever], pins, barred });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ body, mac: this.custody.mac(body) }), { mode: 0o600 }); fs.renameSync(`${this.file}.tmp`, this.file);
  }
  have(person) { return [...this.keys.values()].some(k => k.person === person); }
  /** Step 1 of the ceremony: a one-time token for this person and this key, minutes long. The kernel shows it through the pairing flow. */
  begin({ person, key_id, spki }) {
    const token = crypto.randomBytes(16).toString("base64url");
    this.tokens.set(token, { person, key_id, spki: sha256b64(spki), exp: this.now() + 300_000 });
    return { token, expires_in_ms: 300_000 };
  }
  /**
   * Step 2: enrol a device key for a person. The chain must be exactly that person; the token must be this key's, unused and fresh; a second device
   * needs a proof from a key already enrolled for the same person; the signer class must be proved by a platform attestation, or the process
   * must have been started to allow unattested keys (development, and a platform where no attestation exists, said plainly in the card).
   * @returns {{ attested: boolean } | { refused: string }}
   */
  enrol({ person, key_id, spki, signer, rp, token, attestation, proof, bind, ctx }) {
    const unfit = signerProblem(signer, rp); if (unfit) return { refused: unfit };
    if (signer === SOFTWARE && !this.allowSoftware) return { refused: "software_refused" };
    if (!ctx?.one_person || ctx.model_originated || ctx.person !== person) return { refused: "chain_not_person" };
    const t = this.tokens.get(token); this.tokens.delete(token);
    if (!t || t.exp < this.now() || t.person !== person || t.key_id !== key_id || t.spki !== sha256b64(spki)) return { refused: "no_ceremony" };
    if (this.recovery) return { refused: "needs_recovery" };
    if (this.keys.has(key_id)) return { refused: "exists" };
    // Someone who enrolled before and has no key left has lost every device: no proof can exist, so this is a recovery, never a first device.
    if (!this.have(person) && this.ever.has(person)) return { refused: "needs_recovery" };
    if (this.have(person)) {
      const why = this.refuse(proof, { op: "presence.enrol", space: ctx.space, fields: { key_id, spki: t.spki, signer }, ctx });
      if (why) return { refused: why === "no_proof" ? "needs_presence" : why };
    }
    // Once a chain is pinned for the person, every key is vouched for by a listed device (item R8-3): no bind, no key.
    const pin = this.pins.get(person);
    if (pin && !this.bindPinned(pin, person, bind, key_id, spki)) return { refused: "needs_bind" };
    const v = this.vouch(attestation, spki, signer, token, key_id);
    if ("refused" in v) return { refused: v.refused };
    const { attested, aa } = v;
    this.keys.set(key_id, { person, signer, ...(signer === "webauthn_platform" ? { rp: String(rp) } : {}), attested, spki, device: pin ? bind.eid : undefined, since: this.now(), founder: !this.have(person), ...(aa ? { aa } : {}), key: crypto.createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" }) });
    this.ever.add(person); this.save();
    return { attested };
  }
  /**
   * How a new key is vouched for, the one rule for enrol, recover and join: an App Attest attestation over `token` (kernel/seal/appattest.js), a platform verifier's, or none, which a software key (a development build only, checked by the caller), an
   * unattested-allowed process and a phone's or a passkey's secure key (UNATTESTED_SIGNERS) accept.
   * @returns {{ attested: boolean, aa?: any } | { refused: string }}
   */
  vouch(attestation, spki, signer, token, key_id) {
    if (attestation && attestation.format === "apple-appattest") { const a = this.attestApple(attestation, spki, signer, token, key_id); return "refused" in a ? a : { attested: true, aa: a.aa }; }
    if (attestation && this.verifiers[attestation.format]) return this.verifiers[attestation.format](attestation, Buffer.from(spki, "base64")) === signer ? { attested: true } : { refused: "bad_attestation" };
    return signer === SOFTWARE || this.allowUnattested || UNATTESTED_SIGNERS.has(signer) ? { attested: false } : { refused: "unattested" };
  }
  /** Apple App Attest at enrol or recover: kernel/seal/appattest.js bindAttestation (attested only from the verifier, secure_enclave only, one App Attest key per Secure Enclave key). */
  attestApple(attestation, spki, signer, token, key_id) { return bindAttestation(this.appattest, this.keys, attestation, spki, signer, token, key_id); }
  /** Taking a key away needs a presence proof from a key of the same person (the one being revoked may sign): a person's chain alone is not enough. @returns {string|null} the reason it is refused */
  revoke(key_id, ctx, proof) {
    const k = this.keys.get(key_id);
    if (!k || !ctx?.one_person || ctx.person !== k.person) return "not_found";
    // Another enrolled key vouches, so a stolen device cannot sign away the person's others; the only key may sign its own removal (then recovery, not enrolment).
    const others = [...this.keys].filter(([id, x]) => x.person === k.person && id !== key_id).length;
    if (others > 0 && proof?.key_id === key_id) return "needs_other_key";
    // A sign-in under 24 hours old can remove only newer ones (DESIGN-wink section 2); any older key removes a newcomer in one tap.
    const by = this.keys.get(proof?.key_id);
    if (by && by.person === k.person && this.young(by) && k.since <= by.since && proof.key_id !== key_id) return "newcomer";
    const why = this.refuse(proof, { op: "presence.revoke", space: ctx.space, fields: { key_id }, ctx });
    if (why) return why === "no_proof" ? "needs_presence" : why;
    this.keys.delete(key_id); if (k.device) this.barred.add(k.device); this.save(); return null;
  }
  /** Check a bind against the devices of the pinned chain, synchronously (Ed25519 through node:crypto). */
  bindPinned(pin, person, b, key_id, spki) {
    const raw = pin.devices?.[b?.eid]; if (!raw || this.barred.has(b.eid)) return false;
    try { return crypto.verify(null, bindBytes(person, key_id, spki), crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(raw, "base64url")]), format: "der", type: "spki" }), Buffer.from(b.sig, "base64url")); } catch { return false; }
  }
  young(k) { return !k.founder && this.now() - k.since < NEWCOMER_MS; }
  /**
   * R-8, the way back. Verify a person's identity chain here (the process does not take the kernel's word): it must be that person's own chain, must
   * continue the head pinned at the last sync (a replayed older list, where a since-removed device was still listed, is refused), and may bind presence
   * keys to device entries: a device's chain key signs bindBytes(person, key_id, spki).
   */
  async evidence(person, ops) {
    let st;
    try { st = await verifyChain(ops, { now: this.now() }); } catch { throw Object.assign(new Error("bad_chain"), { code: "bad_chain" }); }
    if (st.id !== person) throw Object.assign(new Error("other_id"), { code: "bad_chain" });
    const a = await checkAnswer(this.pins.get(person), ops);
    if (!a.ok) throw Object.assign(new Error(a.code), { code: a.code === "fork" ? "chain_fork" : "chain_stale" });
    return { st, pin: { ...pinOf(st), first: this.pins.get(person)?.first ?? this.now(), devices: Object.fromEntries(st.entries.filter(e => e.kind === "device").map(e => [e.eid, e.pub])) } };
  }
  async bindOk(st, person, b, key_id, spki) {
    const e = st.entries.find(x => x.eid === b?.eid && x.kind === "device");
    return !!e && !this.barred.has(e.eid) && await verifyWith(e.pub, bindBytes(person, key_id, spki), b.sig, e);
  }
  /** Take a newer verified chain: keys bound to a device the list no longer holds are dropped (fail closed), and listed devices bind keys. No proof needed: this only narrows. */
  async sync({ person, ops, binds = [], ctx }) {
    if (!ctx?.one_person || ctx.model_originated || ctx.person !== person) return { refused: "chain_not_person" };
    const { st, pin } = await this.evidence(person, ops);
    for (const b of binds) { const k = this.keys.get(b?.key_id); if (k && k.person === person && !k.device && await this.bindOk(st, person, b, b.key_id, k.spki)) k.device = b.eid; }
    // Keys go only on chain evidence (R8 V-2): a key whose device left the list, and, when this chain removed a device the last pin had, a key nobody ever
    // bound (it would outlive that removal). A sync that shows no removal drops nothing, so it cannot be used to force a recovery. Their devices are barred.
    const prev = this.pins.get(person), listed = eid => st.entries.some(e => e.eid === eid && e.kind === "device");
    const removed = !!prev?.devices && Object.keys(prev.devices).some(eid => !listed(eid));
    const pruned = [...this.keys].filter(([, k]) => k.person === person && (k.device ? !listed(k.device) : removed)).map(([id]) => id);
    for (const id of pruned) { const k = this.keys.get(id); if (k.device) this.barred.add(k.device); this.keys.delete(id); }
    this.pins.set(person, pin); this.save();
    return { pinned: pin.seq, pruned };
  }
  /**
   * R-8: a person with no presence key left (every device lost, or this process in recovery) gets a new first key from chain evidence, never from a bare
   * claim: the chain shows a device entry, added by a signer on the list (the recovery code with its PIN, or two recovery contacts), and that device's
   * chain key vouches for this presence key. The new key is a newcomer for 24 hours. Whoever holds the code (and PIN) can do this: the design's stated limit.
   */
  async recover({ person, ops, bind, key_id, spki, signer, rp, token, attestation, ctx }) {
    const unfit = signerProblem(signer, rp); if (unfit) return { refused: unfit };
    if (signer === SOFTWARE && !this.allowSoftware) return { refused: "software_refused" };
    if (!ctx?.one_person || ctx.model_originated || ctx.person !== person) return { refused: "chain_not_person" };
    const t = this.tokens.get(token); this.tokens.delete(token);
    if (!t || t.exp < this.now() || t.person !== person || t.key_id !== key_id || t.spki !== sha256b64(spki)) return { refused: "no_ceremony" };
    // With keys left, only a device the chain gained since the last pin may start a newcomer key this way (the recovery code or two contacts added it, as the chain
    // allows): the person lost their devices and has no old key to prove with. A device the pin already knew enrols the ordinary way, with a proof.
    if (this.have(person) && (!this.pins.has(person) || this.pins.get(person).devices?.[bind?.eid])) return { refused: "has_keys" };
    if (!this.pins.has(person)) return { refused: "no_pin" };
    if (!this.have(person) && !this.ever.has(person) && !this.recovery) return { refused: "not_in_recovery" };
    const v = this.vouch(attestation, spki, signer, token, key_id);
    if ("refused" in v) return { refused: v.refused };
    const { attested, aa } = v;
    const { st, pin } = await this.evidence(person, ops);
    if (!await this.bindOk(st, person, bind, key_id, spki)) return { refused: "bad_bind" };
    this.keys.set(key_id, { person, signer, ...(signer === "webauthn_platform" ? { rp: String(rp) } : {}), attested, spki, device: bind.eid, since: this.now(), founder: false, ...(aa ? { aa } : {}), key: crypto.createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" }) });
    this.pins.set(person, pin); this.recovery = [...this.ever].some(p => !this.have(p)); this.save();
    return { attested, device: bind.eid };
  }
  /**
   * The first key of a person this process has never met, from an invite (RC1, the ruling on the invitee's key): the person is not a member of this server yet, so no earlier key can vouch and no
   * recovery is under way. The evidence is the person's identity chain (`ops`, which THIS process verifies, the kernel having read it from the names directory and never from the caller) and a signature
   * by a device listed on it over exactly this invite, this Space, this identity and this key (joinBytes). The device must be listed and not barred (`not_listed`), the signature must hold (`bad_bind`), and
   * a device the list gained under 24 hours ago is refused (`young_device`, the newcomer rule: the person's founding device is exempt). Nothing is enrolled unless every check holds. The key is a newcomer for 24
   * hours, like any first key from chain evidence. A person this process has met before (`known_person`) enrols further devices the ordinary way (a proof from a key already enrolled).
   * @returns {Promise<{ attested: boolean, device: string } | { refused: string }>}
   */
  async join({ person, ops, bind, invite, key_id, spki, signer, rp, attestation, ctx }) {
    const unfit = signerProblem(signer, rp); if (unfit) return { refused: unfit };
    if (signer === SOFTWARE && !this.allowSoftware) return { refused: "software_refused" };
    if (!ctx?.one_person || ctx.model_originated || ctx.person !== person) return { refused: "chain_not_person" };
    if (typeof invite !== "string" || !invite || typeof key_id !== "string" || typeof spki !== "string" || !bind || typeof bind.eid !== "string" || typeof bind.sig !== "string") return { refused: "bad_binding" };
    if (this.recovery) return { refused: "needs_recovery" };
    if (this.keys.has(key_id)) return { refused: "exists" };
    if (this.have(person) || this.ever.has(person) || this.pins.has(person)) return { refused: "known_person" };
    let ev;
    try { ev = await this.evidence(person, ops); } catch (e) { return { refused: /** @type {any} */ (e).code || "bad_chain" }; }
    const e = ev.st.entries.find((/** @type {any} */ x) => x.eid === bind.eid && x.kind === "device");
    if (!e || this.barred.has(e.eid)) return { refused: "not_listed" };
    if (youngAt(e, this.now())) return { refused: "young_device" };
    if (!await verifyWith(e.pub, joinBytes(invite, ctx.space, person, key_id, spki), bind.sig, e)) return { refused: "bad_binding" };
    // Every await is behind us: the state checks that decided "a stranger" are made again here, in the same synchronous block as the write, so two joins at once cannot both pass them.
    if (this.recovery) return { refused: "needs_recovery" };
    if (this.keys.has(key_id)) return { refused: "exists" };
    if (this.have(person) || this.ever.has(person) || this.pins.has(person)) return { refused: "known_person" };
    if (this.barred.has(e.eid)) return { refused: "not_listed" };
    const v = this.vouch(attestation, spki, signer, "join:" + invite, key_id);
    if ("refused" in v) return { refused: v.refused };
    const { attested, aa } = v;
    this.keys.set(key_id, { person, signer, ...(signer === "webauthn_platform" ? { rp: String(rp) } : {}), attested, spki, device: bind.eid, since: this.now(), founder: false, ...(aa ? { aa } : {}), key: crypto.createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" }) });
    this.pins.set(person, ev.pin); this.ever.add(person); this.joined.set(key_id, { person, invite }); this.save();
    return { attested, device: bind.eid };
  }
  /**
   * Take back a key `join` just enrolled, because the accept that carried it did not finish (all or nothing): only a key this process enrolled by `join` for this invite, for this person, and only the person's
   * only key (a person who had none before: join refuses anyone else), so it restores what was there before. Nothing else is ever removed this way.
   * @returns {{ undone: boolean } | { refused: string }}
   */
  unjoin({ person, invite, key_id, ctx }) {
    if (!ctx?.one_person || ctx.model_originated || ctx.person !== person) return { refused: "chain_not_person" };
    const j = this.joined.get(key_id), k = this.keys.get(key_id);
    if (!j || !k || j.person !== person || j.invite !== invite) return { refused: "not_found" };
    this.joined.delete(key_id); this.keys.delete(key_id);
    if (!this.have(person)) { this.pins.delete(person); this.ever.delete(person); }
    this.save();
    return { undone: true };
  }
  /** @param {any} proof @param {{ op: string, space: string, fields: any, ctx: any, dry?: boolean }} a `dry`: do every check (key, signature, payload, expiry, the replay lookup, the app key's assertion) and record nothing: the nonce stays unspent and the app key's counter does not move, so the real call that follows still passes once. @returns {string|null} the reason a proof is refused, or null when it stands. */
  /**
   * A passkey signs a proof as a WebAuthn assertion (the identity chain's envelope, challenge = SHA-256 of proofBytes). That check is asynchronous (WebCrypto) and `refuse` is not, so every
   * request is looked through once, first, and each proof-shaped object a webauthn_platform key made is checked HERE with the chain's own verifier and remembered by identity (a WeakSet: nothing a
   * request says can put an object in it). `refuse` then asks the set. @param {any} req
   */
  preverify(req, depth = 0, found = []) {
    if (!req || typeof req !== "object" || depth > 4) return found.length ? Promise.all(found).then(() => {}) : undefined;
    if (typeof req.signature === "string" && req.signer === "webauthn_platform" && typeof req.key_id === "string") {
      const k = this.keys.get(req.key_id);
      if (k && k.signer === "webauthn_platform" && k.rp) {
        found.push((async () => { let ok = false; try { const raw = Buffer.from(k.spki, "base64").subarray(-65); ok = raw.length === 65 && await verifyWebAuthn(raw.toString("base64url"), k.rp, proofBytes(req), req.signature); } catch { ok = false; } if (ok) this.waOk.add(req); })());
      }
      return depth === 0 && found.length ? Promise.all(found).then(() => {}) : undefined;
    }
    for (const v of Array.isArray(req) ? req : Object.values(req)) if (v && typeof v === "object") this.preverify(v, depth + 1, found);
    return depth === 0 && found.length ? Promise.all(found).then(() => {}) : undefined;
  }
  refuse(proof, { op, space, fields, ctx, dry = false }) {
    if (!proof || typeof proof !== "object") return "no_proof";
    if (!ctx.one_person || !ctx.person) return "chain_not_person";
    const k = this.keys.get(proof.key_id);
    if (!k || k.person !== ctx.person || k.signer !== proof.signer) return "unknown_key";
    // The ONE strength rule (strength.js, shared with the registry): a software key satisfies presence only where a dev switch is on, and is marked method software.
    // UY-2: a phone's unattested secure-chip key is admitted on release too, and marked unattested; every other unattested key needs the dev switch
    const unattested = isUnattestedEnclave(k);
    const why = unattested ? null : strengthRefusal(strengthOf(k.attested), k.signer === SOFTWARE ? this.allowSoftware : this.allowUnattested); if (why) return why; // each dev switch admits only its own kind of key
    // V-3: a key from before the chain was pinned and never bound has a day after the first pin to be bound by a sync; after that it proves nothing.
    const pin = this.pins.get(ctx.person);
    if (!k.device && pin?.first !== undefined && this.now() - pin.first > UNBOUND_GRACE_MS) return "needs_bind";
    if (proof.decision !== op || proof.chain_hash !== ctx.chain_hash) return "wrong_decision";
    if (proof.payload_hash !== payloadHash(op, space, fields)) return "wrong_payload";
    const t = this.now();
    // The used-nonce list is in memory: a proof issued before this process started could already have been used, so none is accepted.
    if (proof.issued_at < this.since || !(proof.issued_at <= t + 5000) || !(proof.expires_at > t) || proof.expires_at - proof.issued_at > MAX_PROOF_LIFE_MS) return "expired";
    let ok = false;
    try {
      // a passkey's assertion was checked in preverify, by the chain's verifier; every other key's signature is ECDSA over the proof's bytes
      const sig = Buffer.from(proof.signature, "base64url");
      ok = k.signer === "webauthn_platform" ? this.waOk.has(proof) : crypto.verify("sha256", proofBytes(proof), { key: k.key, dsaEncoding: sig.length === 64 ? "ieee-p1363" : "der" }, sig);
    } catch { ok = false; }
    if (!ok) return "bad_signature";
    // B2 (App Attest, appattest.js assertProof): the proof also carries the app key's assertion over the same bytes; the new counter is written BEFORE the proof is accepted.
    if (k.aa && k.aa.required) { const why = dry ? assertProofDry(this.appattest, k, proof, proofBytes(proof)) : assertProof(this.appattest, k, proof, proofBytes(proof), () => this.save()); if (why) return why; }
    if (!dry) for (const [n, e] of this.used) if (e < t) this.used.delete(n);
    if (this.used.has(proof.nonce) && this.used.get(proof.nonce) >= t) return "replayed";
    if (!dry) this.used.set(proof.nonce, proof.expires_at);
    this.lastMethod = unattested ? "unattested" : methodOf(strengthOf(k.attested)); this.lastStrength = unattested ? "unattested" : strengthOf(k.attested);
    return null;
  }
}
