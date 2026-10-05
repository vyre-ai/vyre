// @ts-check
// bus — the bus modules hear what happened on, over the kernel's log: there is one mechanism, the log.
//
// Events are facts about the past, named "<noun>.<past-verb>": watcher.fired, thread.started,
// gate.held. They are how modules built separately learn about each other without importing
// each other. A payload never carries a secret: the log is readable by every module and shown
// in the Deck, so anything that looks like a credential is refused at the door.

import { randomBytes } from "node:crypto";
import { createEventLog } from "./core/events.js";
import { createChainBuilder } from "./core/chain.js";
import { createKernelSeal } from "./core/seal.js";

const NAME = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

// A deliberately blunt check. It refuses the obvious shapes (key=value secrets, long tokens with
// known prefixes); the vault's own redactor is stricter and is what the vault module uses.
// A token prefix counts only at the start of a token (not inside a longer word or a random id, where "sk-" or "AKIA" turn up by chance: FL-1), and the prefixes are case-sensitive as the providers issue them.
const SECRET_PREFIX = /(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/;
const SECRET_SHAPE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|"(?:password|secret|token|api_?key)"\s*:\s*"[^"]{6,}"/i;
const LOOKS_SECRET = { test: (/** @type {string} */ json) => SECRET_PREFIX.test(json) || SECRET_SHAPE.test(json) };

/** Events one drain delivers before it stops (a loop of listeners emitting each other). */
export const DRAIN_CAP = 10_000;

export class Events {
  /** @param {any} [_db] unused: the log is the kernel's (kept so a caller that used to hand the store over still reads the same) */
  constructor(_db) {
    /** @type {Map<string, Set<(e: any) => void>>} */
    this.listeners = new Map();
    /** Events stored and not yet delivered to the listeners, and whether a delivery is running. @type {any[]} */
    this.queue = [];
    /** Where a dropped drain is said; the daemon sets it to its log. @type {(msg: string) => void} */
    this.log = () => {};
    this.delivering = false;
    // Until the daemon attaches the home's kernel log (what it does as soon as the kernel is up), the bus runs over a reference log of its own with the kernel's own chain builder.
    const B32 = "abcdefghijklmnopqrstuvwxyz234567", space = "spc_" + Array.from(randomBytes(12), b => B32[b & 31]).join("");
    const builder = createChainBuilder({ space, owner: "per_bus", owner_uid: 0, seal: createKernelSeal({ key: randomBytes(32) }), clock: Date.now, is_person: () => true });
    /** @type {{ log: any, chainFor: (name: string) => any, space: string }} */
    this.k = { log: createEventLog({ space }), chainFor: name => builder.fromFacts({ kind: "module", module: String(name), first_party: true }), space };
    this.lastId = 0;
  }

  /**
   * Make the home's kernel log the store: every event from now on is appended to it (its id is the log's sequence number, so a surface's cursor is a log position), `since` reads it, and what
   * was emitted before it was attached moves in, in order. Listeners are the same in-process bus as ever.
   * @param {any} log the kernel's event log @param {(name: string) => any} chainFor the kernel chain of a service by name @param {string} space
   */
  attach(log, chainFor, space) {
    const before = [...this.k.log.iterate({})];
    this.k = { log, chainFor, space };
    /** The newest bus event's position (the log also holds the kernel's own entries, which are not bus events): a surface that follows from here hears everything emitted after it. */
    this.lastId = log.latestSeq();
    for (const e of before) {
      const ev = Events.#fromLog(e);
      if (ev) { try { this.#append(ev.source, ev.type, ev.payload, { project: ev.project || undefined, thread: ev.thread || undefined, at: ev.at }); } catch { /* an event the log refuses is not carried over */ } }
    }
  }

  /** The subject an event is filed under in the log: its thread when it has one (an indexed read of one thread's history), else its source. @param {string} source @param {string | undefined} thread */
  #subject(source, thread) {
    const seg = (/** @type {string} */ x) => String(x).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 120) || "x";
    return thread ? `vyre://${this.k?.space}/thread/${seg(thread)}` : `vyre://${this.k?.space}/event/${seg(source)}`;
  }

  /** @returns {{ id: number, at: number, type: string, source: string, project: string | null, thread: string | null, payload: any }} */
  #append(/** @type {string} */ source, /** @type {string} */ type, /** @type {any} */ payload, /** @type {{ project?: string, thread?: string, at?: number }} */ where) {
    const k = /** @type {any} */ (this.k), at = where.at || Date.now();
    const e = k.log.append(k.chainFor(source), { type, sv: 1, subject: this.#subject(source, where.thread), data: { legacy: 1, source, at, project: where.project || null, thread: where.thread || null, payload }, vis: "owner", red: "internal" });
    this.lastId = Math.max(this.lastId || 0, e.seq);
    return { id: e.seq, at, type, source, project: where.project || null, thread: where.thread || null, payload };
  }

  /** One log entry as the bus's event, or null for an entry that is not a bus event (the kernel's own) or whose data was erased. @param {any} e */
  static #fromLog(e) {
    const d = e && e.data;
    if (!d || d.legacy !== 1) return null;
    return { id: e.seq, at: d.at, type: e.type, source: d.source, project: d.project, thread: d.thread, payload: d.payload };
  }

