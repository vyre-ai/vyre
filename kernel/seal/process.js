// kernel/seal/process.js: the sealing process (K3). A separate process that is the only place sealed plaintext exists, apart from the person's
// reveal view. It speaks newline-delimited JSON over its stdin and stdout, which only the process that spawned it holds, so no agent, sandbox or
// other local user can reach it. Request { id, op, ctx, ... } gets { id, ok, result } or { id, ok: false, error: { code } }. An error carries a
// stable code and nothing from the input, so no value reaches a log or a stack trace. The language is Node for now: the protocol in this file
// (ops, fields, codes) is the interface a Rust process can implement later.
//   ops: init, put, use, deliver, reveal, derived.read, detect, save, session.end, lookup, match, drop, presence.enrol, presence.revoke, presence.check, reseal, wrap.pub, export.approve, export, import, spacekey.pub, spacekey.sign, health
// ctx is the kernel's summary of the chain (wire.chainCtx). This process trusts the kernel for who is in the chain and checks the rest itself.
// `approver` (use and deliver) is the chain of the person who approved: the act may run under an assistant's or a Flow's chain, but the proof
// must come from exactly one person, and the process verifies it against that chain.
import { Leases } from "./leases.js";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { CLASSES, hintOf, redact } from "./classes.js";
import { compact, ledgerEntries } from "./normalise.js";
import { Presence } from "./proof.js";
import { isUnattestedEnclave } from "./strength.js";
/** How an enrolled key is marked: hardware only when attested; unattested for a phone's secure-chip key the server could not attest (UY-2); else software. */
const markOf = (/** @type {boolean} */ attested, /** @type {string} */ signer) => (attested ? "hardware" : isUnattestedEnclave({ attested: false, signer }) ? "unattested" : "software");
import { appAttestVerifier, devSwitch } from "./appattest.js";
export { devSwitch };
import { SealStore } from "./store.js";

export const HUMAN_SURFACES = new Set(["deck", "capsule", "mobile"]);
const REVEAL_MS = 30_000, LOOKUP_PER_MIN = 10, MATCH_PER_MIN = 5, MATCH_PER_DAY = 100, MATCH_SPACE_PER_DAY = 200, MATCH_MIN = 4, MAX_VALUE = 8192, MAX_BODY = 1 << 20;
/** Every address an envelope names: to, cc and bcc, a string or a list, case and spacing folded. */
export const recipientsOf = env => ["to", "cc", "bcc"].flatMap(k => (Array.isArray(env[k]) ? env[k] : env[k] == null ? [] : [env[k]])).map(x => String(x).trim().toLowerCase());
/** True only when the whole recipient set is the one verified contact the value was merged for. A document destination has no recipient, so any recipient is unverified. */
export function recipientsVerified(meta, env) {
  const r = recipientsOf(env);
  if (meta.dest_kind === "contact_point") return r.length > 0 && r.every(x => x === String(meta.dest_contact).trim().toLowerCase());
  return r.length === 0;
}
const SERVICE_NAME = /^[a-z0-9][a-z0-9._/-]{2,100}$/;
const serviceMeta = name => ({ ref: `seal_svc${crypto.createHash("sha256").update(name).digest("hex").slice(0, 30)}`, space: "_service", record: name, field: "service-key", class: "service" });
const err = (code) => Object.assign(new Error(code), { code });
const need = (c, m) => { if (!c) throw err(m); };

