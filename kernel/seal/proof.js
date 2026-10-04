// kernel/seal/proof.js: the sealing process checks a presence proof itself (invariant 4): a signature by an enrolled, biometric-gated key of the
// one person in the chain, over exactly this payload, fresh, used once. The process trusts the kernel only for who is in the chain.
import crypto from "node:crypto";
import fs from "node:fs";
import { proofBytes, payloadHash, sha256b64, bindBytes } from "./wire.js";
// The identity chain verifier lives in kernel/identity (windows authors it, its hash is pinned there): the root of trust for devices.
import { verifyChain, checkAnswer, pinOf, verifyWith } from "../identity/chain.js";

export const SIGNERS = new Set(["secure_enclave", "tpm", "windows_hello", "strongbox", "webauthn_platform"]);
/** A software key, for the automated walk on a development-kind build only (ruling 4, 5 Oct): the process takes it only when started with `allowSoftware`, which main sets only for a development build, and every use is named method "software". */
export const SOFTWARE = "software";
export const MAX_PROOF_LIFE_MS = 120_000;
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
export const UNBOUND_GRACE_MS = 24 * 3_600_000;
export const NEWCOMER_MS = 24 * 3_600_000;

export class Presence {
  /** @param {() => number} [now] @param {{ verifiers?: Record<string, (att: any, spki: Buffer) => string | null>, allowUnattested?: boolean }} [o] a verifier checks a platform attestation (App Attest, Android key attestation, a TPM quote, WebAuthn) and returns the signer class it proves, or null */
  constructor(now = Date.now, { verifiers = {}, allowUnattested = false, allowSoftware = false, file = null, custody = null } = {}) {
    this.keys = new Map(); this.used = new Map(); this.tokens = new Map(); this.now = now; this.since = now(); this.verifiers = verifiers; this.allowUnattested = allowUnattested; this.allowSoftware = allowSoftware;
    this.file = file; this.pins = new Map(); this.barred = new Set(); this.ever = new Set(); this.v = 0; this.recovery = false; this.custody = custody;
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
      for (const [id, k] of Object.entries(j.keys)) this.keys.set(id, { person: k.person, signer: k.signer, attested: k.attested, spki: k.spki, device: k.device, since: k.since ?? 0, founder: k.founder ?? true, key: crypto.createPublicKey({ key: Buffer.from(k.spki, "base64"), format: "der", type: "spki" }) });
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
    const keys = Object.fromEntries([...this.keys].map(([id, k]) => [id, { person: k.person, signer: k.signer, attested: k.attested, spki: k.spki, device: k.device, since: k.since, founder: k.founder }]));
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
  enrol({ person, key_id, spki, signer, token, attestation, proof, bind, ctx }) {
    if (!SIGNERS.has(signer) && signer !== SOFTWARE) return { refused: "bad_signer" };
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
    let attested = false;
    if (attestation && this.verifiers[attestation.format]) {
      if (this.verifiers[attestation.format](attestation, Buffer.from(spki, "base64")) !== signer) return { refused: "bad_attestation" };
      attested = true;
    } else if (signer === SOFTWARE) { /* allowed above: a development build only */ } else if (!this.allowUnattested) return { refused: "unattested" };
    this.keys.set(key_id, { person, signer, attested, spki, device: pin ? bind.eid : undefined, since: this.now(), founder: !this.have(person), key: crypto.createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" }) });
    this.ever.add(person); this.save();
    return { attested };
  }
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
    return !!e && !this.barred.has(e.eid) && await verifyWith(e.pub, bindBytes(person, key_id, spki), b.sig);
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
  async recover({ person, ops, bind, key_id, spki, signer, token, attestation, ctx }) {
    if (!SIGNERS.has(signer) && signer !== SOFTWARE) return { refused: "bad_signer" };
    if (signer === SOFTWARE && !this.allowSoftware) return { refused: "software_refused" };
    if (!ctx?.one_person || ctx.model_originated || ctx.person !== person) return { refused: "chain_not_person" };
    const t = this.tokens.get(token); this.tokens.delete(token);
    if (!t || t.exp < this.now() || t.person !== person || t.key_id !== key_id || t.spki !== sha256b64(spki)) return { refused: "no_ceremony" };
    // With keys left, only a device the chain gained since the last pin may start a newcomer key this way (the recovery code or two contacts added it, as the chain
    // allows): the person lost their devices and has no old key to prove with. A device the pin already knew enrols the ordinary way, with a proof.
    if (this.have(person) && (!this.pins.has(person) || this.pins.get(person).devices?.[bind?.eid])) return { refused: "has_keys" };
    if (!this.pins.has(person)) return { refused: "no_pin" };
    if (!this.have(person) && !this.ever.has(person) && !this.recovery) return { refused: "not_in_recovery" };
    let attested = false;
    if (attestation && this.verifiers[attestation.format]) {
      if (this.verifiers[attestation.format](attestation, Buffer.from(spki, "base64")) !== signer) return { refused: "bad_attestation" };
      attested = true;
    } else if (signer === SOFTWARE) { /* allowed above: a development build only */ } else if (!this.allowUnattested) return { refused: "unattested" };
    const { st, pin } = await this.evidence(person, ops);
    if (!await this.bindOk(st, person, bind, key_id, spki)) return { refused: "bad_bind" };
    this.keys.set(key_id, { person, signer, attested, spki, device: bind.eid, since: this.now(), founder: false, key: crypto.createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" }) });
    this.pins.set(person, pin); this.recovery = [...this.ever].some(p => !this.have(p)); this.save();
    return { attested, device: bind.eid };
  }
  /** @returns {string|null} the reason a proof is refused, or null when it stands. */
  refuse(proof, { op, space, fields, ctx }) {
    if (!proof || typeof proof !== "object") return "no_proof";
    if (!ctx.one_person || !ctx.person) return "chain_not_person";
    const k = this.keys.get(proof.key_id);
    if (!k || k.person !== ctx.person || k.signer !== proof.signer) return "unknown_key";
    if (k.signer === SOFTWARE) { if (!this.allowSoftware) return "software_refused"; } else if (!k.attested && !this.allowUnattested) return "unattested";
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
      const sig = Buffer.from(proof.signature, "base64url");
      ok = crypto.verify("sha256", proofBytes(proof), { key: k.key, dsaEncoding: sig.length === 64 ? "ieee-p1363" : "der" }, sig);
    } catch { ok = false; }
    if (!ok) return "bad_signature";
    for (const [n, e] of this.used) if (e < t) this.used.delete(n);
    if (this.used.has(proof.nonce)) return "replayed";
    this.used.set(proof.nonce, proof.expires_at);
    this.lastMethod = k.signer === SOFTWARE ? "software" : k.attested ? "attested" : "unattested";
    return null;
  }
}
