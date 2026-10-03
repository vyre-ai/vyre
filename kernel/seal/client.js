// kernel/seal/client.js: the kernel's side of the sealing process: spawns it with a bare environment, talks NDJSON over the pipes only this
// process holds, and implements the SealApi stud from kernel/contracts/seal.d.ts plus the calls the inference door and the gateway need.
// Plaintext crosses here once (put, as the person types it) and on a human reveal (it is passed through to the reveal view and never kept).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { chainCtx } from "./wire.js";

const PROCESS = path.join(path.dirname(fileURLToPath(import.meta.url)), "process.js");

export class SealError extends Error { constructor(code) { super(code); this.code = code; } }

/** @param {{ dir: string, sinks?: Record<string,string>, timeoutMs?: number, execPath?: string }} o */
export function startSealer({ dir, sinks = {}, timeoutMs = 20_000, execPath = process.execPath, profile, dev = false, unattested = false, verifiers = null }) {
  const env = { VYRE_SEAL_DIR: dir, VYRE_SEAL_SINKS: JSON.stringify(sinks), PATH: process.env.PATH || "", ...(profile ? { VYRE_SEAL_PROFILE: profile } : {}), ...(dev ? { VYRE_SEAL_DEV: "1" } : {}), ...(unattested ? { VYRE_SEAL_UNATTESTED: "1" } : {}), ...(verifiers ? { VYRE_SEAL_VERIFIERS: verifiers } : {}), ...(process.env.VYRE_AGENT_UIDS ? { VYRE_AGENT_UIDS: process.env.VYRE_AGENT_UIDS } : {}) };
  const child = spawn(execPath, [PROCESS], { stdio: ["pipe", "pipe", "inherit"], env });
  const pending = new Map(); let n = 0, closed = false;
  readline.createInterface({ input: child.stdout }).on("line", line => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.t);
    m.ok ? p.res(m.result) : p.rej(new SealError(m.error?.code || "failed"));
  });
  const fail = code => { for (const p of pending.values()) { clearTimeout(p.t); p.rej(new SealError(code)); } pending.clear(); };
  child.on("exit", () => { closed = true; fail("sealer_down"); });
  child.stdin.on("error", () => {});
  const call = (op, body = {}) => new Promise((res, rej) => {
    if (closed) return rej(new SealError("sealer_down"));
    const id = ++n, t = setTimeout(() => { pending.delete(id); rej(new SealError("timeout")); }, timeoutMs);
    pending.set(id, { res, rej, t });
    child.stdin.write(JSON.stringify({ id, op, ...body }) + "\n");
  });
  const withCtx = (op, i, extra = {}) => call(op, { ctx: chainCtx(i.chain), ...(i.approver_chain ? { approver: chainCtx(i.approver_chain) } : {}), ...extra });
  return {
    pid: child.pid,
    /** SealApi (contracts/seal.d.ts). `use` takes the template body and the slot bindings, which the kernel read from the Template record. */
    api: {
      put: i => withCtx("put", i, { record: i.record, field: i.field, class: i.class, value: i.value, hint_allowed: i.hint_allowed, unique: i.unique }),
      use: i => withCtx("use", i, { body: i.body, bindings: i.bindings ?? [{ slot: i.slot, ref: i.ref }], destination: i.destination, template: i.template, template_version: i.template_version, proof: i.proof }),
      reveal: i => withCtx("reveal", i, { ref: i.ref, purpose: i.purpose, proof: i.proof, ledger_key: i.ledger_key }),
    },
    deliver: i => withCtx("deliver", i, { output_ref: i.output_ref, sink: i.sink, envelope: i.envelope, proof: i.proof }),
    revealDerived: i => withCtx("derived.read", i, { ref: i.output_ref, purpose: i.purpose, proof: i.proof, ledger_key: i.ledger_key }),
    detect: i => withCtx("detect", i, { session: i.session, text: i.text, ledger_key: i.ledger_key }),
    save: i => withCtx("save", i, { session: i.session, class: i.class, n: i.n, record: i.record, field: i.field, hint_allowed: i.hint_allowed }),
    endSession: (chain, session) => withCtx("session.end", { chain }, { session }),
    lookup: i => withCtx("lookup", i, { class: i.class, field: i.field, value: i.value }),
    /** `seal.detect`: yes or no, is this candidate a sealed field's current value in this Space. `caller` is the kernel's word for which first-party module asked. */
    detectValue: i => withCtx("match", i, { caller: i.caller, value: i.value }),
    drop: i => withCtx("drop", i, { ref: i.ref }),
    /** The enrolment ceremony: `begin` gives a one-time token, `enrol` needs it, the person's chain, a platform attestation (or an unattested-allowed process) and, for a second device, a proof from the first. */
    begin: i => withCtx("presence.begin", i, { person: i.person, key_id: i.key_id, spki: i.spki }),
    enrol: i => withCtx("presence.enrol", i, { person: i.person, key_id: i.key_id, spki: i.spki, signer: i.signer, token: i.token, attestation: i.attestation, proof: i.proof, bind: i.bind, ops: i.ops }),
    /** R-8: `sync` hands the process the person's identity chain (ops) and device-to-key binds; `recover` gives a person with no key left a new first key from chain evidence. */
    sync: i => withCtx("presence.sync", i, { person: i.person, ops: i.ops, binds: i.binds }),
    recover: i => withCtx("presence.recover", i, { person: i.person, ops: i.ops, bind: i.bind, key_id: i.key_id, spki: i.spki, signer: i.signer, token: i.token, attestation: i.attestation }),
    revoke: i => withCtx("presence.revoke", i, { key_id: i.key_id, proof: i.proof }),
    /** Does this proof stand for this kernel act (a task op) by the one person in the chain? Uses the proof up. Resolves null when it stands, else the reason. */
    presenceCheck: i => withCtx("presence.check", i, { act: i.op, fields: i.fields, proof: i.proof }).then(() => null, e => (e instanceof SealError ? e.code : "failed")),
    /** The Space's checkpoint key, held in the sealing process: its public half, and a signature over a checkpoint of this Space (nothing else is signed). */
    spaceKey: { pub: i => withCtx("spacekey.pub", i), sign: i => withCtx("spacekey.sign", i, { bytes: Buffer.from(i.bytes).toString("base64") }) },
    /** Key leases for a lent computer's workspace. `allowed` is the kernel's answer that both Offer grants hold. */
    lease: {
      issue: i => withCtx("lease.issue", i, { device: i.device, allowed: i.allowed }),
      renew: i => withCtx("lease.renew", i, { lease: i.id, allowed: i.allowed }),
      revoke: i => withCtx("lease.revoke", i, { member: i.member, device: i.device }),
      reinstate: i => withCtx("lease.reinstate", i, { member: i.member, device: i.device, proof: i.proof }),
      check: i => withCtx("lease.check", i, { lease: i.id }),
    },
    /** The kernel's own MAC key lives in the sealing process (K-3): `mac` and `verify` take a purpose (separates uses: "grant-event", "chain") and the data as a string (canonical JSON). The key is never returned. */
    kernel: {
      mac: i => call("kernel.mac", { purpose: i.purpose, data: i.data }).then(r => r.mac),
      verify: i => call("kernel.verify", { purpose: i.purpose, data: i.data, mac: i.mac }).then(r => r.ok),
    },
    /** The storage pool's key for one owner (a person or Space id), derived from the home's master for that purpose only; the pool encrypts chunks with it in the home's process. */
    poolKey: i => call("pool.key", { owner: i.owner }).then(r => Buffer.from(r.key, "base64")),
    /** Service credentials the kernel's own modules hold (a Space's Twenty API key), sealed here instead of in a 0600 file: `put` (also how a rotation lands), `get` at the point of use, `delete`, `list` (names only). `adopt` moves an existing file in once and shreds it. */
    service: {
      put: i => call("service.put", { name: i.name, value: i.value }),
      get: i => call("service.get", { name: i.name }).then(r => r.value),
      delete: i => call("service.delete", { name: i.name }),
      list: () => call("service.list").then(r => r.names),
      adopt: async i => { const v = fs.readFileSync(i.file, "utf8").trim(); await call("service.put", { name: i.name, value: v }); const n = fs.statSync(i.file).size; fs.writeFileSync(i.file, crypto.randomBytes(n)); fs.unlinkSync(i.file); return { adopted: true }; },
    },
    health: () => call("health"),
    close: () => new Promise(res => { if (closed) return res(); child.once("exit", () => res()); child.stdin.end(); setTimeout(() => child.kill(), 2000).unref(); }),
  };
}
