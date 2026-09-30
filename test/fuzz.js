// @ts-check
// A small seeded generator for the ingress fuzz tests: the same seed is the same input, so a
// failure reproduces.

/** @param {number} seed */
export function rng(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (/** @type {number} */ n) => Math.floor(next() * n);
  const pick = (/** @type {any[]} */ a) => a[int(a.length)];
  const bytes = (/** @type {number} */ n) => Buffer.from(Array.from({ length: n }, () => int(256)));
  return { next, int, pick, bytes };
}

/** A random JSON-ish value: odd types, nesting, huge numbers, prototype keys. */
export function junk(/** @type {ReturnType<typeof rng>} */ r, depth = 0) {
  const k = r.int(depth > 3 ? 7 : 10);
  switch (k) {
    case 0: return null;
    case 1: return r.pick([0, -1, 1e308, -0, 2 ** 53, 4294967295, NaN === 0 ? 0 : 7]);
    case 2: return r.pick(["", "x", "\u0000", "a".repeat(5000), "\ud800", "__proto__", "constructor", "../../etc/passwd"]);
    case 3: return r.pick([true, false]);
    case 4: return [];
    case 5: return {};
    case 6: return r.pick(["tools/list", "tools/call", "initialize", "ping", "notifications/cancelled"]);
    case 7: return Array.from({ length: r.int(4) }, () => junk(r, depth + 1));
    default: {
      const o = /** @type {any} */ ({});
      for (let i = 0, n = r.int(5); i < n; i++) o[r.pick(["id", "method", "params", "jsonrpc", "name", "arguments", "__proto__", "result", "error", "x"])] = junk(r, depth + 1);
      return o;
    }
  }
}
