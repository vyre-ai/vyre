// kernel/core/events.js: the event envelope and an in-memory hash-chained log (contract 7; invariant 7).
// The envelope is built only here, from a kernel chain: the actor, chain, trust, source Spaces and class come from
// the chain, never from the caller. `commit` is a salted commitment to the data, `hash` covers the envelope with the
// data replaced by the commit, and `prev` links it to the one before, so erasing data leaves the chain verifiable.
// Durable storage is K2's store interface; this is the reference log it must match.
import { randomBytes } from "node:crypto";
import { canonical, sha256 } from "./canonical.js";
import { mintUuid } from "./ids.js";
import { isChain, actorString, mergeLabels } from "./chain.js";
import { segments, spaceOf } from "./urn.js";
import { REDACTION_ORDER } from "../contracts/index.js";
import { KernelError } from "./errors.js";

const okVis = (/** @type {any} */ v) => ["space", "actor", "subject", "owner"].includes(v) || (typeof v === "string" && /^members:.+/.test(v));
const TYPE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
export const genesis = (/** @type {string} */ space) => sha256(`vyre-genesis:${space}`);

/** The envelope's hash input: everything but `data` (replaced by `commit`, already present), `hash` and `sig`. */
export function hashOf(/** @type {any} */ e) {
  const { data: _d, hash: _h, sig: _s, ...rest } = e;
  return sha256(canonical(rest));
}

/** Does an event type match a filter (`*`, `noun.*`, or exact)? */
export const typeMatches = (/** @type {string | undefined} */ filter, /** @type {string} */ type) =>
  !filter || filter === "*" || filter === type || (filter.endsWith(".*") && type.startsWith(filter.slice(0, -1)));

/** Check any list of events (read back from a store, or received from another node) against the hash chain. */
export function verifyEvents(/** @type {string} */ space, /** @type {readonly any[]} */ list) {
  let prev = genesis(space);
  let n = 0;
  for (const e of list) {
    n++;
    if (e.seq !== n) return { ok: false, at: e.seq, why: "seq is not contiguous" };
    if (e.prev !== prev) return { ok: false, at: e.seq, why: "prev does not match the event before" };
    if (hashOf(e) !== e.hash) return { ok: false, at: e.seq, why: "hash does not match the envelope" };
    prev = e.hash;
  }
  return { ok: true, head: prev, seq: n };
}

const deepFreezeEarly = (/** @type {any} */ o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreezeEarly(v); } return o; };

/**
 * @param {{ space: string, clock?: () => number, rand?: (n: number) => Uint8Array,
 *   initial?: { events: any[], salts: [number, string][], cursors: [string, number][] },
 *   persist?: { append(e: any, salt: string): void, erase(seq: number, e: any): void, cursor(name: string, seq: number): void } }} cfg
 *   initial and persist make the log durable (kernel/store/sqlite-log.js): the history it starts from, and a write-through done BEFORE the event is
 *   taken as appended, so an event that could not be written is not in the log.
 */
