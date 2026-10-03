// kernel/audit/index.js: K5, signed checkpoints on the hash-chained log (contract 7.8, T8; invariant 7). The log already links every event to the one
// before (kernel/core/events.js), so an edit or a deletion inside it is caught. What a chain alone cannot catch is a home that is rolled back to an
// older head, or that tells two devices two histories. So the home signs `{ space, seq, hash, time, key_id }` with the Space key every 1,000 events or
// 10 minutes and appends `checkpoint.signed`; each of the person's devices keeps the latest checkpoint it has seen and the home is held to it: a log
// that no longer contains the event a stored checkpoint names is rolled back or rewritten, and two devices comparing checkpoints expose a split.
// The signing key is the Space key, held by its owners: this module takes a `sign` function and a public key, never the private key itself.
import crypto from "node:crypto";
import { canonical, sha256 } from "../core/canonical.js";
import { verifyEvents } from "../core/events.js";
import { KernelError } from "../core/errors.js";

export const EVERY_EVENTS = 1000;
export const EVERY_MS = 10 * 60 * 1000;
const SUBJECT = (/** @type {string} */ space) => `vyre://${space}/audit/log`;

/** The bytes a checkpoint signature covers. @param {{ space: string, seq: number, hash: string, time: number, key_id: string }} c */
export const checkpointBytes = c => Buffer.from("vyre-checkpoint-v1\n" + canonical({ space: c.space, seq: c.seq, hash: c.hash, time: c.time, key_id: c.key_id }));

/** Is this checkpoint signed by this key? A bad signature or shape is false, never a throw. @param {any} cp @param {crypto.KeyObject | string} publicKey */
export function verifyCheckpoint(cp, publicKey) {
  try {
    if (!cp || typeof cp.signature !== "string" || !Number.isInteger(cp.seq) || cp.seq < 0 || typeof cp.hash !== "string" || typeof cp.space !== "string" || typeof cp.key_id !== "string") return false;
    const key = typeof publicKey === "string" ? crypto.createPublicKey(publicKey) : publicKey;
    return crypto.verify(null, checkpointBytes(cp), key, Buffer.from(cp.signature, "base64url"));
  } catch { return false; }
}

/** A signer over an Ed25519 private key: what a Space's owners' signer client provides. The kernel only calls `sign(bytes)`. @param {crypto.KeyObject} privateKey */
export const ed25519Signer = privateKey => (/** @type {Buffer} */ bytes) => crypto.sign(null, bytes, privateKey).toString("base64url");

/**
 * The home's side: sign and append checkpoints.
 * @param {{ publicKey?: crypto.KeyObject | string, space: string, log: any, chains: any, sign: (bytes: Buffer) => string | Promise<string>, key_id: string, clock?: () => number, every_events?: number, every_ms?: number }} cfg
 */
export function createCheckpointer(cfg) {
  const clock = cfg.clock || Date.now;
  const everyEvents = cfg.every_events ?? EVERY_EVENTS, everyMs = cfg.every_ms ?? EVERY_MS;
  let last = { seq: 0, time: clock() };
  let busy = false;
  const kernelChain = () => cfg.chains.fromFacts({ kind: "module", module: "audit", first_party: true });

  const api = {
    /** Sign the log's head now and append `checkpoint.signed`. The checkpoint covers the head BEFORE its own event, so it never names itself. */
    async sign() {
      const seq = cfg.log.latestSeq(), hash = cfg.log.head(), time = clock();
      const body = { space: cfg.space, seq, hash, time, key_id: cfg.key_id };
      const signature = await cfg.sign(checkpointBytes(body));
      const cp = Object.freeze({ ...body, signature });
      cfg.log.append(kernelChain(), { type: "checkpoint.signed", sv: 1, subject: SUBJECT(cfg.space), data: { checkpoint: cp }, vis: "space", red: "public" });
      last = { seq, time };
      return cp;
    },
    /** Sign when 1,000 events or 10 minutes have passed since the last checkpoint (and something happened). Called by a 60-second timer and after bursts. */
    async tick() {
      if (busy) return null;
      const seq = cfg.log.latestSeq(), now = clock();
      if (seq === last.seq || (seq - last.seq < everyEvents && now - last.time < everyMs)) return null;
      busy = true;
      try { return await api.sign(); } finally { busy = false; }
    },
    /** A 60-second timer (nothing runs faster), never keeping the process alive. @returns {() => void} */
    start() { const t = setInterval(() => { api.tick().catch(() => {}); }, 60_000); t.unref(); return () => clearInterval(t); },
    /** The latest checkpoint in the log that verifies under the Space's checkpoint key (`publicKey`); any chain may append that event type, so one that does not verify is skipped. */
    latest() {
      const l = cfg.log.read({ type: "checkpoint.signed" });
      for (let i = l.length - 1; i >= 0; i--) { const c = l[i].data && l[i].data.checkpoint; if (!cfg.publicKey || verifyCheckpoint(c, cfg.publicKey)) return c; }
      return null;
    },
  };
  return Object.freeze(api);
}

/**
 * Recompute the chain and check every checkpoint in it (`vyre audit verify`): the hash chain, each signature, and that the event a checkpoint names
 * is in the log with the hash it names. Problems are listed, not thrown.
 * @param {{ space: string, log: any, publicKey: crypto.KeyObject | string }} cfg
 */
