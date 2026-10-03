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

const deepFreeze = (/** @type {any} */ o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const WINDOW = Object.freeze({ events: 2000, bytes: 4 * 1024 * 1024 });
const BATCH = 500;

/**
 * @param {{ space: string, clock?: () => number, rand?: (n: number) => Uint8Array,
 *   initial?: { count?: number, head?: string, window?: any[], salts?: [number, string][], cursors?: [string, number][], events?: any[] },
 *   persist?: { append(e: any, salt: string): number | void, erase(seq: number, e: any): void, cursor(name: string, seq: number): void,
 *     get?(seq: number): { event: any, salt: string | null } | null, range?(q: { after: number, before?: number, filter?: any, limit: number }): any[], latest?(subject: string, before: number): any },
 *   window?: { events?: number, bytes?: number } }} cfg
 *   Without `persist` the whole log is kept (the reference log). With it (kernel/store/sqlite-log.js) the log is durable and BOUNDED in memory: only a recent window of events
 *   (by count and by bytes) is kept, an older event is read back from the database when asked for, and a full scan walks the log in batches (`iterate`) instead of holding it.
 *   `initial` is the state a durable log starts from: how many events there are, the hash of the last, the recent window, its salts and the consumers' cursors.
 */
export function createEventLog(cfg) {
  const clock = cfg.clock || Date.now;
  const rand = cfg.rand || (n => randomBytes(n));
  const durable = Boolean(cfg.persist && cfg.persist.get && cfg.persist.range);
  const limits = { events: cfg.window?.events ?? WINDOW.events, bytes: cfg.window?.bytes ?? WINDOW.bytes };
  /** @type {any[]} the events kept in memory: the whole log for the reference log, the recent window for a durable one */ const log = [];
  /** @type {number[]} the size of each kept event on disk, to bound the window by bytes */ const sizes = [];
  let weight = 0;
  /** @type {Map<number, string>} the salt kept beside the data, erased with it (the window's; older ones are on disk) */ const salts = new Map();
  let count = 0, headHash = genesis(cfg.space);
  if (cfg.initial) {
    const w = cfg.initial.window || cfg.initial.events || [];
    for (const e of w) { log.push(deepFreeze(e)); sizes.push(0); }
    for (const [s, v] of cfg.initial.salts || []) salts.set(s, v);
    count = cfg.initial.count ?? (w.length ? w[w.length - 1].seq : 0);
    headHash = cfg.initial.head ?? (w.length ? w[w.length - 1].hash : headHash);
  }
  /** The seq of the first event kept in memory (everything before it is on disk). */
  const base = () => (log.length ? log[0].seq : count + 1);
  /** @type {Map<string, { filter: any, cursor: number, onEvent: any, busy: boolean, fails?: { seq: number, n: number } }>} */ const consumers = new Map();

  /** One event by seq: from the window, else from the database. */
  function get(/** @type {number} */ seq) {
    if (!Number.isInteger(seq) || seq < 1 || seq > count) return null;
    if (seq >= base()) return log[seq - base()] || null;
    const r = cfg.persist && cfg.persist.get ? cfg.persist.get(seq) : null;
    return r ? deepFreeze(r.event) : null;
  }

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
    const seq = count + 1;
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
      prev: headHash,
    };
    e.hash = hashOf(e);
    deepFreeze(e);
    const size = (cfg.persist && cfg.persist.append(e, salt)) || 0;
    log.push(e); sizes.push(size || 0); weight += size || 0;
    count = seq; headHash = e.hash;
    salts.set(seq, salt);
    // The window is bounded (a durable log only): the oldest events leave memory, and stay on disk.
    if (durable) while (log.length > 1 && (log.length > limits.events || weight > limits.bytes)) { const old = log.shift(); weight -= sizes.shift() || 0; salts.delete(old.seq); }
    queueMicrotask(pump);
    return e;
  }


  const matches = (/** @type {any} */ filter, /** @type {any} */ e) => {
    if (filter.since !== undefined && e.seq <= filter.since) return false;
    if (!typeMatches(filter.type, e.type)) return false;
    if (filter.subject_prefix && !(e.subject === filter.subject_prefix || e.subject.startsWith(filter.subject_prefix.replace(/\/$/, "") + "/"))) return false;
    if (filter.corr && e.corr !== filter.corr) return false;
    if (filter.actor && e.actor !== filter.actor) return false;
    if (filter.ref && !(e.data && e.data.id === filter.ref)) return false;
    return true;
  };

  /**
   * Walk the log in order, oldest first, in batches: the part on disk first (the database does the filtering by indexed columns), then the window. It holds one batch, never the
   * log, so a rebuild, an audit or a chain check over a million events needs no more memory than over a hundred. `limit` stops it; `since` starts after a seq.
   * @param {any} [filter] @param {{ from?: number }} [o]
   * @returns {Generator<any, void, undefined>}
   */
  function* iterate(filter = {}, o = {}) {
    let after = Math.max(filter.since ?? 0, o.from ?? 0);
    let given = 0;
    const cap = filter.limit || Infinity;
    const first = base();
    if (durable && after < first - 1) {
      while (after < first - 1) {
        const rows = /** @type {any} */ (cfg.persist).range({ after, before: first, filter, limit: BATCH });
        if (!rows.length) { after = first - 1; break; }
        for (const raw of rows) { yield deepFreeze(raw); if (++given >= cap) return; }
        after = rows[rows.length - 1].seq;
      }
    }
    for (let i = 0; i < log.length; i++) {
      const e = log[i];
      if (e.seq <= after || !matches(filter, e)) continue;
      yield e;
      if (++given >= cap) return;
    }
  }

  /**
   * The newest event about one subject whose data carries a version hash (a record's last write), or undefined. On a durable log this is one indexed lookup, so the gateway
   * need not hold a version index for every record it has ever written.
   * @param {string} subject
   */
  function latestFor(subject) {
    for (let i = log.length - 1; i >= 0; i--) { const e = log[i]; if (e.subject === subject && e.data && typeof e.data.version_hash === "string") return e; }
    if (durable && base() > 1 && cfg.persist && cfg.persist.latest) { const raw = cfg.persist.latest(subject, base()); return raw ? deepFreeze(raw) : undefined; }
    return undefined;
  }

  /** Raw read, no permission check: the gateway authorizes `events.read` and filters by `vis` before calling this. Holds the matches: a scan of the whole log uses `iterate`. */
  function read(/** @type {any} */ filter = {}) { return [...iterate(filter)]; }

  /**
   * Walk the chain and say whether it holds. By default from the genesis; `{ from, prev }` starts after the event `from` whose hash is `prev` (a checkpoint the caller already
   * trusts), so a restart checks only what was written since. Returns { ok: true, head, seq } or { ok: false, at, why }.
   * @param {{ from?: number, prev?: string }} [o]
   */
  function verify(o = {}) {
    let prev = o.from ? o.prev : genesis(cfg.space);
    if (o.from && typeof prev !== "string") return { ok: false, at: o.from, why: "a start point needs the hash of the event before it" };
    let n = o.from || 0;
    for (const e of iterate({}, { from: o.from || 0 })) {
      n++;
      if (e.seq !== n) return { ok: false, at: e.seq, why: "seq is not contiguous" };
      if (e.prev !== prev) return { ok: false, at: e.seq, why: "prev does not match the event before" };
      if (hashOf(e) !== e.hash) return { ok: false, at: e.seq, why: "hash does not match the envelope" };
      prev = e.hash;
    }
    if (n !== count) return { ok: false, at: n + 1, why: "the log is shorter than it says" };
    return { ok: true, head: prev, seq: n };
  }

  /** Does the kept data (and salt) still match the commitment? False once erased. */
  function proves(/** @type {number} */ seq) {
    const e = get(seq);
    let s = salts.get(seq);
    if (s === undefined && cfg.persist && cfg.persist.get && seq < base()) { const r = cfg.persist.get(seq); s = r && r.salt ? r.salt : undefined; }
    return Boolean(e && s && e.data !== undefined && !e.__erased && sha256(s + canonical(e.data)) === e.commit);
  }

  /** Erase an event's data and its salt. The envelope, commit and hash stay, so the chain still verifies and no dictionary oracle is left. */
  function erase(/** @type {number} */ seq) {
    const e = get(seq);
    if (!e) throw new KernelError("not_found", "no such event");
    const erased = deepFreeze({ ...e, data: { erased: true } });
    if (cfg.persist) cfg.persist.erase(seq, erased);
    salts.delete(seq);
    if (seq >= base()) log[seq - base()] = erased;
  }

  /** At-least-once with a durable named cursor: a handler that throws is retried, never skipped. @returns {() => void} */
  function subscribe(/** @type {string} */ consumer, /** @type {any} */ filter, /** @type {(e: any) => any} */ onEvent) {
    const had = consumers.get(consumer);
    const c = { filter, cursor: had ? had.cursor : 0, onEvent, busy: false };
    consumers.set(consumer, c);
    queueMicrotask(pump);
    return () => { if (consumers.get(consumer) === c) consumers.delete(consumer); };
  }

  const cursors = new Map(cfg.initial ? cfg.initial.cursors || [] : []);
  /** @type {{ consumer: string, seq: number, at: number }[]} */ const dead = [];
  const MAX_ATTEMPTS = 8;
  const nextFor = (/** @type {any} */ c) => { for (const e of iterate({ since: c.cursor, ...(c.filter && c.filter.type ? { type: c.filter.type } : {}), limit: 1 })) return e; return undefined; };
  async function pump() {
    for (const [name, c] of consumers) {
      if (c.busy) continue;
      c.busy = true;
      try {
        for (;;) {
          const upto = count;
          const next = nextFor(c);
          if (!next) { c.cursor = Math.max(c.cursor, upto); break; }
          await c.onEvent(next);
          c.cursor = next.seq;
          cursors.set(name, c.cursor);
          if (cfg.persist) cfg.persist.cursor(name, c.cursor);
        }
      } catch {
        // The cursor did not move: retry the same event with a growing delay, and after MAX_ATTEMPTS set it aside (dead letter) so one
        // poison event cannot stall the consumer for ever (K1 item 9f).
        const next = nextFor(c);
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
    append, read, iterate, get, latestFor, verify, proves, erase, subscribe, pump,
    cursor: (/** @type {string} */ n) => (consumers.get(n) ? /** @type {any} */ (consumers.get(n)).cursor : cursors.get(n) ?? 0),
    latestSeq: () => count,
    deadLetters: () => [...dead],
    head: () => headHash,
    /** What is held in memory now: for the bound's tests and the load measurements. */
    durable,
    stats: () => ({ count, in_memory: log.length, bytes: weight, first_in_memory: base() }),
  });
}
