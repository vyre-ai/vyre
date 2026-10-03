// kernel/seal/ledger.js: the seal ledger, held at the inference door. Per session (and every session derived from it): keyed hashes of
// every value the session resolved or revealed, in every form normalise.js knows. Never plaintext; the key lives in memory only and the
// ledger ends with the session. The door refuses any prompt that contains a ledgered value (invariant 6).
import crypto from "node:crypto";
import { compact, b64stream, keyed } from "./normalise.js";

/** Most windows hashed for one prompt. Beyond this the door refuses (fail closed) rather than skip the check. */
export const MAX_WINDOWS = 400_000;

export class Ledger {
  /** @param {Buffer} [key] @param {Ledger} [parent] a derived session shares its parent's entries */
  constructor(key = crypto.randomBytes(32), parent = null) { this.key = key; this.parent = parent; this.by = { a: new Map(), b: new Map() }; }
  /** Entries from the sealing process (ledgerEntries), computed with this ledger's key. */
  add(entries) { for (const e of entries) { const m = this.by[e.s], k = e.len; if (!m.has(k)) m.set(k, new Map()); m.get(k).set(e.h, e.class); } return this; }
  get size() { return this.by.a.size + this.by.b.size + (this.parent ? this.parent.size : 0); }
  /** Every ledger from the root down to this one, the same key space only if keys match: a child is made with the parent's key. */
  *chain() { for (let l = this; l; l = l.parent) yield l; }
  /** @returns {null | { hit: string } | { too_big: true }} the class of a ledgered value found in `text`, or null */
  check(text) {
    const streams = { a: compact(text), b: b64stream(text) }, lens = { a: new Set(), b: new Set() };
    for (const l of this.chain()) for (const s of ["a", "b"]) for (const len of l.by[s].keys()) lens[s].add(len);
    let n = 0;
    for (const s of ["a", "b"]) for (const len of lens[s]) n += Math.max(0, streams[s].length - len + 1);
    if (n > MAX_WINDOWS) return { too_big: true };
    for (const s of ["a", "b"]) for (const len of lens[s]) for (let i = 0; i + len <= streams[s].length; i++) {
      const h = keyed(this.key, streams[s].slice(i, i + len));
      for (const l of this.chain()) { const c = l.by[s].get(len)?.get(h); if (c) return { hit: c }; }
    }
    return null;
  }
  /** A session derived from this one: it starts with everything this ledger knows, under the same key. */
  derive() { return new Ledger(this.key, this); }
}