export function verifyLog(cfg) {
  const all = cfg.log.read({});
  const chain = verifyEvents(cfg.space, all);
  /** @type {{ seq?: number, why: string }[]} */ const problems = [];
  if (!chain.ok) problems.push({ seq: chain.at, why: chain.why || "the hash chain is broken" });
  let prev = -1, n = 0;
  for (const e of all) {
    if (e.type !== "checkpoint.signed") continue;
    const cp = e.data && e.data.checkpoint;
    n++;
    if (!verifyCheckpoint(cp, cfg.publicKey)) { problems.push({ seq: e.seq, why: "a checkpoint's signature does not verify" }); continue; }
    if (cp.space !== cfg.space) problems.push({ seq: e.seq, why: "a checkpoint is for another Space" });
    if (cp.seq < prev) problems.push({ seq: e.seq, why: "checkpoints go backwards" });
    prev = Math.max(prev, cp.seq);
    const at = cp.seq === 0 ? null : all[cp.seq - 1];
    if (cp.seq > 0 && (!at || at.hash !== cp.hash)) problems.push({ seq: e.seq, why: "the event a checkpoint names is not in the log as signed" });
    if (cp.seq >= e.seq) problems.push({ seq: e.seq, why: "a checkpoint names an event at or after itself" });
  }
  return { ok: problems.length === 0, events: all.length, checkpoints: n, problems };
}

/**
 * The device's side: it keeps the latest checkpoint it has seen from the home, refuses a checkpoint that does not verify, and holds the home to what
 * it has seen. `held` is whatever durable store the device has (the device's own, never the home's).
 * @param {{ space: string, publicKey: crypto.KeyObject | string, held?: { get(): any, set(cp: any): void }, clock?: () => number, max_age_ms?: number }} cfg
 *   Staleness: a held checkpoint older than `max_age_ms` (three checkpoint intervals) by THIS device's clock at receipt means the home has stopped producing them
 *   (a rolled-back or silenced home looks exactly like that), and the device says so. `time` in a checkpoint is the home's own claim and is never used for this.
 */
export function createDeviceCheckpoints(cfg) {
  let mem = null, receivedAt = 0;
  const clock = cfg.clock || Date.now, maxAge = cfg.max_age_ms ?? 3 * EVERY_MS;
  /** @type {Set<string>} key ids an owner revoked: their checkpoints are no longer accepted */ const revoked = new Set();
  const held = cfg.held || { get: () => mem, set: (/** @type {any} */ c) => { mem = c; } };
  return Object.freeze({
    /** Take a checkpoint from the home. Newer and valid replaces the held one; older or invalid is refused. @returns {{ ok: boolean, why?: string }} */
    accept(/** @type {any} */ cp) {
      if (cp && revoked.has(cp.key_id)) return { ok: false, why: "key_revoked" };
      if (!verifyCheckpoint(cp, cfg.publicKey) || cp.space !== cfg.space) return { ok: false, why: "bad_signature" };
      const cur = held.get();
      if (cur && cp.seq < cur.seq) return { ok: false, why: "older_than_held" };
      if (cur && cp.seq === cur.seq && cp.hash !== cur.hash) return { ok: false, why: "split_history" };
      held.set(cp); receivedAt = clock();
      return { ok: true };
    },
    held: () => held.get(),
    /** An owner revoked the checkpoint key (kernel/audit/key.js `verifyRevocation` has checked it): nothing more is accepted from it. */
    revoke(/** @type {string} */ key_id) { revoked.add(key_id); },
    /** Has the home gone quiet? Judged by this device's clock since it last accepted a checkpoint. @returns {{ stale: boolean, age_ms: number | null }} */
    staleness() { return held.get() ? { stale: clock() - receivedAt > maxAge, age_ms: clock() - receivedAt } : { stale: true, age_ms: null }; },
    /**
     * Is the home's log still the history this device saw? A log shorter than the held checkpoint is a rollback; a log whose event at that
     * position has another hash is a rewrite or a split.
     * @param {{ latestSeq(): number, read(f?: any): any[] }} log @returns {{ ok: boolean, why?: string }}
     */
    check(log) {
      const cp = held.get();
      if (!cp) return { ok: true };
      if (log.latestSeq() < cp.seq) return { ok: false, why: "rolled_back" };
      if (cp.seq === 0) return { ok: true };
      const e = log.read({}).find((/** @type {any} */ x) => x.seq === cp.seq);
      return e && e.hash === cp.hash ? { ok: true } : { ok: false, why: "history_differs" };
    },
  });
}

/**
 * Two devices compare the checkpoints they hold. The same position with two hashes is a split (the home told them different histories); a checkpoint
 * that is valid for neither is refused. Two honest checkpoints at different positions cannot be told apart without a log, so with one they are checked
 * for inclusion.
 * @param {any} a @param {any} b @param {crypto.KeyObject | string} publicKey @param {{ read(f?: any): any[] }} [log]
 * @returns {{ ok: boolean, why?: string }}
 */
export function compareCheckpoints(a, b, publicKey, log) {
  if (!verifyCheckpoint(a, publicKey) || !verifyCheckpoint(b, publicKey)) return { ok: false, why: "bad_signature" };
  if (a.seq === b.seq) return a.hash === b.hash ? { ok: true } : { ok: false, why: "split_history" };
  if (!log) return { ok: true };
  const [lo, hi] = a.seq < b.seq ? [a, b] : [b, a];
  const e = log.read({}).find((/** @type {any} */ x) => x.seq === lo.seq);
  return e && e.hash === lo.hash && log.read({}).some((/** @type {any} */ x) => x.seq === hi.seq && x.hash === hi.hash) ? { ok: true } : { ok: false, why: "history_differs" };
}

export { sha256, KernelError };