export class Sealer {
  /** @param {{ dir: string, master: Buffer, sinks?: Record<string,string>, now?: () => number }} o */
  constructor({ dir, master, sinks = {}, now = Date.now, verifiers = {}, allowUnattested = false, allowSoftware = false, appattest = null }) {
    this.store = new SealStore(dir, master); this.sinks = sinks; this.now = now; this.presence = new Presence(now, { verifiers, allowUnattested, allowSoftware, appattest, file: path.join(dir, "presence.json"), custody: this.store }); this.allowUnattested = allowUnattested;
    this.sessions = new Map(); this.lookups = new Map(); this.leases = new Leases(this.store, now);
    // Filled text does not last: swept at start and every hour (a day at most, ten minutes after a delivery), so a restart loses no deadline.
    const sweep = () => { this.store.sweep("derived", 86_400_000); this.store.sweepDelivered(600_000); };
    sweep(); setInterval(sweep, 3_600_000).unref();
  }
  ctxOf(ctx) { need(ctx && typeof ctx.space === "string" && ctx.space, "bad_input"); return ctx; }
  /** A session belongs to one Space: the key is (space, session), so another Space's id is simply absent (invariants 6 and 8). */
  session(ctx, sid) {
    need(typeof sid === "string" && sid, "bad_input");
    const id = `${ctx.space}\0${sid}`;
    const t = this.now();
    // Originals found in text are kept for a session only: at most a day, at most 1000 sessions, and never on disk.
    for (const [k, v] of this.sessions) if (v.at < t - 86_400_000) this.sessions.delete(k);
    if (!this.sessions.has(id)) { if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value); this.sessions.set(id, { at: t, numbers: new Map(), counts: {}, values: new Map() }); }
    return this.sessions.get(id);
  }

  put(r) {
    const ctx = this.ctxOf(r.ctx), cls = CLASSES[r.class];
    need(cls && typeof r.record === "string" && typeof r.field === "string" && typeof r.value === "string" && r.value.length > 0 && r.value.length <= MAX_VALUE, "bad_input");
    const bi = this.store.blind(ctx.space, r.field, r.class, compact(r.value));
    // The one equality allowed at write time is a person's, rate limited with the lookup: never a model's, never free (R5-5).
    if (r.unique) {
      need(ctx.one_person && !ctx.model_originated, "human_only"); this.rate(ctx, r.field);
      if (this.store.metas("values", ctx.space).some(m => m.field === r.field && m.class === r.class && m.blind === bi)) throw err("duplicate");
    }
    const meta = { ref: this.store.newRef("seal"), space: ctx.space, record: r.record, field: r.field, class: r.class, set_at: this.now(), valid_format: cls.validate(r.value), blind: bi };
    this.store.write("values", meta, r.value);
    const hint = r.hint_allowed ? hintOf(r.value) : undefined;
    return { ref: { sealed: cls.label, ref: meta.ref, present: true, valid_format: meta.valid_format, set_at: meta.set_at, ...(hint ? { hint } : {}) } };
  }
  /** Move a sealed value into another Space's namespace without it leaving this process: opened under the source chain, sealed again under the target's (a new ref there). Both chains must be the same one person, no model in either; the kernel authorised the move (its records in both logs) before asking. */
  reseal(r) {
    const from = this.ctxOf(r.ctx), to = this.ctxOf(r.to_ctx);
    need(from.one_person && to.one_person && !from.model_originated && !to.model_originated && from.person && from.person === to.person && from.space !== to.space, "human_only");
    need(typeof r.to_record === "string" && typeof r.field === "string", "bad_input");
    const v = this.open(from, r.ref);
    return this.put({ ctx: to, record: r.to_record, field: r.field, class: v.meta.class, value: v.plaintext });
  }
  /**
   * Moving a sealed value to a Space on ANOTHER server (the Personal to My Cloud upgrade) without its plaintext leaving a sealing process or touching a disk. The target's sealing process holds an
   * X25519 wrapping key per Space (made here, never returned: `wrap.pub` answers the public half). `export` runs in the source's process, with the person's own proof as a reveal needs: it opens the
   * value, wraps it to that public key (an ephemeral X25519 key, HKDF, AES-256-GCM, bound to the record and field) and answers the blob. `import` runs in the target's process: it opens the blob with
   * the private half and stores the value there as a new sealed value, answering the new sealed reference.
   */
  wrapKey(ctx) {
    const ref = `seal_wk${crypto.createHash("sha256").update(ctx.space).digest("hex").slice(0, 30)}`;
    let rec = this.store.read("values", ref, "_system");
    if (!rec) {
      const { privateKey } = crypto.generateKeyPairSync("x25519");
      this.store.write("values", { ref, space: "_system", record: ctx.space, field: "wrapkey", class: "wrapkey" }, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
      rec = this.store.read("values", ref, "_system");
    }
    const priv = crypto.createPrivateKey(/** @type {any} */ (rec).plaintext);
    return { priv, pub: crypto.createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64") };
  }
  /**
   * One approval for a whole move (the Personal to My Cloud upgrade): the person's own proof, once, over the upgrade's plan hash (which the surface signs in the same prompt as the upgrade itself), the target's key and the exact list of sealed references it will carry. The sealing
   * process keeps that grant in memory only (a restart loses it, and the upgrade is asked again), for a day, and each reference on the list may then be exported once, to that key only.
   */
  exportApprove(r) {
    const ctx = this.ctxOf(r.ctx);
    need(ctx.one_person && !ctx.model_originated && (HUMAN_SURFACES.has(ctx.surface) || ctx.device), "human_only");
    need(typeof r.plan_hash === "string" && r.plan_hash.length > 0 && r.plan_hash.length <= 100 && typeof r.target_key === "string" && r.target_key.length > 20 && r.target_key.length < 200 && Array.isArray(r.refs) && r.refs.length > 0 && r.refs.length <= 5000 && r.refs.every(x => typeof x === "string" && x.length <= 100), "bad_input");
    const refs = [...new Set(r.refs)].sort();
    const why = this.presence.refuse(r.proof, { op: "seal.export_approve", space: ctx.space, fields: { plan_hash: r.plan_hash, target_key: r.target_key, refs }, ctx });
    if (why) throw err(why === "no_proof" ? "needs_presence" : why);
    this.exports ??= new Map();
    const t = this.now();
    for (const [k, g] of this.exports) if (g.expires <= t) this.exports.delete(k);
    this.exports.set(`${ctx.space}\0${r.plan_hash}\0${r.target_key}`, { person: ctx.person, target_key: r.target_key, refs: new Set(refs), used: new Set(), expires: t + 24 * 3600_000 });
    return { approved: refs.length, expires_at: t + 24 * 3600_000 };
  }
  export(r) {
    const ctx = this.ctxOf(r.ctx);
    need(ctx.one_person && !ctx.model_originated && (HUMAN_SURFACES.has(ctx.surface) || ctx.device), "human_only");
    need(typeof r.target_key === "string" && r.target_key.length > 20 && r.target_key.length < 200 && typeof r.record === "string" && typeof r.field === "string" && typeof r.ref === "string", "bad_input");
    if (typeof r.plan_hash === "string") {
      // Under an approved move: only a reference on its list, once, to its key, for the person who approved it, within its day.
      const g = this.exports && this.exports.get(`${ctx.space}\0${r.plan_hash}\0${r.target_key}`);
      need(g && g.expires > this.now() && g.person === ctx.person && g.target_key === r.target_key && g.refs.has(r.ref) && !g.used.has(r.ref), "needs_presence");
      g.used.add(r.ref);
    } else {
      const why = this.presence.refuse(r.proof, { op: "seal.export", space: ctx.space, fields: { ref: r.ref, record: r.record, ...(typeof r.to_record === "string" ? { to_record: r.to_record } : {}), field: r.field, target_key: r.target_key }, ctx });
      if (why) throw err(why === "no_proof" ? "needs_presence" : why);
    }
    const v = this.open(ctx, r.ref);
    let pub; try { pub = crypto.createPublicKey({ key: Buffer.from(r.target_key, "base64"), type: "spki", format: "der" }); } catch { throw err("bad_input"); }
    need(pub.asymmetricKeyType === "x25519", "bad_input");
    const eph = crypto.generateKeyPairSync("x25519");
    const key = Buffer.from(crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub }), Buffer.alloc(0), "vyre-upgrade-field-v1", 32));
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(`${typeof r.to_record === "string" ? r.to_record : r.record}\0${r.field}`));
    const ct = Buffer.concat([c.update(JSON.stringify({ class: v.meta.class, value: v.plaintext }), "utf8"), c.final()]);
    return { blob: { epk: eph.publicKey.export({ type: "spki", format: "der" }).toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") }, event: { type: "field.exported", record: r.record, field: r.field, class: v.meta.class } };
  }
  import(r) {
    const ctx = this.ctxOf(r.ctx);
    need(ctx.one_person && !ctx.model_originated, "human_only");
    const b = r.blob;
    need(b && ["epk", "iv", "ct", "tag"].every(k => typeof b[k] === "string") && typeof r.record === "string" && typeof r.field === "string", "bad_input");
    let body;
    try {
      const key = Buffer.from(crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey: this.wrapKey(ctx).priv, publicKey: crypto.createPublicKey({ key: Buffer.from(b.epk, "base64"), type: "spki", format: "der" }) }), Buffer.alloc(0), "vyre-upgrade-field-v1", 32));
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(b.iv, "base64")); d.setAAD(Buffer.from(`${r.record}\0${r.field}`)); d.setAuthTag(Buffer.from(b.tag, "base64"));
      body = JSON.parse(Buffer.concat([d.update(Buffer.from(b.ct, "base64")), d.final()]).toString("utf8"));
    } catch { throw err("bad_input"); }
    need(body && typeof body.class === "string" && typeof body.value === "string", "bad_input");
    return this.put({ ctx, record: r.record, field: r.field, class: body.class, value: body.value });
  }
  /**
   * R031-83, a Space bundle's sealed values. `space.dump`: every sealed value of one Space opened here and sealed again under the bundle key the kernel passes (AES-256-GCM, its meta as the associated
   * data), so a bundle carries the values and never this process's master or any key derived from it. `space.restore`: onto a fresh process (a Space with no values here), each is opened with the same bundle key and written under THIS
   * process's own keys, with the same ref (so no record is rewritten) and its blind index made again under the new master. Both are the kernel's own calls on its own pipe, as `pool.key` is.
   */
  spaceDump(r) {
    need(/^spc_[a-z0-9]{8,40}$/.test(r.space) && typeof r.bk === "string" && Buffer.from(r.bk, "base64").length === 32, "bad_input");
    const bk = Buffer.from(r.bk, "base64"), items = [];
    for (const m of this.store.metas("values", r.space)) {
      const v = this.store.read("values", m.ref, r.space); if (!v) continue;
      const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", bk, iv); c.setAAD(Buffer.from(`vyre:space-bundle:v1:${m.ref}:${r.space}`));
      const ct = Buffer.concat([c.update(v.plaintext, "utf8"), c.final()]);
      items.push({ meta: v.meta, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") });
    }
    // the Space's drive pool key too (a derived key, not the master): the Drive's chunks are sealed under it, so a restored Space reads its files again
    return { items, pool: this.store.poolKey(r.space).toString("base64") };
  }
  spaceRestore(r) {
    need(/^spc_[a-z0-9]{8,40}$/.test(r.space) && typeof r.bk === "string" && Buffer.from(r.bk, "base64").length === 32 && Array.isArray(r.items) && r.items.length <= 100_000, "bad_input");
    need(this.store.metas("values", r.space).length === 0, "not_empty");
    const bk = Buffer.from(r.bk, "base64"); let n = 0;
    for (const it of r.items) {
      need(it && it.meta && it.meta.space === r.space && typeof it.meta.ref === "string" && /^seal_[a-z0-9]{20,40}$/.test(it.meta.ref) && CLASSES[it.meta.class], "bad_input");
      let plaintext;
      try { const d = crypto.createDecipheriv("aes-256-gcm", bk, Buffer.from(it.iv, "base64")); d.setAAD(Buffer.from(`vyre:space-bundle:v1:${it.meta.ref}:${r.space}`)); d.setAuthTag(Buffer.from(it.tag, "base64")); plaintext = Buffer.concat([d.update(Buffer.from(it.ct, "base64")), d.final()]).toString("utf8"); } catch { throw err("bad_input"); }
      this.store.write("values", { ...it.meta, blind: this.store.blind(r.space, it.meta.field, it.meta.class, compact(plaintext)) }, plaintext); n++;
    }
    if (typeof r.pool === "string" && Buffer.from(r.pool, "base64").length === 32) this.store.write("values", serviceMeta(`pool.override.${r.space}`), r.pool);
    return { restored: n };
  }
  open(ctx, ref) { const v = this.store.read("values", ref, ctx.space); need(v, "not_found"); return v; }

  /** Merge sealed slots into a template body. The merged text is a sealed derivative; the caller learns only that it happened. */
  use(r) {
    const ctx = this.ctxOf(r.ctx);
    need(typeof r.body === "string" && r.body.length <= MAX_BODY && Array.isArray(r.bindings) && r.bindings.length && r.destination, "bad_input");
    const dest = r.destination, vals = r.bindings.map(b => { need(typeof b.slot === "string" && /^[a-z][a-z0-9_]{0,40}$/.test(b.slot), "bad_input"); return { slot: b.slot, ...this.open(ctx, b.ref) }; });
    const own = vals.every(v => dest.record === v.meta.record && (dest.kind === "document" || (dest.kind === "contact_point" && dest.verified === true && typeof dest.contact === "string")));
    // R5-4: only the record's own verified contact point or a document for it; anything else, and anything a model started, needs fresh presence.
    if (!own || ctx.model_originated) {
      const why = this.presence.refuse(r.proof, { op: "seal.use", space: ctx.space, fields: { refs: r.bindings.map(b => b.ref).sort(), destination: dest, template: r.template, template_version: r.template_version }, ctx: r.approver || ctx });
      if (why) throw err(why === "no_proof" ? "needs_presence" : why);
    }
    // One pass over the body, so a value that looks like a slot cannot inject into another. The slots in the body are exactly the bound ones.
    const by = new Map(vals.map(v => [v.slot, v.plaintext])), inBody = new Set([...r.body.matchAll(/\{\{sealed:([a-z][a-z0-9_]*)\}\}/g)].map(m => m[1]));
    need(inBody.size === by.size && [...by.keys()].every(k => inBody.has(k)), "slot_mismatch");
    const body = r.body.replace(/\{\{sealed:([a-z][a-z0-9_]*)\}\}/g, (_, k) => by.get(k));
    const out = this.store.newRef("out");
    this.store.sweep("derived", 86_400_000);
    this.store.write("derived", { ref: out, space: ctx.space, record: dest.record, field: "output", class: "derived", from: vals.map(v => v.meta.ref), dest_kind: dest.kind, dest_contact: dest.kind === "contact_point" ? dest.contact : null, set_at: this.now() }, body);
    return { merged: true, output_ref: `vyre://${ctx.space}/sealed-output/${out}`, sealed_slots: vals.map(v => ({ slot: v.slot, class: v.meta.class })) };
  }
  outRef(ctx, ref) { const m = /^vyre:\/\/([^/]+)\/sealed-output\/(out_[a-z0-9]+)$/.exec(String(ref)); need(m && m[1] === ctx.space, "not_found"); return m[2]; }

  /** Hand the merged output to an egress sink (a mail adapter's socket), as the person approved it. Never returned to the caller. */
  async deliver(r) {
    const ctx = this.ctxOf(r.ctx), id = this.outRef(ctx, r.output_ref), d = this.store.read("derived", id, ctx.space);
    need(d && Object.hasOwn(this.sinks, r.sink) && r.envelope && typeof r.envelope === "object", "not_found");
    const why = this.presence.refuse(r.proof, { op: "seal.deliver", space: ctx.space, fields: { output_ref: r.output_ref, sink: r.sink, envelope: r.envelope }, ctx: r.approver || ctx });
    if (why) throw err(why === "no_proof" ? "needs_presence" : why);
    const reply = await new Promise((res, rej) => {
      const s = net.createConnection(this.sinks[r.sink]); let buf = "";
      s.setTimeout(15_000, () => { s.destroy(); rej(err("sink_timeout")); });
      s.on("error", () => rej(err("sink_failed"))); s.on("data", c => { buf += c; });
      s.on("end", () => { try { res(JSON.parse(buf)); } catch { rej(err("sink_failed")); } });
      s.end(JSON.stringify({ envelope: r.envelope, body: d.plaintext }) + "\n");
    });
    // A sink that echoes the value back is not trusted to say so politely: only its status leaves this process.
    const ok = reply && reply.ok === true;
    // The filled text has no business lasting: a day at most, ten minutes after a delivery. A recipient other than the verified contact is said so.
    if (ok) this.store.markDelivered(id);
    return { delivered: ok, status: typeof reply?.status === "number" ? reply.status : null, recipient_verified: recipientsVerified(d.meta, r.envelope) };
  }

  /** Human-only. The value goes to the person's blind reveal view, once, and `field.revealed` goes to the log without it. */
  reveal(r, derived = false) {
    const ctx = this.ctxOf(r.ctx);
    need(typeof r.purpose === "string" && r.purpose.length > 0 && r.purpose.length <= 200, "bad_input");
    // A person at the deck, the capsule or the mobile app, or a member on a paired device (the kernel's device chain carries `via.device` and no surface): the hardware-signed proof below is what proves the person.
    need(ctx.one_person && !ctx.model_originated && (HUMAN_SURFACES.has(ctx.surface) || ctx.device), "human_only");
    const op = derived ? "seal.reveal_derived" : "seal.reveal";
    const why = this.presence.refuse(r.proof, { op, space: ctx.space, fields: { ref: r.ref, purpose: r.purpose }, ctx });
    if (why) throw err(why === "no_proof" ? "needs_presence" : why);
    const v = derived ? this.store.read("derived", this.outRef(ctx, r.ref), ctx.space) : this.open(ctx, r.ref);
    need(v, "not_found");
    const ledger = r.ledger_key ? ledgerEntries(v.plaintext, v.meta.class, Buffer.from(r.ledger_key, "base64")) : [];
    return { value: v.plaintext, expires_in_ms: REVEAL_MS, ledger, event: { type: "field.revealed", record: v.meta.record, field: v.meta.field, class: v.meta.class, purpose: r.purpose, expires_at: this.now() + REVEAL_MS } };
  }

  /** Text on its way to a model: sealed-looking values become `[sealed: US SSN #1]`; the originals stay here, bound to the session. */
  detect(r) {
    const ctx = this.ctxOf(r.ctx), s = this.session(ctx, r.session);
    need(typeof r.text === "string" && r.text.length <= 4 * MAX_BODY, "bad_input");
    const number = (cls, value) => {
      const k = `${cls}\0${compact(value)}`;
      if (!s.numbers.has(k)) { s.counts[cls] = (s.counts[cls] || 0) + 1; s.numbers.set(k, s.counts[cls]); s.values.set(`${cls}#${s.counts[cls]}`, value); }
      return s.numbers.get(k);
    };
    const { text, found } = redact(r.text, number);
    const key = r.ledger_key ? Buffer.from(r.ledger_key, "base64") : null;
    return { text, found: found.map(f => ({ class: f.class, n: f.n })), ledger: key ? found.flatMap(f => ledgerEntries(f.value, f.class, key)) : [] };
  }
  /** "Save as a sealed field on this contact": the retained original becomes a sealed value; nothing is returned but the reference. */
  save(r) { const ctx = this.ctxOf(r.ctx); need(ctx.one_person && !ctx.model_originated, "human_only"); const v = this.session(ctx, r.session).values.get(`${r.class}#${r.n}`); need(v, "not_found"); return this.put({ ctx, record: r.record, field: r.field, class: r.class, value: v, hint_allowed: r.hint_allowed }); }
  sessionEnd(r) { const ctx = this.ctxOf(r.ctx); this.sessions.delete(`${ctx.space}\0${r.session}`); return { ended: true }; }

  rate(ctx, field) {
    const k = `${ctx.person}\0${field}`, t = this.now(), hits = (this.lookups.get(k) || []).filter(x => x > t - 60_000);
    need(hits.length < LOOKUP_PER_MIN, "rate_limited");
    hits.push(t); this.lookups.set(k, hits);
  }
  /** The named human lookup (R5-5): one person, rate limited per person and field, never a Flow step. Returns refs, never values. */
  lookup(r) {
    const ctx = this.ctxOf(r.ctx);
    need(ctx.one_person && !ctx.model_originated && CLASSES[r.class] && typeof r.field === "string" && typeof r.value === "string", "human_only");
    this.rate(ctx, r.field);
    const bi = this.store.blind(ctx.space, r.field, r.class, compact(r.value));
    return { refs: this.store.metas("values", ctx.space).filter(m => m.field === r.field && m.class === r.class && m.blind === bi).map(m => m.ref), event: { type: "seal.lookup", field: r.field, class: r.class } };
  }
  /**
   * `seal.detect` (assistant's ask): does this one candidate equal a sealed field's current value in this Space? A yes or no, nothing else: no field, record,
   * class or ref comes back. Equality is the same keyed blind index the write-time `unique` check and `lookup` use, so no new store. For the first-party
   * modules the kernel names (`caller.first_party`), never a chain with a model in it, one candidate per call, at least MATCH_MIN characters, MATCH_PER_MIN a
   * minute and MATCH_PER_DAY a day per (Space, module) and MATCH_SPACE_PER_DAY a day for the Space. The counters live in this process (a restart resets them,
   * and a restart is the operator's act). The event names the module and today's count, never the candidate or the answer.
   */
  match(r) {
    const ctx = this.ctxOf(r.ctx), c = r.caller;
    need(c && c.first_party === true && typeof c.module === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(c.module), "first_party_only");
    need(!ctx.model_originated, "human_only");
    need(typeof r.value === "string" && r.value.length <= MAX_VALUE && compact(r.value).length >= MATCH_MIN, "bad_input");
    const t = this.now(), day = Math.floor(t / 86_400_000), mk = `${ctx.space}\0${c.module}`, sk = `${ctx.space}\0*`;
    // The per-day counts are sealed on disk, so a restart does not reset a limit; the per-minute window is memory only (a restart gives at most one minute's worth back).
    const saved = this.store.matchRead();
    const days = saved && saved.day === day ? saved.counts : {};
    const m = this.matches || (this.matches = new Map());
    const hits = (m.get(mk) || []).filter(x => x > t - 60_000);
    need(hits.length < MATCH_PER_MIN && (days[mk] || 0) < MATCH_PER_DAY && (days[sk] || 0) < MATCH_SPACE_PER_DAY, "rate_limited");
    hits.push(t); m.set(mk, hits); days[mk] = (days[mk] || 0) + 1; days[sk] = (days[sk] || 0) + 1;
    this.store.matchWrite({ day, counts: days });
    const cv = compact(r.value), all = this.store.metas("values", ctx.space), pairs = new Set(all.map(x => `${x.field}\0${x.class}`));
    // The records whose sealed fields hold this value. The kernel's side filters them by what the person may read and returns only the yes or no; they never leave the kernel.
    const records = new Set();
    for (const pr of pairs) { const [field, cls] = pr.split("\0"); const b = this.store.blind(ctx.space, field, cls, cv); for (const x of all) if (x.field === field && x.class === cls && x.blind === b) records.add(x.record); }
    const yes = records.size > 0;
    return { match: yes, records: [...records], event: { type: "seal.detect", module: c.module, count: days[mk] } };
  }
  drop(r) { const ctx = this.ctxOf(r.ctx); this.open(ctx, r.ref); return { dropped: this.store.drop("values", r.ref) }; }

  /**
   * The Space's checkpoint key (K5, DESIGN-wink 2): an Ed25519 key made here, held here and never returned. It signs one thing, a checkpoint of this
   * Space's log; the public half is endorsed in the Space's identity chain by an owner, and the owners' devices hold the checkpoints it signs.
   * @returns {{ priv: crypto.KeyObject, pub: string, key_id: string }}
   */
  spaceKey(ctx) {
    const ref = `seal_sk${crypto.createHash("sha256").update(ctx.space).digest("hex").slice(0, 30)}`;
    let rec = this.store.read("values", ref, "_system");
    if (!rec) {
      const { privateKey } = crypto.generateKeyPairSync("ed25519");
      this.store.write("values", { ref, space: "_system", record: ctx.space, field: "spacekey", class: "spacekey" }, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
      rec = this.store.read("values", ref, "_system");
    }
    const priv = crypto.createPrivateKey(/** @type {any} */ (rec).plaintext);
    const spki = crypto.createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
    return { priv, pub: spki, key_id: crypto.createHash("sha256").update(Buffer.from(spki, "base64")).digest("hex").slice(0, 16) };
  }

  async handle(req) {
    { const pv = this.presence.preverify(req); if (pv) await pv; } // a passkey's assertion is checked once here, with the identity chain's verifier (proof.js refuse reads the result)
    switch (req.op) {
      case "put": return this.put(req); case "use": return this.use(req); case "deliver": return this.deliver(req);
      case "reseal": return this.reseal(req); case "wrap.pub": return { key: this.wrapKey(this.ctxOf(req.ctx)).pub }; case "export": return this.export(req); case "export.approve": return this.exportApprove(req); case "import": return this.import(req); case "reveal": return this.reveal(req); case "derived.read": return this.reveal(req, true);
      case "detect": return this.detect(req); case "save": return this.save(req); case "session.end": return this.sessionEnd(req);
      case "lookup": return this.lookup(req); case "match": return this.match(req); case "drop": return this.drop(req);
      case "presence.begin": { const ctx = this.ctxOf(req.ctx); need(ctx.one_person && !ctx.model_originated && ctx.person === req.person, "chain_not_person"); return this.presence.begin(req); }
      case "presence.enrol": {
        const ctx = this.ctxOf(req.ctx);
        // A pinned person's enrolment first takes the current chain (V-1): a device removed since the last sync is gone, with its keys, before its bind is looked at.
        if (this.presence.pins.has(req.person)) { need(Array.isArray(req.ops), "needs_chain"); const s = await this.presence.sync({ person: req.person, ops: req.ops, ctx }); if (s.refused) throw err(s.refused); }
        const r = this.presence.enrol({ ...req, ctx }); if (r.refused) throw err(r.refused); return { enrolled: true, attested: r.attested, strength: markOf(r.attested, req.signer), event: { type: "presence.enrolled", strength: markOf(r.attested, req.signer), method: r.attested ? "attested" : markOf(false, req.signer) === "unattested" ? "unattested" : "software", person: req.person, key_id: req.key_id, signer: req.signer, attested: r.attested } }; }
      case "presence.revoke": { const why = this.presence.revoke(req.key_id, this.ctxOf(req.ctx), req.proof); if (why) throw err(why); return { revoked: true, event: { type: "presence.revoked", key_id: req.key_id } }; }
      // The one verifier for the kernel: a task approval (or any kernel act the person signs) is checked here, against the keys enrolled here,
      // and the proof is used up. The kernel supplies who is in the chain; only task and grant ops are accepted, so this is not a path to a seal op.
      case "presence.check": { const ctx = this.ctxOf(req.ctx); need(typeof req.act === "string" && /^(task|grant)\.[a-z_]+$/.test(req.act) && req.fields && typeof req.fields === "object", "bad_input"); const why = this.presence.refuse(req.proof, { op: req.act, space: ctx.space, fields: req.fields, ctx, dry: req.dry === true }); if (why) throw err(why === "no_proof" ? "needs_presence" : why); return { ok: true, method: this.presence.lastMethod, strength: this.presence.lastStrength }; }
      // The Space's checkpoint key: its public half on request, and signatures over checkpoints of this Space only.
      case "spacekey.pub": { const ctx = this.ctxOf(req.ctx); const k = this.spaceKey(ctx); return { key_id: k.key_id, pub: k.pub }; }
      case "spacekey.sign": {
        const ctx = this.ctxOf(req.ctx); need(typeof req.bytes === "string", "bad_input");
        const bytes = Buffer.from(req.bytes, "base64"), tag = "vyre-checkpoint-v1\n";
        need(bytes.length < 4096 && bytes.subarray(0, tag.length).toString() === tag, "bad_input");
        let body; try { body = JSON.parse(bytes.subarray(tag.length).toString()); } catch { body = null; }
        need(body && body.space === ctx.space, "wrong_space");
        const k = this.spaceKey(ctx);
        return { key_id: k.key_id, signature: crypto.sign(null, bytes, k.priv).toString("base64url") };
      }
      case "presence.sync": { const r = await this.presence.sync({ ...req, ctx: this.ctxOf(req.ctx) }); if (r.refused) throw err(r.refused); return { ...r, events: r.pruned.map(key_id => ({ type: "presence.revoked", key_id, why: "device_removed" })) }; }
      // An invitee's first key on a server that has never met them: the identity chain (`ops`) is verified here, and a listed, not-young device's signature over this invite, this Space and this key is what vouches for it.
      case "presence.join": { const r = await this.presence.join({ ...req, ctx: this.ctxOf(req.ctx) }); if (r.refused) throw err(r.refused); return { joined: true, attested: r.attested, strength: markOf(r.attested, req.signer), event: { type: "presence.joined", strength: markOf(r.attested, req.signer), person: req.person, key_id: req.key_id, device: r.device, invite: req.invite, newcomer_for_ms: 24 * 3_600_000 } }; }
      // The accept that carried a join's key did not finish: take the key back (all or nothing).
      case "presence.unjoin": { const r = this.presence.unjoin({ ...req, ctx: this.ctxOf(req.ctx) }); if (r.refused) throw err(r.refused); return { undone: true, event: { type: "presence.revoked", key_id: req.key_id, why: "join_undone" } }; }
      case "presence.recover": { const r = await this.presence.recover({ ...req, ctx: this.ctxOf(req.ctx) }); if (r.refused) throw err(r.refused); return { recovered: true, attested: r.attested, strength: markOf(r.attested, req.signer), event: { type: "presence.recovered", strength: markOf(r.attested, req.signer), person: req.person, key_id: req.key_id, device: r.device, newcomer_for_ms: 24 * 3_600_000 } }; }
      case "lease.issue": { const c = this.ctxOf(req.ctx); need(c.one_person && !c.model_originated, "human_only"); need(c.person, "bad_input"); return this.leases.issue({ space: c.space, member: c.person, device: req.device, allowed: req.allowed }); }
      case "lease.renew": { const c = this.ctxOf(req.ctx); need(c.one_person && !c.model_originated, "human_only"); return this.leases.renew({ id: req.lease, member: c.person, allowed: req.allowed }); }
      case "lease.revoke": { const c = this.ctxOf(req.ctx); need(c.one_person && !c.model_originated, "human_only"); return this.leases.revoke({ space: c.space, member: req.member, device: req.device }); }
      case "lease.reinstate": { const c = this.ctxOf(req.ctx); const why = this.presence.refuse(req.proof, { op: "lease.reinstate", space: c.space, fields: { member: req.member, device: req.device }, ctx: c }); if (why) throw err(why === "no_proof" ? "needs_presence" : why); return this.leases.reinstate({ space: c.space, member: req.member, device: req.device }); }
      case "lease.check": { const c = this.ctxOf(req.ctx); return this.leases.check({ id: req.lease, member: c.person }); }
      // The kernel's own channel only: this process's pipes belong to the kernel, and a call that says a model started it is refused. The key never leaves.
      // The log anchor (kernel-2, BL-2): the latest (seq, head) of a Space's event log the kernel showed this process, kept in its own sealed store, moving only forward. The kernel calls advance
      // when it signs a checkpoint and reads it at boot, so a log with its newest events deleted no longer verifies. Kernel channel only, never a model's chain.
      case "anchor.advance": case "anchor.read": {
        const ctx = this.ctxOf(req.ctx); need(!ctx.model_originated, "human_only");
        const meta = { ref: `seal_la${crypto.createHash("sha256").update(ctx.space).digest("hex").slice(0, 30)}`, space: ctx.space, record: "_", field: "logAnchor", class: "logAnchor" };
        const held = (() => { const r = this.store.read("values", meta.ref, ctx.space); return r ? JSON.parse(r.plaintext) : null; })();
        if (req.op === "anchor.read") return { anchor: held };
        need(Number.isSafeInteger(req.seq) && req.seq >= 0 && typeof req.head === "string" && /^[A-Za-z0-9_=+\/-]{16,128}$/.test(req.head), "bad_input");
        if (held) { need(req.seq >= held.seq, "anchor_behind"); if (req.seq === held.seq) { need(req.head === held.head, "anchor_split"); return { anchor: held, event: null }; } }
        this.store.write("values", meta, JSON.stringify({ seq: req.seq, head: req.head }));
        return { anchor: { seq: req.seq, head: req.head }, event: null };
      }
      // The person's own reset of a Space's anchor (BL-2a): after a restore from backup or a bad advance the log would otherwise never boot. Needs the person's presence on this exact act.
      case "anchor.reset": {
        const c = this.ctxOf(req.ctx); need(!c.model_originated, "human_only");
        const why = this.presence.refuse(req.proof, { op: "anchor.reset", space: c.space, fields: {}, ctx: c });
        if (why) throw err(why === "no_proof" ? "needs_presence" : why);
        const ref = `seal_la${crypto.createHash("sha256").update(c.space).digest("hex").slice(0, 30)}`;
        this.store.write("values", { ref, space: c.space, record: "_", field: "logAnchor", class: "logAnchor" }, "null");
        return { anchor: null };
      }
      case "kernel.mac": { need(!req.ctx?.model_originated && /^[a-z0-9_.-]{1,40}$/.test(req.purpose) && typeof req.data === "string" && req.data.length <= 2_000_000, "bad_input"); return { mac: this.store.kernelMac(req.purpose, req.data) }; }
      case "kernel.verify": { need(!req.ctx?.model_originated && /^[a-z0-9_.-]{1,40}$/.test(req.purpose) && typeof req.data === "string" && req.data.length <= 2_000_000 && typeof req.mac === "string", "bad_input"); const a = Buffer.from(this.store.kernelMac(req.purpose, req.data)), b = Buffer.from(req.mac); return { ok: a.length === b.length && crypto.timingSafeEqual(a, b) }; }
      case "space.dump": { need(!req.ctx?.model_originated, "bad_input"); return this.spaceDump(req); }
      case "space.restore": { need(!req.ctx?.model_originated, "bad_input"); return this.spaceRestore(req); }
      case "pool.key": { need(!req.ctx?.model_originated && /^(per|spc)_[a-z0-9]{8,40}$/.test(req.owner), "bad_input"); const o = this.store.read("values", serviceMeta(`pool.override.${req.owner}`).ref, "_service"); return { key: o ? o.plaintext : this.store.poolKey(req.owner).toString("base64") }; }
      // Service credentials the kernel's own modules hold (a Space's Twenty API key): sealed here instead of in a 0600 file any same-uid process can read, read back at the
      // point of use over the kernel's own channel. A name is `<module>.<space>.<what>`; a call that says a model started it is refused; nothing is ever returned by another op.
      case "service.put": { need(!req.ctx?.model_originated && SERVICE_NAME.test(req.name) && typeof req.value === "string" && req.value.length > 0 && req.value.length <= 16_384, "bad_input"); this.store.write("values", serviceMeta(req.name), req.value); return { stored: true, event: { type: "service.stored", name: req.name } }; }
      case "service.get": { need(!req.ctx?.model_originated && SERVICE_NAME.test(req.name), "bad_input"); const r = this.store.read("values", serviceMeta(req.name).ref, "_service"); need(r, "not_found"); return { value: r.plaintext }; }
      case "service.delete": { need(!req.ctx?.model_originated && SERVICE_NAME.test(req.name), "bad_input"); return { deleted: this.store.drop("values", serviceMeta(req.name).ref), event: { type: "service.deleted", name: req.name } }; }
      case "service.list": { need(!req.ctx?.model_originated, "bad_input"); return { names: this.store.metas("values", "_service").map(m => m.record).sort() }; }
      case "health": return { ok: true, pid: process.pid, unattested_allowed: this.allowUnattested, custody: { master: "file", profile: process.env.VYRE_SEAL_PROFILE || "desktop", platform: process.platform, note: custodyNote() }, presence: this.presence.recovery ? "recovery" : "ok", needs_recovery: [...this.presence.ever].filter(p => !this.presence.have(p)) };
      default: throw err("bad_op");
    }
  }
}

/** The master key: from a 0600 file in the process's own folder (created on first start). The OS keystore plugs in here (Keychain, DPAPI, enclave). */
export function fileMaster(dir) {
  const f = path.join(dir, "master.key");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  const st = fs.statSync(f);
  if (process.platform !== "win32" && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid())) throw Object.assign(new Error("master key file is not private to this user"), { safe: true });
  return Buffer.from(fs.readFileSync(f, "utf8"), "base64");
}

/**
 * Ship gate (reviewer-2, K3 item 6): a key file beside the values is safe only on a server where this process runs as its own user and no agent
 * or Claude Code session shares that uid. Otherwise any process of that user reads the key and the values, and invariant 5 does not hold.
 * profile "server": refuse when this uid is one of the agent uids (VYRE_AGENT_UIDS, default the box image's 2000 to 2063).
 * profile "desktop" (the default): the master is a 0600 file inside the Vyre home. Vyre's own sessions are sandboxed away from that folder (core/runner/homesandbox.js denies the whole Vyre
 * home on macOS and Linux) and the disk's own encryption protects it at rest; fileMaster still refuses a file that is not private to this user. An OS keystore (Keychain, DPAPI, secret
 * service) is the 0.3.1 upgrade. No development switch is needed anywhere; VYRE_SEAL_DEV=1 only skips these checks in tests.
 */
/** What the person is told about where the master lives, plainly. */
export function custodyNote(profile = process.env.VYRE_SEAL_PROFILE || "desktop", platform = process.platform) {
  if (profile === "server") return "The sealing key is a file owned by the sealing process's own user. Root on this server, or a stolen disk, can read it.";
  if (platform === "win32") return "Sealed data on this PC is only as protected as this PC's own Windows account: any program running as you can read the key file.";
  return "The sealing key is a file inside your Vyre folder, private to you. Vyre's own sessions are sandboxed away from it and your disk's encryption protects it at rest; root, or a program running as you outside Vyre's sandbox, can read it.";
}
export function hostCheck({ profile = process.env.VYRE_SEAL_PROFILE || "desktop", dev = devSwitch(process.env.VYRE_SEAL_DEV), uid = process.getuid?.() ?? -1, agentUids = process.env.VYRE_AGENT_UIDS } = {}) {
  if (dev || profile === "desktop") return;
  const agents = agentUids ? agentUids.split(",").map(Number) : Array.from({ length: 64 }, (_, i) => 2000 + i);
  if (profile !== "server" || agents.includes(uid)) throw Object.assign(new Error("the sealing process must run as its own user, not an agent's"), { safe: true });
}

/** Is a SOFTWARE signer (no platform attestation) accepted for presence? Only in a development build and only with VYRE_SEAL_UNATTESTED=1 (kernel/devbuild.test.js holds this). @param {Record<string, string | undefined>} env @param {string} [root] */
export const unattestedAllowed = (env, root) => devSwitch(env.VYRE_SEAL_UNATTESTED, root);

/** Serve requests on stdin and stdout. Anything unexpected is a generic code: the message of an exception may hold input, so it is never sent. */
export function serve({ dir, master = (hostCheck(), fileMaster(dir)), sinks = {}, input = process.stdin, output = process.stdout, verifiers = {}, allowUnattested = false, allowSoftware = false, appattest = null } = {}) {
  const sealer = new Sealer({ dir, master, sinks, verifiers, allowUnattested, allowSoftware, appattest });
  if (allowSoftware) process.stderr.write("seal: software presence keys are accepted (development build); every use is method software\n");
  const rl = readline.createInterface({ input });
  rl.on("line", async line => {
    let req; try { req = JSON.parse(line); } catch { return; }
    let res;
    try { res = { id: req.id, ok: true, result: await sealer.handle(req) }; } catch (e) { res = { id: req.id, ok: false, error: { code: typeof e?.code === "string" && /^[a-z_]+$/.test(e.code) ? e.code : "failed" } }; }
    output.write(JSON.stringify(res) + "\n");
  });
  return sealer;
}
if (process.argv[1] && process.argv[1].endsWith("kernel/seal/process.js") && process.env.VYRE_SEAL_DIR) {
  // A crash must not print the exception: its message or stack could hold a value.
  process.on("uncaughtException", () => { process.stderr.write("seal: internal error\n"); process.exit(70); });
  process.on("unhandledRejection", () => { process.stderr.write("seal: internal error\n"); process.exit(70); });
  // The pipe is the only way in: when the kernel closes it or dies, this process ends, so no test or crash leaves one running.
  process.stdin.on("end", () => process.exit(0)); process.stdin.on("close", () => process.exit(0));
  let verifiers = {};
  if (process.env.VYRE_SEAL_VERIFIERS) verifiers = (await import(process.env.VYRE_SEAL_VERIFIERS)).default;
  try { serve({ dir: process.env.VYRE_SEAL_DIR, sinks: JSON.parse(process.env.VYRE_SEAL_SINKS || "{}"), verifiers, allowUnattested: devSwitch(process.env.VYRE_SEAL_UNATTESTED), allowSoftware: devSwitch(process.env.VYRE_SEAL_SOFTWARE), appattest: (() => {
    // App Attest: the test root, the development environment and extra app ids exist only under the process's own devSwitch (AA-1, AA-2); a release-kind build ignores all three variables.
    const dev = devSwitch(process.env.VYRE_SEAL_APPATTEST_DEV);
    return appAttestVerifier({ dev, testRootPem: dev && process.env.VYRE_SEAL_APPATTEST_ROOT ? fs.readFileSync(process.env.VYRE_SEAL_APPATTEST_ROOT, "utf8") : null, extraAppIds: dev && process.env.VYRE_SEAL_APPATTEST_APPS ? process.env.VYRE_SEAL_APPATTEST_APPS.split(",") : [] });
  })() }); }
  catch (e) { process.stderr.write(`seal: ${e?.safe ? e.message : "internal error"}\n`); process.exit(70); }
}
