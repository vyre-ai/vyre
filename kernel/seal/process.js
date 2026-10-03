// kernel/seal/process.js: the sealing process (K3). A separate process that is the only place sealed plaintext exists, apart from the person's
// reveal view. It speaks newline-delimited JSON over its stdin and stdout, which only the process that spawned it holds, so no agent, sandbox or
// other local user can reach it. Request { id, op, ctx, ... } gets { id, ok, result } or { id, ok: false, error: { code } }. An error carries a
// stable code and nothing from the input, so no value reaches a log or a stack trace. The language is Node for now: the protocol in this file
// (ops, fields, codes) is the interface a Rust process can implement later.
//   ops: init, put, use, deliver, reveal, derived.read, detect, save, session.end, lookup, drop, presence.enrol, presence.revoke, health
// ctx is the kernel's summary of the chain (wire.chainCtx). This process trusts the kernel for who is in the chain and checks the rest itself.
// `approver` (use and deliver) is the chain of the person who approved: the act may run under an assistant's or a Flow's chain, but the proof
// must come from exactly one person, and the process verifies it against that chain.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { CLASSES, hintOf, redact } from "./classes.js";
import { compact, ledgerEntries } from "./normalise.js";
import { Presence } from "./proof.js";
import { SealStore } from "./store.js";

export const HUMAN_SURFACES = new Set(["deck", "capsule", "mobile"]);
const REVEAL_MS = 30_000, LOOKUP_PER_MIN = 10, MAX_VALUE = 8192, MAX_BODY = 1 << 20;
const err = (code) => Object.assign(new Error(code), { code });
const need = (c, m) => { if (!c) throw err(m); };

export class Sealer {
  /** @param {{ dir: string, master: Buffer, sinks?: Record<string,string>, now?: () => number }} o */
  constructor({ dir, master, sinks = {}, now = Date.now }) {
    this.store = new SealStore(dir, master); this.sinks = sinks; this.now = now; this.presence = new Presence(now);
    this.sessions = new Map(); this.lookups = new Map();
  }
  ctxOf(ctx) { need(ctx && typeof ctx.space === "string" && ctx.space, "bad_input"); return ctx; }
  session(id) {
    need(typeof id === "string" && id, "bad_input");
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
    if (r.unique && this.store.metas("values", ctx.space).some(m => m.field === r.field && m.class === r.class && m.blind === bi)) throw err("duplicate");
    const meta = { ref: this.store.newRef("seal"), space: ctx.space, record: r.record, field: r.field, class: r.class, set_at: this.now(), valid_format: cls.validate(r.value), blind: bi };
    this.store.write("values", meta, r.value);
    const hint = r.hint_allowed ? hintOf(r.value) : undefined;
    return { ref: { sealed: cls.label, ref: meta.ref, present: true, valid_format: meta.valid_format, set_at: meta.set_at, ...(hint ? { hint } : {}) } };
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
    this.store.write("derived", { ref: out, space: ctx.space, record: dest.record, field: "output", class: "derived", from: vals.map(v => v.meta.ref), set_at: this.now() }, body);
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
    return { delivered: reply && reply.ok === true, status: typeof reply?.status === "number" ? reply.status : null };
  }

  /** Human-only. The value goes to the person's blind reveal view, once, and `field.revealed` goes to the log without it. */
  reveal(r, derived = false) {
    const ctx = this.ctxOf(r.ctx);
    need(typeof r.purpose === "string" && r.purpose.length > 0 && r.purpose.length <= 200, "bad_input");
    need(ctx.one_person && !ctx.model_originated && HUMAN_SURFACES.has(ctx.surface), "human_only");
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
    this.ctxOf(r.ctx); const s = this.session(r.session);
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
  save(r) { const ctx = this.ctxOf(r.ctx), v = this.session(r.session).values.get(`${r.class}#${r.n}`); need(v, "not_found"); return this.put({ ctx, record: r.record, field: r.field, class: r.class, value: v, hint_allowed: r.hint_allowed }); }
  sessionEnd(r) { this.sessions.delete(r.session); return { ended: true }; }

  /** The named human lookup (R5-5): one person, rate limited per person and field, never a Flow step. Returns refs, never values. */
  lookup(r) {
    const ctx = this.ctxOf(r.ctx);
    need(ctx.one_person && !ctx.model_originated && CLASSES[r.class] && typeof r.field === "string" && typeof r.value === "string", "human_only");
    const k = `${ctx.person}\0${r.field}`, t = this.now(), hits = (this.lookups.get(k) || []).filter(x => x > t - 60_000);
    need(hits.length < LOOKUP_PER_MIN, "rate_limited");
    hits.push(t); this.lookups.set(k, hits);
    const bi = this.store.blind(ctx.space, r.field, r.class, compact(r.value));
    return { refs: this.store.metas("values", ctx.space).filter(m => m.field === r.field && m.class === r.class && m.blind === bi).map(m => m.ref), event: { type: "seal.lookup", field: r.field, class: r.class } };
  }
  drop(r) { const ctx = this.ctxOf(r.ctx); this.open(ctx, r.ref); return { dropped: this.store.drop("values", r.ref) }; }

  async handle(req) {
    switch (req.op) {
      case "put": return this.put(req); case "use": return this.use(req); case "deliver": return this.deliver(req);
      case "reveal": return this.reveal(req); case "derived.read": return this.reveal(req, true);
      case "detect": return this.detect(req); case "save": return this.save(req); case "session.end": return this.sessionEnd(req);
      case "lookup": return this.lookup(req); case "drop": return this.drop(req);
      case "presence.enrol": this.presence.enrol(req); return { ok: true };
      case "presence.revoke": this.presence.revoke(req.key_id); return { ok: true };
      case "health": return { ok: true, pid: process.pid };
      default: throw err("bad_op");
    }
  }
}

/** The master key: from a 0600 file in the process's own folder (created on first start). The OS keystore plugs in here (Keychain, DPAPI, enclave). */
export function fileMaster(dir) {
  const f = path.join(dir, "master.key");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(f, "utf8"), "base64");
}

/** Serve requests on stdin and stdout. Anything unexpected is a generic code: the message of an exception may hold input, so it is never sent. */
export function serve({ dir, master = fileMaster(dir), sinks = {}, input = process.stdin, output = process.stdout } = {}) {
  const sealer = new Sealer({ dir, master, sinks });
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
  serve({ dir: process.env.VYRE_SEAL_DIR, sinks: JSON.parse(process.env.VYRE_SEAL_SINKS || "{}") });
}
