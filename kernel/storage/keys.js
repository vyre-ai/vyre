// @ts-check
// kernel/storage/keys.js: keys derived from a Space's own pool key, for things the home keeps on its disk for that Space beyond the Drive (a lent computer's checkpoints: core/runner/checkpoint-store.js). The pool key
// is the Space's (the sealing process derives it per Space; kernel/storage/provision.js), so what is sealed under a key derived here opens only with that Space's key. The Drive of each Space's kernel is held here,
// not on the kernel object a module can reach: only code that holds the kernel itself (the daemon, the registry) can ask for a derived key.
import crypto from "node:crypto";

/** @type {WeakMap<object, any>} */
const drives = new WeakMap();
/** @param {object} kernel the Space's booted kernel @param {any} drive its Drive @returns {object} the kernel */
export function holdKernelDrive(kernel, drive) { if (drive && drive.pool && drive.pool.enc) drives.set(kernel, drive); return kernel; }

/** A 32-byte key for `label`, derived from this Space's pool key, or null when the Space has no Drive (and so no key of its own). @param {object} kernel @param {string} label @returns {Buffer | null} */
export function derivedKey(kernel, label) {
  const d = drives.get(kernel);
  return d ? Buffer.from(crypto.hkdfSync("sha256", d.pool.enc, "vyre-derived", String(label), 32)) : null;
}
