// kernel/seal/client.js: the kernel's side of the sealing process: spawns it with a bare environment, talks NDJSON over the pipes only this
// process holds, and implements the SealApi stud from kernel/contracts/seal.d.ts plus the calls the inference door and the gateway need.
// Plaintext crosses here once (put, as the person types it) and on a human reveal (it is passed through to the reveal view and never kept).
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { chainCtx } from "./wire.js";

const PROCESS = path.join(path.dirname(fileURLToPath(import.meta.url)), "process.js");

export class SealError extends Error { constructor(code) { super(code); this.code = code; } }

/** @param {{ dir: string, sinks?: Record<string,string>, timeoutMs?: number, execPath?: string }} o */
export function startSealer({ dir, sinks = {}, timeoutMs = 20_000, execPath = process.execPath }) {
  const child = spawn(execPath, [PROCESS], { stdio: ["pipe", "pipe", "inherit"], env: { VYRE_SEAL_DIR: dir, VYRE_SEAL_SINKS: JSON.stringify(sinks), PATH: process.env.PATH || "" } });
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
    endSession: session => call("session.end", { session }),
    lookup: i => withCtx("lookup", i, { class: i.class, field: i.field, value: i.value }),
    drop: i => withCtx("drop", i, { ref: i.ref }),
    enrol: d => call("presence.enrol", d), revoke: key_id => call("presence.revoke", { key_id }),
    health: () => call("health"),
    close: () => new Promise(res => { if (closed) return res(); child.once("exit", () => res()); child.stdin.end(); setTimeout(() => child.kill(), 2000).unref(); }),
  };
}
