// @ts-check
// The Personal to My Cloud upgrade, memory's part (windows' spaces.upgrade.*): the person's sealed memory (the identity home, the Personal backup and the encrypted personal records, all ciphertext) is carried
// object by object to their per-member storage on the My Cloud server, keys unchanged, each object hash-checked after it lands. Nothing is decrypted and nothing is re-keyed: the same device keys and the same recovery
// code open it there. A re-run is safe: an object already there with the same bytes is skipped, a different one is a conflict and stops that object (reported by name).
import { sha256Hex } from "../../lib/databox.js";

/** @param {string} identity */
export const prefixesOf = identity => [`identity/${identity}`, `backup/${identity}`, `personal/${identity}`];

/** Every object under a prefix of a (folder-like) backend, recursively. @param {{ list(p: string): any, get(n: string): any }} backend @param {string} prefix @returns {string[]} */
export function objectsUnder(backend, prefix) {
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ p, /** @type {number} */ depth) => {
    for (const n of backend.list(p)) {
      const b = backend.get(n);
      if (b) out.push(n); else if (depth < 6) walk(n, depth + 1);
    }
  };
  walk(prefix, 0);
  return out.sort();
}

/**
 * What would move, read only: small and stable numbers (they go into the hash the person approves) and anything that would stop the upgrade before it starts.
 * @param {{ list(p: string): any, get(n: string): any } | null} backend @param {string} identity @param {{ unsaved?: () => boolean }} [o]
 * @returns {{ counts: { objects: number, bytes: number }, blockers: string[] }}
 */
export function planOf(backend, identity, o = {}) {
  if (!backend) return { counts: { objects: 0, bytes: 0 }, blockers: [] };
  let objects = 0, bytes = 0;
  for (const p of prefixesOf(identity)) for (const n of objectsUnder(backend, p)) { objects++; bytes += (backend.get(n) || []).length; }
  return { counts: { objects, bytes }, blockers: o.unsaved && o.unsaved() ? ["the identity memory has facts not yet sealed: they are sealed first, then it can move"] : [] };
}

/**
 * Copy every object to the server's storage and check it there.
 * @param {{ list(p: string): any, get(n: string): any }} backend
 * @param {{ get(name: string): Promise<Uint8Array|null>, put(name: string, bytes: Uint8Array, o: { ifMatch: string|null }): Promise<{ ok: boolean }> }} transport
 * @param {string} identity
 * @returns {Promise<{ objects: number, bytes: number, skipped: number, failed: { name: string, why: string }[] }>}
 */
export async function carry(backend, transport, identity) {
  let objects = 0, bytes = 0, skipped = 0;
  /** @type {{ name: string, why: string }[]} */ const failed = [];
  for (const p of prefixesOf(identity)) {
    for (const name of objectsUnder(backend, p)) {
      const data = backend.get(name);
      const want = sha256Hex(data);
      try {
        const r = await transport.put(name, data, { ifMatch: null });
        if (!r.ok) {
          const there = await transport.get(name);
          if (there && sha256Hex(there) === want) { skipped++; continue; }
          failed.push({ name, why: "a different object is already there" }); continue;
        }
        const back = await transport.get(name);
        if (!back || sha256Hex(back) !== want) { failed.push({ name, why: "it did not match after copying" }); continue; }
        objects++; bytes += data.length;
      } catch (e) { failed.push({ name, why: String(/** @type {Error} */ (e).message) }); }
    }
  }
  return { objects, bytes, skipped, failed };
}
