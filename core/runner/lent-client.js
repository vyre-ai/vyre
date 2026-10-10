// @ts-check
// The lender's end of the lent-computer wire (team/archive/work-journals/runner.md): the runner's three ports over the kernel's remote call. `invoke(call, args)` is the kernel remote client's
// transport (kernel/remote/client.js: Wink, the relay, or the in-memory stand-in in tests); the chain never leaves this computer, the home reads who is calling from the transport.
// Nothing here writes a key or a secret to disk. Files cross in numbered base64 chunks, transcripts in batches that fit one request.
import crypto from "node:crypto";
import { CHUNK_BYTES } from "./lent-home.js";
import { RUNNER_PROTOCOL, runnerVersion } from "./protocol.js";

const BATCH_BYTES = 120 * 1024;

/**
 * @param {{ invoke: (call: string, args: any[]) => Promise<any>, device: string, deviceKey: string, eid?: string, cap?: () => ("provider" | "internet" | undefined) }} o
 *   eid: this computer's identity-list entry, the device whose presence key signs the lease request; with it the request carries a signed hello (device, key, limit, runner version, protocol)
 */
export function createLentClient(o) {
  let lease = "";
  // The epoch the home gave each session when it was lent: every write names it, so a session the server took back cannot be written by this computer any more. A write the home refuses as moved (or as
  // unknown, after a restart without it) tells the runner to stop that session here (`onFenced`): what it does next belongs to the server.
  /** @type {Map<string, number>} */ const epochs = new Map();
  /** @type {Set<(session: string) => void>} */ const fencedFns = new Set();
  const fence = (/** @type {string} */ session, /** @type {any} */ e) => { if (e && (e.code === "conflict" || e.code === "not_found")) { epochs.delete(session); for (const fn of fencedFns) { try { fn(session); } catch { /* the runner's own */ } } } };
  const write = async (/** @type {string} */ session, /** @type {() => Promise<any>} */ f) => { try { return await f(); } catch (e) { fence(session, e); throw e; } };
  const sync = {
    async appendTranscript(session, entries) {
      let acked = 0, batch = [], size = 0;
      const flush = async () => { if (batch.length) { const b = batch; acked = (await write(session, () => o.invoke("lent.appendTranscript", [session, b, epochs.get(session)]))).acked; batch = []; size = 0; } };
      for (const e of entries) { const n = Buffer.byteLength(e.line) + 40; if (size + n > BATCH_BYTES) await flush(); batch.push(e); size += n; }
      await flush();
      return { acked };
    },
    getTranscript: async (session, from, limit) => {
      // The answer is capped by the wire, so a long transcript is read in pages.
      if (limit) return o.invoke("lent.getTranscript", [session, from, limit]);
      const out = []; let at = from || 1;
      for (;;) { const page = await o.invoke("lent.getTranscript", [session, at, 500]); out.push(...page); if (page.length < 500) return out; at = page[page.length - 1].seq + 1; }
    },
    async putFile(session, rel, bytes) {
      if (bytes === null) return write(session, () => o.invoke("lent.putFile", [session, rel, { deleted: true, epoch: epochs.get(session) }]));
      const b = Buffer.from(bytes), upload = crypto.randomBytes(12).toString("base64url"), total = Math.max(1, Math.ceil(b.length / CHUNK_BYTES));
      let r;
      for (let i = 0; i < total; i++) r = await write(session, () => o.invoke("lent.putFile", [session, rel, { upload, index: i, total, epoch: epochs.get(session), b64: b.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).toString("base64") }]));
      return r;
    },
    async getFile(session, rel, version) {
      const parts = []; let offset = 0, size = Infinity;
      while (offset < size) { const r = await o.invoke("lent.getFile", [session, rel, version, { offset, len: CHUNK_BYTES }]); size = r.size; const b = Buffer.from(r.b64, "base64"); parts.push(b); offset += b.length; if (!b.length) break; }
      return new Uint8Array(Buffer.concat(parts));
    },
    putCheckpoint: (session, cp) => write(session, () => o.invoke("lent.putCheckpoint", [session, cp, epochs.get(session)])),
    getCheckpoint: session => o.invoke("lent.getCheckpoint", [session]),
  };
  return {
    /** The id the Space's home gives this computer (from what the transport proved): the Offers are made for it. */
    whoami: () => o.invoke("lent.whoami", []),
    sync,
    vault: {
      lease: async () => {
        // The hello names exactly what the lease is for; the home asks this computer's own presence key to sign it (the remote call answers the challenge) and refuses a request that is not.
        const cap = o.cap ? o.cap() : undefined;
        const hello = o.eid ? { device: o.device, device_key: o.deviceKey, eid: o.eid, cap: cap || null, runner_version: runnerVersion(), protocol: RUNNER_PROTOCOL } : undefined;
        const r = await o.invoke("leases.issue", [{ device: o.device, device_key: o.deviceKey, ...(hello ? { hello } : {}) }]);
        if (r && r.id) lease = r.id; return r;
      },
      renew: ({ id }) => o.invoke("leases.renew", [{ id }]),
      credential: req => o.invoke("leases.use", [{ session: req.session, route: req.route, method: req.method, path: req.path }]),
    },
    /** The Space's definition of the session, written at the home with the lender's cap already applied. */
    spec: async ({ session, chat, cap }) => {
      const r = await o.invoke("lent.start", [{ session, lease, device_key: o.deviceKey, ...(chat ? { chat } : {}), ...(cap ? { cap } : {}) }]);
      if (r && Number.isInteger(r.epoch)) epochs.set(session, r.epoch);
      return r;
    },
    stop: session => o.invoke("lent.stop", [{ session }]).finally(() => { epochs.delete(session); }),
    /** The epoch the home gave this session, or undefined when it is not lent from here. */
    epochOf: session => epochs.get(session),
    /** The heartbeat: this computer's sessions with their epochs and use, and whether nothing holds them back now. The answer lists the sessions the home no longer has at that epoch (stopped here), what it offers back and what it wants done. */
    beat: async ({ sessions, well }) => {
      const r = await o.invoke("lent.beat", [{ sessions, ...(well === true ? { well: true } : {}) }]);
      if (r && Array.isArray(r.fenced)) for (const s of r.fenced) fence(s, { code: "conflict" });
      return r;
    },
    /** Hand a session to the server after its final checkpoint. */
    release: async ({ session, reason }) => { const r = await o.invoke("lent.release", [{ session, epoch: epochs.get(session), reason }]); if (r && r.moved) epochs.delete(session); return r; },
    /** Told when the home fences a session of this computer. */
    onFenced: fn => { fencedFns.add(fn); return () => { fencedFns.delete(fn); }; },
  };
}
