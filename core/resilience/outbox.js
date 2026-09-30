// @ts-check
// outbox: writes made while the box is out of reach are kept and delivered once
// (docs/adr/0029-resilience.md, R2).
//
// A surface puts every send, answer, approval, note and todo here first, with a key that stays
// the same across retries, and shows it at once as "sending". The outbox delivers entries in
// order. An entry leaves only on an answer from the tool itself: a result (delivered) or a
// refusal (refused, with its reason, which the surface shows beside it). A transport failure, a
// restarting box or a call still running keeps the entry and tries again later. vyred runs a
// repeated key once (core/modules/idempotency.js), so a retry after a lost answer is safe.
//
// Storage and the call are passed in, so the same code serves the Deck (IndexedDB), the CLI and
// the Capsule (a file) and the tests (memory). No Node imports.

import { backoff as makeBackoff } from "./backoff.js";

/** Codes that mean "not now", not "no". */
export const RETRY = new Set(["unreachable", "restarting", "timeout", "offline", "in_progress"]);

/**
 * @typedef {{ key: string, tool: string, input: any, at: number, tries: number, state: "sending"|"waiting"|"needs_presence" }} Entry
 * @typedef {{ load: () => Entry[] | Promise<Entry[]>, save: (entries: Entry[]) => void | Promise<void> }} Store
 * @typedef {(tool: string, input: any, key: string) => Promise<{ data?: any, error?: { code: string, message: string } }>} Call
 */

/** An outbox kept in memory only, for tests and for surfaces with nowhere durable to write. */
export function memoryStore() {
  let saved = /** @type {Entry[]} */ ([]);
  return { load: () => saved.map(e => ({ ...e })), save: (/** @type {Entry[]} */ es) => { saved = es.map(e => ({ ...e })); } };
}

/**
 * @param {{ store: Store, call: Call, onChange?: (o: { pending: Entry[], done?: { entry: Entry, data: any }, refused?: { entry: Entry, error: any } }) => void,
 *   newKey?: () => string, backoff?: ReturnType<typeof makeBackoff>, now?: () => number }} o
 */
export async function outbox({ store, call, onChange, newKey = () => globalThis.crypto.randomUUID(), backoff = makeBackoff(), now = Date.now }) {
  /** @type {Entry[]} */
  const pending = [...await store.load()];
  let running = /** @type {Promise<void>|null} */ (null);
  /** @type {any} */ let wait = null;
  let stopped = false;
  /** @type {Map<string, (r: any) => void>} */
  const waiters = new Map();

  const persist = () => store.save(pending);
  const tell = (/** @type {{ done?: { entry: Entry, data: any }, refused?: { entry: Entry, error: any } }} */ extra = {}) => onChange?.({ pending: pending.map(e => ({ ...e })), ...extra });

  async function drain() {
    clearTimeout(wait); wait = null;
    while (pending.length && !stopped) {
      const entry = pending[0];
      if (entry.state === "needs_presence") return;
      entry.state = "sending"; entry.tries++;
      const r = await call(entry.tool, entry.input, entry.key);
      if (r.error && RETRY.has(r.error.code)) {
        entry.state = "waiting";
        await persist(); tell();
        if (!stopped) wait = setTimeout(flush, backoff.delay());
        return;
      }
      if (r.error && r.error.code === "presence_required") {
        // An approval that needs the person again. It stays first in line; the surface asks for
        // presence and calls retry().
        entry.state = "needs_presence";
        await persist(); tell();
        return;
      }
      pending.shift();
      backoff.reset();
      await persist();
      tell(r.error ? { refused: { entry, error: r.error } } : { done: { entry, data: r.data } });
      waiters.get(entry.key)?.(r); waiters.delete(entry.key);
    }
  }

  function flush() {
    if (!running) running = drain().finally(() => { running = null; });
    return running;
  }

  if (pending.length) flush();
  return {
    /**
     * Queue a write and start delivering. Resolves with the tool's answer whenever it comes
     * (after a restart of the surface, the answer arrives through onChange instead).
     * @param {string} tool @param {any} input @param {{ key?: string }} [o]
     */
    async add(tool, input, { key = newKey() } = {}) {
      /** @type {Entry} */
      const entry = { key, tool, input, at: now(), tries: 0, state: "sending" };
      const answered = new Promise(r => waiters.set(key, r));
      pending.push(entry);
      await persist(); tell();
      flush();
      return { key, answered };
    },
    /** The box is back, the network changed, or the person proved presence: try now. */
    retry() {
      for (const e of pending) if (e.state !== "sending") e.state = "waiting";
      backoff.reset();
      return flush();
    },
    /** The network came back or the app is in front again: try now, but do not ask for presence again. */
    kick() {
      backoff.reset();
      return flush();
    },
    get pending() { return pending.map(e => ({ ...e })); },
    stop() { stopped = true; clearTimeout(wait); },
  };
}
