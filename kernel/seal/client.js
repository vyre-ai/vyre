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
export function startSealer({ dir, sinks = {}, timeoutMs = 20_000, execPath = process.execPath, profile, dev = false, unattested = false, software = false, appattest = null, verifiers = null }) {
  const env = { VYRE_SEAL_DIR: dir, VYRE_SEAL_SINKS: JSON.stringify(sinks), PATH: process.env.PATH || "", ...(profile ? { VYRE_SEAL_PROFILE: profile } : {}), ...(dev ? { VYRE_SEAL_DEV: "1" } : {}), ...(unattested ? { VYRE_SEAL_UNATTESTED: "1" } : {}), ...(software ? { VYRE_SEAL_SOFTWARE: "1" } : {}), ...(appattest ? { VYRE_SEAL_APPATTEST_DEV: "1", ...(appattest.rootPem ? { VYRE_SEAL_APPATTEST_ROOT: appattest.rootPem } : {}), ...(appattest.appIds ? { VYRE_SEAL_APPATTEST_APPS: appattest.appIds.join(",") } : {}) } : {}), ...(verifiers ? { VYRE_SEAL_VERIFIERS: verifiers } : {}), ...(process.env.VYRE_AGENT_UIDS ? { VYRE_AGENT_UIDS: process.env.VYRE_AGENT_UIDS } : {}) };
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
      reseal: i => withCtx("reseal", i, { to_ctx: chainCtx(i.to_chain), ref: i.ref, to_record: i.to_record, field: i.field }),
      /** Across servers: `wrapKey` answers this Space's public wrapping key; `export` (source process, the person's own proof) answers a blob wrapped to a target's key; `import` (target process) stores it. */
      wrapKey: i => withCtx("wrap.pub", i),
      /** One approval for a whole move: the person's proof once over `{ plan_hash, target_key, refs }`; then `export` with the same `plan_hash` takes each listed ref once, with no proof of its own. */
      exportApprove: i => withCtx("export.approve", i, { plan_hash: i.plan_hash, target_key: i.target_key, refs: i.refs, proof: i.proof }),
      export: i => withCtx("export", i, { ref: i.ref, target_key: i.target_key, record: i.record, to_record: i.to_record, field: i.field, proof: i.proof, plan_hash: i.plan_hash }),
      import: i => withCtx("import", i, { blob: i.blob, record: i.record, field: i.field }),
      reveal: i => withCtx("reveal", i, { ref: i.ref, purpose: i.purpose, proof: i.proof, ledger_key: i.ledger_key }),
    },
    deliver: i => withCtx("deliver", i, { output_ref: i.output_ref, sink: i.sink, envelope: i.envelope, proof: i.proof }),
    revealDerived: i => withCtx("derived.read", i, { ref: i.output_ref, purpose: i.purpose, proof: i.proof, ledger_key: i.ledger_key }),
    detect: i => withCtx("detect", i, { session: i.session, text: i.text, ledger_key: i.ledger_key }),
    save: i => withCtx("save", i, { session: i.session, class: i.class, n: i.n, record: i.record, field: i.field, hint_allowed: i.hint_allowed }),
    endSession: (chain, session) => withCtx("session.end", { chain }, { session }),
    lookup: i => withCtx("lookup", i, { class: i.class, field: i.field, value: i.value }),
    /**
     * `seal.detect`: yes or no, is this candidate the current value of a sealed field the call's person may read. `caller` is the kernel's word for which first-party module asked, taken from
     * the module registry and NEVER from the module's input (`first_party` and `module` are the registry's); `canRead(record)` is the kernel's grants check for the chain's person on one record
     * URN, and is required. The sealing process finds the records that hold the value; only those the person may read count, so a value sealed only where they cannot read answers no. Only
     * `{ match, event }` leaves this function: the records never do.
     */
    detectValue: async i => {
      if (typeof i.canRead !== "function") throw new SealError("bad_input");
      const r = await withCtx("match", i, { caller: i.caller, value: i.value });
      let match = false;
      for (const rec of r.records || []) { if (await i.canRead(rec)) { match = true; break; } }
      return { match, event: r.event };
    },
    drop: i => withCtx("drop", i, { ref: i.ref }),
    /** The enrolment ceremony: `begin` gives a one-time token, `enrol` needs it, the person's chain, a platform attestation (or an unattested-allowed process) and, for a second device, a proof from the first. */
    begin: i => withCtx("presence.begin", i, { person: i.person, key_id: i.key_id, spki: i.spki }),
    enrol: i => withCtx("presence.enrol", i, { person: i.person, key_id: i.key_id, spki: i.spki, signer: i.signer, rp: i.rp, token: i.token, attestation: i.attestation, proof: i.proof, bind: i.bind, ops: i.ops }),
    /** R-8: `sync` hands the process the person's identity chain (ops) and device-to-key binds; `recover` gives a person with no key left a new first key from chain evidence. */
    sync: i => withCtx("presence.sync", i, { person: i.person, ops: i.ops, binds: i.binds }),
    /** RC1: an invitee's first key on a server that has never met them, from the identity chain (ops) and a listed device's signature over this invite, Space and key. */
    join: i => withCtx("presence.join", i, { person: i.person, ops: i.ops, bind: i.bind, invite: i.invite, key_id: i.key_id, spki: i.spki, signer: i.signer, rp: i.rp, attestation: i.attestation }),
    /** Take back the key a join just enrolled when the accept that carried it did not finish. */
    unjoin: i => withCtx("presence.unjoin", i, { person: i.person, invite: i.invite, key_id: i.key_id }),
    recover: i => withCtx("presence.recover", i, { person: i.person, ops: i.ops, bind: i.bind, key_id: i.key_id, spki: i.spki, signer: i.signer, token: i.token, attestation: i.attestation }),
    revoke: i => withCtx("presence.revoke", i, { key_id: i.key_id, proof: i.proof }),
    /** Does this proof stand for this kernel act (a task op) by the one person in the chain? Uses the proof up. Resolves null when it stands, else the reason. */
    /** Like presenceCheck, and says how the proof was made: { ok: true, method: "attested" | "software", strength: "hardware" | "software" } or { ok: false, code }. */
    presenceProve: i => withCtx("presence.check", i, { act: i.op, fields: i.fields, proof: i.proof, ...(i.dry === true ? { dry: true } : {}) }).then(r => ({ ok: true, method: r.method, strength: r.strength }), e => ({ ok: false, code: e instanceof SealError ? e.code : "failed" })),
    presenceCheck: i => withCtx("presence.check", i, { act: i.op, fields: i.fields, proof: i.proof, ...(i.dry === true ? { dry: true } : {}) }).then(() => null, e => (e instanceof SealError ? e.code : "failed")),
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
    /** The log anchor (BL-2): the latest (seq, head) of a Space's log, moving only forward ('anchor_behind', 'anchor_split'). Kernel channel only. */
    anchor: {
      advance: i => call("anchor.advance", { ctx: { space: i.space }, seq: i.seq, head: i.head }).then(r => r.anchor),
      read: i => call("anchor.read", { ctx: { space: i.space } }).then(r => r.anchor),
      /** The person's own reset (needs their presence proof for "anchor.reset" with no fields): the anchor reads null again. */
      reset: i => withCtx("anchor.reset", i, { proof: i.proof }).then(() => null),
    },
    kernel: {
      mac: i => call("kernel.mac", { purpose: i.purpose, data: i.data }).then(r => r.mac),
      verify: i => call("kernel.verify", { purpose: i.purpose, data: i.data, mac: i.mac }).then(r => r.ok),
    },
    /** The storage pool's key for one owner (a person or Space id), derived from the home's master for that purpose only; the pool encrypts chunks with it in the home's process. */
    poolKey: i => call("pool.key", { owner: i.owner }).then(r => Buffer.from(r.key, "base64")),
    /** R031-83: a Space's sealed values sealed under a bundle key (`dump`), and put back under this process's own keys on a fresh one (`restore`). */
    spaceDump: i => call("space.dump", { space: i.space, bk: Buffer.from(i.bk).toString("base64") }),
    spaceRestore: i => call("space.restore", { space: i.space, bk: Buffer.from(i.bk).toString("base64"), items: i.items, ...(i.pool ? { pool: i.pool } : {}) }),
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
