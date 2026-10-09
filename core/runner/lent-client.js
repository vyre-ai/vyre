// @ts-check
// The lender's end of the lent-computer wire (team/archive/work-journals/runner.md): the runner's three ports over the kernel's remote call. `invoke(call, args)` is the kernel remote client's
// transport (kernel/remote/client.js: Wink, the relay, or the in-memory stand-in in tests); the chain never leaves this computer, the home reads who is calling from the transport.
// Nothing here writes a key or a secret to disk. Files cross in numbered base64 chunks, transcripts in batches that fit one request.
import crypto from "node:crypto";
import { CHUNK_BYTES } from "./lent-home.js";

const BATCH_BYTES = 120 * 1024;

/**
 * @param {{ invoke: (call: string, args: any[]) => Promise<any>, device: string, deviceKey: string }} o
 */
export function createLentClient(o) {
  let lease = "";
  const sync = {
    async appendTranscript(session, entries) {
      let acked = 0, batch = [], size = 0;
      const flush = async () => { if (batch.length) { acked = (await o.invoke("lent.appendTranscript", [session, batch])).acked; batch = []; size = 0; } };
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
      if (bytes === null) return o.invoke("lent.putFile", [session, rel, { deleted: true }]);
      const b = Buffer.from(bytes), upload = crypto.randomBytes(12).toString("base64url"), total = Math.max(1, Math.ceil(b.length / CHUNK_BYTES));
      let r;
      for (let i = 0; i < total; i++) r = await o.invoke("lent.putFile", [session, rel, { upload, index: i, total, b64: b.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).toString("base64") }]);
      return r;
    },
    async getFile(session, rel, version) {
      const parts = []; let offset = 0, size = Infinity;
      while (offset < size) { const r = await o.invoke("lent.getFile", [session, rel, version, { offset, len: CHUNK_BYTES }]); size = r.size; const b = Buffer.from(r.b64, "base64"); parts.push(b); offset += b.length; if (!b.length) break; }
      return new Uint8Array(Buffer.concat(parts));
    },
    putCheckpoint: (session, cp) => o.invoke("lent.putCheckpoint", [session, cp]),
    getCheckpoint: session => o.invoke("lent.getCheckpoint", [session]),
  };
  return {
    /** The id the Space's home gives this computer (from what the transport proved): the Offers are made for it. */
    whoami: () => o.invoke("lent.whoami", []),
    sync,
    vault: {
      lease: async () => { const r = await o.invoke("leases.issue", [{ device: o.device, device_key: o.deviceKey }]); if (r && r.id) lease = r.id; return r; },
      renew: ({ id }) => o.invoke("leases.renew", [{ id }]),
      credential: req => o.invoke("leases.use", [{ session: req.session, route: req.route, method: req.method, path: req.path }]),
    },
    /** The Space's definition of the session, written at the home with the lender's cap already applied. */
    spec: ({ session, chat, cap }) => o.invoke("lent.start", [{ session, lease, device_key: o.deviceKey, ...(chat ? { chat } : {}), ...(cap ? { cap } : {}) }]),
    stop: session => o.invoke("lent.stop", [{ session }]),
  };
}