  /**
   * Record an event and tell whoever is listening. Returns the stored event.
   * @param {string} source the module emitting it
   * @param {string} type   "<noun>.<past-verb>"
   * @param {object} payload
   * @param {{ project?: string, thread?: string, at?: number }} [where]
   */
  emit(source, type, payload = {}, where = {}) {
    if (!NAME.test(type)) throw new Error(`event type "${type}" must look like noun.past-verb`);
    const json = JSON.stringify(payload);
    if (LOOKS_SECRET.test(json)) throw new Error(`event ${type} from ${source} carries something that looks like a secret; events are readable by every module`);
    const at = where.at || Date.now();
    const event = this.#append(source, type, payload, { ...where, at });
    // An event a listener emits while another is being delivered waits its turn: every listener hears events in id order, so a stream that
    // follows an id cursor (the SSE one) never meets 13 before 12 and drops the 12 (a model.switched the settings hub answered with its own
    // event was lost to every live Deck this way, #41).
    this.queue.push(event);
    if (this.delivering) return event;
    this.delivering = true;
    try {
      // One drain is bounded: listeners that answer each other (A emits B, B emits A) would otherwise spin the daemon for ever. The rest is dropped
      // from delivery (it stays stored) and the log names the types.
      let n = 0;
      for (let e; (e = this.queue.shift());) {
        if (++n > DRAIN_CAP) {
          const types = [...new Set([e, ...this.queue].map(x => x.type))].slice(0, 8).join(", ");
          this.queue.length = 0;
          this.log(`events: delivery stopped after ${DRAIN_CAP} events in one drain (listeners emitting each other?); dropped from delivery: ${types}`);
          break;
        }
        for (const key of [e.type, e.type.split(".")[0] + ".*", "*"]) {
          for (const fn of this.listeners.get(key) || []) {
            // A listener that throws must not stop the others or the emitter.
            try { fn(e); } catch {}
          }
        }
      }
    } finally { this.delivering = false; }
    return event;
  }

  /** Listen for "watcher.fired", "watcher.*" or "*". Returns a function that stops listening. */
  on(pattern, fn) {
    if (!this.listeners.has(pattern)) this.listeners.set(pattern, new Set());
    this.listeners.get(pattern).add(fn);
    return () => this.listeners.get(pattern)?.delete(fn);
  }

  /**
   * Delete events that another event has made redundant, such as a turn's partial text once its
   * whole text is stored. The log is otherwise append-only; this is the one exception, and it is
   * narrow: one type, at or before one id, optionally one source and thread, optionally only rows
   * whose payload has a given top-level key. Returns how many rows went.
   * @param {{ type: string, before: number, source?: string, thread?: string, has?: string }} o
   */
  prune({ type, before, source, thread, has }) {
    if (!NAME.test(String(type))) throw new Error(`event type "${type}" must look like noun.past-verb`);
    if (!Number.isInteger(before)) throw new Error("prune needs an event id to stop at");
    if (has !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(has)) throw new Error(`"${has}" is not a payload key`);
    {
      let n = 0;
      for (const e of [...this.k.log.iterate({ type })]) {
        if (e.seq > before) break;
        const ev = Events.#fromLog(e);
        if (!ev || (source !== undefined && ev.source !== source) || (thread !== undefined && ev.thread !== thread) || (has !== undefined && !(ev.payload && ev.payload[has] !== undefined && ev.payload[has] !== null))) continue;
        this.k.log.erase(e.seq); n++;
      }
      return n;
    }
  }

  /** The newest id handed out, or 0 on a fresh log. Counts pruned ids too: a cursor never goes back. */
  latestId() {
    return this.lastId || 0;
  }

  /**
   * Whether a surface resuming from `cursor` can be caught up by replay. A cursor past the newest
   * id (the box's log was reset, or the surface followed another box) cannot: the surface must
   * reload its state through tools and follow from `from` (ADR 0029, R1).
   * @param {number} cursor @returns {{ ok: true } | { ok: false, from: number }}
   */
  resumable(cursor) {
    const latest = this.latestId();
    return cursor > latest ? { ok: false, from: latest } : { ok: true };
  }

  /** Events after a cursor, oldest first. How a surface catches up after being away. */
  since(id = 0, { type = null, project = null, limit = 200 } = {}) {
    const out = [];
    for (const e of this.k.log.iterate({ since: id, ...(type ? { type } : {}) })) {
      const ev = Events.#fromLog(e);
      if (!ev || (project && ev.project !== project)) continue;
      out.push(ev);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * One thread's events, oldest first (an indexed read of the log by its subject): `types` keeps those types, `after` those with an id past it, `before` those below one,
   * `limit` the first that many, or with `tail` the last that many.
   * @param {string} thread @param {{ types?: string[], after?: number, before?: number, limit?: number, tail?: boolean }} [o]
   */
  ofThread(thread, { types, after = 0, before = Infinity, limit = Infinity, tail = false } = {}) {
    /** @type {any[]} */ const out = [];
    for (const e of this.k.log.iterate({ subject_prefix: this.#subject("x", thread), since: after })) {
      const ev = Events.#fromLog(e);
      if (ev && ev.thread === thread && ev.id < before && (!types || types.includes(ev.type))) out.push(ev);
    }
    return Number.isFinite(limit) ? (tail ? out.slice(-limit) : out.slice(0, limit)) : out;
  }
}
