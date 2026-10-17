// @ts-check
// The mark on an invite link, drawn from the vault's encoder (core/vault/qr.js). The app paints the modules; this only returns them.

import { encode } from "../../../../core/vault/qr.js";

function ensureBuffer() {
  if (typeof globalThis.Buffer === "function" && typeof globalThis.Buffer.from === "function") return;
  /** @param {string | Uint8Array} input */
  const from = (input) => (input instanceof Uint8Array ? input : new TextEncoder().encode(String(input)));
  globalThis.Buffer = /** @type {any} */ ({
    from,
    /** @param {number} n */
    alloc: (n) => new Uint8Array(n),
  });
}

/**
 * Modules for an invite link, with a quiet margin of false cells. Null when the link is too long for the encoder.
 * @param {string} link @returns {boolean[][] | null}
 */
export function inviteModules(link) {
  const text = String(link || "");
  if (!text || text.length > 180) return null;
  try {
    ensureBuffer();
    const { modules } = encode(text);
    const quiet = 2;
    const n = modules.length + quiet * 2;
    const out = Array.from({ length: n }, () => Array(n).fill(false));
    modules.forEach((row, y) => row.forEach((on, x) => { out[y + quiet][x + quiet] = on; }));
    return out;
  } catch { return null; }
}