export function createEventLog(cfg) {
  const clock = cfg.clock || Date.now;
  const rand = cfg.rand || (n => randomBytes(n));
  /** @type {any[]} */ const log = [];
  /** @type {Map<number, string>} the salt kept beside the data, erased with it */ const salts = new Map();
  if (cfg.initial) { log.push(...cfg.initial.events.map((/** @type {any} */ e) => deepFreezeEarly(e))); for (const [s, v] of cfg.initial.salts) salts.set(s, v); }
  /** @type {Map<string, { filter: any, cursor: number, onEvent: any, busy: boolean, fails?: { seq: number, n: number } }>} */ const consumers = new Map();

  /**
   * Append one event. `chain` must be kernel-built; `ev` is a NewEvent. Throws a KernelError for a refusal.
   * @param {any} chain @param {any} ev @param {{ decision?: string, time?: number, via?: any }} [opts]
   */
  function append(chain, ev, opts = {}) {
    if (!isChain(chain)) throw new KernelError("bad_input", "an event needs a kernel-built chain");
    if (chain.space !== cfg.space) throw new KernelError("wrong_space", "event for another space");
    if (!ev || typeof ev.type !== "string" || !TYPE.test(ev.type)) throw new KernelError("bad_input", "event type must be noun.past-verb");
    if (!segments(ev.subject) || spaceOf(ev.subject) !== cfg.space) throw new KernelError("wrong_space", "subject is not in this space");
    if (!Number.isInteger(ev.sv) || ev.sv < 1) throw new KernelError("bad_input", "event needs a schema version");
    // A class or visibility outside the registries is refused, never read as the lowest (invariants 5, 7).
    if (ev.red !== undefined && !REDACTION_ORDER.includes(ev.red)) throw new KernelError("bad_input", "unknown event class");
    if (ev.vis !== undefined && !okVis(ev.vis)) throw new KernelError("bad_input", "unknown event visibility");
    const labels = mergeLabels(chain.labels, { trust: chain.labels.trust, red: ev.red || "internal", source_spaces: [] });
    // A secret is never stored: the write is refused, not redacted (7.5).
    if (labels.red === "secret") throw new KernelError("secret_refused", "a secret is never written to the log");
    const last = chain.hops[chain.hops.length - 1];
    const salt = Buffer.from(rand(16)).toString("base64url");
    const seq = log.length + 1;
    const now = clock();
    /** @type {any} */
    const e = {
      v: 1, id: mintUuid(now, rand), seq, space: cfg.space, type: ev.type, sv: ev.sv,
      time: opts.time ?? now, received_at: now,
      actor: actorString(last.actor), chain: chain.hops,
      ...(last.via ? { via: last.via } : {}),
      subject: ev.subject,
      ...(ev.cause ? { cause: ev.cause } : opts.decision ? { cause: opts.decision } : {}),
      // Under a Flow run (a job chain) every event carries the run id as its correlation, so a run's effects are found by it.
      ...(ev.corr ? { corr: ev.corr } : chain.job ? { corr: chain.job } : {}),
      ...(ev.prov || opts.decision ? { prov: { ...(ev.prov || {}), ...(opts.decision ? { decision: opts.decision } : {}) } } : {}),
      trust: labels.trust, source_spaces: labels.source_spaces,
      vis: ev.vis || "space", red: labels.red,
      data: ev.data === undefined ? null : ev.data,
      commit: sha256(salt + canonical(ev.data === undefined ? null : ev.data)),
      prev: seq === 1 ? genesis(cfg.space) : log[seq - 2].hash,
    };
    e.hash = hashOf(e);
    deepFreeze(e);
    if (cfg.persist) cfg.persist.append(e, salt);
    log.push(e);
    salts.set(seq, salt);
    queueMicrotask(pump);
    return e;
  }

  const deepFreeze = (/** @type {any} */ o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

  /** Raw read, no permission check: the gateway authorizes `events.read` and filters by `vis` before calling this. */
  function read(/** @type {any} */ filter = {}) {
    const out = [];
    for (const e of log) {
      if (filter.since !== undefined && e.seq <= filter.since) continue;
      if (!typeMatches(filter.type, e.type)) continue;
      if (filter.subject_prefix && !(e.subject === filter.subject_prefix || e.subject.startsWith(filter.subject_prefix.replace(/\/$/, "") + "/"))) continue;
      if (filter.corr && e.corr !== filter.corr) continue;
      if (filter.actor && e.actor !== filter.actor) continue;
      out.push(e);
      if (filter.limit && out.length >= filter.limit) break;
    }
    return out;
  }

  /** Walk the chain from the genesis. Returns { ok: true, head } or { ok: false, at, why }. */
  const verify = () => verifyEvents(cfg.space, log);

  /** Does the kept data (and salt) still match the commitment? False once erased. */
  function proves(/** @type {number} */ seq) {
    const e = log[seq - 1], s = salts.get(seq);
    return Boolean(e && s && e.data !== undefined && !e.__erased && sha256(s + canonical(e.data)) === e.commit);
  }

  /** Erase an event's data and its salt. The envelope, commit and hash stay, so the chain still verifies and no dictionary oracle is left. */
  function erase(/** @type {number} */ seq) {
    const e = log[seq - 1];
    if (!e) throw new KernelError("not_found", "no such event");
    const erased = deepFreeze({ ...e, data: { erased: true } });
    if (cfg.persist) cfg.persist.erase(seq, erased);
    salts.delete(seq);
    log[seq - 1] = erased;
  }

  /** At-least-once with a durable named cursor: a handler that throws is retried, never skipped. @returns {() => void} */
  function subscribe(/** @type {string} */ consumer, /** @type {any} */ filter, /** @type {(e: any) => any} */ onEvent) {
    const had = consumers.get(consumer);
    const c = { filter, cursor: had ? had.cursor : 0, onEvent, busy: false };
    consumers.set(consumer, c);
    queueMicrotask(pump);
    return () => { if (consumers.get(consumer) === c) consumers.delete(consumer); };
  }

  const cursors = new Map(cfg.initial ? cfg.initial.cursors : []);
  /** @type {{ consumer: string, seq: number, at: number }[]} */ const dead = [];
  const MAX_ATTEMPTS = 8;
  async function pump() {
    for (const [name, c] of consumers) {
      if (c.busy) continue;
      c.busy = true;
      try {
        for (;;) {
          const next = log.find(e => e.seq > c.cursor && typeMatches(c.filter && c.filter.type, e.type));
          const upto = log.length;
          if (!next) { c.cursor = Math.max(c.cursor, upto); break; }
          await c.onEvent(next);
          c.cursor = next.seq;
          cursors.set(name, c.cursor);
          if (cfg.persist) cfg.persist.cursor(name, c.cursor);
        }
      } catch {
        // The cursor did not move: retry the same event with a growing delay, and after MAX_ATTEMPTS set it aside (dead letter) so one
        // poison event cannot stall the consumer for ever (K1 item 9f).
        const next = log.find(e => e.seq > c.cursor && typeMatches(c.filter && c.filter.type, e.type));
        if (next) {
          c.fails = c.fails && c.fails.seq === next.seq ? { seq: next.seq, n: c.fails.n + 1 } : { seq: next.seq, n: 1 };
          if (c.fails.n >= MAX_ATTEMPTS) { dead.push({ consumer: name, seq: next.seq, at: clock() }); c.cursor = next.seq; cursors.set(name, c.cursor); c.fails = undefined; queueMicrotask(pump); }
          else setTimeout(pump, Math.min(100 * 2 ** c.fails.n, 30_000)).unref();
        }
      }
      finally { c.busy = false; }
    }
  }

  return Object.freeze({
    append, read, verify, proves, erase, subscribe, pump,
    cursor: (/** @type {string} */ n) => (consumers.get(n) ? /** @type {any} */ (consumers.get(n)).cursor : cursors.get(n) ?? 0),
    latestSeq: () => log.length,
    deadLetters: () => [...dead],
    head: () => (log.length ? log[log.length - 1].hash : genesis(cfg.space)),
  });
}
